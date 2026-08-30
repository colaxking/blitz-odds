import { getStore } from "@netlify/blobs";
import { NOTIF_STORE, USER_STORE } from "./notif.mts";
import { removeUserFromStandings } from "./rescore.mts";

// Everything attached to one account, removed. Lifted out of
// admin-user-delete.mts when self-service deletion was added, because the
// two paths must not drift: an account deleted by its owner has to leave
// exactly as little behind as one deleted by an admin, and the surest way
// to guarantee that is for there to be one implementation.
//
// This deliberately does NOT touch the Identity login. The caller does that,
// afterwards, and the order matters - see the note in each caller.

const LEAGUE_STORE = "blitz-leagues";
const PREDICTION_STORE = "blitz-predictions";
const ANALYTICS_STORE = "blitz-analytics";

export interface PurgeResult {
  picks: number;
  memberships: number;
  standings: number;
  requests: number;
  predictions: number;
  follows: number;
  profile: number;
  prefs: number;
  /** League ids whose standings had to be re-ranked after the removal. */
  leaguesAffected: string[];
}

/** Deletes every key under a prefix. Returns how many went. */
async function purgePrefix(store: any, prefix: string): Promise<number> {
  let removed = 0;
  const { blobs } = await store.list({ prefix });
  await Promise.all(
    blobs.map(async (b: any) => {
      try {
        await store.delete(b.key);
        removed++;
      } catch {
        /* a key that's already gone is a success for our purposes */
      }
    })
  );
  return removed;
}

/**
 * Removes every trace of `userId` from the blob stores.
 *
 * There is no "keep their picks" variant. A pick with no account behind it
 * shows as a blank row in a league table forever, and the person asking to
 * be forgotten reasonably expects the pick to go too.
 *
 * Analytics records are NOT removed and are not looked for here: they are
 * keyed to an anonymous visitor id generated in the browser and are never
 * joined to an account id, so there is nothing in that store to find. The
 * privacy policy says the same thing.
 */
export async function purgeUserData(userId: string): Promise<PurgeResult> {
  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const userStore = getStore(USER_STORE, { consistency: "strong" });
  const notif = getStore(NOTIF_STORE, { consistency: "strong" });

  const result: PurgeResult = {
    picks: 0, memberships: 0, standings: 0, requests: 0,
    predictions: 0, follows: 0, profile: 0, prefs: 0,
    leaguesAffected: [],
  };

  // 1. Picks. Keyed picks:{leagueId}:{week}:{userId}:{gameId}, so the user
  //    id sits in the middle and can't be reached with a prefix scan. The
  //    whole picks space has to be walked and filtered on the segment.
  const pickList = await leagueStore.list({ prefix: "picks:" });
  const mine = pickList.blobs.filter((b: any) => b.key.split(":")[3] === userId);
  await Promise.all(
    mine.map(async (b: any) => {
      try {
        await leagueStore.delete(b.key);
        result.picks++;
      } catch {
        /* already gone */
      }
    })
  );

  // 2. League memberships, and the standings rows that reference them.
  const memberList = await leagueStore.list({ prefix: "members:" });
  for (const b of memberList.blobs) {
    const leagueId = b.key.slice("members:".length);
    try {
      const doc: any = await leagueStore.get(b.key, { type: "json" });
      if (!doc?.members?.some((m: any) => m.userId === userId)) continue;

      doc.members = doc.members.filter((m: any) => m.userId !== userId);
      await leagueStore.setJSON(b.key, doc);
      result.memberships++;

      const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
      if (league) {
        league.memberCount = doc.members.length;
        league.updatedAt = new Date().toISOString();
        await leagueStore.setJSON(`league:${leagueId}`, league);
      }

      // standings.season is a ranked ARRAY built by ScoringEngine, not a
      // map - deleting a key off it would do nothing. removeUserFromStandings
      // drops the user's row from each stored week and re-runs the same
      // ranking pass, which is what actually removes them from the table.
      if (await removeUserFromStandings(leagueStore, leagueId, userId)) {
        result.standings++;
        result.leaguesAffected.push(leagueId);
      }

      // Survivor tracks alive/eliminated state in its own doc.
      try {
        const survivor: any = await leagueStore.get(`survivor:${leagueId}`, { type: "json" });
        if (survivor && survivor[userId]) {
          delete survivor[userId];
          await leagueStore.setJSON(`survivor:${leagueId}`, survivor);
        }
      } catch {
        /* not a survivor league */
      }
    } catch {
      /* skip an unreadable league rather than half-deleting the user */
    }
  }

  // 3. Pending join requests, keyed request:{leagueId}:{userId}.
  const reqList = await leagueStore.list({ prefix: "request:" });
  await Promise.all(
    reqList.blobs
      .filter((b: any) => b.key.endsWith(`:${userId}`))
      .map(async (b: any) => {
        try {
          await leagueStore.delete(b.key);
          result.requests++;
        } catch {
          /* already gone */
        }
      })
  );

  // 4. Per-game alert follows. Keyed follow:{season}:{week}:{userId} in the
  //    notification store (see lib/follows.mts), so they span every week the
  //    reader has followed anything in and can't be reached by one prefix.
  //    Missed by the original admin delete: these are swept weekly as
  //    housekeeping, but "it expires eventually" is not deletion.
  const followList = await notif.list({ prefix: "follow:" });
  await Promise.all(
    followList.blobs
      .filter((b: any) => b.key.split(":")[3] === userId)
      .map(async (b: any) => {
        try {
          await notif.delete(b.key);
          result.follows++;
        } catch {
          /* already gone */
        }
      })
  );

  // 5. Profile, notification prefs, push subscriptions, and the send ledger.
  try {
    await userStore.delete(`users:${userId}`);
    result.profile = 1;
  } catch {
    /* no profile row */
  }
  try {
    await notif.delete(`prefs:${userId}`);
    result.prefs = 1;
  } catch {
    /* no prefs row */
  }
  /* Push devices. lib/push.mts writes push:{userId}:{deviceId}; this used to
     purge `sub:{userId}`, a prefix nothing has ever written, so a deleted
     account kept its registered devices and the dispatchers kept pushing to
     them until the endpoint 410'd on its own. */
  result.prefs += await purgePrefix(notif, `push:${userId}:`);

  // 5b. The two idempotency ledgers, sent:{type}:{season}:{week}:{userId}
  //     and evt:{season}:{week}:{type}:{event}:{userId}. Both end in the
  //     user id, so a suffix filter reaches them without knowing the middle.
  //     They're swept per-week as housekeeping, but until that sweep runs
  //     they are a record of which alerts a named person was sent.
  for (const prefix of ["sent:", "evt:"]) {
    try {
      const { blobs } = await notif.list({ prefix });
      await Promise.all(
        blobs
          .filter((b: any) => b.key.endsWith(`:${userId}`))
          .map(async (b: any) => {
            try {
              await notif.delete(b.key);
              result.prefs++;
            } catch {
              /* already gone */
            }
          })
      );
    } catch {
      /* an unreadable ledger must not abort a deletion that's already run */
    }
  }

  // 6. Prediction snapshots keyed to this user, if any exist yet.
  try {
    result.predictions = await purgePrefix(
      getStore(PREDICTION_STORE, { consistency: "strong" }),
      `user:${userId}`
    );
  } catch {
    /* the predictions store may not have per-user keys at all */
  }

  return result;
}

/** Named so a reader of either caller doesn't have to guess what's excluded. */
export const PURGE_EXCLUDES = [ANALYTICS_STORE];

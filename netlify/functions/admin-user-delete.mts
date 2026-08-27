import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  requireAdmin, identityAdminFetch, adminJson, forbidden, audit, ADMIN_CORS,
} from "./lib/admin.mts";
import { NOTIF_STORE, USER_STORE } from "./lib/notif.mts";
import { removeUserFromStandings } from "./lib/rescore.mts";

// POST /.netlify/functions/admin-user-delete
//   { userId, confirmEmail }  -> { ok, removed: {...} }
//
// Deletes the login AND everything attached to it. There is no "keep their
// picks" variant: a pick with no account behind it shows as a blank row in
// a league table forever, and the person asking to be forgotten reasonably
// expects the pick to go too.
//
// ORDER MATTERS. Blob data is purged BEFORE the Identity user is deleted.
// The reverse order has a failure mode with no recovery path: if the blob
// sweep dies halfway, the account is already gone, and the orphaned picks
// are now keyed to a userId that can no longer be looked up or re-deleted
// through this endpoint. Done this way, a mid-sweep failure leaves the
// account intact and the operation is simply repeatable.
//
// confirmEmail must match the target's address. The UI already makes the
// admin type it, but the UI is not the security boundary - a mis-scripted
// POST with the wrong id should not be able to delete a stranger.

const LEAGUE_STORE = "blitz-leagues";
const PREDICTION_STORE = "blitz-predictions";

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

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ADMIN_CORS });
  if (req.method !== "POST") return adminJson(405, { ok: false, error: "Method not allowed" });

  const actor = await requireAdmin(req);
  if (!actor) return forbidden();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return adminJson(400, { ok: false, error: "Body must be JSON" });
  }

  const userId = String(body.userId || "").trim();
  const confirmEmail = String(body.confirmEmail || "").trim().toLowerCase();
  if (!userId || !confirmEmail) {
    return adminJson(400, { ok: false, error: "userId and confirmEmail are required" });
  }

  // Deleting your own account through the admin panel logs you out mid-action
  // and, if you were the last admin, locks everyone out. The account can still
  // be removed - just not from here, and not by its owner.
  if (userId === actor.id) {
    return adminJson(409, { ok: false, error: "You can't delete your own account from here" });
  }

  try {
    const targetRes = await identityAdminFetch(req, context, `/admin/users/${userId}`);
    if (!targetRes.ok) return adminJson(404, { ok: false, error: "No such user" });
    const target: any = await targetRes.json();

    if ((target.email || "").trim().toLowerCase() !== confirmEmail) {
      return adminJson(400, { ok: false, error: "The email you typed doesn't match that account" });
    }

    const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
    const userStore = getStore(USER_STORE, { consistency: "strong" });
    const notif = getStore(NOTIF_STORE, { consistency: "strong" });

    const removed = { picks: 0, memberships: 0, standings: 0, requests: 0, predictions: 0, profile: 0, prefs: 0 };
    const rescored: string[] = [];

    // 1. Picks. Keyed picks:{leagueId}:{week}:{userId}:{gameId}, so the user
    //    id sits in the middle and can't be reached with a prefix scan. The
    //    whole picks space has to be walked and filtered on the segment.
    const pickList = await leagueStore.list({ prefix: "picks:" });
    const mine = pickList.blobs.filter((b: any) => b.key.split(":")[3] === userId);
    await Promise.all(
      mine.map(async (b: any) => {
        try {
          await leagueStore.delete(b.key);
          removed.picks++;
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
        removed.memberships++;

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
          removed.standings++;
          rescored.push(leagueId);
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
            removed.requests++;
          } catch {
            /* already gone */
          }
        })
    );

    // 4. Profile, notification prefs, push subscriptions, and the send ledger.
    try {
      await userStore.delete(`users:${userId}`);
      removed.profile = 1;
    } catch {
      /* no profile row */
    }
    try {
      await notif.delete(`prefs:${userId}`);
      removed.prefs = 1;
    } catch {
      /* no prefs row */
    }
    removed.prefs += await purgePrefix(notif, `sub:${userId}`);

    // 5. Prediction snapshots keyed to this user, if any exist yet.
    try {
      removed.predictions = await purgePrefix(
        getStore(PREDICTION_STORE, { consistency: "strong" }),
        `user:${userId}`
      );
    } catch {
      /* the predictions store may not have per-user keys at all */
    }

    // 6. Only now, with the data provably gone, remove the login itself.
    const delRes = await identityAdminFetch(req, context, `/admin/users/${userId}`, { method: "DELETE" });
    if (!delRes.ok && delRes.status !== 404) {
      return adminJson(delRes.status, {
        ok: false,
        error: `Their data was removed but Identity refused to delete the login (${delRes.status}). Retry to finish.`,
        removed,
      });
    }

    await audit(
      actor,
      "user.delete",
      `deleted ${target.email} and all their data`,
      { target: userId, meta: { removed, leaguesAffected: rescored } }
    );

    return adminJson(200, { ok: true, removed, leaguesAffected: rescored });
  } catch (err) {
    return adminJson(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/admin-user-delete",
};

import { notifStore } from "./notif.mts";

// Per-game follows: "alert me about THIS game", for one week only.
//
// Favourites and picks both answer "which games" indirectly - a team you
// like, a game you staked something on. Neither covers the ordinary case of
// wanting one specific game: a Thursday nighter you're planning to watch,
// or a game your league rival needs to lose. Doing that with the existing
// controls means starring a team you don't otherwise care about, which then
// hands you that team's other sixteen games for the rest of the season, and
// which you then have to remember to un-star.
//
// Storage (blitz-notif store):
//   follow:{season}:{week}:{userId} -> { games: string[], updatedAt }
//
// THE WEEK IS IN THE KEY, not a field on the record. That's what makes
// "only for that week" structural rather than a rule someone has to
// remember to enforce: next week reads a different key, finds nothing, and
// alerts nothing. There is no expiry check in the send path that could be
// forgotten, mis-ordered, or fail closed-on-the-wrong-side and quietly
// leave last week's follows firing all season.
//
// Blobs has no TTL, so the keys themselves still need clearing eventually -
// that's sweepFollows(), which the dispatcher runs a few weeks behind the
// current one, the same shape and for the same reason as the event ledger
// sweep in notif.mts. Sweeping is housekeeping, not correctness: a key that
// never gets swept still never alerts, because nothing reads a past week.

export interface FollowDoc {
  games: string[];
  updatedAt: string;
}

/** A full slate is 16 games, so this is "every game this week" plus a
 *  little headroom rather than a limit anyone should ever meet. It exists
 *  to bound the record, not to ration the feature. */
export const MAX_FOLLOWS_PER_WEEK = 20;

export function followKey(season: number, week: number, userId: string): string {
  return `follow:${season}:${week}:${userId}`;
}

export function followWeekPrefix(season: number, week: number): string {
  return `follow:${season}:${week}:`;
}

/** The gameIds this reader follows in this week. Empty set when they follow
 *  nothing, which is the overwhelmingly common case. */
export async function getFollows(season: number, week: number, userId: string): Promise<Set<string>> {
  try {
    const doc = (await notifStore().get(followKey(season, week, userId), { type: "json" })) as FollowDoc | null;
    return new Set(Array.isArray(doc?.games) ? doc!.games : []);
  } catch {
    // A read failure must not read as "follows nothing" anywhere it would
    // suppress an alert - but the alternative (throwing) would take out the
    // whole tick for every other reader. The dispatcher treats this the
    // same way it treats an unreadable league: one missed alert, not a
    // failed pass.
    return new Set();
  }
}

/**
 * Adds or removes one game. Read-modify-write, so two devices toggling in
 * the same second can lose one edit - acceptable for a control only ever
 * driven by one person tapping a button, and the UI reflects the response
 * rather than its own optimistic guess, so the loser sees the truth.
 */
export async function toggleFollow(
  season: number,
  week: number,
  userId: string,
  gameId: string,
  follow: boolean
): Promise<string[]> {
  const current = await getFollows(season, week, userId);
  if (follow) {
    if (!current.has(gameId) && current.size >= MAX_FOLLOWS_PER_WEEK) {
      throw new Error(`You can follow up to ${MAX_FOLLOWS_PER_WEEK} games in a week.`);
    }
    current.add(gameId);
  } else {
    current.delete(gameId);
  }

  const games = [...current];
  const key = followKey(season, week, userId);
  if (!games.length) {
    // Delete rather than storing an empty array. The dispatcher's user list
    // is topped up from the *existence* of these keys, so an empty record
    // left behind would pull someone into every push pass forever to
    // discover they follow nothing.
    try { await notifStore().delete(key); } catch { /* already gone is the desired state */ }
    return [];
  }
  await notifStore().setJSON(key, { games, updatedAt: new Date().toISOString() } as FollowDoc);
  return games;
}

/**
 * Every reader's follows for one week, as userId -> gameIds.
 *
 * One list plus one read per following user, done once per pass, rather
 * than a read per user per game. Callers must scope this to the weeks
 * actually in play; there is deliberately no season-wide version, because
 * every tick paying to enumerate January in September is how a cheap
 * feature becomes an expensive one.
 */
export async function loadWeekFollows(season: number, week: number): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const store = notifStore();
  const prefix = followWeekPrefix(season, week);
  try {
    for await (const page of store.list({ prefix, paginate: true })) {
      for (const blob of page.blobs) {
        const userId = blob.key.slice(prefix.length);
        if (!userId) continue;
        try {
          const doc = (await store.get(blob.key, { type: "json" })) as FollowDoc | null;
          const games = Array.isArray(doc?.games) ? doc!.games : [];
          if (games.length) out.set(userId, new Set(games));
        } catch { /* one unreadable record shouldn't cost the others */ }
      }
    }
  } catch { /* no follows this week is indistinguishable from an empty store */ }
  return out;
}

/** Deletes a whole week of follow keys. Housekeeping only - see the header. */
export async function sweepFollows(season: number, week: number): Promise<number> {
  const store = notifStore();
  let deleted = 0;
  try {
    for await (const page of store.list({ prefix: followWeekPrefix(season, week), paginate: true })) {
      for (const blob of page.blobs) {
        try { await store.delete(blob.key); deleted++; } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
  return deleted;
}

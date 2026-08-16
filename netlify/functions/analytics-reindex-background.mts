import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// ---------------------------------------------------------------------------
// Nightly cleanup for the sparse drill-down indexes written by track.mts.
// ---------------------------------------------------------------------------
// track.mts writes index entries as blind, unconditional `store.set()` calls
// (no read first) so that ingestion under heavy traffic stays fast and never
// races. The cost of that: a returning visitor writes a new index key every
// time they touch the same dimension/value (e.g. every pageview from the
// same city), so duplicates accumulate under a given prefix indefinitely, and
// an "unfavorite" never removes the earlier "favorited" index entry live.
//
// This job runs nightly (see `schedule` below) and, for each idx: prefix:
//   1. Collapses duplicate (dimension, value, visitorId) entries down to just
//      the most recent one, freeing up storage without losing "this visitor
//      is associated with this value, as of roughly this time".
//   2. For the favTeam dimension specifically, deletes any entry for a team
//      the visitor's session shows they no longer have favorited - this is
//      where "unfavorite" cleanup actually happens (the live analytics-
//      sessions.mts endpoint flags this window with `activeForFilter` in the
//      meantime, so nothing is presented as misleadingly current).
//
// Runs as a background function (up to 15 min) and caps total work per
// invocation so it degrades gracefully rather than timing out outright.
const MAX_KEYS_PER_RUN = 50000;

export default async () => {
  const store = getStore("blitz-analytics");
  const sessionFavoriteCache = new Map<string, Set<string> | null>();

  async function currentFavorites(visitorId: string): Promise<Set<string> | null> {
    if (sessionFavoriteCache.has(visitorId)) return sessionFavoriteCache.get(visitorId)!;
    try {
      const session = await store.get(`session:${visitorId}`, { type: "json" });
      const favs = session && session.favoriteTeams ? new Set<string>(Object.keys(session.favoriteTeams)) : new Set<string>();
      sessionFavoriteCache.set(visitorId, favs);
      return favs;
    } catch {
      sessionFavoriteCache.set(visitorId, null);
      return null;
    }
  }

  // Group keys by (dimension, value, visitorId) so we can find duplicates.
  // Key shape: idx:{dimension}:{encodedValue}:{invertedTs}:{visitorId}
  const groups = new Map<string, string[]>();
  let scanned = 0;
  let deleted = 0;

  scan: for await (const page of store.list({ prefix: "idx:", paginate: true })) {
    for (const b of page.blobs) {
      scanned += 1;
      if (scanned > MAX_KEYS_PER_RUN) break scan;

      const parts = b.key.split(":");
      if (parts.length < 5) continue; // malformed/legacy key, ignore
      const dimension = parts[1];
      const encodedValue = parts[2];
      const visitorId = parts[parts.length - 1];
      const groupKey = `${dimension}:${encodedValue}:${visitorId}`;

      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey)!.push(b.key);
    }
  }

  const deletions: Promise<unknown>[] = [];

  for (const [groupKey, keys] of groups) {
    const [dimension, encodedValue, visitorId] = groupKey.split(":");

    if (dimension === "favTeam") {
      const favs = await currentFavorites(visitorId);
      const stillFavorited = favs ? favs.has(decodeURIComponent(encodedValue)) : true; // unknown session -> leave alone
      if (!stillFavorited) {
        for (const k of keys) {
          deletions.push(store.delete(k));
          deleted += 1;
        }
        continue;
      }
    }

    // Keys sort lexicographically by inverted timestamp, so the first key
    // for this visitor+value (in list order) is already the most recent -
    // delete the rest.
    if (keys.length > 1) {
      for (const k of keys.slice(1)) {
        deletions.push(store.delete(k));
        deleted += 1;
      }
    }
  }

  await Promise.all(deletions);

  return new Response(
    JSON.stringify({ ok: true, scanned, groups: groups.size, deleted }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  schedule: "0 9 * * *", // daily at 9am UTC - low-traffic window for an NFL site
};

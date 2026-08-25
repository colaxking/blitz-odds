import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";

// GET /.netlify/functions/standings-get?leagueId={id}[&week={n}]
//   -> { ok, format, memberCount,
//        season: [{userId,rank,points,correct,incorrect,hasResults,...profile}],
//        week?: {...} (only if ?week= was passed),
//        survivor?: { [userId]: {alive, usedTeams, eliminatedWeek} } }
//
// Reads only - all the actual scoring happens in results-process.mts.
//
// `season` is the league's full roster, not just the scored slice.
// standings:{leagueId}.season only contains people results-process has
// actually scored a week for, which meant a league looked half-empty (or
// completely empty) until the first Sunday's games finished, and anyone
// who joined mid-season simply wasn't in the table until they'd played a
// week. Members with nothing scored yet are merged in here with zeroed
// totals and hasResults:false so the client can render them as "not played
// yet" rather than as a real 0-0 record, and so the table always adds up
// to the league's actual membership.

const LEAGUE_STORE = "blitz-leagues";
const USER_STORE = "blitz-users";

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const url = new URL(req.url);
  const leagueId = url.searchParams.get("leagueId") || "";
  const week = url.searchParams.get("week") ? Number(url.searchParams.get("week")) : null;
  if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId query param is required" }, CORS_HEADERS);

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });

  try {
    // Four independent reads (auth is a network call to the site's own
    // Identity endpoint) that were each waiting on the one before it. The
    // survivor doc is fetched unconditionally rather than after league.format
    // is known - it's one small get, and paying for it on non-survivor
    // leagues is cheaper than an extra sequential round trip on survivor
    // ones. Every check below runs in the same order and returns the same
    // status codes as before.
    const [claims, league, membersDoc, standingsRaw, survivorRaw] = await Promise.all([
      getAuthenticatedUser(req),
      leagueStore.get(`league:${leagueId}`, { type: "json" }) as Promise<any>,
      leagueStore.get(`members:${leagueId}`, { type: "json" }) as Promise<any>,
      leagueStore.get(`standings:${leagueId}`, { type: "json" }) as Promise<any>,
      leagueStore.get(`survivor:${leagueId}`, { type: "json" }) as Promise<any>,
    ]);

    if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
    const userId = claims.id;

    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);

    const isMember = membersDoc?.members?.some((m: any) => m.userId === userId);
    if (!isMember) return jsonResponse(403, { ok: false, error: "Not a member of this league" }, CORS_HEADERS);

    const standingsDoc: any = standingsRaw || { weeks: {}, season: [] };
    const memberById = new Map(
      (membersDoc?.members || []).map((m: any) => [m.userId, { displayName: m.displayName, avatar: m.avatar ?? null }])
    );

    // The members doc is a snapshot, kept in sync on a best-effort basis
    // by user-profile.mts whenever someone edits their name/avatar (see
    // that function's fan-out). Rather than depend on every past and
    // future write path remembering to keep that snapshot current, read
    // each member's live profile here too and let it win when present -
    // this is the one place people actually look to see if a change
    // "took," so it should never be able to show a stale name/icon just
    // because some other write path missed the fan-out.
    const userStore = getStore(USER_STORE, { consistency: "strong" });
    await Promise.all(
      Array.from(memberById.keys()).map(async (uid) => {
        try {
          const profile: any = await userStore.get(`users:${uid}`, { type: "json" });
          if (!profile) return;
          const current = memberById.get(uid)!;
          memberById.set(uid, {
            displayName: (typeof profile.displayName === "string" && profile.displayName.trim())
              ? profile.displayName
              : current.displayName,
            avatar: typeof profile.avatar === "string" ? profile.avatar : (profile.avatar === null ? null : current.avatar),
          });
        } catch {
          // Best-effort - fall back to the members-doc snapshot already in the map.
        }
      })
    );

    const memberInfo = (uid: string) => memberById.get(uid) || { displayName: "Player", avatar: null };

    // Scored rows keep the rank results-process gave them. Anyone on the
    // roster it hasn't scored yet gets appended, all sharing the next rank
    // (they're genuinely tied - none of them has played), flagged with
    // hasResults:false so the client shows a dash instead of a fabricated
    // 0-0 record and a 0% win rate. A member who's since left the league
    // is dropped rather than lingering as a ghost row: standings:{id} is
    // never pruned on leave, and the members doc is the source of truth
    // for who's actually in the league.
    const scored = (standingsDoc.season || []).filter((row: any) => memberById.has(row.userId));
    const scoredWithNames = scored.map((row: any) => ({
      ...row,
      ...memberInfo(row.userId),
      hasResults: true,
    }));

    const scoredIds = new Set(scored.map((row: any) => row.userId));
    const unscoredRank = scoredWithNames.length + 1;
    const unscored = (membersDoc?.members || [])
      .filter((m: any) => !scoredIds.has(m.userId))
      .map((m: any) => ({
        userId: m.userId,
        ...memberInfo(m.userId),
        rank: unscoredRank,
        points: 0,
        correct: 0,
        incorrect: 0,
        hasResults: false,
      }))
      .sort((a: any, b: any) => String(a.displayName || "").localeCompare(String(b.displayName || "")));

    const responseBody: any = {
      ok: true,
      format: league.format,
      memberCount: (membersDoc?.members || []).length,
      season: [...scoredWithNames, ...unscored],
    };

    if (week) {
      const weekScores = standingsDoc.weeks?.[week] || {};
      responseBody.week = Object.keys(weekScores).map((userId2) => ({
        userId: userId2,
        ...memberInfo(userId2),
        ...weekScores[userId2],
      }));
    }

    if (league.format === "survivor") {
      const survivorState: any = survivorRaw || {};
      // results-process only writes survivor state for weeks it has
      // actually processed, so before the first scored week - or for
      // someone who joined after it - a member has no entry at all and the
      // standings row had nothing to show in the Status column. Everyone
      // on the roster starts alive by default here; a real stored entry
      // always wins over that default.
      const entries = (membersDoc?.members || []).map((m: any) => [
        m.userId,
        {
          alive: true,
          usedTeams: [],
          eliminatedWeek: null,
          ...(survivorState[m.userId] || {}),
          ...memberInfo(m.userId),
        },
      ]);
      responseBody.survivor = Object.fromEntries(entries);
    }

    return jsonResponse(200, responseBody, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/standings-get",
};

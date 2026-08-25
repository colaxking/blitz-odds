import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { makeGameId } from "./lib/gameId.mts";
import { isPastKickoff } from "./lib/kickoff.mts";

// GET /.netlify/functions/league-picks?leagueId={id}&week={n}
//   -> { ok, week, format, members: [{userId,displayName,avatar}],
//        games: [{ gameId, away, home, date, time, network, locked,
//                  winner, tie, final,
//                  picks: [{userId, team, confidence?, spread?, correct?}] }] }
//
// "Who picked what" for a whole league week. picks-mine.mts answers the
// same question for one member (the caller); this answers it for everyone,
// which is the part that actually makes a pool feel like a pool.
//
// THE LOCK IS THE WHOLE POINT. A game's picks array is only populated once
// that game is past its own kickoff (isPastKickoff, the same per-game
// deadline picks-submit.mts enforces on write). Before kickoff the game
// comes back with locked:false and an empty picks array - not a hidden or
// masked list, nothing is sent at all - so there is no way to read a
// rival's pick out of the response early, however the client is poked. The
// gate is per-game rather than per-week because that's how locking already
// works everywhere else in this app: Thursday night's picks are visible
// while Sunday's are still secret.
//
// Reads are the same one-key-per-game-per-member layout everything else
// uses (see picks-submit.mts for why it's shaped that way), so this is
// members x locked-games direct gets, all issued together. Only locked
// games are read at all - early in the week that's zero or one game's
// worth of reads, not the full slate.

const LEAGUE_STORE = "blitz-leagues";
const SITE_DATA_STORE = "blitz-site-data";

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Same short-lived module-scope memo as picks-mine.mts - the schedule blob
// is identical for every caller and changes at most a few times a week.
const SCHEDULE_CACHE_MS = 60 * 1000;
let scheduleCache: { at: number; doc: any } | null = null;

async function getSchedule(store: ReturnType<typeof getStore>): Promise<any> {
  if (scheduleCache && Date.now() - scheduleCache.at < SCHEDULE_CACHE_MS) return scheduleCache.doc;
  const doc: any = await store.get("schedule", { type: "json" });
  if (doc?.weeks) scheduleCache = { at: Date.now(), doc };
  return doc;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const url = new URL(req.url);
  const leagueId = url.searchParams.get("leagueId") || "";
  const week = Number(url.searchParams.get("week"));
  if (!leagueId || !week) return jsonResponse(400, { ok: false, error: "leagueId and week query params are required" }, CORS_HEADERS);

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const siteDataStore = getStore(SITE_DATA_STORE);
  const userStore = getStore("blitz-users", { consistency: "strong" });

  try {
    const [claims, league, membersDoc, schedule, resultsDoc] = await Promise.all([
      getAuthenticatedUser(req),
      leagueStore.get(`league:${leagueId}`, { type: "json" }) as Promise<any>,
      leagueStore.get(`members:${leagueId}`, { type: "json" }) as Promise<any>,
      getSchedule(siteDataStore),
      leagueStore.get(`results:${leagueId}:${week}`, { type: "json" }) as Promise<any>,
    ]);

    if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
    const userId = claims.id;

    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);

    // Non-members get nothing. This endpoint exposes other people's picks,
    // so membership is the entire access control story - it is checked
    // before a single pick key is read, not just before they're returned.
    const isMember = membersDoc?.members?.some((m: any) => m.userId === userId);
    if (!isMember) return jsonResponse(403, { ok: false, error: "Not a member of this league" }, CORS_HEADERS);

    const weekEntry = schedule?.weeks?.find((w: any) => w.week === week);
    if (!weekEntry) return jsonResponse(404, { ok: false, error: `No schedule found for week ${week}` }, CORS_HEADERS);

    const roster: any[] = membersDoc?.members || [];
    const memberIds = roster.map((m: any) => m.userId);

    // Same live-profile overlay standings-get.mts does, and for the same
    // reason: the members doc is a best-effort snapshot, and this is a
    // place people look to see whether their own name/avatar change took.
    const profiles = new Map<string, { displayName: string; avatar: string | null }>(
      roster.map((m: any) => [m.userId, { displayName: m.displayName, avatar: m.avatar ?? null }])
    );
    await Promise.all(memberIds.map(async (uid: string) => {
      try {
        const profile: any = await userStore.get(`users:${uid}`, { type: "json" });
        if (!profile) return;
        const current = profiles.get(uid)!;
        profiles.set(uid, {
          displayName: (typeof profile.displayName === "string" && profile.displayName.trim())
            ? profile.displayName
            : current.displayName,
          avatar: typeof profile.avatar === "string" ? profile.avatar : (profile.avatar === null ? null : current.avatar),
        });
      } catch {
        // Best-effort - fall back to the members-doc snapshot.
      }
    }));

    const weekResults: Record<string, any> = resultsDoc?.results || {};

    const scheduleGames: any[] = weekEntry.games || [];
    const lockedFlags = scheduleGames.map((g: any) => isPastKickoff(league.season, g.date, g.time));

    // One flat list of {game, member} reads rather than nested Promise.all
    // per game - same number of gets either way, but a single flight means
    // the slowest game doesn't gate the rest.
    const wanted: Array<{ gid: string; uid: string }> = [];
    scheduleGames.forEach((g: any, i: number) => {
      if (!lockedFlags[i]) return; // pre-kickoff: never read, never returned
      const gid = makeGameId(league.season, week, g.away, g.home);
      memberIds.forEach((uid: string) => wanted.push({ gid, uid }));
    });

    const picksByGame: Record<string, Array<any>> = {};
    await Promise.all(wanted.map(async ({ gid, uid }) => {
      const pick: any = await leagueStore.get(`picks:${leagueId}:${week}:${uid}:${gid}`, { type: "json" });
      if (!pick || !pick.team) return;
      (picksByGame[gid] || (picksByGame[gid] = [])).push({
        userId: uid,
        team: pick.team,
        ...(typeof pick.confidence === "number" ? { confidence: pick.confidence } : {}),
        ...(typeof pick.spread === "number" ? { spread: pick.spread } : {}),
      });
    }));

    const games = scheduleGames.map((g: any, i: number) => {
      const gameId = makeGameId(league.season, week, g.away, g.home);
      const locked = lockedFlags[i];
      const result = weekResults[gameId] || null;
      const picks = (picksByGame[gameId] || []).map((p: any) => ({
        ...p,
        // Only claim right/wrong once the game is actually final and
        // scored - a leader at halftime is not a correct pick yet.
        ...(result?.final && !result.tie && result.winner
          ? { correct: p.team === result.winner }
          : {}),
      }));
      // Confidence leagues read most naturally highest-stake-first;
      // everything else is alphabetical so the order is at least stable
      // between renders instead of following blob response timing.
      picks.sort((a: any, b: any) => {
        if (typeof a.confidence === "number" && typeof b.confidence === "number" && a.confidence !== b.confidence) {
          return b.confidence - a.confidence;
        }
        const an = profiles.get(a.userId)?.displayName || "";
        const bn = profiles.get(b.userId)?.displayName || "";
        return String(an).localeCompare(String(bn));
      });

      return {
        gameId,
        away: g.away,
        home: g.home,
        date: g.date,
        time: g.time,
        network: g.network || null,
        locked,
        winner: result?.winner ?? null,
        tie: !!result?.tie,
        final: !!result?.final,
        picks,
      };
    });

    return jsonResponse(200, {
      ok: true,
      week,
      format: league.format,
      memberCount: roster.length,
      members: memberIds.map((uid: string) => ({
        userId: uid,
        displayName: profiles.get(uid)?.displayName || "Player",
        avatar: profiles.get(uid)?.avatar ?? null,
      })),
      games,
    }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-picks",
};

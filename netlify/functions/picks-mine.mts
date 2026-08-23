import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { makeGameId } from "./lib/gameId.mts";
import { isPastKickoff } from "./lib/kickoff.mts";

// GET /.netlify/functions/picks-mine?leagueId={id}&week={n}
//   -> { ok, week, games: [{ gameId, away, home, date, time, locked, pick }] }
// One request gives the frontend everything it needs to render the week's
// game cards - the schedule, each game's live locked/unlocked state, and
// whatever the caller has already picked - without three separate calls.

const LEAGUE_STORE = "blitz-leagues";
const SITE_DATA_STORE = "blitz-site-data";

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId = claims.id;

  const url = new URL(req.url);
  const leagueId = url.searchParams.get("leagueId") || "";
  const week = Number(url.searchParams.get("week"));
  if (!leagueId || !week) return jsonResponse(400, { ok: false, error: "leagueId and week query params are required" }, CORS_HEADERS);

  const leagueStore = getStore(LEAGUE_STORE);
  const siteDataStore = getStore(SITE_DATA_STORE);

  try {
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);

    const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
    const isMember = membersDoc?.members?.some((m: any) => m.userId === userId);
    if (!isMember) return jsonResponse(403, { ok: false, error: "Not a member of this league" }, CORS_HEADERS);

    const schedule: any = await siteDataStore.get("schedule", { type: "json" });
    const weekEntry = schedule?.weeks?.find((w: any) => w.week === week);
    if (!weekEntry) return jsonResponse(404, { ok: false, error: `No schedule found for week ${week}` }, CORS_HEADERS);

    const weekPicksDoc: any = await leagueStore.get(`picks:${leagueId}:${week}`, { type: "json" });
    const userPicks: any = weekPicksDoc?.[userId] || {};

    const games = (weekEntry.games || []).map((g: any) => {
      const gameId = makeGameId(league.season, week, g.away, g.home);
      return {
        gameId,
        away: g.away,
        home: g.home,
        date: g.date,
        time: g.time,
        network: g.network || null,
        locked: isPastKickoff(league.season, g.date, g.time),
        pick: userPicks[gameId] || null,
      };
    });

    const complete = games.filter((g: any) => g.pick).length;

    return jsonResponse(200, {
      ok: true,
      week,
      format: league.format,
      scoringSettings: league.scoringSettings,
      totalGames: games.length,
      picksComplete: complete,
      games,
    }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/picks-mine",
};

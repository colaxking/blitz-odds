import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { makeGameId } from "./lib/gameId.mts";
import { isPastKickoff } from "./lib/kickoff.mts";

// GET /.netlify/functions/picks-mine?leagueId={id}&week={n}
//   -> { ok, week, games: [{ gameId, away, home, date, time, locked, pick,
//        favorite?, spread? }], usedTeams? }
// One request gives the frontend everything it needs to render the week's
// game cards - the schedule, each game's live locked/unlocked state, and
// whatever the caller has already picked - without three separate calls.
// Reads picks:{leagueId}:{week}:{userId} - one key per user per week (see
// picks-submit.mts for why: a single shared doc for the whole league let
// two different members submitting around the same time clobber each
// other). ats leagues additionally get each game's current favorite/spread
// (for display before a pick is made - the actual grading line is whatever
// gets snapshotted onto the pick at submit time, see picks-submit.mts).
// survivor leagues additionally get usedTeams, the same season-wide
// "already picked" set picks-submit.mts enforces server-side, so the UI
// can disable those teams before a submit gets rejected rather than only
// after.

const LEAGUE_STORE = "blitz-leagues";
const SITE_DATA_STORE = "blitz-site-data";
const ODDS_STORE = "blitz-odds-live";

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

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const siteDataStore = getStore(SITE_DATA_STORE);
  const oddsStore = getStore(ODDS_STORE);

  try {
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);

    const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
    const isMember = membersDoc?.members?.some((m: any) => m.userId === userId);
    if (!isMember) return jsonResponse(403, { ok: false, error: "Not a member of this league" }, CORS_HEADERS);

    const schedule: any = await siteDataStore.get("schedule", { type: "json" });
    const weekEntry = schedule?.weeks?.find((w: any) => w.week === week);
    if (!weekEntry) return jsonResponse(404, { ok: false, error: `No schedule found for week ${week}` }, CORS_HEADERS);

    const userPicks: any = (await leagueStore.get(`picks:${leagueId}:${week}:${userId}`, { type: "json" })) || {};

    // ats: pull current spreads so unpicked games can still show a line.
    let oddsWeekGames: any = null;
    if (league.format === "ats") {
      const oddsDoc: any = await oddsStore.get("odds", { type: "json" });
      oddsWeekGames = oddsDoc?.weeks?.[String(week)]?.games || null;
    }

    const games = (weekEntry.games || []).map((g: any) => {
      const gameId = makeGameId(league.season, week, g.away, g.home);
      const oddsGame = oddsWeekGames ? oddsWeekGames[`${g.away}-${g.home}`] : null;
      return {
        gameId,
        away: g.away,
        home: g.home,
        date: g.date,
        time: g.time,
        network: g.network || null,
        locked: isPastKickoff(league.season, g.date, g.time),
        pick: userPicks[gameId] || null,
        ...(oddsGame ? { favorite: oddsGame.favorite, spread: oddsGame.spread } : {}),
      };
    });

    const complete = games.filter((g: any) => g.pick).length;

    // survivor: season-wide used teams (any prior week, mirrors the same
    // check picks-submit.mts enforces) so the client can disable those team
    // buttons up front instead of only surfacing a rejected-pick error.
    let usedTeams: string[] | undefined;
    if (league.format === "survivor") {
      const seen = new Set<string>();
      for (let w = 1; w < week; w++) {
        const priorDoc: any = await leagueStore.get(`picks:${leagueId}:${w}:${userId}`, { type: "json" });
        const priorPick: any = priorDoc && Object.values(priorDoc)[0];
        if (priorPick?.team) seen.add(priorPick.team);
      }
      usedTeams = [...seen];
    }

    return jsonResponse(200, {
      ok: true,
      week,
      format: league.format,
      scoringSettings: league.scoringSettings,
      totalGames: games.length,
      picksComplete: complete,
      games,
      ...(usedTeams ? { usedTeams } : {}),
    }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/picks-mine",
};

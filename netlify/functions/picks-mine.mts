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
// Reads picks:{leagueId}:{week}:{userId}:{gameId} - one key per game per
// member per week (see picks-submit.mts for the full history of why).
// Fetched by direct get() on every possible key derived from the schedule
// (not list()+prefix) - live testing showed list()'s own index lags well
// behind get()'s strong-consistency guarantee, so a get() on the exact key
// is the only read path here proven to see a write immediately. This means
// one get() per game in the relevant week(s) instead of one list() call,
// which is more requests but every one of them is a targeted, known key.
// ats leagues additionally get each game's current favorite/spread (for
// display before a pick is made - the actual grading line is whatever gets
// snapshotted onto the pick at submit time, see picks-submit.mts). survivor
// leagues additionally get usedTeams, the same season-wide "already picked"
// set picks-submit.mts enforces server-side, so the UI can disable those
// teams before a submit gets rejected rather than only after.

const LEAGUE_STORE = "blitz-leagues";
const SITE_DATA_STORE = "blitz-site-data";
const ODDS_STORE = "blitz-odds-live";

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// The schedule blob is the same document for every caller and changes at
// most a few times a week (flex scheduling), but it was being re-read on
// every single request - one extra round trip in front of the picks reads,
// paid by every member of every league on every week change. Module scope
// survives between invocations on a warm instance, so this holds it for a
// minute at a time. Deliberately short: a flex-time change still shows up
// within a minute, and a cold instance always reads fresh. Only cached on
// a successful non-empty read so a transient miss can't pin an empty
// schedule in memory for the next minute.
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
  const oddsStore = getStore(ODDS_STORE);

  try {
    // Auth verification is a network call out to the site's own Identity
    // endpoint, and the league/members/schedule reads are three more - none
    // of which depend on each other's results, so waiting for each in turn
    // was spending four sequential round trips before the first pick read
    // even started. They all go out together now and get validated below in
    // the same order as before, so the responses (401/404/403) are
    // unchanged; only the wall-clock cost is. The reads are cheap and
    // authorization is still checked before any of their contents are
    // returned, so speculatively issuing them costs nothing but a couple of
    // wasted gets on a request that was going to be rejected anyway.
    const [claims, league, membersDoc, schedule] = await Promise.all([
      getAuthenticatedUser(req),
      leagueStore.get(`league:${leagueId}`, { type: "json" }) as Promise<any>,
      leagueStore.get(`members:${leagueId}`, { type: "json" }) as Promise<any>,
      getSchedule(siteDataStore),
    ]);

    if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
    const userId = claims.id;

    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);

    const isMember = membersDoc?.members?.some((m: any) => m.userId === userId);
    if (!isMember) return jsonResponse(403, { ok: false, error: "Not a member of this league" }, CORS_HEADERS);

    const weekEntry = schedule?.weeks?.find((w: any) => w.week === week);
    if (!weekEntry) return jsonResponse(404, { ok: false, error: `No schedule found for week ${week}` }, CORS_HEADERS);

    // Fetch every pick this user has made this week - direct get() on every
    // game's own key (see header note on why not list()).
    // ats: pull current spreads so unpicked games can still show a line.
    // Issued alongside the pick reads rather than after them - it's an
    // independent read against a different store and there's no reason for
    // it to wait its turn behind them.
    const oddsPromise: Promise<any> = league.format === "ats"
      ? (oddsStore.get("odds", { type: "json" }) as Promise<any>)
      : Promise.resolve(null);

    const userPicks: Record<string, any> = {};
    const picksPromise = Promise.all((weekEntry.games || []).map(async (g: any) => {
      const gid = makeGameId(league.season, week, g.away, g.home);
      const pick = await leagueStore.get(`picks:${leagueId}:${week}:${userId}:${gid}`, { type: "json" });
      if (pick) userPicks[gid] = pick;
    }));

    const [, oddsDoc] = await Promise.all([picksPromise, oddsPromise]);

    // survivor: submitting a new game mid-week deletes the previously
    // picked game's key (see picks-submit.mts), but delete() has its own
    // brief consistency lag independent of the store's strong-consistency
    // setting - live testing showed a get() shortly after can transiently
    // still return the deleted value. Rather than trust delete() to have
    // already landed, only trust the most recently updated pick when more
    // than one somehow shows up for the same week.
    if (league.format === "survivor" && Object.keys(userPicks).length > 1) {
      const latestGid = Object.keys(userPicks).reduce((a, b) =>
        userPicks[a].updatedAt >= userPicks[b].updatedAt ? a : b
      );
      for (const gid of Object.keys(userPicks)) {
        if (gid !== latestGid) delete userPicks[gid];
      }
    }

    const oddsWeekGames: any = oddsDoc?.weeks?.[String(week)]?.games || null;

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

    // A confidence-format pick with a team but no confidence value yet
    // (allowed - see picks-submit.mts) isn't actually complete for scoring
    // purposes, so it shouldn't count toward "picks complete" either.
    const complete = games.filter((g: any) =>
      g.pick && (league.format !== "confidence" || typeof g.pick.confidence === "number")
    ).length;

    // survivor: season-wide used teams (any prior week, mirrors the same
    // check picks-submit.mts enforces) so the client can disable those team
    // buttons up front instead of only surfacing a rejected-pick error.
    // Every prior week is independent of every other one, but this used to
    // await each week's reads before starting the next - by week 15 that's
    // fourteen sequential round trips stacked in front of the response, and
    // it got slower every week of the season. The weeks all go out at once
    // now; the per-week "most recent pick wins" resolution is unchanged.
    let usedTeams: string[] | undefined;
    if (league.format === "survivor") {
      const priorWeeks = Array.from({ length: Math.max(0, week - 1) }, (_, i) => i + 1);
      const teamsByWeek = await Promise.all(priorWeeks.map(async (w) => {
        const priorWeekEntry = schedule?.weeks?.find((x: any) => x.week === w);
        if (!priorWeekEntry) return null;
        const priorPicksByGid: Record<string, any> = {};
        await Promise.all((priorWeekEntry.games || []).map(async (g: any) => {
          const gid = makeGameId(league.season, w, g.away, g.home);
          const p = await leagueStore.get(`picks:${leagueId}:${w}:${userId}:${gid}`, { type: "json" });
          if (p) priorPicksByGid[gid] = p;
        }));
        // Same "most recent wins" guard as above, for the same reason.
        const gids = Object.keys(priorPicksByGid);
        const latestGid = gids.length > 1
          ? gids.reduce((a, b) => priorPicksByGid[a].updatedAt >= priorPicksByGid[b].updatedAt ? a : b)
          : gids[0];
        return (latestGid && priorPicksByGid[latestGid]?.team) || null;
      }));
      usedTeams = [...new Set(teamsByWeek.filter((t): t is string => !!t))];
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

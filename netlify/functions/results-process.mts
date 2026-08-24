import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { makeGameId } from "./lib/gameId.mts";

// Processes one week's final NFL results across every pick'em league, using
// the same scoring engine (js/scoringEngine.js) the frontend does. Follows
// the same secret-header write-endpoint pattern as odds-update.mts /
// hotpicks-update.mts / site-data-update.mts: an external scheduled script
// (GitHub Actions, triggered by cron-job.org - see repo memory on why
// native `schedule:` triggers are avoided) fetches final scores from ESPN
// and POSTs the distilled winner/tie per game here. This function itself
// then does the league-specific work (matching against picks, scoring,
// updating standings) because that needs Blobs access to picks/leagues
// data the external script doesn't have.
//
// POST /.netlify/functions/results-process
// Header: x-results-process-secret
// Body: {
//   season: number,             // defaults to CURRENT_SEASON if omitted
//   week: number,
//   results: {
//     "AWAY-HOME": {
//       winner: "AWAY"|"HOME"|"TIE",   // team abbrevs, or "TIE"
//       homeScore?: number, awayScore?: number  // needed to grade ats leagues;
//                                                // omit and ats picks for this
//                                                // game stay ungraded (voided:0,
//                                                // correct:null) until a later
//                                                // run supplies them
//     }
//   }
// }
//
// IDEMPOTENCY: each run fully overwrites results:{leagueId}:{week} and
// standings:{leagueId}.weeks[week] rather than incrementing anything, then
// recomputes the season total by summing all stored weeks. Running this
// twice with the same input produces exactly the same output - no
// double-awarded points.

const LEAGUE_STORE = "blitz-leagues";
const CURRENT_SEASON = 2026;

// scoringEngine.js is a UMD module (module.exports for Node / window global
// for the browser) - importing it directly here keeps this function on the
// exact same scoring logic as the frontend, per the "one scoring engine"
// requirement rather than a re-implementation.
// @ts-ignore - plain JS UMD module, no type declarations
import ScoringEngine from "../../js/scoringEngine.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

interface RawResult {
  winner: string; // team abbrev, or "TIE"
  homeScore?: number;
  awayScore?: number;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const expectedSecret = process.env.RESULTS_PROCESS_SECRET;
  if (!expectedSecret) return jsonResponse(500, { ok: false, error: "RESULTS_PROCESS_SECRET not configured on this site" });

  const providedSecret = req.headers.get("x-results-process-secret");
  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-results-process-secret header" });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const season = typeof body.season === "number" ? body.season : CURRENT_SEASON;
  const week = Number(body.week);
  const rawResults: Record<string, RawResult> = body.results;
  if (!week || !rawResults || typeof rawResults !== "object") {
    return jsonResponse(400, { ok: false, error: "week and results are required" });
  }

  const leagueStore = getStore(LEAGUE_STORE);

  // Build { gameId: { winner, tie, final, home, away, homeScore?, awayScore? } }
  // once - shared across every league. home/away/scores are only used by ats
  // grading (see scoreAtsPick in scoringEngine.js); other formats ignore them.
  const weekResults: Record<string, {
    winner: string | null; tie: boolean; final: boolean;
    home: string; away: string; homeScore?: number; awayScore?: number;
  }> = {};
  for (const [awayHome, r] of Object.entries(rawResults)) {
    const [away, home] = awayHome.split("-");
    if (!away || !home) continue;
    const gameId = makeGameId(season, week, away, home);
    const isTie = r.winner === "TIE";
    weekResults[gameId] = {
      winner: isTie ? null : r.winner,
      tie: isTie,
      final: true,
      home,
      away,
      ...(typeof r.homeScore === "number" ? { homeScore: r.homeScore } : {}),
      ...(typeof r.awayScore === "number" ? { awayScore: r.awayScore } : {}),
    };
  }

  const processedLeagues: string[] = [];
  const errors: Array<{ leagueId: string; error: string }> = [];

  try {
    for await (const page of leagueStore.list({ prefix: "league:", paginate: true })) {
      for (const b of page.blobs) {
        const leagueId = b.key.slice("league:".length);
        try {
          await processLeague(leagueStore, leagueId, season, week, weekResults);
          processedLeagues.push(leagueId);
        } catch (err) {
          errors.push({ leagueId, error: err instanceof Error ? err.message : "Unknown error" });
        }
      }
    }

    return jsonResponse(200, { ok: true, season, week, processedLeagues, errors });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

async function processLeague(
  leagueStore: ReturnType<typeof getStore>,
  leagueId: string,
  season: number,
  week: number,
  weekResults: Record<string, { winner: string | null; tie: boolean; final: boolean }>
) {
  const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
  if (!league || league.season !== season) return; // different season, or league vanished mid-scan

  const weekPicksDoc: any = (await leagueStore.get(`picks:${leagueId}:${week}`, { type: "json" })) || {};

  // 1. Score every member's week.
  const weekScores = ScoringEngine.scoreWeek(league.format, league.scoringSettings, weekPicksDoc, weekResults);

  await leagueStore.setJSON(`results:${leagueId}:${week}`, {
    week,
    results: weekResults,
    scores: weekScores,
    processedAt: new Date().toISOString(),
  });

  // 2. Update standings: overwrite this week's slice, then recompute season
  //    totals by summing every stored week (not incrementing) - this is
  //    what makes reruns idempotent.
  const standingsDoc: any = (await leagueStore.get(`standings:${leagueId}`, { type: "json" })) || { weeks: {} };
  standingsDoc.weeks[week] = weekScores;

  const seasonTotals: Record<string, { points: number; correct: number; incorrect: number }> = {};
  for (const wk of Object.keys(standingsDoc.weeks)) {
    const wkScores = standingsDoc.weeks[wk];
    for (const userId of Object.keys(wkScores)) {
      const t = seasonTotals[userId] || (seasonTotals[userId] = { points: 0, correct: 0, incorrect: 0 });
      t.points += wkScores[userId].points;
      t.correct += wkScores[userId].correct;
      t.incorrect += wkScores[userId].incorrect;
    }
  }
  standingsDoc.season = ScoringEngine.rankStandings(seasonTotals, league.tieBreaker);
  standingsDoc.updatedAt = new Date().toISOString();
  await leagueStore.setJSON(`standings:${leagueId}`, standingsDoc);

  // 3. Survivor: advance alive/eliminated state.
  if (league.format === "survivor") {
    const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
    let survivorState: any = (await leagueStore.get(`survivor:${leagueId}`, { type: "json" })) || {};
    // Initialize any member not yet tracked (new joiners, or first week processed).
    for (const m of membersDoc?.members || []) {
      if (!survivorState[m.userId]) {
        survivorState[m.userId] = { alive: true, usedTeams: [], eliminatedWeek: null };
      }
    }
    survivorState = ScoringEngine.applySurvivorWeek(
      survivorState,
      weekPicksDoc,
      weekResults,
      week,
      league.scoringSettings?.survivorTieHandling
    );
    await leagueStore.setJSON(`survivor:${leagueId}`, survivorState);
  }
}

export const config: Config = {
  path: "/.netlify/functions/results-process",
};

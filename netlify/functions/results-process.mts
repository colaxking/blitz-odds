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
const SITE_DATA_STORE = "blitz-site-data";
const PREDICTION_STORE = "blitz-predictions";
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
  const siteDataStore = getStore(SITE_DATA_STORE);

  // Picks are keyed per game per member per week (see picks-submit.mts) and
  // there's no reliable way to enumerate "every game a member picked" other
  // than checking every game that existed that week - live testing showed
  // list()'s index isn't a safe source of truth for freshly-written keys,
  // so this fetches the schedule once and every league's picks get read by
  // direct key from it instead.
  const schedule: any = await siteDataStore.get("schedule", { type: "json" });
  const weekEntry = schedule?.weeks?.find((w: any) => w.week === week);
  const weekGames: Array<{ away: string; home: string }> = weekEntry?.games || [];

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

  // The model's call on each game, frozen at that game's kickoff by
  // scripts/prediction-snapshot.mjs. Read once and shared across every
  // league, the same way weekResults is. Absent entries are normal - any
  // week that ran before the snapshot job existed simply has no predictions,
  // and follow rate is skipped for it rather than guessed at.
  const predictionStore = getStore(PREDICTION_STORE, { consistency: "strong" });
  const weekPredictions: Record<string, { predictedWinner: string }> = {};
  await Promise.all(
    weekGames.map(async (g) => {
      const gameId = makeGameId(season, week, g.away, g.home);
      try {
        const p: any = await predictionStore.get(`pred:${season}:${week}:${gameId}`, { type: "json" });
        if (p && p.predictedWinner) weekPredictions[gameId] = { predictedWinner: p.predictedWinner };
      } catch {
        // A missing or unreadable snapshot just means no follow-rate credit
        // for that game; it must never fail the scoring run.
      }
    })
  );

  const processedLeagues: string[] = [];
  const errors: Array<{ leagueId: string; error: string }> = [];

  try {
    for await (const page of leagueStore.list({ prefix: "league:", paginate: true })) {
      for (const b of page.blobs) {
        const leagueId = b.key.slice("league:".length);
        try {
          await processLeague(leagueStore, leagueId, season, week, weekGames, weekResults, weekPredictions);
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
  weekGames: Array<{ away: string; home: string }>,
  weekResults: Record<string, { winner: string | null; tie: boolean; final: boolean }>,
  weekPredictions: Record<string, { predictedWinner: string }>
) {
  const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
  if (!league || league.season !== season) return; // different season, or league vanished mid-scan

  // Picks live one key per game per member per week
  // (picks:{leagueId}:{week}:{userId}:{gameId} - see picks-submit.mts for
  // why). Reassembling { [userId]: { [gameId]: pick } } means, for every
  // current member, a direct get() on every game that existed this week
  // (derived from the schedule, not list()) and keeping whichever ones
  // actually have a pick stored.
  const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
  const memberIds: string[] = (membersDoc?.members || []).map((m: any) => m.userId);

  const weekPicksDoc: Record<string, any> = {};
  await Promise.all(memberIds.map(async (userId) => {
    const userPicks: Record<string, any> = {};
    await Promise.all(weekGames.map(async (g) => {
      const gid = makeGameId(season, week, g.away, g.home);
      const pick = await leagueStore.get(`picks:${leagueId}:${week}:${userId}:${gid}`, { type: "json" });
      if (pick) userPicks[gid] = pick;
    }));
    if (Object.keys(userPicks).length > 0) weekPicksDoc[userId] = userPicks;
  }));

  // 1. Score every member's week.
  const weekScores = ScoringEngine.scoreWeek(league.format, league.scoringSettings, weekPicksDoc, weekResults);

  // 1b. Blitz follow rate: of the picks a member made on games where the
  // model's call was frozen, how many matched it. Graded here rather than in
  // home-summary because every pick is already in memory at this point -
  // computing it anywhere else would mean re-reading all of them.
  //
  // ATS is deliberately excluded. The model produces a straight-up winner,
  // not a cover lean, and in an against-the-spread league the favoured team
  // failing to cover is the normal case - so "you picked who the model
  // liked" would answer a question nobody asked and read as agreement with
  // a pick the model never made. prediction-snapshot.mjs freezes each game's
  // odds alongside the prediction, so a real cover comparison can be added
  // later without a gap in the historical record.
  const followGraded = league.format !== "ats";
  for (const userId of Object.keys(weekScores)) {
    let followed = 0;
    let followable = 0;
    if (followGraded) {
      const userPicks = weekPicksDoc[userId] || {};
      for (const gameId of Object.keys(userPicks)) {
        const predicted = weekPredictions[gameId];
        // Only games with both a pick and a frozen prediction count toward
        // the denominator - an unpicked game or an unsnapshotted one is
        // absent from the measure entirely, not a miss.
        if (!predicted) continue;
        followable++;
        if (userPicks[gameId]?.team === predicted.predictedWinner) followed++;
      }
    }
    weekScores[userId].followed = followed;
    weekScores[userId].followable = followable;
  }

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

  const seasonTotals: Record<string, { points: number; correct: number; incorrect: number; followed: number; followable: number }> = {};
  for (const wk of Object.keys(standingsDoc.weeks)) {
    const wkScores = standingsDoc.weeks[wk];
    for (const userId of Object.keys(wkScores)) {
      const t = seasonTotals[userId] || (seasonTotals[userId] = { points: 0, correct: 0, incorrect: 0, followed: 0, followable: 0 });
      t.points += wkScores[userId].points;
      t.correct += wkScores[userId].correct;
      t.incorrect += wkScores[userId].incorrect;
      // Older stored weeks predate follow grading and have neither field.
      t.followed += wkScores[userId].followed || 0;
      t.followable += wkScores[userId].followable || 0;
    }
  }
  standingsDoc.season = ScoringEngine.rankStandings(seasonTotals, league.tieBreaker);
  standingsDoc.updatedAt = new Date().toISOString();
  await leagueStore.setJSON(`standings:${leagueId}`, standingsDoc);

  // 3. Survivor: advance alive/eliminated state.
  if (league.format === "survivor") {
    let survivorState: any = (await leagueStore.get(`survivor:${leagueId}`, { type: "json" })) || {};
    // Initialize any member not yet tracked (new joiners, or first week processed).
    for (const m of membersDoc?.members || []) {
      if (!survivorState[m.userId]) {
        survivorState[m.userId] = { alive: true, usedTeams: [], eliminatedWeek: null, strikes: 0 };
      }
    }
    survivorState = ScoringEngine.applySurvivorWeek(
      survivorState,
      weekPicksDoc,
      weekResults,
      week,
      league.scoringSettings?.survivorTieHandling,
      league.scoringSettings?.survivorStrikes
    );
    await leagueStore.setJSON(`survivor:${leagueId}`, survivorState);
  }
}

export const config: Config = {
  path: "/.netlify/functions/results-process",
};

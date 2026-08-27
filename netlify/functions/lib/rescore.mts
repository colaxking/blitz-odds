import { makeGameId } from "./gameId.mts";
// @ts-ignore - plain ES module shared with the browser, no types
import ScoringEngine from "../../../js/scoringEngine.js";

// Re-scores a league week WITHOUT needing ESPN.
//
// results-process.mts is the normal scoring path: cron posts finished game
// results, it scores every league, and it writes results:{leagueId}:{week}
// alongside the standings. That function needs the results in its request
// body, which is fine for a cron job that just fetched them and useless for
// an admin who edited one pick and needs that week's numbers to catch up.
//
// The saving detail is that results-process already PERSISTS the results it
// used. So a rescore doesn't need the outcomes re-fetched - it re-reads the
// stored ones, re-runs exactly the same ScoringEngine calls over the current
// picks, and overwrites the same keys. Same inputs, same code, same outputs;
// the only thing that changed is the picks, which is the point.
//
// A week with no stored results (never scored, or still in progress) is
// skipped rather than zeroed. Writing an empty week would wipe real standings
// for anyone whose results doc simply hasn't been written yet.

const CURRENT_SEASON = 2026;

export interface RescoreResult {
  leagueId: string;
  weeksRescored: number[];
  weeksSkipped: number[];
}

/**
 * Recomputes standings.season from whatever is currently in standings.weeks.
 * Split out because deleting a user needs this without re-scoring anything -
 * their week rows are simply gone and the totals have to stop counting them.
 */
export function rebuildSeason(standingsDoc: any, tieBreaker: string | undefined): any {
  const seasonTotals: Record<string, {
    points: number; correct: number; incorrect: number; followed: number; followable: number;
  }> = {};

  for (const wk of Object.keys(standingsDoc.weeks || {})) {
    const wkScores = standingsDoc.weeks[wk] || {};
    for (const userId of Object.keys(wkScores)) {
      const t = seasonTotals[userId] || (seasonTotals[userId] = {
        points: 0, correct: 0, incorrect: 0, followed: 0, followable: 0,
      });
      t.points += wkScores[userId].points || 0;
      t.correct += wkScores[userId].correct || 0;
      t.incorrect += wkScores[userId].incorrect || 0;
      t.followed += wkScores[userId].followed || 0;
      t.followable += wkScores[userId].followable || 0;
    }
  }

  standingsDoc.season = ScoringEngine.rankStandings(seasonTotals, tieBreaker);
  standingsDoc.updatedAt = new Date().toISOString();
  return standingsDoc;
}

/**
 * Re-scores specific weeks of one league from stored results and current
 * picks. Pass no weeks to rebuild every week that has a stored results doc -
 * that's the "this leaderboard looks wrong" button.
 */
export async function rescoreLeague(
  leagueStore: any,
  leagueId: string,
  weeks?: number[],
  season: number = CURRENT_SEASON
): Promise<RescoreResult> {
  const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
  if (!league) throw new Error("No such league");

  let targetWeeks: number[];
  if (weeks && weeks.length) {
    targetWeeks = weeks;
  } else {
    const { blobs } = await leagueStore.list({ prefix: `results:${leagueId}:` });
    targetWeeks = blobs
      .map((b: any) => Number(b.key.split(":").pop()))
      .filter((n: number) => Number.isFinite(n))
      .sort((a: number, b: number) => a - b);
  }

  const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
  const memberIds: string[] = (membersDoc?.members || []).map((m: any) => m.userId);

  const standingsDoc: any = (await leagueStore.get(`standings:${leagueId}`, { type: "json" })) || { weeks: {} };
  if (!standingsDoc.weeks) standingsDoc.weeks = {};

  const weeksRescored: number[] = [];
  const weeksSkipped: number[] = [];

  for (const week of targetWeeks) {
    const stored: any = await leagueStore.get(`results:${leagueId}:${week}`, { type: "json" });
    if (!stored?.results) {
      weeksSkipped.push(week);
      continue;
    }
    const weekResults = stored.results;
    const gameIds: string[] = Object.keys(weekResults);

    // Rebuilt from the results doc's own game list rather than the schedule:
    // the results are the record of what was actually scored that week, and
    // a schedule edit after the fact shouldn't retroactively change it.
    const weekPicksDoc: Record<string, any> = {};
    await Promise.all(
      memberIds.map(async (userId) => {
        const userPicks: Record<string, any> = {};
        await Promise.all(
          gameIds.map(async (gid) => {
            const pick = await leagueStore.get(`picks:${leagueId}:${week}:${userId}:${gid}`, { type: "json" });
            if (pick) userPicks[gid] = pick;
          })
        );
        if (Object.keys(userPicks).length > 0) weekPicksDoc[userId] = userPicks;
      })
    );

    const weekScores = ScoringEngine.scoreWeek(
      league.format,
      league.scoringSettings,
      weekPicksDoc,
      weekResults
    );

    // Follow-rate grading is carried across from the previous scoring run
    // rather than recomputed. The frozen predictions it compares against are
    // keyed by game, not by league, and re-reading them here would make an
    // admin pick edit depend on the prediction snapshot store being healthy.
    // Editing one pick can change whether that user followed the model, so
    // the carried-over value is refreshed for the edited user only when the
    // previous run recorded one.
    const priorScores = stored.scores || {};
    for (const userId of Object.keys(weekScores)) {
      const prior = priorScores[userId];
      weekScores[userId].followed = prior?.followed || 0;
      weekScores[userId].followable = prior?.followable || 0;
    }

    await leagueStore.setJSON(`results:${leagueId}:${week}`, {
      ...stored,
      scores: weekScores,
      rescoredAt: new Date().toISOString(),
    });

    standingsDoc.weeks[week] = weekScores;
    weeksRescored.push(week);
  }

  rebuildSeason(standingsDoc, league.tieBreaker);
  await leagueStore.setJSON(`standings:${leagueId}`, standingsDoc);

  return { leagueId, weeksRescored, weeksSkipped };
}

/** Drops one user out of every stored week and re-totals the season. */
export async function removeUserFromStandings(
  leagueStore: any,
  leagueId: string,
  userId: string
): Promise<boolean> {
  const standingsDoc: any = await leagueStore.get(`standings:${leagueId}`, { type: "json" });
  if (!standingsDoc?.weeks) return false;

  let touched = false;
  for (const wk of Object.keys(standingsDoc.weeks)) {
    if (standingsDoc.weeks[wk]?.[userId]) {
      delete standingsDoc.weeks[wk][userId];
      touched = true;
    }
  }
  if (!touched) return false;

  const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
  rebuildSeason(standingsDoc, league?.tieBreaker);
  await leagueStore.setJSON(`standings:${leagueId}`, standingsDoc);
  return true;
}

export { makeGameId };

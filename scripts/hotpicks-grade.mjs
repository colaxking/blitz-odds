#!/usr/bin/env node
/**
 * Blitz Odds - Hot Picks weekly grading (no Claude in the loop).
 *
 * For every frozen Hot Picks snapshot (see hotpicks-snapshot.mjs) that
 * isn't graded yet, checks whether every game referenced by that week's
 * picks is final on ESPN. If so, grades each pick (confidence x3, spread,
 * moneyline, total) against the actual result and the exact odds that were
 * frozen at snapshot time - never a re-fetched, possibly-moved line. Weeks
 * that aren't fully final yet are simply skipped and retried on the next
 * run.
 *
 * The season aggregate is always rebuilt from scratch from every graded
 * week rather than incremented in place, so re-running this script (e.g.
 * after a stat correction) can never double-count a result.
 *
 * Required env vars:
 *   HOTPICKS_UPDATE_SECRET - shared secret for hotpicks-update
 * Optional env vars:
 *   SITE_BASE  - defaults to https://blitz-odds.netlify.app
 *   REPO_ROOT  - defaults to CWD; where data/*.json live
 *   SEASON     - defaults to 2026
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.netlify.app";
const HOTPICKS_UPDATE_SECRET = process.env.HOTPICKS_UPDATE_SECRET;
const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const SEASON = parseInt(process.env.SEASON || "2026", 10);

// Same ESPN quirks as scripts/history-results-refresh.mjs: browser-style
// User-Agents get 403'd from server IPs, and ESPN's abbreviations need a
// couple of fixups to match ours.
const ESPN_FETCH_HEADERS = { "User-Agent": "curl/8.4.0" };
const ESPN_ABBR_FIX = { WSH: "WAS", LA: "LAR" };

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function writeJson(relPath, data) {
  const full = path.join(REPO_ROOT, relPath);
  await writeFile(full, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function fixAbbr(a) {
  return ESPN_ABBR_FIX[a] || a;
}

/** Every game's final score and state for a regular-season week, keyed by
 *  "away-home". Games not yet final are simply absent, not null - callers
 *  check for presence to decide "fully graded yet?". */
async function fetchWeekResults(week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${SEASON}&seasontype=2&week=${week}`;
  const res = await fetch(url, { headers: ESPN_FETCH_HEADERS });
  if (!res.ok) throw new Error(`ESPN scoreboard request failed (week=${week}): ${res.status}`);
  const data = await res.json();
  const results = {};
  for (const event of data.events || []) {
    const comp = event.competitions && event.competitions[0];
    if (!comp) continue;
    const state = comp.status && comp.status.type && comp.status.type.state;
    if (state !== "post") continue;
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const homeAbbr = fixAbbr(home.team.abbreviation);
    const awayAbbr = fixAbbr(away.team.abbreviation);
    results[`${awayAbbr}-${homeAbbr}`] = { awayScore: Number(away.score), homeScore: Number(home.score) };
  }
  return results;
}

/** Mirrors getSpreadCoverage() in index.html: does pickTeamId cover the
 *  frozen spread? spread is stored relative to `favorite` (negative).
 *  Returns "win" | "loss" | "push". */
function gradeSpreadPick(pickTeamId, odds, homeId, awayScore, homeScore) {
  if (!odds || odds.spread == null || !odds.favorite) return null;
  const teamScore = pickTeamId === homeId ? homeScore : awayScore;
  const oppScore = pickTeamId === homeId ? awayScore : homeScore;
  const teamSpread = odds.favorite === pickTeamId ? odds.spread : -odds.spread;
  const adjusted = teamScore + teamSpread;
  if (adjusted === oppScore) return "push";
  return adjusted > oppScore ? "win" : "loss";
}

function gradeTotalPick(lean, overUnder, awayScore, homeScore) {
  if (overUnder == null) return null;
  const total = awayScore + homeScore;
  if (total === overUnder) return "push";
  if (lean === "over") return total > overUnder ? "win" : "loss";
  return total < overUnder ? "win" : "loss";
}

function tallyInto(bucket, outcome) {
  if (outcome === "win") bucket.wins += 1;
  else if (outcome === "loss") bucket.losses += 1;
  else if (outcome === "push" && "pushes" in bucket) bucket.pushes += 1;
}

async function main() {
  if (!HOTPICKS_UPDATE_SECRET) {
    throw new Error("HOTPICKS_UPDATE_SECRET is required");
  }

  const [snapshotsRes, gradesRes] = await Promise.all([
    fetch(`${SITE_BASE}/.netlify/functions/hotpicks-current?type=snapshots`),
    fetch(`${SITE_BASE}/.netlify/functions/hotpicks-current?type=grades`),
  ]);
  if (!snapshotsRes.ok) throw new Error(`hotpicks-current?type=snapshots failed: ${snapshotsRes.status}`);
  const snapshotsDoc = await snapshotsRes.json();
  const gradesDoc = gradesRes.ok ? await gradesRes.json() : { weeks: {} };
  const snapshots = (snapshotsDoc && snapshotsDoc.weeks) || {};
  const grades = gradesDoc && typeof gradesDoc.weeks === "object" ? gradesDoc : { weeks: {} };

  const weekNumbers = Object.keys(snapshots).map((w) => parseInt(w, 10)).sort((a, b) => a - b);
  if (!weekNumbers.length) {
    log("No snapshots to grade yet.");
    return;
  }

  let anyGraded = false;

  for (const week of weekNumbers) {
    const snap = snapshots[String(week)];
    const gradingContext = snap.gradingContext || {};
    const matchupKeys = Object.keys(gradingContext);
    if (!matchupKeys.length) continue;

    let weekResults;
    try {
      weekResults = await fetchWeekResults(week);
    } catch (err) {
      log(`WARN: skipping week ${week} - ${err.message}`);
      continue;
    }

    const allFinal = matchupKeys.every((k) => weekResults[k]);
    if (!allFinal) {
      log(`Week ${week}: not every referenced game is final yet - skipping until next run.`);
      continue;
    }

    const picks = snap.picks || {};
    const gradedPicks = { confidencePicks: [], spreadPick: null, moneylinePick: null, totalPick: null };

    (picks.topConfidence || []).forEach((p) => {
      const key = `${p.game.awayId}-${p.game.homeId}`;
      const r = weekResults[key];
      const outcome = r.homeScore === r.awayScore ? "push" : (p.pickTeamId === (r.homeScore > r.awayScore ? p.game.homeId : p.game.awayId) ? "win" : "loss");
      gradedPicks.confidencePicks.push({ ...p, result: outcome, finalScore: r });
    });

    if (picks.spreadPick) {
      const p = picks.spreadPick;
      const key = `${p.game.awayId}-${p.game.homeId}`;
      const r = weekResults[key];
      const odds = gradingContext[key];
      const outcome = gradeSpreadPick(p.pickTeamId, odds, p.game.homeId, r.awayScore, r.homeScore);
      gradedPicks.spreadPick = { ...p, result: outcome, finalScore: r };
    }

    if (picks.moneylinePick) {
      const p = picks.moneylinePick;
      const key = `${p.game.awayId}-${p.game.homeId}`;
      const r = weekResults[key];
      const winnerId = r.homeScore === r.awayScore ? null : (r.homeScore > r.awayScore ? p.game.homeId : p.game.awayId);
      const outcome = winnerId == null ? "push" : (p.pickTeamId === winnerId ? "win" : "loss");
      gradedPicks.moneylinePick = { ...p, result: outcome, finalScore: r };
    }

    if (picks.totalPick) {
      const p = picks.totalPick;
      const key = `${p.game.awayId}-${p.game.homeId}`;
      const r = weekResults[key];
      const odds = gradingContext[key];
      const outcome = gradeTotalPick(p.lean, odds ? odds.overUnder : null, r.awayScore, r.homeScore);
      gradedPicks.totalPick = { ...p, result: outcome, finalScore: r };
    }

    grades.weeks[String(week)] = {
      week,
      season: snap.season || SEASON,
      gradedAt: new Date().toISOString(),
      ...gradedPicks,
    };
    anyGraded = true;
    log(`Week ${week}: graded.`);
  }

  if (!anyGraded) {
    log("Nothing newly gradeable this run.");
    return;
  }

  // Rebuild the aggregate from scratch every time - never increment in
  // place, so a re-run after a correction can't double-count anything.
  const aggregate = {
    season: SEASON,
    updatedAt: new Date().toISOString(),
    confidencePicks: { wins: 0, losses: 0 },
    spreadPicks: { wins: 0, losses: 0, pushes: 0 },
    moneylinePicks: { wins: 0, losses: 0 },
    totalPicks: { wins: 0, losses: 0, pushes: 0 },
    byWeek: [],
  };

  const gradedWeekNumbers = Object.keys(grades.weeks).map((w) => parseInt(w, 10)).sort((a, b) => a - b);
  for (const week of gradedWeekNumbers) {
    const g = grades.weeks[String(week)];
    const weekTally = {
      week,
      confidencePicks: { wins: 0, losses: 0 },
      spreadPick: g.spreadPick ? g.spreadPick.result : null,
      moneylinePick: g.moneylinePick ? g.moneylinePick.result : null,
      totalPick: g.totalPick ? g.totalPick.result : null,
    };
    (g.confidencePicks || []).forEach((p) => {
      tallyInto(aggregate.confidencePicks, p.result);
      tallyInto(weekTally.confidencePicks, p.result);
    });
    if (g.spreadPick) tallyInto(aggregate.spreadPicks, g.spreadPick.result);
    if (g.moneylinePick) tallyInto(aggregate.moneylinePicks, g.moneylinePick.result);
    if (g.totalPick) tallyInto(aggregate.totalPicks, g.totalPick.result);
    aggregate.byWeek.push(weekTally);
  }

  const publishRes = await fetch(`${SITE_BASE}/.netlify/functions/hotpicks-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hotpicks-update-secret": HOTPICKS_UPDATE_SECRET },
    body: JSON.stringify({ grades, aggregate }),
  });
  if (!publishRes.ok) {
    throw new Error(`hotpicks-update publish failed: ${publishRes.status} ${await publishRes.text().catch(() => "")}`);
  }
  log(`Published updated grades + aggregate (${gradedWeekNumbers.length} graded week(s)).`);

  await writeJson("data/hotpicks-track-record.json", { grades, aggregate });
  log("wrote on-disk mirror (data/hotpicks-track-record.json).");
}

main().catch((err) => {
  console.error("hotpicks-grade failed:", err);
  process.exit(1);
});

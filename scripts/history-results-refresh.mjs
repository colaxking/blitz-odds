#!/usr/bin/env node
/**
 * Blitz Odds - automated historical results refresh (no Claude in the loop).
 *
 * IMPORTANT SCOPE NOTE: this script only automates the `results` field of
 * each weekly history snapshot (final scores, pulled mechanically from
 * ESPN). It deliberately does NOT touch `teamStats` (offense/defense ranks)
 * or `impactPlayers` (injury report) for weeks that don't already have a
 * snapshot entry - those two fields require real research/judgment (stat
 * lookups + written injury notes), the same reason odds-refresh.mjs's
 * header explains team stats/injuries were never folded into that script
 * either. This script's job is narrower and fully deterministic: for any
 * week that ALREADY has a history snapshot entry (teamStats/impactPlayers
 * already captured, presumably by hand or a future task), keep its
 * `results` field current as games go final. It will not fabricate a new
 * week entry from nothing.
 *
 * What it does, in order:
 *   1. Fetch the current published history doc (site-data-current?type=history).
 *   2. For every week that already has a snapshot entry, resolve that
 *      week's ESPN seasontype/week params (mirrors getEspnParams() in
 *      index.html) and pull that week's ESPN scoreboard.
 *   3. Build a results map of final scores for that week and diff it
 *      against what's already stored.
 *   4. If anything changed, POST the full updated history doc back to
 *      site-data-update and write the on-disk mirror (data/history.json)
 *      for the workflow to commit.
 *
 * Required env vars:
 *   SITE_DATA_UPDATE_SECRET - shared secret for site-data-update
 * Optional env vars:
 *   SITE_BASE   - defaults to https://blitz-odds.netlify.app
 *   REPO_ROOT   - defaults to CWD; where data/*.json live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.netlify.app";
const SITE_DATA_UPDATE_SECRET = process.env.SITE_DATA_UPDATE_SECRET;
const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const SEASON = 2026;

const ESPN_ABBR_FIX = {
  WSH: "WAS", // ESPN uses WSH; our data uses WAS
  LA: "LAR",  // ESPN occasionally returns bare "LA" for the Rams
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function readJson(relPath) {
  const full = path.join(REPO_ROOT, relPath);
  return JSON.parse(await readFile(full, "utf8"));
}

async function writeJson(relPath, data) {
  const full = path.join(REPO_ROOT, relPath);
  await writeFile(full, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function fixAbbr(a) {
  return ESPN_ABBR_FIX[a] || a;
}

// Mirrors getEspnParams(week) in index.html - keep these two in sync if the
// preseason/playoff round data shape ever changes.
function buildEspnParamsResolver(preseasonData, playoffsData) {
  const preseasonRounds = (preseasonData && preseasonData.rounds) || [];
  const playoffRounds = (playoffsData && playoffsData.rounds) || [];
  return function getEspnParams(week) {
    if (week < 1) {
      const round = preseasonRounds.find((r) => r.week === week);
      return round ? { seasontype: round.espnSeasonType, week: round.espnWeek } : null;
    }
    if (week <= 18) return { seasontype: 2, week };
    const round = playoffRounds.find((r) => r.week === week);
    return round ? { seasontype: round.espnSeasonType, week: round.espnWeek } : null;
  };
}

// ESPN's edge blocks requests carrying a browser-style User-Agent from
// server IPs (returns 403) but allows curl-style ones through - confirmed
// by direct testing, not documented anywhere. Node's fetch (undici) sends
// its own default UA that also gets blocked, so this has to be set
// explicitly on every request to this API from a script/server context.
const ESPN_FETCH_HEADERS = { "User-Agent": "curl/8.4.0" };

async function fetchEspnResults(seasontype, week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${SEASON}&seasontype=${seasontype}&week=${week}`;
  const res = await fetch(url, { headers: ESPN_FETCH_HEADERS });
  if (!res.ok) throw new Error(`ESPN scoreboard request failed (seasontype=${seasontype} week=${week}): ${res.status}`);
  const data = await res.json();
  const results = {};
  for (const event of data.events || []) {
    const comp = event.competitions && event.competitions[0];
    if (!comp) continue;
    const state = comp.status && comp.status.type && comp.status.type.state;
    if (state !== "post") continue; // only care about finished games here
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const homeAbbr = fixAbbr(home.team.abbreviation);
    const awayAbbr = fixAbbr(away.team.abbreviation);
    results[`${awayAbbr}-${homeAbbr}`] = {
      awayScore: Number(away.score),
      homeScore: Number(home.score),
      final: true,
    };
  }
  return results;
}

function resultsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.awayScore === b.awayScore && a.homeScore === b.homeScore && a.final === b.final;
}

async function main() {
  if (!SITE_DATA_UPDATE_SECRET) {
    throw new Error("SITE_DATA_UPDATE_SECRET is required");
  }

  const [preseasonData, playoffsData] = await Promise.all([
    readJson("data/schedule-preseason-2026.json"),
    readJson("data/schedule-playoffs-2026.json"),
  ]);
  const getEspnParams = buildEspnParamsResolver(preseasonData, playoffsData);

  const historyRes = await fetch(`${SITE_BASE}/.netlify/functions/site-data-current?type=history`);
  let history;
  if (historyRes.status === 404) {
    log("no history doc published yet - nothing to refresh results on.");
    return;
  }
  if (!historyRes.ok) {
    throw new Error(`fetching current history failed: ${historyRes.status}`);
  }
  history = await historyRes.json();
  if (!history || !Array.isArray(history.weeks)) {
    throw new Error("published history doc is missing a weeks[] array");
  }

  let changed = false;
  const skipped = [];

  for (const snap of history.weeks) {
    const params = getEspnParams(snap.week);
    if (!params) {
      skipped.push(`week ${snap.week} (no ESPN params - not-yet-announced playoff round?)`);
      continue;
    }
    let freshResults;
    try {
      freshResults = await fetchEspnResults(params.seasontype, params.week);
    } catch (err) {
      log(`WARN: skipping week ${snap.week} - ${err.message}`);
      continue;
    }
    const existing = snap.results || {};
    const merged = { ...existing };
    let weekChanged = false;
    for (const [matchup, result] of Object.entries(freshResults)) {
      if (!resultsEqual(existing[matchup], result)) {
        merged[matchup] = result;
        weekChanged = true;
      }
    }
    if (weekChanged) {
      snap.results = merged;
      changed = true;
      log(`week ${snap.week}: updated ${Object.keys(freshResults).length} final result(s).`);
    }
  }

  if (skipped.length) log(`skipped: ${skipped.join("; ")}`);

  if (!changed) {
    log("nothing changed - no publish, no disk write.");
    return;
  }

  const publishRes = await fetch(`${SITE_BASE}/.netlify/functions/site-data-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-site-data-update-secret": SITE_DATA_UPDATE_SECRET },
    body: JSON.stringify({ history }),
  });
  if (!publishRes.ok) {
    throw new Error(`site-data-update publish failed: ${publishRes.status} ${await publishRes.text().catch(() => "")}`);
  }
  log("published updated history results.");

  await writeJson("data/history.json", history);
  log("wrote on-disk mirror (data/history.json).");
}

main().catch((err) => {
  console.error("history-results-refresh failed:", err);
  process.exit(1);
});

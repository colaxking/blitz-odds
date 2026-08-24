#!/usr/bin/env node
/**
 * Blitz Odds - pick'em league results processing trigger (no Claude in the loop).
 *
 * Fetches ESPN's scoreboard for every regular-season week and POSTs
 * whatever games have gone final to results-process.mts, which does the
 * actual per-league scoring (see netlify/functions/results-process.mts).
 * This script has no knowledge of leagues, picks, or scoring settings - it
 * only distills ESPN's raw scores into { "AWAY-HOME": { winner } } and
 * hands that off.
 *
 * Deliberately scans all 18 regular-season weeks every run rather than
 * trying to compute a "current week" - results-process.mts is idempotent
 * (each run fully overwrites that week's stored slice), so re-posting an
 * already-final week is a harmless no-op, and this way a late correction
 * or a missed run on an earlier week is picked up automatically on the
 * next pass instead of needing a backfill.
 *
 * Required env vars:
 *   RESULTS_PROCESS_SECRET - shared secret for results-process
 * Optional env vars:
 *   SITE_BASE - defaults to https://blitz-odds.com
 *   SEASON    - defaults to 2026
 */

const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.com";
const RESULTS_PROCESS_SECRET = process.env.RESULTS_PROCESS_SECRET;
const SEASON = parseInt(process.env.SEASON || "2026", 10);
const REGULAR_SEASON_WEEKS = 18;

// Same ESPN quirks as scripts/history-results-refresh.mjs and
// scripts/hotpicks-grade.mjs: browser-style User-Agents get 403'd from
// server IPs, and ESPN's abbreviations need a couple of fixups to match ours.
const ESPN_FETCH_HEADERS = { "User-Agent": "curl/8.4.0" };
const ESPN_ABBR_FIX = { WSH: "WAS", LA: "LAR" };

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function fixAbbr(a) {
  return ESPN_ABBR_FIX[a] || a;
}

// Same rationale as hotpicks-grade.mjs: retry transient network blips
// between the GitHub Actions runner and either ESPN or Netlify's edge,
// instead of failing the whole (idempotent, cheap-to-rerun) job over one
// bad connection.
async function fetchWithRetry(url, options, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      log(`fetch failed (attempt ${i}/${attempts}) for ${url}: ${err.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw lastErr;
}

/** Every finished game's winner for a regular-season week, keyed by
 *  "away-home" (matching odds-2026.json's existing key convention, and
 *  what results-process.mts expects). Games not yet final are simply
 *  absent from the returned object. */
async function fetchWeekWinners(week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${SEASON}&seasontype=2&week=${week}`;
  const res = await fetchWithRetry(url, { headers: ESPN_FETCH_HEADERS });
  if (!res.ok) throw new Error(`ESPN scoreboard request failed (week=${week}): ${res.status}`);
  const data = await res.json();
  const results = {};
  for (const event of data.events || []) {
    const comp = event.competitions && event.competitions[0];
    if (!comp) continue;
    const state = comp.status && comp.status.type && comp.status.type.state;
    if (state !== "post") continue; // only fully final games count

    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;

    const homeAbbr = fixAbbr(home.team.abbreviation);
    const awayAbbr = fixAbbr(away.team.abbreviation);
    const homeScore = Number(home.score);
    const awayScore = Number(away.score);

    let winner;
    if (homeScore === awayScore) winner = "TIE";
    else winner = homeScore > awayScore ? homeAbbr : awayAbbr;

    // homeScore/awayScore are included alongside winner so results-process
    // can grade ats (against-the-spread) leagues - straight_up/confidence/
    // survivor leagues only ever use winner and ignore these.
    results[`${awayAbbr}-${homeAbbr}`] = { winner, homeScore, awayScore };
  }
  return results;
}

async function processWeek(week) {
  const results = await fetchWeekWinners(week);
  const gameCount = Object.keys(results).length;
  if (gameCount === 0) {
    log(`week ${week}: no final games yet, skipping`);
    return;
  }

  log(`week ${week}: ${gameCount} final game(s), posting to results-process`);
  const res = await fetchWithRetry(`${SITE_BASE}/.netlify/functions/results-process`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-results-process-secret": RESULTS_PROCESS_SECRET,
    },
    body: JSON.stringify({ season: SEASON, week, results }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`week ${week}: results-process failed (${res.status}): ${body.error || "unknown error"}`);
  }

  log(`week ${week}: processed ${body.processedLeagues?.length ?? 0} league(s)` +
    (body.errors?.length ? `, ${body.errors.length} error(s): ${JSON.stringify(body.errors)}` : ""));
}

async function main() {
  if (!RESULTS_PROCESS_SECRET) {
    throw new Error("RESULTS_PROCESS_SECRET is required");
  }

  const failures = [];
  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
    try {
      await processWeek(week);
    } catch (err) {
      log(`week ${week}: ERROR - ${err.message}`);
      failures.push({ week, error: err.message });
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} week(s) failed: ${JSON.stringify(failures)}`);
  }
  log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Blitz Odds - automated historical results refresh (no Claude in the loop).
 *
 * Two mechanical jobs, both deterministic, neither needing judgment:
 *
 *   A. SEED each week's snapshot entry at kickoff. A weekly entry's
 *      `teamStats` and `impactPlayers` are supposed to be what the model was
 *      running on when that week's games were played - that's what makes a
 *      finished card's ranks, injury report and write-up factors honest.
 *      Capturing them after the week is over gets them wrong in exactly the
 *      way that matters: the Tuesday weekly-update task refreshes teams.json
 *      to "through week N" and archives week N in the same run, so the
 *      archive picks up ranks that already include that week's games, and
 *      injury statuses that include injuries suffered in them. Week 1 of
 *      2026 shipped that way (DEN@KC read "KC 86%, called it" against a
 *      kickoff call of DEN 57%). So this script creates the entry itself,
 *      from the docs the live site is actually serving, once the week's
 *      first kickoff is inside SEED_LEAD_MIN - before any of that week's
 *      results exist to leak in. Each team's stats and injury list are then
 *      re-captured on every run until that team's own kickoff passes, so a
 *      Sunday team's list reflects Sunday's inactives rather than Thursday's
 *      report; after kickoff a team's inputs are never touched again.
 *      site-data-update.mts refuses to let a later publish restate a seeded
 *      week's inputs (see preserveFrozenHistoryInputs there), so the weekly
 *      task can keep refreshing teams.json/impact-players.json for the new
 *      week without being able to overwrite the archive of the old one.
 *
 *   B. Keep each entry's `results` field current as games go final (final
 *      scores, pulled mechanically from ESPN).
 *
 * The prediction-snapshot job separately freezes each game's inputs on the
 * game's own record (schema 3, see scripts/prediction-snapshot.mjs); the
 * card prefers that per-game record and uses this week-level entry as the
 * fallback for a game whose freeze was missed or landed late.
 *
 * Regular season and playoffs only (week >= 1): preseason isn't frozen,
 * graded or shown as a track record anywhere, and its entries continue to
 * come from the weekly task.
 *
 * What it does, in order:
 *   1. Fetch the published site docs (site-data-current): history, schedule,
 *      and the teams/players docs the live site is running on (blob when
 *      published, the deployed static file otherwise - never the repo
 *      checkout, which can be ahead of what's deployed).
 *   2. Seed a snapshot entry for any week >= 1 whose first kickoff is due
 *      and that has no entry yet; refresh the inputs of teams that haven't
 *      kicked off yet in weeks already seeded.
 *   3. For every week with an entry, resolve that week's ESPN
 *      seasontype/week params (mirrors getEspnParams() in index.html), pull
 *      that week's ESPN scoreboard, and merge any new final scores.
 *   4. If anything changed, POST the full updated history doc back to
 *      site-data-update. Write the on-disk mirror (data/history.json)
 *      whenever it differs from the published doc, so git converges on
 *      what the site serves.
 *
 * Required env vars:
 *   SITE_DATA_UPDATE_SECRET - shared secret for site-data-update
 * Optional env vars:
 *   SITE_BASE      - defaults to https://blitz-odds.com
 *   REPO_ROOT      - defaults to CWD; where data/*.json live
 *   SEED_LEAD_MIN  - minutes before a week's first kickoff to seed its entry
 *                    (default 90 - late enough that the teams doc is this
 *                    week's, early enough to beat the first game)
 *   DRY_RUN        - "1" to log what would change without publishing or
 *                    writing to disk (no secret needed)
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.com";
const SITE_DATA_UPDATE_SECRET = process.env.SITE_DATA_UPDATE_SECRET;
const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const SEASON = 2026;
const SEED_LEAD_MIN = Number(process.env.SEED_LEAD_MIN || 90);
const DRY_RUN = process.env.DRY_RUN === "1";

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

// ---- Kickoff times (mirrors lib/kickoff.mts / prediction-snapshot.mjs) ----

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function nyOffsetMinutesAt(utcGuess) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(utcGuess).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asIfUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asIfUTC - utcGuess.getTime()) / 60000;
}

/** "Sun, Sep 13" + "1:00 PM ET" + season year -> UTC ms, or null. */
function kickoffUtcMs(dateStr, timeStr, seasonYear) {
  const dm = /([A-Za-z]+)\s+(\d+)\s*$/.exec(dateStr || "");
  const tm = /(\d+):(\d+)\s*(AM|PM)/i.exec(timeStr || "");
  if (!dm || !tm) return null;
  const month = MONTHS[dm[1]];
  if (month == null) return null;
  const day = parseInt(dm[2], 10);
  let hour = parseInt(tm[1], 10) % 12;
  if (/PM/i.test(tm[3])) hour += 12;
  const minute = parseInt(tm[2], 10);
  const year = month <= 5 ? seasonYear + 1 : seasonYear;
  const guess = Date.UTC(year, month, day, hour, minute) + 5 * 3600 * 1000;
  const offset = nyOffsetMinutesAt(new Date(guess));
  return Date.UTC(year, month, day, hour, minute) - offset * 60000;
}

// ---- Seeding weekly snapshot entries at kickoff ----------------------------

/** The teams/players docs exactly as the live site resolves them: the
 *  published blob when there is one, otherwise the deployed static file
 *  (the same copy index.html embeds at deploy time). Never the repo
 *  checkout - a commit can be ahead of what's actually published. */
async function fetchLiveInputDocs(siteData) {
  let teamsDoc = siteData && siteData.teams;
  if (!teamsDoc || !Array.isArray(teamsDoc.teams) || !teamsDoc.teams.length) {
    const res = await fetch(`${SITE_BASE}/data/teams.json`);
    if (!res.ok) throw new Error(`fetching deployed data/teams.json failed: ${res.status}`);
    teamsDoc = await res.json();
  }
  let playersDoc = siteData && siteData.players;
  if (!playersDoc || !playersDoc.players || typeof playersDoc.players !== "object") {
    const res = await fetch(`${SITE_BASE}/data/impact-players.json`);
    if (!res.ok) throw new Error(`fetching deployed data/impact-players.json failed: ${res.status}`);
    playersDoc = await res.json();
  }
  return { teamsDoc, playersDoc };
}

/** Which week a stats doc runs through. The weekly update stamps
 *  `asOfWeek`; a prior-season final doc (weeks 1-4 run on it) has none and
 *  reports 0. Mirrors the same derivation in prediction-snapshot.mjs. */
function teamStatsThroughWeekOf(teamsDoc, seasonYear) {
  if (Number.isFinite(Number(teamsDoc.asOfWeek))) return Number(teamsDoc.asOfWeek);
  return Number(teamsDoc.season) < seasonYear ? 0 : null;
}

function seedNote(week, seasonYear) {
  const label = week > 18 ? `Playoff round (week ${week})` : `Week ${week}`;
  return `${label} of the ${seasonYear} season. Team stats and injury statuses are what the model was running on at kickoff (each team's captured on the last refresh before its own game), not the numbers updated after the week's games were played. Final scores fill in automatically as games finish.`;
}

/** Weeks >= 1 with a schedule: regular season from the published schedule
 *  doc, plus any playoff round whose matchups are announced. */
function seedableWeeks(scheduleDoc, playoffsData) {
  const out = [];
  for (const w of (scheduleDoc && scheduleDoc.weeks) || []) {
    if (w && w.week >= 1 && Array.isArray(w.games) && w.games.length) out.push({ week: w.week, games: w.games });
  }
  for (const r of (playoffsData && playoffsData.rounds) || []) {
    if (r && r.week >= 1 && Array.isArray(r.games) && r.games.length) out.push({ week: r.week, games: r.games });
  }
  return out;
}

/** Creates the entry for any due week that has none, and re-captures the
 *  inputs of not-yet-kicked-off teams in weeks already seeded. Returns the
 *  number of entries touched. Entries that were never seeded (hand-authored,
 *  no `inputsFrozenAt`) are left alone. */
function seedWeekSnapshots(history, weeks, teamsDoc, playersDoc, seasonYear, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const throughWeek = teamStatsThroughWeekOf(teamsDoc, seasonYear);
  const statsById = {};
  for (const t of teamsDoc.teams || []) if (t && t.id && t.stats) statsById[t.id] = t.stats;
  const playersById = playersDoc.players || {};
  let touched = 0;

  for (const { week, games } of weeks) {
    const kickoffs = games.map((g) => kickoffUtcMs(g.date, g.time, seasonYear)).filter((ms) => ms != null);
    if (!kickoffs.length) continue;
    const firstKickoff = Math.min(...kickoffs);
    if (nowMs < firstKickoff - SEED_LEAD_MIN * 60000) continue; // not due yet

    let snap = history.weeks.find((w) => w && w.week === week);
    if (snap && !snap.inputsFrozenAt) continue; // hand-authored entry: not ours to touch

    // Teams whose game hasn't started: their inputs can still move (Friday
    // designations, Sunday inactives) and should be re-captured this run.
    const pending = new Set();
    for (const g of games) {
      const ms = kickoffUtcMs(g.date, g.time, seasonYear);
      if (ms != null && nowMs < ms) { pending.add(g.away); pending.add(g.home); }
    }

    if (!snap) {
      snap = {
        week,
        isDemo: false,
        snapshotDate: nowIso,
        inputsFrozenAt: nowIso,
        inputsCapturedAt: {},
        teamStatsThroughWeek: throughWeek,
        teamStatsSeason: teamsDoc.season != null ? teamsDoc.season : null,
        note: seedNote(week, seasonYear),
        teamStats: {},
        impactPlayers: {},
        results: {},
      };
      for (const id of Object.keys(statsById)) {
        snap.teamStats[id] = statsById[id];
        snap.impactPlayers[id] = playersById[id] || [];
        snap.inputsCapturedAt[id] = nowIso;
      }
      history.weeks.push(snap);
      history.weeks.sort((a, b) => a.week - b.week);
      touched += 1;
      log(`week ${week}: seeded snapshot entry (${Object.keys(snap.teamStats).length} teams, stats through week ${throughWeek}, ${pending.size} team(s) still pending kickoff).`);
      continue;
    }

    if (!pending.size) continue;
    let weekChanged = false;
    for (const id of pending) {
      const stats = statsById[id];
      const players = playersById[id] || [];
      if (stats && JSON.stringify(stats) !== JSON.stringify(snap.teamStats[id])) { snap.teamStats[id] = stats; weekChanged = true; }
      if (JSON.stringify(players) !== JSON.stringify(snap.impactPlayers[id])) { snap.impactPlayers[id] = players; weekChanged = true; }
      if (weekChanged) {
        if (!snap.inputsCapturedAt) snap.inputsCapturedAt = {};
        snap.inputsCapturedAt[id] = nowIso;
      }
    }
    if (weekChanged) {
      touched += 1;
      log(`week ${week}: re-captured inputs for ${pending.size} team(s) still ahead of kickoff.`);
    }
  }
  return touched;
}

async function main() {
  if (!SITE_DATA_UPDATE_SECRET && !DRY_RUN) {
    throw new Error("SITE_DATA_UPDATE_SECRET is required");
  }

  const [preseasonData, playoffsData] = await Promise.all([
    readJson("data/schedule-preseason-2026.json"),
    readJson("data/schedule-playoffs-2026.json"),
  ]);
  const getEspnParams = buildEspnParamsResolver(preseasonData, playoffsData);

  const siteDataRes = await fetch(`${SITE_BASE}/.netlify/functions/site-data-current`);
  if (!siteDataRes.ok) {
    throw new Error(`fetching site-data-current failed: ${siteDataRes.status}`);
  }
  const siteData = (await siteDataRes.json()) || {};
  let history = siteData.history;
  if (!history) {
    // Nothing published yet: start from the on-disk mirror so a first seed
    // doesn't drop the preseason entries that already live there.
    history = await readJson("data/history.json").catch(() => ({ weeks: [] }));
    log("no history doc published yet - starting from data/history.json.");
  }
  if (!history || !Array.isArray(history.weeks)) {
    throw new Error("published history doc is missing a weeks[] array");
  }
  const publishedJson = JSON.stringify(history);

  // A seeded or repaired entry in git outranks an unseeded one in the blob.
  // The mirror below otherwise treats the published doc as the source of
  // truth, which is right for results and for seeding - but a week whose
  // kickoff inputs were restored by hand in git (Week 1 of 2026) would be
  // reverted to the blob's post-game numbers on the next run, and the only
  // other way to get the repaired entry live is a manual publish. So: for
  // any week where the on-disk entry carries `inputsFrozenAt` and the
  // published one doesn't, the on-disk entry is published (keeping any
  // final scores the blob already has), after which the guard in
  // site-data-update keeps it that way.
  let changed = false;
  const onDiskDoc = await readJson("data/history.json").catch(() => null);
  for (const diskWeek of (onDiskDoc && Array.isArray(onDiskDoc.weeks) ? onDiskDoc.weeks : [])) {
    if (!diskWeek || typeof diskWeek.week !== "number" || !diskWeek.inputsFrozenAt) continue;
    const idx = history.weeks.findIndex((w) => w && w.week === diskWeek.week);
    const published = idx >= 0 ? history.weeks[idx] : null;
    if (published && published.inputsFrozenAt) continue; // blob already seeded: it wins
    const merged = { ...diskWeek, results: { ...(diskWeek.results || {}), ...((published && published.results) || {}) } };
    if (idx >= 0) history.weeks[idx] = merged; else history.weeks.push(merged);
    history.weeks.sort((a, b) => a.week - b.week);
    changed = true;
    log(`week ${diskWeek.week}: on-disk entry carries kickoff inputs the published doc lacks - publishing the on-disk entry.`);
  }

  // Seed / refresh kickoff inputs before touching results, so a week whose
  // first game just kicked off gets its entry on the same run.
  const scheduleDoc = siteData.schedule || (await readJson("data/schedule-full-2026.json"));
  const seasonYear = Number(scheduleDoc.season) || SEASON;
  const { teamsDoc, playersDoc } = await fetchLiveInputDocs(siteData);
  const seeded = seedWeekSnapshots(history, seedableWeeks(scheduleDoc, playoffsData), teamsDoc, playersDoc, seasonYear, Date.now());

  // Belt-and-braces with the same guard in site-data-update.mts. If a demo
  // snapshot ever reaches the published doc anyway, drop it here so it can't
  // reach the on-disk mirror either - data/history.json is what the weekly
  // archive and the embedded HISTORY_DATA block get rebuilt from, and that is
  // exactly how the 2026 Week 1 sample kept resurfacing.
  if (seeded > 0) changed = true;

  const demoWeeks = history.weeks.filter((w) => w && w.isDemo === true);
  if (demoWeeks.length) {
    history.weeks = history.weeks.filter((w) => !(w && w.isDemo === true));
    changed = true;
    log(`dropped ${demoWeeks.length} demo snapshot(s): week ${demoWeeks.map((w) => w.week).join(", ")}`);
  }

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

  if (DRY_RUN) {
    log(`DRY_RUN: ${changed ? "would publish the updated history doc" : "nothing to publish"}; weeks in doc: ${history.weeks.map((w) => w.week).join(", ")}.`);
    return;
  }

  if (changed) {
    const publishRes = await fetch(`${SITE_BASE}/.netlify/functions/site-data-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-site-data-update-secret": SITE_DATA_UPDATE_SECRET },
      body: JSON.stringify({ history }),
    });
    if (!publishRes.ok) {
      throw new Error(`site-data-update publish failed: ${publishRes.status} ${await publishRes.text().catch(() => "")}`);
    }
    log("published updated history doc.");
  } else {
    log("nothing changed - no publish.");
  }

  // The mirror tracks what the site serves, not just what this run changed:
  // if the published doc drifted from git (a publish-only update, or the
  // site-data-update guard keeping a seeded week's inputs that a later commit
  // restated), the next run brings git back in line. The workflow commits
  // the file only when it actually differs.
  const onDisk = await readJson("data/history.json").catch(() => null);
  if (changed || !onDisk || JSON.stringify(onDisk) !== (changed ? JSON.stringify(history) : publishedJson)) {
    await writeJson("data/history.json", history);
    log("wrote on-disk mirror (data/history.json).");
  } else {
    log("on-disk mirror already matches - no disk write.");
  }
}

main().catch((err) => {
  console.error("history-results-refresh failed:", err);
  process.exit(1);
});

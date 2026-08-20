#!/usr/bin/env node
/**
 * Blitz Odds - Hot Picks weekly snapshot (no Claude in the loop).
 *
 * Computes this week's Hot Picks (top 3 confidence picks, spread/moneyline/
 * total angles) using the exact same PredictionEngine + HotPicksEngine
 * modules the live site uses, then freezes the result under that week's key
 * so the track record feature always grades the pick a user actually saw -
 * never a pick recomputed later after ratings/odds/injuries have moved.
 *
 * Idempotent by design: if a snapshot already exists for the target week,
 * this is a no-op unless FORCE_RESNAPSHOT=1 is set. That means it's safe to
 * run this on a cheap daily/every-few-hours cadence via cron-job.org -
 * whichever run happens to land after that week's odds are posted is the
 * one that "sticks," and every run after that is a harmless no-op until the
 * following week rolls over.
 *
 * Deliberately scoped to regular-season weeks (1-18) only - preseason picks
 * aren't meaningful for a confidence-pool track record, and playoff weeks
 * are a small enough sample that they're better handled as a separate,
 * later feature than folded into the season record silently.
 *
 * Required env vars:
 *   HOTPICKS_UPDATE_SECRET - shared secret for hotpicks-update
 * Optional env vars:
 *   SITE_BASE        - defaults to https://blitz-odds.netlify.app
 *   REPO_ROOT         - defaults to CWD; where data/*.json live
 *   FORCE_RESNAPSHOT  - "1" to overwrite an existing snapshot for the target week
 *   TARGET_WEEK       - override the auto-detected current week (1-18)
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import PredictionEngine from "../js/predictionEngine.js";
import HotPicksEngine from "../js/hotPicksEngine.js";

const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.netlify.app";
const HOTPICKS_UPDATE_SECRET = process.env.HOTPICKS_UPDATE_SECRET;
const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const FORCE_RESNAPSHOT = process.env.FORCE_RESNAPSHOT === "1";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function writeJson(relPath, data) {
  const full = path.join(REPO_ROOT, relPath);
  await writeFile(full, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---- Current-week detection (mirrors getDefaultWeek()/getPeriodRolloverMs()
// in index.html, scoped down to regular-season weeks only) -----------------

const MONTH_INDEX_BY_ABBR = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const WEEK_ROLLOVER_HOUR_ET = 8;

function latestGameDateMs(games, seasonYear) {
  let latest = null;
  (games || []).forEach((g) => {
    if (!g || !g.date) return;
    const m = /([A-Za-z]+)\s+(\d+)\s*$/.exec(g.date);
    if (!m) return;
    const month = MONTH_INDEX_BY_ABBR[m[1]];
    if (month == null) return;
    const day = parseInt(m[2], 10);
    const year = month <= 5 ? seasonYear + 1 : seasonYear;
    const ms = Date.parse(`${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00-05:00`);
    if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
  });
  return latest;
}

function getCurrentRegularWeek(scheduleData) {
  const seasonYear = (scheduleData && scheduleData.season) || new Date().getFullYear();
  const weeks = (scheduleData && scheduleData.weeks) || [];
  const now = Date.now();
  for (const w of weeks) {
    const lastGameDayMs = latestGameDateMs(w.games, seasonYear);
    const rollover = lastGameDayMs == null ? null : lastGameDayMs + (24 + WEEK_ROLLOVER_HOUR_ET) * 60 * 60 * 1000;
    if (rollover == null || now < rollover) return w.week;
  }
  return weeks.length ? weeks[weeks.length - 1].week : null;
}

async function main() {
  if (!HOTPICKS_UPDATE_SECRET) {
    throw new Error("HOTPICKS_UPDATE_SECRET is required");
  }

  const [siteDataRes, oddsRes, weatherRes, stadiumsRes] = await Promise.all([
    fetch(`${SITE_BASE}/.netlify/functions/site-data-current`),
    fetch(`${SITE_BASE}/.netlify/functions/odds-current`),
    fetch(`${SITE_BASE}/.netlify/functions/weather-current`),
    fetch(`${SITE_BASE}/data/stadiums.json`),
  ]);
  if (!siteDataRes.ok) throw new Error(`site-data-current failed: ${siteDataRes.status}`);
  if (!oddsRes.ok) throw new Error(`odds-current failed: ${oddsRes.status}`);
  if (!weatherRes.ok) throw new Error(`weather-current failed: ${weatherRes.status}`);
  if (!stadiumsRes.ok) throw new Error(`stadiums.json fetch failed: ${stadiumsRes.status}`);

  const siteData = await siteDataRes.json();
  const odds = await oddsRes.json();
  const weather = await weatherRes.json();
  const stadiums = await stadiumsRes.json();

  const teams = (siteData.teams && siteData.teams.teams) || [];
  const players = (siteData.players && siteData.players.players) || {};
  const schedule = siteData.schedule || { season: 2026, weeks: [] };

  const targetWeek = process.env.TARGET_WEEK
    ? parseInt(process.env.TARGET_WEEK, 10)
    : getCurrentRegularWeek(schedule);

  if (!targetWeek || targetWeek < 1 || targetWeek > 18) {
    log(`No regular-season week to snapshot right now (resolved week: ${targetWeek}). Exiting.`);
    return;
  }

  const weekEntry = schedule.weeks.find((w) => w.week === targetWeek);
  const games = (weekEntry && weekEntry.games) || [];
  if (!games.length) {
    log(`Week ${targetWeek} has no games in the schedule yet. Exiting.`);
    return;
  }

  function isDomeTeam(teamId) {
    const entry = stadiums.teamStadiums && stadiums.teamStadiums[teamId];
    return !!(entry && entry.isDome);
  }

  const weekOdds = (odds.weeks && odds.weeks[String(targetWeek)]) || null;
  const weekWeather = (weather.weeks && weather.weeks[String(targetWeek)]) || null;

  const hotPicksInput = games
    .map((g) => {
      const home = teams.find((t) => t.id === g.home);
      const away = teams.find((t) => t.id === g.away);
      if (!home || !away) return null;
      const homePlayers = players[g.home] || [];
      const awayPlayers = players[g.away] || [];
      const gameOdds = weekOdds && weekOdds.games ? weekOdds.games[`${g.away}-${g.home}`] || null : null;
      const gameWeather = weekWeather && weekWeather.games ? weekWeather.games[`${g.away}-${g.home}`] || null : null;
      const prediction = PredictionEngine.predictMatchup({
        homeTeam: home,
        awayTeam: away,
        homeImpactPlayers: homePlayers,
        awayImpactPlayers: awayPlayers,
        weather: gameWeather,
        homeIsDomeTeam: isDomeTeam(home.id),
        awayIsDomeTeam: isDomeTeam(away.id),
      });
      return { awayId: away.id, awayName: away.name, homeId: home.id, homeName: home.name, prediction, odds: gameOdds };
    })
    .filter(Boolean);

  if (!hotPicksInput.length) {
    log(`Week ${targetWeek}: no games resolved to full team/prediction data. Exiting.`);
    return;
  }

  const hotPicks = HotPicksEngine.computeHotPicks(hotPicksInput);

  // Freeze the exact odds each referenced game had at snapshot time, keyed
  // by matchup, so grading later never has to re-derive a spread/total
  // number by parsing pick text (fragile) or re-fetch odds that may have
  // moved since (wrong - would grade against a line nobody actually saw).
  const referencedGames = new Map();
  function addGame(g) {
    if (!g) return;
    referencedGames.set(`${g.awayId}-${g.homeId}`, g);
  }
  hotPicks.topConfidence.forEach((p) => addGame(p.game));
  addGame(hotPicks.spreadPick && hotPicks.spreadPick.game);
  addGame(hotPicks.moneylinePick && hotPicks.moneylinePick.game);
  addGame(hotPicks.totalPick && hotPicks.totalPick.game);

  const gradingContext = {};
  for (const [key, g] of referencedGames) {
    const input = hotPicksInput.find((h) => h.awayId === g.awayId && h.homeId === g.homeId);
    gradingContext[key] = input ? input.odds : null;
  }

  // Fetch-before-merge, same pattern as every other refresh script.
  const snapshotsRes = await fetch(`${SITE_BASE}/.netlify/functions/hotpicks-current?type=snapshots`);
  const existingDoc = snapshotsRes.ok ? await snapshotsRes.json() : { weeks: {} };
  const snapshots = existingDoc && typeof existingDoc.weeks === "object" ? existingDoc : { weeks: {} };

  if (snapshots.weeks[String(targetWeek)] && !FORCE_RESNAPSHOT) {
    log(`Week ${targetWeek} already has a frozen snapshot - leaving it as-is. Set FORCE_RESNAPSHOT=1 to overwrite.`);
    return;
  }

  snapshots.weeks[String(targetWeek)] = {
    week: targetWeek,
    season: schedule.season || 2026,
    snapshotAt: new Date().toISOString(),
    picks: hotPicks,
    gradingContext,
  };

  const publishRes = await fetch(`${SITE_BASE}/.netlify/functions/hotpicks-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hotpicks-update-secret": HOTPICKS_UPDATE_SECRET },
    body: JSON.stringify({ snapshots }),
  });
  if (!publishRes.ok) {
    throw new Error(`hotpicks-update publish failed: ${publishRes.status} ${await publishRes.text().catch(() => "")}`);
  }
  log(`Week ${targetWeek}: snapshot published (${hotPicks.topConfidence.length} confidence picks, spread=${!!hotPicks.spreadPick}, ml=${!!hotPicks.moneylinePick}, total=${!!hotPicks.totalPick}).`);

  await writeJson("data/hotpicks-snapshots.json", snapshots);
  log("wrote on-disk mirror (data/hotpicks-snapshots.json).");
}

main().catch((err) => {
  console.error("hotpicks-snapshot failed:", err);
  process.exit(1);
});

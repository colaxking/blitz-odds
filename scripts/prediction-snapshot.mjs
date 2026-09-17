#!/usr/bin/env node
/**
 * Blitz Odds - per-game model prediction snapshot, frozen at kickoff.
 *
 * Freezes what the model said about each game at the moment that game's
 * picks locked, so "Blitz follow rate" grades a member against the pick
 * they could actually see when they made theirs - never against a
 * prediction recomputed later, after injuries, weather and lines have moved.
 *
 * Why per-game and not per-week: picks lock at each game's own kickoff (see
 * netlify/functions/lib/kickoff.mts), and a week's games kick off across
 * Thursday through Monday. A single weekly freeze would be "at kickoff" for
 * one game and days early or late for the rest. So each game is frozen
 * independently, on whichever run of this job lands in its freeze window.
 *
 * Cadence: run this often - every 10-15 minutes through game days. Each run
 * freezes only games entering their window and is otherwise a no-op, so a
 * tight cadence costs almost nothing and keeps the freeze close to kickoff.
 *
 * Idempotent and append-only: predictions-update refuses to overwrite an
 * already-frozen game unless explicitly forced. A snapshot that could be
 * quietly restated later would defeat the entire purpose.
 *
 * The frozen record deliberately includes that game's odds as well as the
 * model's straight-up call, because an ATS read needs a cover lean rather
 * than a winner and that can't be reconstructed after the fact if the line
 * was never captured. The site reads both: once a game is live or final the
 * card renders this record instead of recomputing, so the Blitz Edge number
 * and the spread/O-U it was measured against stay what they were at kickoff
 * rather than drifting with later injury and line moves.
 *
 * Schema 3 also freezes the model's *inputs* - both teams' stat blocks, both
 * impact-player lists and the weather entry exactly as the engine saw them -
 * under `inputs`. The weekly archive in data/history.json is a per-week
 * snapshot taken after the week is over, and Week 1 of 2026 showed why that
 * isn't enough: its team stats were the season-to-date numbers *including*
 * that week's games and its injury statuses included injuries suffered in
 * them, so a finished card recomputed against hindsight (DEN@KC read "KC
 * 86%, called it" when the model had DEN 57% at kickoff). With the inputs on
 * the record, a card for a finished game can show the same ranks, injury
 * report and write-up factors the call was actually made on, independent of
 * whatever the archive later says.
 *
 * Scope: regular season and postseason (week >= 1). Preseason is excluded -
 * exhibition games where starters play a quarter aren't a meaningful test of
 * whether someone follows the model.
 *
 * Required env vars:
 *   PREDICTIONS_UPDATE_SECRET - shared secret for predictions-update
 * Optional env vars:
 *   SITE_BASE          - defaults to https://blitz-odds.com
 *   FREEZE_LEAD_MIN    - minutes before kickoff to freeze (default 15)
 *   TARGET_WEEK        - override the auto-detected week
 *   FORCE_REFREEZE     - "1" to overwrite existing snapshots (use with care)
 */

import PredictionEngine from "../js/predictionEngine.js";

const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.com";
const PREDICTIONS_UPDATE_SECRET = process.env.PREDICTIONS_UPDATE_SECRET;
const FREEZE_LEAD_MIN = Number(process.env.FREEZE_LEAD_MIN || 15);
const FORCE_REFREEZE = process.env.FORCE_REFREEZE === "1";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

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

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Resolves the UTC offset America/New_York observes at a given instant,
 *  rather than hand-maintaining DST dates. Mirrors lib/kickoff.mts. */
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

/** "Sun, Sep 13" + "1:00 PM ET" + season year -> real UTC ms, or null.
 *  Same derivation as lib/kickoff.mts's parseKickoffUTC; duplicated here
 *  because that module is TypeScript and this script runs as plain ESM. */
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
  // Jan-Jun dates belong to the calendar year after the season year.
  const year = month <= 5 ? seasonYear + 1 : seasonYear;
  const guess = Date.UTC(year, month, day, hour, minute) + 5 * 3600 * 1000;
  const offset = nyOffsetMinutesAt(new Date(guess));
  return Date.UTC(year, month, day, hour, minute) - offset * 60000;
}

/** Every week that still has an unfrozen game in or past its freeze window.
 *  Scanning all weeks rather than only "the current week" means a run that
 *  happens during a Monday-night game still catches it after the week has
 *  otherwise rolled over, and a missed window is picked up late (flagged)
 *  rather than lost. */
function weeksInScope(schedule, nowMs) {
  const seasonYear = schedule.season || new Date().getFullYear();
  const cutoff = nowMs + FREEZE_LEAD_MIN * 60000;
  const out = [];
  for (const w of schedule.weeks || []) {
    if (w.week < 1) continue; // preseason out of scope
    const due = (w.games || []).filter((g) => {
      const ms = kickoffUtcMs(g.date, g.time, seasonYear);
      return ms != null && ms <= cutoff;
    });
    if (due.length) out.push({ week: w.week, games: due, seasonYear });
  }
  return out;
}

async function main() {
  if (!PREDICTIONS_UPDATE_SECRET) throw new Error("PREDICTIONS_UPDATE_SECRET is required");

  // Sequential fetches, not Promise.all - concurrent connections to the same
  // host from GitHub Actions runners have been unreliable here (see the note
  // in hotpicks-snapshot.mjs).
  const siteDataRes = await fetchWithRetry(`${SITE_BASE}/.netlify/functions/site-data-current`);
  const oddsRes = await fetchWithRetry(`${SITE_BASE}/.netlify/functions/odds-current`);
  const weatherRes = await fetchWithRetry(`${SITE_BASE}/.netlify/functions/weather-current`);
  const stadiumsRes = await fetchWithRetry(`${SITE_BASE}/data/stadiums.json`);
  for (const [name, res] of [["site-data-current", siteDataRes], ["odds-current", oddsRes], ["weather-current", weatherRes], ["stadiums.json", stadiumsRes]]) {
    if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
  }

  const siteData = await siteDataRes.json();
  const odds = await oddsRes.json();
  const weather = await weatherRes.json();
  const stadiums = await stadiumsRes.json();

  /* site-data-current only returns the docs that have actually been
   * published to Blobs, and omits the rest - `teams` in particular has never
   * been published, because the site gets its ranks from the copy embedded
   * in index.html at deploy time and only *overlays* the blob when one
   * exists (see useLiveSiteData). This script had no such fallback: it read
   * the blob only, got an empty team list, failed to resolve either side of
   * every game, and exited having frozen nothing - successfully, and every
   * run, for as long as it had been scheduled. Resolve the same way the site
   * does: published blob if there is one, the static file otherwise.
   */
  let teamsDoc = siteData.teams || null;
  let teams = (teamsDoc && teamsDoc.teams) || [];
  if (!teams.length) {
    const res = await fetchWithRetry(`${SITE_BASE}/data/teams.json`);
    if (!res.ok) throw new Error(`data/teams.json failed: ${res.status}`);
    teamsDoc = (await res.json()) || {};
    teams = teamsDoc.teams || [];
    log(`site-data-current published no teams doc - fell back to data/teams.json (${teams.length} teams).`);
  }
  if (!teams.length) throw new Error("No team data from either site-data-current or data/teams.json");

  let players = (siteData.players && siteData.players.players) || {};
  if (!Object.keys(players).length) {
    const res = await fetchWithRetry(`${SITE_BASE}/data/impact-players.json`);
    if (!res.ok) throw new Error(`data/impact-players.json failed: ${res.status}`);
    players = ((await res.json()) || {}).players || {};
    log("site-data-current published no players doc - fell back to data/impact-players.json.");
  }

  const schedule = siteData.schedule || { season: new Date().getFullYear(), weeks: [] };
  // Which week the stats doc runs through: the weekly update stamps
  // `asOfWeek`; a prior-season final doc (what weeks 1-4 run on) has none and
  // reports 0. Mirrors teamStatsThroughWeekOf() in history-results-refresh.mjs.
  const teamStatsThroughWeek = Number.isFinite(Number(teamsDoc.asOfWeek))
    ? Number(teamsDoc.asOfWeek)
    : (Number(teamsDoc.season) < Number(schedule.season || new Date().getFullYear()) ? 0 : null);

  const isDomeTeam = (teamId) => {
    const entry = stadiums.teamStadiums && stadiums.teamStadiums[teamId];
    return !!(entry && entry.isDome);
  };

  const nowMs = Date.now();
  let scope = weeksInScope(schedule, nowMs);
  if (process.env.TARGET_WEEK) {
    const tw = parseInt(process.env.TARGET_WEEK, 10);
    scope = scope.filter((s) => s.week === tw);
  }
  if (!scope.length) {
    log("No games are inside their freeze window right now. Exiting.");
    return;
  }

  const predictions = [];
  // Counted so an unresolvable slate fails the run instead of exiting 0. The
  // freeze is invisible when it works, so a silent no-op is indistinguishable
  // from success until someone goes looking - which is exactly how the empty
  // teams list above went unnoticed.
  let unresolved = 0;
  for (const { week, games, seasonYear } of scope) {
    const weekOdds = (odds.weeks && odds.weeks[String(week)]) || null;
    const weekWeather = (weather.weeks && weather.weeks[String(week)]) || null;

    for (const g of games) {
      const home = teams.find((t) => t.id === g.home);
      const away = teams.find((t) => t.id === g.away);
      if (!home || !away) {
        log(`Week ${week} ${g.away}@${g.home}: team data missing, skipping.`);
        unresolved += 1;
        continue;
      }
      const gameOdds = weekOdds && weekOdds.games ? weekOdds.games[`${g.away}-${g.home}`] || null : null;
      const gameWeather = weekWeather && weekWeather.games ? weekWeather.games[`${g.away}-${g.home}`] || null : null;

      const prediction = PredictionEngine.predictMatchup({
        homeTeam: home,
        awayTeam: away,
        homeImpactPlayers: players[g.home] || [],
        awayImpactPlayers: players[g.away] || [],
        weather: gameWeather,
        homeIsDomeTeam: isDomeTeam(home.id),
        awayIsDomeTeam: isDomeTeam(away.id),
        // Load-bearing. Weeks 1-4 run on prior-season ranks and take the
        // wider EARLY_SEASON_MARGIN_SD; omitting `week` silently falls back
        // to MARGIN_SD and freezes a *more confident* number than the card
        // ever showed. Snapshots written before this was passed are repaired
        // on read - see the legacy branch in predictions-current.mts.
        week,
      });

      const koMs = kickoffUtcMs(g.date, g.time, seasonYear);
      predictions.push({
        season: seasonYear,
        week,
        gameId: `${seasonYear}-w${week}-${g.away}-${g.home}`,
        away: g.away,
        home: g.home,
        // schema 2 added predictedMargin/confidence and was the first version
        // written with `week` passed through; a record without this field is
        // a schema-1 record and gets repaired on read. schema 3 adds `inputs`
        // (below).
        schema: 3,
        predictedWinner: prediction.predictedWinner,
        homeWinProbability: prediction.homeWinProbability,
        awayWinProbability: prediction.awayWinProbability,
        // The card's ats and confidence reads need the margin, not just the
        // win probability: a model line can only be compared against the
        // market's in points. Stored rather than re-derived so the frozen
        // record can rebuild every format's recommendation on its own.
        predictedMargin: prediction.predictedMargin,
        confidence: prediction.confidence,
        kickoffUtcMs: koMs,
        frozenAt: new Date(nowMs).toISOString(),
        // Set when the freeze happened after kickoff rather than inside the
        // lead window - the job was down, or the game moved. The record is
        // still worth having, but it isn't strictly "as of lock time" and
        // shouldn't be presented as though it were.
        late: koMs != null && nowMs > koMs,
        odds: gameOdds,
        // Everything predictMatchup() above was handed, so a finished game's
        // card can render the ranks, injury report and write-up factors the
        // call was made on rather than whatever the data says later. Stored
        // as-is (no trimming): the card's injury section reads the same
        // player fields the live path does, and a week of records is well
        // under a megabyte.
        inputs: {
          homeStats: home.stats || null,
          awayStats: away.stats || null,
          homeImpactPlayers: players[g.home] || [],
          awayImpactPlayers: players[g.away] || [],
          weather: gameWeather,
          // Which stats doc the ranks came from, for anyone auditing a
          // record later. asOfWeek is set by the weekly update; a prior-season
          // final doc (weeks 1-4 run on it) reports 0.
          teamStatsThroughWeek: teamStatsThroughWeek,
          teamStatsSeason: teamsDoc.season != null ? teamsDoc.season : null,
        },
      });
    }
  }

  if (!predictions.length) {
    // Every game in scope is rebuilt on every run - the append-only skip
    // happens server-side in predictions-update, not here - so an empty list
    // against a non-empty scope means resolution failed, never "already
    // done".
    if (unresolved) throw new Error(`Could not resolve team data for ${unresolved} game(s) in scope - froze nothing.`);
    log("Nothing to freeze after resolving team data. Exiting.");
    return;
  }

  const res = await fetchWithRetry(`${SITE_BASE}/.netlify/functions/predictions-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-predictions-update-secret": PREDICTIONS_UPDATE_SECRET },
    body: JSON.stringify({ predictions, force: FORCE_REFREEZE }),
  });
  if (!res.ok) throw new Error(`predictions-update failed: ${res.status} ${await res.text().catch(() => "")}`);

  const result = await res.json();
  const lateCount = predictions.filter((p) => p.late && result.written.includes(p.gameId)).length;
  log(`Froze ${result.written.length} game(s), skipped ${result.skipped.length} already frozen${lateCount ? `, ${lateCount} frozen late (after kickoff)` : ""}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

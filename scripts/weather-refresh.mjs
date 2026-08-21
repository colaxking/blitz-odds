#!/usr/bin/env node
/**
 * Blitz Odds - automated weather refresh.
 *
 * Runs from GitHub Actions (cron-job.org dispatch, same pattern as
 * odds-refresh.mjs / history-results-refresh.mjs). What it does, in order:
 *   1. Fetch the current weather doc from weather-current (fetch-before-merge).
 *   2. Build the list of upcoming games (next WEATHER_WINDOW_DAYS days) from
 *      the schedule JSON files, skipping any game whose kickoff has already
 *      passed - those entries are frozen and never touched again, which is
 *      what makes the historical record permanent (the last forecast
 *      captured before kickoff just stays as-is). There's no repo-side file
 *      tracking live/final status (the app fetches that from ESPN directly
 *      at runtime), so kickoff time is the freeze signal.
 *   3. For each remaining game, resolve its venue (home team's stadium, or
 *      an international venue matched off game.note) and skip if isDome.
 *   4. Fetch a forecast from Open-Meteo (free, no API key) for that lat/lon
 *      at the game's kickoff time, map into our weather shape.
 *   5. Merge into the fetched doc, publish to weather-update, and write the
 *      same doc to data/weather.json so the workflow can commit a durable
 *      on-disk mirror.
 *
 * Required env vars:
 *   WEATHER_UPDATE_SECRET - shared secret for weather-update
 * Optional env vars:
 *   SITE_BASE   - defaults to https://blitz-odds.com
 *   REPO_ROOT   - defaults to CWD; where data/*.json live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.com";
const WEATHER_UPDATE_SECRET = process.env.WEATHER_UPDATE_SECRET;
const REPO_ROOT = process.env.REPO_ROOT || process.cwd();

const WEATHER_WINDOW_DAYS = 7; // Open-Meteo's reliable hourly forecast horizon
const SEASON_YEAR = 2026;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function readJson(relPath) {
  return JSON.parse(await readFile(path.join(REPO_ROOT, relPath), "utf8"));
}

async function writeJson(relPath, data) {
  await writeFile(path.join(REPO_ROOT, relPath), JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function readJsonOptional(relPath) {
  try {
    return await readJson(relPath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Date parsing (same approach as odds-refresh.mjs)

function parseScheduleDateTime(dateStr, timeStr) {
  const dm = /([A-Za-z]{3})\s+(\d{1,2})/.exec(dateStr || "");
  if (!dm) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = months[dm[1]];
  if (month === undefined) return null;
  const day = Number(dm[2]);
  const year = month <= 1 ? SEASON_YEAR + 1 : SEASON_YEAR;

  let hour = 13, minute = 0; // default 1pm ET-ish if time is missing/unparsed
  const tm = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(timeStr || "");
  if (tm) {
    hour = Number(tm[1]) % 12;
    if (/PM/i.test(tm[3])) hour += 12;
    minute = Number(tm[2]);
    // Schedule times are ET; approximate as UTC-5 (ignores DST, fine for a
    // same-day forecast lookup - Open-Meteo returns hourly data anyway so
    // we round to nearest hour on the response side).
    hour += 5;
  }
  // Deliberately NOT hour % 24 here - Date.UTC correctly rolls the day
  // forward when hour >= 24 (e.g. 8:20 PM ET = hour 25 -> next day 01:20
  // UTC). Modulo-ing the hour first would silently drop that day carry.
  return new Date(Date.UTC(year, month, day, hour, minute));
}

// ---------------------------------------------------------------------------
// Schedule + venue resolution

async function loadAllGames() {
  const [preseason, full, playoffs] = await Promise.all([
    readJsonOptional("data/schedule-preseason-2026.json"),
    readJsonOptional("data/schedule-full-2026.json"),
    readJsonOptional("data/schedule-playoffs-2026.json"),
  ]);

  const out = [];
  // Regular season uses `weeks` (week is a plain number, w.games is an
  // array). Preseason/playoffs use `rounds` (each round already carries its
  // own `week` number - negative for preseason, 19-22 for playoffs - and
  // playoff rounds start with an empty games array until seeding is known).
  const pullWeeks = (doc) => {
    if (!doc || !Array.isArray(doc.weeks)) return;
    doc.weeks.forEach((w) => {
      (w.games || []).forEach((g) => out.push({ ...g, week: w.week }));
    });
  };
  const pullRounds = (doc) => {
    if (!doc || !Array.isArray(doc.rounds)) return;
    doc.rounds.forEach((r) => {
      (r.games || []).forEach((g) => out.push({ ...g, week: r.week }));
    });
  };
  pullRounds(preseason);
  pullWeeks(full);
  pullRounds(playoffs);
  return out;
}

function resolveVenue(game, stadiums) {
  if (game.international && game.note) {
    const hit = stadiums.internationalVenues.find((v) => game.note.includes(v.match));
    if (hit) return hit;
  }
  return stadiums.teamStadiums[game.home] || null;
}

// Mirrors ODDS_DATA's key scheme exactly: weeks[week].games["away-home"].
// Week numbers are already globally unique (negative preseason, 1-18
// regular, 19-22 playoffs) so no separate phase key is needed.
function gameSubKey(game) {
  return `${game.away}-${game.home}`;
}

// ---------------------------------------------------------------------------
// Open-Meteo

const WEATHER_CODE_MAP = {
  0: "clear", 1: "mostly-clear", 2: "partly-cloudy", 3: "overcast",
  45: "fog", 48: "fog", 51: "light-rain", 53: "rain", 55: "heavy-rain",
  61: "light-rain", 63: "rain", 65: "heavy-rain", 71: "light-snow",
  73: "snow", 75: "heavy-snow", 80: "showers", 81: "showers", 82: "heavy-showers",
  95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm",
};

async function fetchForecast(lat, lon, kickoffUtc) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "temperature_2m,precipitation_probability,windspeed_10m,weathercode",
    temperature_unit: "fahrenheit",
    windspeed_unit: "mph",
    timezone: "UTC",
    forecast_days: "10",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) throw new Error(`Open-Meteo failed: ${res.status}`);
  const body = await res.json();

  const times = body?.hourly?.time || [];
  const targetIso = kickoffUtc.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  let idx = times.findIndex((t) => t.startsWith(targetIso));
  if (idx === -1) {
    // Fall back to the closest available hour within the returned window.
    let best = -1, bestDiff = Infinity;
    times.forEach((t, i) => {
      const diff = Math.abs(new Date(t + ":00Z").getTime() - kickoffUtc.getTime());
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    idx = best;
  }
  if (idx === -1) return null;

  const code = body.hourly.weathercode[idx];
  return {
    tempF: Math.round(body.hourly.temperature_2m[idx]),
    condition: WEATHER_CODE_MAP[code] || "unknown",
    windMph: Math.round(body.hourly.windspeed_10m[idx]),
    precipChance: body.hourly.precipitation_probability[idx],
    isDome: false,
    source: "forecast",
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// weather-current / weather-update

async function getWeatherCurrent() {
  const res = await fetch(`${SITE_BASE}/.netlify/functions/weather-current`, { cache: "no-store" });
  if (!res.ok) throw new Error(`weather-current failed: ${res.status}`);
  return res.json();
}

async function publishWeather(doc) {
  const res = await fetch(`${SITE_BASE}/.netlify/functions/weather-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-weather-update-secret": WEATHER_UPDATE_SECRET },
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`weather-update failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Main

async function main() {
  if (!WEATHER_UPDATE_SECRET) throw new Error("WEATHER_UPDATE_SECRET not set");

  const stadiums = await readJson("data/stadiums.json");
  const games = await loadAllGames();

  const current = await getWeatherCurrent();
  // Deep-ish copy so we can freely mutate per-week game maps without
  // touching the object we fetched (not strictly necessary, but avoids
  // accidental aliasing bugs if this script grows later).
  const doc = { weeks: {} };
  Object.entries(current.weeks || {}).forEach(([wk, weekDoc]) => {
    doc.weeks[wk] = { games: { ...(weekDoc.games || {}) } };
  });

  const now = Date.now();
  const windowEnd = now + WEATHER_WINDOW_DAYS * 86400000;

  let fetched = 0, skippedDome = 0, skippedFrozen = 0, skippedOutOfWindow = 0, skippedNoVenue = 0;

  for (const game of games) {
    const kickoff = parseScheduleDateTime(game.date, game.time);
    if (!kickoff) continue;
    const weekKey = String(game.week);
    const subKey = gameSubKey(game);
    if (!doc.weeks[weekKey]) doc.weeks[weekKey] = { games: {} };

    const kt = kickoff.getTime();
    // Kickoff already passed -> freeze. Whatever's already in this slot
    // (copied from the current published doc above) stays untouched, which
    // is the entire freeze mechanism - we simply never overwrite it again.
    if (kt <= now) { skippedFrozen++; continue; }
    if (kt > windowEnd) { skippedOutOfWindow++; continue; }

    const venue = resolveVenue(game, stadiums);
    if (!venue) { skippedNoVenue++; log(`no venue match for week ${weekKey} ${subKey}`); continue; }

    if (venue.isDome) {
      doc.weeks[weekKey].games[subKey] = { tempF: null, condition: null, windMph: null, precipChance: null, isDome: true, source: "dome", capturedAt: new Date().toISOString() };
      skippedDome++;
      continue;
    }

    try {
      const forecast = await fetchForecast(venue.lat, venue.lon, kickoff);
      if (forecast) {
        doc.weeks[weekKey].games[subKey] = forecast;
        fetched++;
      }
    } catch (err) {
      log(`forecast fetch failed for week ${weekKey} ${subKey}:`, err.message);
    }
  }

  log(`fetched=${fetched} dome=${skippedDome} frozen=${skippedFrozen} outOfWindow=${skippedOutOfWindow} noVenue=${skippedNoVenue}`);

  const result = await publishWeather(doc);
  log("published:", JSON.stringify(result));

  await writeJson("data/weather.json", doc);
  log("wrote data/weather.json mirror");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

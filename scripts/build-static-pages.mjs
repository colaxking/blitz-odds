#!/usr/bin/env node
/**
 * build-static-pages.mjs
 *
 * Phase 3 Stage 2: generates real, crawlable static HTML files for both
 * per-team pages (/teams/{team-slug}/index.html, 32 files - Stage 2a) and
 * per-game pages (/games/{year}/{week-slug}/{away}-at-{home}/index.html,
 * ~320 files across preseason + regular season - Stage 2b), so search
 * engines have actual indexable pages for team- and matchup-specific
 * queries instead of only the single homepage URL.
 *
 * Approach - no real SSR/build framework, hand-rolled to fit the site's
 * existing "no build step, deploy index.html as-is" architecture (same
 * spirit as scripts/backfill-historical-season.mjs's static archive pages):
 *   1. Take the production index.html as a template - same embedded JSON
 *      data blocks, same <script defer src="/js/app.js?v=..."> tag - so the
 *      exact same React app can still boot on top and take over for live
 *      interactivity (scores, odds, the box score modal, etc). The app
 *      itself is a precompiled bundle (scripts/build-app.mjs), so a page
 *      is ~85 KB of HTML plus one shared, cached bundle rather than 2 MB.
 *   2. Swap only the <head> tags that need to be page-specific (title,
 *      meta description, canonical, OG/Twitter mirrors) using the SAME
 *      copy useDocumentMeta() would set client-side, so there's no
 *      title/description flash on load.
 *   3. Insert a real, visible content snapshot (team stats, full schedule
 *      with predictions/results, injury report) right after <body> -
 *      this is what a non-JS-executing crawler or link-preview scraper
 *      actually sees.
 *   4. Leave the snapshot visible until the React app mounts - bootApp()
 *      in src/app.jsx hides it at that moment, so real visitors only ever
 *      see the one, fully-interactive version, and a slow connection shows
 *      real content in the meantime instead of a blank page.
 *
 * Run: node scripts/build-static-pages.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { buildApp, assertArtifactsFresh } from "./build-app.mjs";
import { siteHeaderHtml, SITE_NAV_LINK } from "./site-header.mjs";

const require = createRequire(import.meta.url);
/**
 * Writes `html` to `outPath`, and reports whether it actually differed from
 * what was already there.
 *
 * The "changed?" answer is the point. Every run regenerates all ~350 pages,
 * and before this the sitemap stamped today's date on all of them
 * regardless - so the moment the date rolled over, sitemap.xml differed
 * even when not a single page had. static-pages-refresh saw the diff,
 * committed, pushed, and Netlify ran a production deploy: 15 credits a day
 * for a timestamp, on a plan with 1,000 credits a month.
 *
 * It's also just wrong as SEO. lastmod is supposed to mean "this page
 * changed"; a sitemap claiming 353 pages changed every single day teaches
 * crawlers to ignore the field.
 *
 * Skipping the write when content matches is a small bonus - git compares
 * content, not mtime, so it wasn't causing the churn - but there's no
 * reason to rewrite 350 identical files either.
 */
async function writeIfChanged(outPath, html) {
  let existing = null;
  try {
    existing = await readFile(outPath, "utf8");
  } catch {
    // New file - falls through to the write below.
  }
  if (existing === html) return false;
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  // The file is always rewritten above - every page must reference the
  // current js/app.js / css/app.css build - but a diff that is ONLY those
  // `?v=<hash>` stamps isn't a content change. Counting it as one put
  // today's date on 380 of 382 sitemap URLs after every app build (preseason
  // week-1 games "modified" in November), which teaches Google to ignore
  // lastmod. Found in the 2026-11-18 Search Console review.
  if (existing !== null && stripAssetHashes(existing) === stripAssetHashes(html)) return false;
  return true;
}

/** Build-only cache-busting stamps: "/js/app.js?v=6b28fd717f" etc. */
function stripAssetHashes(html) {
  return html.replace(/\?v=[0-9a-f]{6,}/g, "?v=");
}

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const SITE_BASE = "https://blitz-odds.com";

const PredictionEngine = require(path.join(REPO_ROOT, "js/predictionEngine.js"));
const HotPicksEngine = require(path.join(REPO_ROOT, "js/hotPicksEngine.js"));

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function readJson(relPath) {
  return JSON.parse(await readFile(path.join(REPO_ROOT, relPath), "utf8"));
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Load data (same files index.html embeds at deploy time) --------------

// The app does not show what is committed under data/: on load it swaps in
// the document served by the site-data-current function (Netlify Blobs),
// which the weekly update and the injury jobs write first and the repo files
// trail - data/teams.json sat three weeks behind in November 2026, and the
// injury list drifts daily. Pages built from the files then disagreed with
// the game cards (a flipped pick on one game, 4-9 points on others). So the
// build asks the live site for the same team stats and injuries the app
// uses, and falls back to the committed files when it can't get a complete
// answer. STATIC_PAGES_OFFLINE=1 skips the request.
const LIVE_SITE_DATA_URL = `${SITE_BASE}/.netlify/functions/site-data-current`;

// Which flagged features a signed-out visitor (and so a crawler) gets: the
// same /features answer the app asks for. College and bowl links in the
// prerendered pages follow it, exactly as the tiles and footer links do in
// the app. Anything but a clear "on" - request failed, offline build - is off.
const BOWLS_VISIBLE_UNTIL = Date.parse("2027-02-01T12:00:00Z"); // = src/app.jsx
async function fetchPublicFeatures() {
  const off = { cfb: false, bowls: false };
  if (process.env.STATIC_PAGES_OFFLINE === "1") return off;
  try {
    const res = await fetch(`${SITE_BASE}/.netlify/functions/features`, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
    if (!res.ok) return off;
    const body = await res.json();
    if (!body || !body.ok || !body.features) return off;
    return { cfb: body.features.cfb === true, bowls: body.features.bowls === true && Date.now() < BOWLS_VISIBLE_UNTIL };
  } catch {
    return off;
  }
}

async function fetchLiveSiteData() {
  if (process.env.STATIC_PAGES_OFFLINE === "1") return null;
  try {
    const res = await fetch(LIVE_SITE_DATA_URL, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const doc = await res.json();
    const teams = doc && doc.teams && doc.teams.teams;
    const players = doc && doc.players && doc.players.players;
    // All or nothing: a partial document must not mix with the files.
    const rank = (t, side) => t && t.stats && t.stats[side] && Number.isFinite(t.stats[side].rankTotal);
    if (!Array.isArray(teams) || teams.length !== 32) return null;
    if (!teams.every((t) => t.id && t.name && rank(t, "offense") && rank(t, "defense") && t.priorStats && Number.isFinite(t.stats.gamesPlayed))) return null;
    if (!players || typeof players !== "object" || !teams.every((t) => Array.isArray(players[t.id]))) return null;
    return { teams, players, teamsAsOfWeek: doc.teams.asOfWeek };
  } catch {
    return null;
  }
}

async function loadData() {
  // The engine's prior-season blend needs priorStats + stats.gamesPlayed on
  // every team; the weekly-update task may rewrite teams.json without them.
  // Repair the file first so the committed copy and these pages agree.
  const { ensureTeamFieldsOnDisk } = await import("./ensure-team-fields.mjs");
  ensureTeamFieldsOnDisk({ log: (m) => console.log(`${new Date().toISOString()} ${m}`) });
  const [teamsFile, scheduleFile, preseasonFile, playoffsFile, playersFile, historyFile, stadiumsFile, oddsFile] = await Promise.all([
    readJson("data/teams.json"),
    readJson("data/schedule-full-2026.json"),
    readJson("data/schedule-preseason-2026.json"),
    readJson("data/schedule-playoffs-2026.json"),
    readJson("data/impact-players.json"),
    readJson("data/history.json"),
    readJson("data/stadiums.json"),
    readJson("data/odds-2026.json"),
  ]);
  // Committed by weather-refresh; the app reads the same numbers through
  // getWeather(). Optional - without it the pages just predict without weather.
  let weatherFile = { weeks: {} };
  try { weatherFile = await readJson("data/weather.json"); } catch { /* no weather file */ }
  const live = await fetchLiveSiteData();
  if (live) log(`Using live team stats (through Week ${live.teamsAsOfWeek ?? "?"}) and injuries from ${LIVE_SITE_DATA_URL}.`);
  else log("Live site data unavailable or disabled - using the committed data/teams.json and data/impact-players.json.");
  const features = await fetchPublicFeatures();
  log(`Feature flags for signed-out visitors: college ${features.cfb ? "on" : "off"}, bowls ${features.bowls ? "on" : "off"}.`);
  return {
    features,
    teams: live ? live.teams : teamsFile.teams,
    schedule: scheduleFile,
    preseason: preseasonFile,
    playoffs: playoffsFile,
    players: live ? live.players : playersFile.players,
    history: historyFile,
    stadiums: stadiumsFile,
    odds: oddsFile,
    weather: weatherFile,
    seasonYear: scheduleFile.season || new Date().getFullYear(),
  };
}

// ---- Small reimplementations of client-side helpers ------------------------
// Kept intentionally tiny and dependency-free rather than trying to import
// index.html's inline script directly - these mirror the exact logic of
// their client-side counterparts (see index.html: isPlayoffAnnounced,
// isDomeTeam, isVisibleInInjuryReport, STATUS_ORDER) so the static snapshot
// never disagrees with what the live app would show for the same data.

function isPlayoffAnnounced(round) {
  return !!round && round.matchupsAnnounced && round.games && round.games.length > 0;
}

function isDomeTeam(stadiums, teamId) {
  const entry = stadiums.teamStadiums && stadiums.teamStadiums[teamId];
  return !!(entry && entry.isDome);
}

const STATUS_ORDER = { active: 0, questionable: 1, out: 2 };
const ACTIVE_VISIBILITY_DAYS = 7;
function isVisibleInInjuryReport(p) {
  if (p.status !== "active") return true;
  if (!p.injury) return false;
  if (!p.activatedDate) return true;
  const activated = new Date(p.activatedDate);
  if (isNaN(activated.getTime())) return true;
  return (Date.now() - activated.getTime()) <= ACTIVE_VISIBILITY_DAYS * 24 * 60 * 60 * 1000;
}

function findTeam(teams, id) {
  return teams.find((t) => t.id === id);
}

function getPeriods(data) {
  const periods = [];
  data.preseason.rounds.forEach((r) => {
    if (isPlayoffAnnounced(r)) periods.push({ week: r.week, label: r.label, games: r.games, showByeIfMissing: false });
  });
  data.schedule.weeks.forEach((w) => periods.push({ week: w.week, label: `Week ${w.week}`, games: w.games, showByeIfMissing: true }));
  data.playoffs.rounds.forEach((r) => {
    if (isPlayoffAnnounced(r)) periods.push({ week: r.week, label: r.label, games: r.games, showByeIfMissing: false });
  });
  return periods;
}

function getHistorySnapshot(data, week) {
  return (data.history.weeks || []).find((w) => w.week === week) || null;
}

/** Team object + stats for a given week, preferring a frozen historical
 *  snapshot when one exists for that week (mirrors getWeekContext client-side) -
 *  falls back to the team's current/base stats otherwise. */
function teamForWeek(data, week, teamId) {
  const base = findTeam(data.teams, teamId);
  const snap = getHistorySnapshot(data, week);
  if (snap && snap.teamStats && snap.teamStats[teamId]) {
    return { ...base, stats: snap.teamStats[teamId] };
  }
  return base;
}

function resultForWeek(data, week, awayAbbr, homeAbbr) {
  const snap = getHistorySnapshot(data, week);
  if (!snap || !snap.results) return null;
  return snap.results[`${awayAbbr}-${homeAbbr}`] || null;
}

/** Impact players for a given week. A finished week's history entry carries
 *  the injury list the site ran on that week (impactPlayers); the app reads
 *  it through getWeekContext().getPlayers, and these pages must too - with
 *  today's list a finished game's "pregame pick" was recomputed against
 *  injuries that happened weeks later, and could flip the stated call. */
function playersForWeek(data, week, teamId) {
  const snap = getHistorySnapshot(data, week);
  if (snap) return (snap.impactPlayers && snap.impactPlayers[teamId]) || [];
  return data.players[teamId] || [];
}

/** Game weather, as the app's getWeather() reads it - so a page's win
 *  probability is the one the game card shows, not a weather-blind variant. */
function weatherForGame(data, week, away, home) {
  const wk = data.weather && data.weather.weeks && data.weather.weeks[String(week)];
  return (wk && wk.games && wk.games[`${away}-${home}`]) || null;
}

/** "Kansas City Chiefs" -> "Chiefs". Every NFL nickname is the last word. */
function nickname(team) {
  return String(team.name).split(" ").pop();
}

function weekHubPath(data, period) {
  return `/games/${data.seasonYear}/${slugify(period.label)}/`;
}

function gamePagePath(data, period, game) {
  const away = findTeam(data.teams, game.away);
  const home = findTeam(data.teams, game.home);
  return `${weekHubPath(data, period)}${slugify(away ? away.name : game.away)}-at-${slugify(home ? home.name : game.home)}/`;
}

/** Visible breadcrumb trail + matching BreadcrumbList JSON-LD. `trail` is
 *  [{ name, path }]; the last item is the current page and is not linked. */
function breadcrumbHtml(trail) {
  return `<nav aria-label="Breadcrumb"><p>${trail
    .map((t, i) => (i === trail.length - 1 ? escapeHtml(t.name) : `<a href="${t.path}">${escapeHtml(t.name)}</a>`))
    .join(" &rsaquo; ")}</p></nav>`;
}
function breadcrumbJsonLd(trail) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: `${SITE_BASE}${t.path}` })),
  };
  return `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
}

/** Title / H1 / description for one game page. Mirrored by gamePageMeta()
 *  in src/app.jsx (useDocumentMeta + the header <h1>) - keep the two in step.
 *  A finished game is described as a result and a model recap, never as an
 *  upcoming prediction. */
function gamePageMeta({ away, home, periodLabel, seasonYear, game, result, pickName, pickPct }) {
  const a = nickname(away);
  const h = nickname(home);
  if (result && result.final) {
    return {
      title: `${a} vs ${h} Final Score & Model Recap - NFL ${periodLabel} ${seasonYear} | Blitz Odds`,
      h1: `${away.name} vs ${home.name} - ${periodLabel} Final Score & Model Recap`,
      description: `Final: ${away.name} ${result.awayScore}, ${home.name} ${result.homeScore} (NFL ${periodLabel}, ${seasonYear}). How the Blitz Odds model called it, the betting line and the team-ranking matchup behind the pick.`,
    };
  }
  const when = game && game.date ? ` on ${game.date}` : "";
  const pick = pickName && pickPct ? ` The Blitz Odds model gives the ${pickName} ${/^(8|11|18)/.test(String(pickPct)) ? "an" : "a"} ${pickPct}% chance to win.` : "";
  return {
    title: `${a} vs ${h} Prediction, Win Probability & Pick'em Analysis - NFL ${periodLabel} ${seasonYear} | Blitz Odds`,
    h1: `${away.name} vs ${home.name} - ${periodLabel} Prediction & Matchup Analysis`,
    description: `${away.name} at ${home.name}${when}.${pick} Spread, moneyline, injuries and the matchup edges behind the pick.`,
  };
}

const DEFAULT_SPORTSBOOK_ID = "draftkings";
function getOdds(data, week, away, home) {
  const weekOdds = data.odds.weeks && data.odds.weeks[String(week)];
  if (!weekOdds || !weekOdds.games) return null;
  const game = weekOdds.games[`${away}-${home}`];
  if (!game) return null;
  const bookLine = game.books && game.books[DEFAULT_SPORTSBOOK_ID];
  return bookLine || game;
}

function formatSpread(spreadForFavorite) {
  if (spreadForFavorite === 0) return "PK";
  return spreadForFavorite > 0 ? `+${spreadForFavorite}` : `${spreadForFavorite}`;
}

function formatMoneyline(ml) {
  if (ml == null) return "";
  return ml > 0 ? `+${ml}` : `${ml}`;
}

const MONTH_INDEX_BY_ABBR = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** The UTC offset US Eastern time is actually on for a local date: -04:00
 *  (EDT) from the second Sunday of March to the first Sunday of November,
 *  -05:00 (EST) otherwise. The 2 AM switchover hour is ignored - no kickoff
 *  lands there. Used only for the published SportsEvent startDate; the
 *  app's own scheduling math keeps its fixed-offset convention untouched. */
function easternOffset(year, month, day) {
  const firstSunday = (m) => 1 + ((7 - new Date(Date.UTC(year, m, 1)).getUTCDay()) % 7);
  const dstStart = firstSunday(2) + 7;   // second Sunday of March
  const dstEnd = firstSunday(10);        // first Sunday of November
  const dst = (month > 2 && month < 10) || (month === 2 && day >= dstStart) || (month === 10 && day < dstEnd);
  return dst ? "-04:00" : "-05:00";
}
/** Mirrors src/app.jsx's iso8601GameStart exactly (real ET offset via
 *  easternOffset, month<=5 rolls to seasonYear+1) - returns null for "TBD"
 *  kickoff times (unflexed weeks 16-18) rather than guessing, same as the
 *  client. Until October 2026 this used a fixed -05:00 all season, which
 *  put every August-October kickoff an hour late in the structured data. */
function iso8601GameStart(game, seasonYear) {
  if (!game || !game.date || !game.time) return null;
  const dm = /([A-Za-z]+)\s+(\d+)\s*$/.exec(game.date);
  if (!dm) return null;
  const month = MONTH_INDEX_BY_ABBR[dm[1]];
  if (month == null) return null;
  const day = parseInt(dm[2], 10);
  const year = month <= 5 ? seasonYear + 1 : seasonYear;
  const tm = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(game.time);
  if (!tm) return null;
  let hour = parseInt(tm[1], 10) % 12;
  if (/pm/i.test(tm[3])) hour += 12;
  const minute = parseInt(tm[2], 10);
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${easternOffset(year, month, day)}`;
}

/** SportsEvent JSON-LD for one game - same shape as index.html's client-side
 *  gameToSportsEvent, except url points at this game's own canonical path
 *  instead of the homepage (the fix flagged when Phase 3 was first scoped:
 *  "per-game SportsEvent schema currently points url at the homepage"). */
function buildGameJsonLd(data, game, seasonYear, canonicalPath) {
  const startDate = iso8601GameStart(game, seasonYear);
  if (!startDate) return "";
  const home = findTeam(data.teams, game.home);
  const away = findTeam(data.teams, game.away);
  const homeName = home ? home.name : game.home;
  const awayName = away ? away.name : game.away;
  const event = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: `${awayName} at ${homeName}`,
    sport: "American Football",
    startDate,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    homeTeam: { "@type": "SportsTeam", name: homeName },
    awayTeam: { "@type": "SportsTeam", name: awayName },
    url: `${SITE_BASE}${canonicalPath}`,
  };
  if (game.international && game.note) {
    event.location = { "@type": "Place", name: game.note.replace(/^International Game\s*—\s*/, "") };
  } else {
    const stadium = data.stadiums.teamStadiums && data.stadiums.teamStadiums[game.home];
    if (stadium) event.location = { "@type": "Place", name: stadium.name };
  }
  return `<script type="application/ld+json">${JSON.stringify(event)}</script>`;
}

function rankRow(label, awayRank, homeRank) {
  const diff = homeRank - awayRank; // positive = away offense has the edge (lower rank number is better)
  return `<tr><td>${escapeHtml(label)}</td><td>#${escapeHtml(awayRank)}</td><td>#${escapeHtml(homeRank)}</td><td>${diff > 0 ? "away" : diff < 0 ? "home" : "even"} edge (${Math.abs(diff)})</td></tr>`;
}

// ---- Blitz Edge write-up ---------------------------------------------------
// Mirrors src/app.jsx buildRationale() for the straight-up format: the same
// sentences, in the same order, from the same inputs (computeCategoryEdges,
// describeEdge, describeWeatherFactor, rationaleTeaser are copied line for
// line). The write-up is the one piece of text that is genuinely different
// on every game page - without it the 300+ game pages are the same
// odds/rank/injury template with the names swapped, which is exactly what
// Google files as "crawled, currently not indexed". Keep the two in sync.
//
// The app shows signed-out visitors only the first sentence or two
// (rationaleTeaser) and gates the rest behind a free account. The
// prerender does the same split: the teaser is plain text, the remainder
// sits in a `.edge-writeup-full` element that the page's Article JSON-LD
// declares as isAccessibleForFree:false via hasPart/cssSelector - Google's
// documented way to index gated text without it reading as cloaking.
// Set GATED_WRITEUP_IN_HTML to false to prerender the teaser only.
const GATED_WRITEUP_IN_HTML = true;

function computeCategoryEdges(away, home) {
  const categories = [
    { label: "Total", key: "rankTotal" },
    { label: "Rush", key: "rankRush" },
    { label: "Pass", key: "rankPass" },
  ];
  const edges = [];
  categories.forEach(({ label, key }) => {
    edges.push({ category: label, offTeamId: away.id, offRank: away.stats.offense[key], defTeamId: home.id, defRank: home.stats.defense[key] });
    edges.push({ category: label, offTeamId: home.id, offRank: home.stats.offense[key], defTeamId: away.id, defRank: away.stats.defense[key] });
  });
  return edges.map((e) => {
    const diff = e.defRank - e.offRank;
    return { ...e, diff, favoredTeamId: diff === 0 ? null : diff > 0 ? e.offTeamId : e.defTeamId };
  });
}

function describeEdge(e) {
  const gap = Math.abs(e.diff);
  const cat = e.category.toLowerCase();
  return e.diff > 0
    ? `${e.offTeamId}'s ${cat} offense (#${e.offRank}) has a ${gap}-spot edge over ${e.defTeamId}'s ${cat} defense (#${e.defRank})`
    : `${e.defTeamId}'s ${cat} defense (#${e.defRank}) has a ${gap}-spot edge over ${e.offTeamId}'s ${cat} offense (#${e.offRank})`;
}

function describeWeatherFactor(a) {
  switch (a.factor) {
    case "cold": return `cold temps (${a.tempF}°F)`;
    case "extreme-cold": return `extreme cold (${a.tempF}°F)`;
    case "wind": return `wind (${a.windMph}mph)`;
    case "severe-wind": return `heavy wind (${a.windMph}mph)`;
    case "precipitation": return `a ${a.precipChance}% chance of precipitation`;
    default: return a.factor;
  }
}

function buildRationaleText({ away, home, prediction, odds }) {
  const homeIsWinner = prediction.predictedWinner === home.id;
  const winner = homeIsWinner ? home : away;
  const loser = homeIsWinner ? away : home;
  const loserAdjustments = homeIsWinner ? prediction.awayAdjustments : prediction.homeAdjustments;
  const confidencePct = Math.round(prediction.confidence * 100);
  const modelAgreesWithMarket = odds && odds.favorite ? odds.favorite === prediction.predictedWinner : null;

  const winningEdges = computeCategoryEdges(away, home)
    .filter((e) => e.favoredTeamId === winner.id)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const sentences = [`The model gives ${winner.name} a ${confidencePct}% chance to win this one.`];

  if (winningEdges.length) {
    const top = winningEdges.slice(0, 2).map(describeEdge);
    sentences.push(top.length > 1 ? `The biggest factors: ${top[0]}, and ${top[1]}.` : `The biggest factor: ${top[0]}.`);
  } else {
    sentences.push(`${away.name} and ${home.name} grade out close to even across offense and defense.`);
  }

  if (homeIsWinner) sentences.push(`Home field adds a small extra boost on top of that.`);

  const weatherFactors = (prediction.homeAdjustments || []).filter((a) => a.factor && a.factor !== "dome-team-acclimation");
  if (weatherFactors.length) {
    sentences.push(`Weather is a factor: ${weatherFactors.map(describeWeatherFactor).join(", ")}, which drags down offense for both sides.`);
  }
  const domeAdj = [...(prediction.homeAdjustments || []), ...(prediction.awayAdjustments || [])].find((a) => a.factor === "dome-team-acclimation");
  if (domeAdj) {
    const domeTeam = (prediction.homeAdjustments || []).includes(domeAdj) ? home : away;
    sentences.push(`${domeTeam.id} plays its home games in a dome, which adds a small extra penalty on the road in these conditions.`);
  }

  if (loserAdjustments && loserAdjustments.length) {
    const injuryAdjustments = loserAdjustments.filter((a) => a.player);
    if (injuryAdjustments.length) {
      const biggest = [...injuryAdjustments].sort((a, b) => Math.abs(b.ratingDelta) - Math.abs(a.ratingDelta))[0];
      sentences.push(`${loser.id} is also dealing with ${biggest.player} (${biggest.position}) listed as ${biggest.status}, which tips things further ${winner.id}'s way.`);
    }
  }

  if (odds && modelAgreesWithMarket === false) {
    sentences.push(`Note: the sportsbook favorite (${odds.favorite}) disagrees with this pick.`);
  }

  return sentences.join(" ");
}

/** Same regex as the app: the first one or two sentences. */
function rationaleTeaser(text) {
  if (!text) return "";
  const match = /^(?:[\s\S]*?[.!?](?=\s|$)\s*){1,2}/.exec(text);
  return match ? match[0].trim() : text;
}

/** Teaser paragraph plus, when enabled, the gated remainder. Returns the
 *  HTML and whether a gated part was emitted (the caller adds the Article
 *  JSON-LD that declares it). */
function buildGatedWriteupHtml(text, gatedClass) {
  const teaser = rationaleTeaser(text);
  const rest = text.slice(teaser.length).trim();
  let html = `<p>${escapeHtml(teaser)}</p>`;
  let gated = false;
  if (rest && GATED_WRITEUP_IN_HTML) {
    html += `\n  <div class="${gatedClass}"><p>${escapeHtml(rest)}</p></div>`;
    gated = true;
  }
  if (rest && !GATED_WRITEUP_IN_HTML) {
    html += `\n  <p><em>Sign in for the rest of this write-up.</em></p>`;
  }
  return { html, gated };
}

/** Article JSON-LD for a page whose prerendered text is partly behind the
 *  free-account gate. hasPart/cssSelector + isAccessibleForFree:false is
 *  the markup Google asks for on registration- or paywall-gated content;
 *  it is what distinguishes "indexed but gated" from hidden text. */
function buildGatedArticleJsonLd({ headline, description, canonicalPath, gatedClass, datePublished }) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline,
    description,
    mainEntityOfPage: `${SITE_BASE}${canonicalPath}`,
    author: { "@type": "Organization", name: "Blitz Odds", url: SITE_BASE },
    publisher: { "@type": "Organization", name: "Blitz Odds", url: SITE_BASE, logo: { "@type": "ImageObject", url: `${SITE_BASE}/branding/app-icon-512.png` } },
    image: `${SITE_BASE}/branding/app-icon-512.png`,
    isAccessibleForFree: false,
    hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: `.${gatedClass}` },
  };
  if (datePublished) ld.datePublished = datePublished;
  return `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
}

/** Insert a prerendered snapshot right after the real <body> tag - the
 *  first one AFTER </head>, so a "<body>" inside a <head> comment (which
 *  once swallowed every snapshot) can never be mistaken for it. */
function injectAfterBody(html, snapshot) {
  const headEnd = html.indexOf("</head>");
  const bodyAt = html.indexOf("<body>", headEnd < 0 ? 0 : headEnd);
  if (bodyAt < 0) throw new Error("template has no <body> tag after </head>");
  const insertAt = bodyAt + "<body>".length;
  return html.slice(0, insertAt) + "\n" + snapshot + html.slice(insertAt);
}

/** Set by the snapshot builders: did the last snapshot emit a gated part? */
let lastSnapshotGated = false;
/** Set by buildGameSnapshotHtml: the title/H1/description and breadcrumb
 *  trail of the game it just rendered, for buildGamePage's <head>. */
let lastGameMeta = null;
let lastGameTrail = null;

function buildGameSnapshotHtml(data, period, game) {
  const away = teamForWeek(data, period.week, game.away);
  const home = teamForWeek(data, period.week, game.home);
  const awayPlayers = playersForWeek(data, period.week, game.away);
  const homePlayers = playersForWeek(data, period.week, game.home);
  const prediction = PredictionEngine.predictMatchup({
    homeTeam: home,
    awayTeam: away,
    homeImpactPlayers: homePlayers,
    awayImpactPlayers: awayPlayers,
    weather: weatherForGame(data, period.week, game.away, game.home),
    homeIsDomeTeam: isDomeTeam(data.stadiums, game.home),
    awayIsDomeTeam: isDomeTeam(data.stadiums, game.away),
    // Weeks 1-4 (and preseason) run on prior-season ranks and take the
    // wider early-season curve; without this the crawler text reads more
    // confident than the app does for the same game.
    week: period.week,
  });
  const homePct = Math.round(prediction.homeWinProbability * 100);
  const awayPct = Math.round(prediction.awayWinProbability * 100);
  const predictedWinnerName = prediction.predictedWinner === home.id ? home.name : away.name;

  const result = resultForWeek(data, period.week, game.away, game.home);
  const isFinal = !!(result && result.final);
  const pickPct = prediction.predictedWinner === home.id ? homePct : awayPct;
  const meta = gamePageMeta({ away, home, periodLabel: period.label, seasonYear: data.seasonYear, game, result, pickName: nickname(prediction.predictedWinner === home.id ? home : away), pickPct });
  lastGameMeta = meta;
  const hubPath = weekHubPath(data, period);
  const trail = [
    { name: "Blitz Odds", path: "/" },
    { name: "NFL games", path: "/games/" },
    { name: `${period.label} picks`, path: hubPath },
    { name: `${nickname(away)} vs ${nickname(home)}`, path: gamePagePath(data, period, game) },
  ];
  lastGameTrail = trail;
  // The rest of the slate, so every game page links sideways to its week
  // (they used to link only to the two team pages and the homepage).
  const otherGames = period.games
    .filter((g) => g !== game && findTeam(data.teams, g.away) && findTeam(data.teams, g.home))
    .map((g) => `    <li><a href="${gamePagePath(data, period, g)}">${escapeHtml(findTeam(data.teams, g.away).name)} at ${escapeHtml(findTeam(data.teams, g.home).name)}</a></li>`)
    .join("\n");
  let resultBlock = "";
  if (result && result.final) {
    const actualWinnerId = result.homeScore > result.awayScore ? game.home : game.away;
    const actualWinnerName = actualWinnerId === home.id ? home.name : away.name;
    const correct = actualWinnerId === prediction.predictedWinner;
    resultBlock = `<p><strong>Final:</strong> ${escapeHtml(away.name)} ${result.awayScore} - ${result.homeScore} ${escapeHtml(home.name)}. ${escapeHtml(actualWinnerName)} won. The model's pregame pick was ${correct ? "correct" : "incorrect"}.</p>`;
  }

  const stadiumEntry = !game.international && data.stadiums.teamStadiums && data.stadiums.teamStadiums[game.home];
  const stadiumName = stadiumEntry ? stadiumEntry.name : "";
  const odds = getOdds(data, period.week, game.away, game.home);
  const writeup = buildGatedWriteupHtml(buildRationaleText({ away, home, prediction, odds }), "edge-writeup-full");
  lastSnapshotGated = writeup.gated;
  const oddsBlock = odds
    ? `<p><strong>Odds (DraftKings):</strong> ${escapeHtml(odds.favorite)} ${escapeHtml(formatSpread(odds.spread))} · ML ${escapeHtml(game.away)} ${escapeHtml(formatMoneyline(odds.moneylineAway))} / ${escapeHtml(game.home)} ${escapeHtml(formatMoneyline(odds.moneylineHome))} · O/U ${escapeHtml(odds.overUnder)}</p>`
    : `<p>Odds not yet posted for this game.</p>`;

  const injuries = [...awayPlayers.map((p) => ({ ...p, teamAbbr: game.away })), ...homePlayers.map((p) => ({ ...p, teamAbbr: game.home }))]
    .filter(isVisibleInInjuryReport)
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3))
    .map(
      (p) =>
        `<li><strong>${escapeHtml(p.name)}</strong> (${escapeHtml(p.teamAbbr)} · ${escapeHtml(p.position)}) - ${escapeHtml(p.status)}${p.injury && p.injury.type ? " - " + escapeHtml(p.injury.type) : ""}</li>`
    )
    .join("\n");

  return `
<div id="prerendered-content">
  ${breadcrumbHtml(trail)}
  <h1>${escapeHtml(meta.h1)}</h1>
  <p>${escapeHtml(meta.description)}</p>
  <p>${escapeHtml(away.name)} at ${escapeHtml(home.name)} · NFL ${escapeHtml(period.label)}, ${data.seasonYear} season · ${escapeHtml(game.date)}${game.time ? " · " + escapeHtml(game.time) : ""}${game.network ? " · " + escapeHtml(game.network) : ""}${stadiumName ? " · " + escapeHtml(stadiumName) : ""}</p>

  ${resultBlock}
  ${oddsBlock}

  <h2>${isFinal ? "How the model called it" : "Model prediction and win probability"}</h2>
  <p>${isFinal ? "Pregame pick" : "Predicted winner"}: <strong>${escapeHtml(predictedWinnerName)}</strong> - ${escapeHtml(game.away)} ${awayPct}% / ${escapeHtml(game.home)} ${homePct}%</p>
  ${isFinal ? "" : `<p>Straight-up pick'em pick: <strong>${escapeHtml(predictedWinnerName)}</strong>. See where this game sits on the <a href="${hubPath}">${escapeHtml(period.label)} confidence pool ladder</a>, or get the survivor and against-the-spread sheets in the <a href="/picks/">Pick'em Playbook</a>.</p>`}

  <h2>Blitz Edge: why the model ${isFinal ? "liked" : "likes"} ${escapeHtml(predictedWinnerName)}</h2>
  ${writeup.html}

  <h2>Team stats comparison (rank out of 32)</h2>
  <table>
    <thead><tr><th></th><th>${escapeHtml(game.away)} offense</th><th>${escapeHtml(game.home)} offense</th><th>Edge</th></tr></thead>
    <tbody>
      ${rankRow("Total yards", away.stats.offense.rankTotal, home.stats.offense.rankTotal)}
      ${rankRow("Rush yards", away.stats.offense.rankRush, home.stats.offense.rankRush)}
      ${rankRow("Pass yards", away.stats.offense.rankPass, home.stats.offense.rankPass)}
    </tbody>
  </table>
  <table>
    <thead><tr><th></th><th>${escapeHtml(game.away)} defense</th><th>${escapeHtml(game.home)} defense</th><th>Edge</th></tr></thead>
    <tbody>
      ${rankRow("Total yards allowed", away.stats.defense.rankTotal, home.stats.defense.rankTotal)}
      ${rankRow("Rush yards allowed", away.stats.defense.rankRush, home.stats.defense.rankRush)}
      ${rankRow("Pass yards allowed", away.stats.defense.rankPass, home.stats.defense.rankPass)}
    </tbody>
  </table>

  ${injuries ? `<h2>Injury report${isFinal ? " (as of that week)" : ""}</h2>\n  <ul>\n${injuries}\n  </ul>` : ""}

  <h2>Teams</h2>
  <p>
    <a href="/teams/${slugify(away.name)}/">${escapeHtml(away.name)} schedule, odds &amp; predictions</a> ·
    <a href="/teams/${slugify(home.name)}/">${escapeHtml(home.name)} schedule, odds &amp; predictions</a>
  </p>

  ${otherGames ? `<h2>More ${escapeHtml(period.label)} games</h2>\n  <ul>\n${otherGames}\n  </ul>` : ""}

  <p>
    <a href="${hubPath}">All ${escapeHtml(period.label)} picks &amp; predictions</a> ·
    <a href="/games/">This week's NFL games</a> ·
    <a href="/leagues/">Play these picks in a free pick'em league</a>
  </p>
</div>`;
}

function buildGameHead(template, title, description, canonicalPath) {
  const canonicalUrl = `${SITE_BASE}${canonicalPath}`;

  let html = template;
  html = html.replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(title)}</title>`);
  html = html.replace(/<meta name="description" content=".*?" \/>/s, `<meta name="description" content="${escapeHtml(description)}" />`);
  html = html.replace(/<link rel="canonical" href=".*?" \/>/s, `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`);
  html = html.replace(/<meta property="og:title" content=".*?" \/>/s, `<meta property="og:title" content="${escapeHtml(title)}" />`);
  html = html.replace(/<meta property="og:description" content=".*?" \/>/s, `<meta property="og:description" content="${escapeHtml(description)}" />`);
  html = html.replace(/<meta property="og:url" content=".*?" \/>/s, `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`);
  html = html.replace(/<meta name="twitter:title" content=".*?" \/>/s, `<meta name="twitter:title" content="${escapeHtml(title)}" />`);
  html = html.replace(/<meta name="twitter:description" content=".*?" \/>/s, `<meta name="twitter:description" content="${escapeHtml(description)}" />`);
  return html;
}

async function buildGamePage(template, data, period, game) {
  const away = findTeam(data.teams, game.away);
  const home = findTeam(data.teams, game.home);
  if (!away || !home) return null;

  const weekSlug = slugify(period.label);
  const canonicalPath = `/games/${data.seasonYear}/${weekSlug}/${slugify(away.name)}-at-${slugify(home.name)}/`;

  // Snapshot first: it works out the result / pick the head metadata needs.
  const snapshot = buildGameSnapshotHtml(data, period, game);
  let html = buildGameHead(template, lastGameMeta.title, lastGameMeta.description, canonicalPath);

  const jsonLd = buildGameJsonLd(data, game, data.seasonYear, canonicalPath);
  if (jsonLd) html = html.replace("</head>", `${jsonLd}\n</head>`);
  html = html.replace("</head>", `${breadcrumbJsonLd(lastGameTrail)}\n</head>`);

  if (lastSnapshotGated) {
    const articleLd = buildGatedArticleJsonLd({
      headline: `${away.name} vs ${home.name} - ${period.label} prediction and Blitz Edge write-up`,
      description: `Why the Blitz Odds model picks its winner in ${away.name} at ${home.name}: the matchup edges, injuries and market read behind the number.`,
      canonicalPath,
      gatedClass: "edge-writeup-full",
    });
    html = html.replace("</head>", `${articleLd}\n</head>`);
  }
  html = injectAfterBody(html, snapshot);
  // The snapshot is hidden by the app itself the moment React mounts (see
  // bootApp() in src/app.jsx) - no inline hide script here any more.


  const outPath = path.join(REPO_ROOT, "games", String(data.seasonYear), weekSlug, `${slugify(away.name)}-at-${slugify(home.name)}`, "index.html");
  const changed = await writeIfChanged(outPath, html);
  return { path: canonicalPath, changed };
}

// ---- Week hub pages --------------------------------------------------------
// /games/{year}/{week-slug}/ - the level between /games and the per-matchup
// pages, which had no file of its own: the non-forced `/games/* /index.html
// 200` rewrite answered it with the homepage, so every week hub was a soft
// 404 serving duplicate content.
//
// This is also the page that matches how pick'em players actually search.
// The per-game pages target "{team} vs {team} prediction"; the head terms
// ("week 1 pick em picks", "confidence pool picks week 1") are week-level,
// and /picks is a single rolling URL that can't accumulate signal per week.
//
// The content is the confidence ladder itself: every game in the period run
// through the same PredictionEngine call the per-game snapshot makes, sorted
// by the model's confidence in the favorite, and numbered N..1 the way a
// confidence pool assigns points. That's the finished artifact a pool player
// wants, and it's genuinely useful prerendered - no JS needed to read it.

/** Every game in a period, predicted and sorted into confidence order.
 *  Highest win probability gets the most points, matching how a pool
 *  assigns N points down to 1 across N games. */
function buildLadder(data, period) {
  const rows = [];
  for (const game of period.games) {
    const away = teamForWeek(data, period.week, game.away);
    const home = teamForWeek(data, period.week, game.home);
    if (!away || !home) continue;
    const prediction = PredictionEngine.predictMatchup({
      homeTeam: home,
      awayTeam: away,
      homeImpactPlayers: playersForWeek(data, period.week, game.home),
      awayImpactPlayers: playersForWeek(data, period.week, game.away),
      weather: weatherForGame(data, period.week, game.away, game.home),
      homeIsDomeTeam: isDomeTeam(data.stadiums, game.home),
      awayIsDomeTeam: isDomeTeam(data.stadiums, game.away),
      week: period.week,
    });
    const pickIsHome = prediction.predictedWinner === home.id;
    const winPct = Math.round(
      (pickIsHome ? prediction.homeWinProbability : prediction.awayWinProbability) * 100
    );
    rows.push({
      game,
      away,
      home,
      prediction,
      pickName: pickIsHome ? home.name : away.name,
      pickAbbr: pickIsHome ? game.home : game.away,
      winPct,
      odds: getOdds(data, period.week, game.away, game.home),
      result: resultForWeek(data, period.week, game.away, game.home),
      slug: `${slugify(away.name)}-at-${slugify(home.name)}`,
    });
  }
  rows.sort((a, b) => b.winPct - a.winPct);
  return rows.map((r, i) => ({ ...r, points: rows.length - i }));
}

function buildWeekHubSnapshotHtml(data, period, ladder, prev, next, allPeriods) {
  const seasonYear = data.seasonYear;
  const weekSlug = slugify(period.label);
  const gameUrl = (row) => `/games/${seasonYear}/${weekSlug}/${row.slug}/`;

  const ladderRows = ladder
    .map((r) => {
      const spread = r.odds ? `${escapeHtml(r.odds.favorite)} ${escapeHtml(formatSpread(r.odds.spread))}` : "-";
      const kickoff = `${escapeHtml(r.game.date)}${r.game.time ? " · " + escapeHtml(r.game.time) : ""}`;
      return `<tr><td>${r.points}</td><td><strong>${escapeHtml(r.pickName)}</strong></td>` +
        `<td><a href="${gameUrl(r)}">${escapeHtml(r.away.name)} at ${escapeHtml(r.home.name)}</a></td>` +
        `<td>${r.winPct}%</td><td>${spread}</td><td>${kickoff}</td></tr>`;
    })
    .join("\n      ");

  // Games that have already been played, so the page stays useful (and
  // honest) after kickoff instead of showing a stale set of predictions.
  const settled = ladder.filter((r) => r.result && r.result.final);
  const hits = settled.filter((r) => {
    const winnerId = r.result.homeScore > r.result.awayScore ? r.game.home : r.game.away;
    return winnerId === r.pickAbbr;
  }).length;
  const resultsBlock = settled.length
    ? `<h2>Results</h2>\n  <p>The model went <strong>${hits}-${settled.length - hits}</strong> on ${escapeHtml(period.label)} games played so far.</p>\n  <ul>\n${settled
        .map((r) => {
          const winnerId = r.result.homeScore > r.result.awayScore ? r.game.home : r.game.away;
          const correct = winnerId === r.pickAbbr;
          return `    <li><a href="${gameUrl(r)}">${escapeHtml(r.away.name)} ${r.result.awayScore} - ${r.result.homeScore} ${escapeHtml(r.home.name)}</a> - picked ${escapeHtml(r.pickName)} (${correct ? "correct" : "incorrect"})</li>`;
        })
        .join("\n")}\n  </ul>`
    : "";

  const nav = [
    prev ? `<a href="/games/${seasonYear}/${slugify(prev.label)}/">&laquo; ${escapeHtml(prev.label)}</a>` : "",
    next ? `<a href="/games/${seasonYear}/${slugify(next.label)}/">${escapeHtml(next.label)} &raquo;</a>` : "",
    `<a href="/games/">This week's NFL games</a>`,
    `<a href="/picks/">Confidence, survivor &amp; ATS sheets</a>`,
    `<a href="/leagues/">Free pick'em leagues</a>`,
  ]
    .filter(Boolean)
    .join(" · ");
  const allWeeks = (allPeriods || [])
    .map((p) => (p === period ? `<strong>${escapeHtml(p.label)}</strong>` : `<a href="${weekHubPath(data, p)}">${escapeHtml(p.label)}</a>`))
    .join(" · ");
  const trail = [
    { name: "Blitz Odds", path: "/" },
    { name: "NFL games", path: "/games/" },
    { name: `${period.label} picks`, path: weekHubPath(data, period) },
  ];

  return `
<div id="prerendered-content">
  ${breadcrumbHtml(trail)}
  <h1>NFL ${escapeHtml(period.label)} Picks &amp; Predictions - ${seasonYear}</h1>
  <p>Blitz Odds model picks for all ${ladder.length} ${escapeHtml(period.label)} games, ranked into a full confidence pool ladder. Win probabilities are adjusted for team rankings, injuries, and home field. Free, no account needed.</p>

  <h2>${escapeHtml(period.label)} confidence pool ladder</h2>
  <p>Assign ${ladder.length} points to the top row down to 1 point at the bottom - the model's most confident pick first.</p>
  <table>
    <thead><tr><th>Points</th><th>Pick</th><th>Matchup</th><th>Win probability</th><th>Spread</th><th>Kickoff</th></tr></thead>
    <tbody>
      ${ladderRows}
    </tbody>
  </table>

  ${resultsBlock}

  <p>${nav}</p>
  ${allWeeks ? `<h2>${seasonYear} NFL season by week</h2>\n  <p>${allWeeks}</p>` : ""}
</div>`;
}

/** ItemList of the week's SportsEvents. The per-game pages each carry their
 *  own SportsEvent; this is the collection-level equivalent, and it gives
 *  the hub an explicit machine-readable link to every game under it. */
function buildWeekHubJsonLd(data, period, ladder, canonicalPath) {
  const items = ladder
    .map((r, i) => {
      const startDate = iso8601GameStart(r.game, data.seasonYear);
      const event = {
        "@type": "SportsEvent",
        name: `${r.away.name} at ${r.home.name}`,
        sport: "American Football",
        url: `${SITE_BASE}/games/${data.seasonYear}/${slugify(period.label)}/${r.slug}/`,
        homeTeam: { "@type": "SportsTeam", name: r.home.name },
        awayTeam: { "@type": "SportsTeam", name: r.away.name },
      };
      if (startDate) event.startDate = startDate;
      return { "@type": "ListItem", position: i + 1, item: event };
    });
  if (!items.length) return "";
  const list = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `NFL ${period.label} ${data.seasonYear} games`,
    url: `${SITE_BASE}${canonicalPath}`,
    numberOfItems: items.length,
    itemListElement: items,
  };
  return `<script type="application/ld+json">${JSON.stringify(list)}</script>`;
}

async function buildWeekHubPage(template, data, period, prev, next, allPeriods) {
  const ladder = buildLadder(data, period);
  if (!ladder.length) return null;

  const weekSlug = slugify(period.label);
  const canonicalPath = `/games/${data.seasonYear}/${weekSlug}/`;
  const isNumberedWeek = /^Week \d+$/.test(period.label);
  const title = isNumberedWeek
    ? `NFL ${period.label} Pick'em Picks & Confidence Pool Rankings ${data.seasonYear} | Blitz Odds`
    : `NFL ${period.label} Picks & Predictions ${data.seasonYear} | Blitz Odds`;
  const description = `Free model picks for all ${ladder.length} NFL ${period.label} games, ranked into a confidence pool ladder with win probabilities, spreads, and injury-adjusted predictions.`;

  let html = applyMeta(template, { title, description, canonicalPath });

  const jsonLd = buildWeekHubJsonLd(data, period, ladder, canonicalPath);
  if (jsonLd) html = html.replace("</head>", `${jsonLd}\n</head>`);
  html = html.replace("</head>", `${breadcrumbJsonLd([
    { name: "Blitz Odds", path: "/" },
    { name: "NFL games", path: "/games/" },
    { name: `${period.label} picks`, path: canonicalPath },
  ])}\n</head>`);

  html = injectAfterBody(html, buildWeekHubSnapshotHtml(data, period, ladder, prev, next, allPeriods));
  // Hidden by bootApp() in src/app.jsx once React mounts.

  const outPath = path.join(REPO_ROOT, "games", String(data.seasonYear), weekSlug, "index.html");
  const changed = await writeIfChanged(outPath, html);
  return { path: canonicalPath, changed };
}

/** One schedule row for a given team/week/game - opponent, date, real result
 *  if the game's been played, and the model's predicted winner/probability
 *  otherwise (same PredictionEngine call the live TeamView schedule tab
 *  makes, minus weather - WEATHER_DATA starts empty at deploy time same as
 *  the live app, so omitting it here doesn't diverge from what a fresh page
 *  load would show anyway). */
function buildScheduleRow(data, period, teamId, game) {
  const isHome = game.home === teamId;
  const oppId = isHome ? game.away : game.home;
  const opp = findTeam(data.teams, oppId);
  const homeTeam = teamForWeek(data, period.week, game.home);
  const awayTeam = teamForWeek(data, period.week, game.away);
  const homePlayers = playersForWeek(data, period.week, game.home);
  const awayPlayers = playersForWeek(data, period.week, game.away);
  const prediction = PredictionEngine.predictMatchup({
    homeTeam,
    awayTeam,
    homeImpactPlayers: homePlayers,
    awayImpactPlayers: awayPlayers,
    weather: weatherForGame(data, period.week, game.away, game.home),
    homeIsDomeTeam: isDomeTeam(data.stadiums, game.home),
    awayIsDomeTeam: isDomeTeam(data.stadiums, game.away),
    // Weeks 1-4 (and preseason) run on prior-season ranks and take the
    // wider early-season curve; without this the crawler text reads more
    // confident than the app does for the same game.
    week: period.week,
  });
  const teamWins = prediction.predictedWinner === teamId;
  const teamWinProb = Math.round((isHome ? prediction.homeWinProbability : prediction.awayWinProbability) * 100);
  const result = resultForWeek(data, period.week, game.away, game.home);

  let resultText = "Not played yet";
  if (result && result.final) {
    const actualWinnerId = result.homeScore > result.awayScore ? game.home : game.away;
    const teamWon = actualWinnerId === teamId;
    const correct = teamWon === teamWins;
    const teamScore = isHome ? result.homeScore : result.awayScore;
    const oppScore = isHome ? result.awayScore : result.homeScore;
    // Leads with this team's own result rather than the raw away-home line.
    // Same reasoning as the app's mobile card: on a team page, "did they
    // win" is the question, and "TEN 19 - 13 SF" makes the reader work it
    // out. The full line still follows for anyone parsing the box score.
    resultText = `${teamWon ? "W" : "L"} ${teamScore}-${oppScore} (${game.away} ${result.awayScore} - ${result.homeScore} ${game.home}${correct ? ", prediction correct" : ", prediction missed"})`;
  }

  const teamName = (findTeam(data.teams, teamId) || {}).name || teamId;
  const oppName = (opp || {}).name || oppId;
  const predictedWinnerName = teamWins ? teamName : oppName;

  const awayName = (findTeam(data.teams, game.away) || {}).name || game.away;
  const homeName = (findTeam(data.teams, game.home) || {}).name || game.home;

  return {
    label: period.label,
    opponent: oppName,
    location: isHome ? "vs" : "@",
    date: game.date,
    time: game.time || "",
    network: game.network || "",
    predictedText: `Model predicts ${predictedWinnerName} to win`,
    winProbPct: teamWinProb,
    resultText,
    // Every period getPeriods() yields also gets a page written for it by
    // buildGamePage(), built from the same slugify(period.label), so these
    // never point at a URL that doesn't exist.
    gamePath: `/games/${data.seasonYear}/${slugify(period.label)}/${slugify(awayName)}-at-${slugify(homeName)}/`,
    opponentPath: `/teams/${slugify(oppName)}/`,
  };
}

// ---- Static content snapshot (the part crawlers/scrapers actually see) ----

function statRow(label, off, def) {
  return `<tr><td>${escapeHtml(label)}</td><td>#${escapeHtml(off)}</td><td>#${escapeHtml(def)}</td></tr>`;
}

function buildTeamSnapshotHtml(data, team) {
  const stats = team.stats;
  const periods = getPeriods(data);
  const current = currentPeriod(data, periods);
  const rows = [];
  periods.forEach((period) => {
    const game = period.games.find((g) => g.home === team.id || g.away === team.id);
    if (!game) {
      if (period.showByeIfMissing) rows.push(`<tr><td>${escapeHtml(period.label)}</td><td colspan="4">Bye week</td></tr>`);
      return;
    }
    const row = buildScheduleRow(data, period, team.id, game);
    // The snapshot listed 21 matchups and linked to none of them, so the
    // per-game pages this same script writes were reachable only from the
    // week view. Two links per row: the matchup's own page, and the
    // opponent's team page.
    rows.push(
      `<tr><td><a href="${row.gamePath}">${escapeHtml(row.label)}</a></td><td>${escapeHtml(row.location)} <a href="${row.opponentPath}">${escapeHtml(row.opponent)}</a></td><td>${escapeHtml(row.date)}${row.time ? " " + escapeHtml(row.time) : ""}</td><td>${escapeHtml(row.predictedText)} (${row.winProbPct}%)</td><td>${escapeHtml(row.resultText)}</td></tr>`
    );
  });

  const injuryRows = [...(data.players[team.id] || [])]
    .filter(isVisibleInInjuryReport)
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3))
    .map(
      (p) =>
        `<li><strong>${escapeHtml(p.name)}</strong> (${escapeHtml(p.position)}) - ${escapeHtml(p.status)}${p.injury && p.injury.type ? " - " + escapeHtml(p.injury.type) : ""}</li>`
    )
    .join("\n");

  return `
<div id="prerendered-content">
  ${breadcrumbHtml(teamTrail(team))}
  <h1>${escapeHtml(team.name)} Schedule, Odds &amp; Predictions</h1>
  <p>${escapeHtml(team.name)} full 2026 schedule with matchup predictions, win probabilities, and injury report - powered by Blitz Odds' team-ranking model.</p>

  <h2>${escapeHtml(team.name)} team stats (rank out of 32)</h2>
  <table>
    <thead><tr><th></th><th>Offense</th><th>Defense</th></tr></thead>
    <tbody>
      ${statRow("Total yards", stats.offense.rankTotal, stats.defense.rankTotal)}
      ${statRow("Rush yards", stats.offense.rankRush, stats.defense.rankRush)}
      ${statRow("Pass yards", stats.offense.rankPass, stats.defense.rankPass)}
    </tbody>
  </table>

  <h2>${escapeHtml(team.name)} 2026 schedule</h2>
  <table>
    <thead><tr><th>Week</th><th>Opponent</th><th>Date</th><th>Prediction</th><th>Result</th></tr></thead>
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table>

  ${injuryRows ? `<h2>${escapeHtml(team.name)} injury report</h2>\n  <ul>\n${injuryRows}\n  </ul>` : ""}

  <p>
    ${current ? `<a href="${weekHubPath(data, current)}">NFL ${escapeHtml(current.label)} picks &amp; predictions</a> · ` : ""}<a href="/teams/">All 32 NFL teams</a> · <a href="/games/">This week's NFL games</a> ·
    <a href="/picks/">Pick'em Playbook</a> ·
    <a href="/leagues/">Free pick'em leagues</a>
  </p>
</div>`;
}

function teamTrail(team) {
  return [
    { name: "Blitz Odds", path: "/" },
    { name: "NFL teams", path: "/teams/" },
    { name: team.name, path: `/teams/${slugify(team.name)}/` },
  ];
}

// ---- Head tag replacement (same copy useDocumentMeta sets client-side) ----

function buildHead(template, team, canonicalPath) {
  const title = `${team.name} Schedule, Odds & Predictions | Blitz Odds`;
  const description = `${team.name} full schedule, injury report, and NFL odds. See this week's matchup prediction and win probability for ${team.name}.`;
  return applyMeta(template, { title, description, canonicalPath });
}

/** Rewrites the shared <head> metadata (title, description, canonical, and
 *  the OG/Twitter mirrors of both) for one prerendered page. Split out of
 *  buildHead so the tab pages below can reuse it without inventing a fake
 *  team object. */
function applyMeta(template, { title, description, canonicalPath }) {
  const canonicalUrl = `${SITE_BASE}${canonicalPath}`;

  let html = template;
  html = html.replace(
    /<title>.*?<\/title>/s,
    `<title>${escapeHtml(title)}</title>`
  );
  html = html.replace(
    /<meta name="description" content=".*?" \/>/s,
    `<meta name="description" content="${escapeHtml(description)}" />`
  );
  html = html.replace(
    /<link rel="canonical" href=".*?" \/>/s,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`
  );
  html = html.replace(
    /<meta property="og:title" content=".*?" \/>/s,
    `<meta property="og:title" content="${escapeHtml(title)}" />`
  );
  html = html.replace(
    /<meta property="og:description" content=".*?" \/>/s,
    `<meta property="og:description" content="${escapeHtml(description)}" />`
  );
  html = html.replace(
    /<meta property="og:url" content=".*?" \/>/s,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`
  );
  html = html.replace(
    /<meta name="twitter:title" content=".*?" \/>/s,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`
  );
  html = html.replace(
    /<meta name="twitter:description" content=".*?" \/>/s,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`
  );
  return html;
}

/** SportsTeam JSON-LD, appended alongside the existing WebSite/Organization
 *  block already in <head> (not replacing it - both are valid on the same
 *  page). */
function buildTeamJsonLd(team, canonicalPath) {
  const data = {
    "@context": "https://schema.org",
    "@type": "SportsTeam",
    name: team.name,
    url: `${SITE_BASE}${canonicalPath}`,
    sport: "American Football",
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

async function buildTeamPage(template, data, team) {
  const slug = slugify(team.name);
  const canonicalPath = `/teams/${slug}/`;
  let html = buildHead(template, team, canonicalPath);

  // Extra SportsTeam JSON-LD, inserted right before </head>.
  html = html.replace("</head>", `${buildTeamJsonLd(team, canonicalPath)}\n${breadcrumbJsonLd(teamTrail(team))}\n</head>`);

  // Visible static snapshot, inserted immediately after <body> (before the
  // React root div) so it's the first thing in the DOM a non-JS-executing
  // crawler or scraper sees.
  const snapshot = buildTeamSnapshotHtml(data, team);
  html = injectAfterBody(html, snapshot);

  // The snapshot stays visible until React actually mounts into #root -
  // bootApp() in src/app.jsx hides it right before createRoot(...).render(),
  // so a slow connection shows real content rather than a blank page while
  // the bundle and data seeds load.

  const outPath = path.join(REPO_ROOT, "teams", slug, "index.html");
  const changed = await writeIfChanged(outPath, html);
  return { path: canonicalPath, changed };
}

/* The tab routes. These were hash fragments ("/#news") until the URL-scheme
 * change, which meant the server never saw them: no crawlable page, and
 * nothing a notification or a native app could link to. Prerendering them
 * gives each one a real, indexable document. /leagues doubles as the SEO
 * route that was already on the roadmap.
 *
 * /picks carries a prerendered snapshot of the current week's sheets (a
 * `snapshot` hook below); the other tab pages are driven by live per-user
 * data (your leagues, the news feed), so for those the value is the
 * metadata and the 200. */
// ---- /picks (Pick'em Playbook) snapshot --------------------------------------
// /picks is the page the product is positioned around and it had no
// prerendered text at all - a 0-character page to anything that doesn't run
// the bundle. This bakes in the current week's finished sheets: the
// confidence ladder (compact - the week hub carries the full table and is
// linked as the deeper page), the safest survivor spends, and the spread
// sheet. The top spread play is open, like the app's "Betting angles"
// preview; the rest sits in the same gated/Article-markup pattern the game
// write-ups use, because the full sheet is a Blitz+ feature.

/** The period a visitor opening /picks today wants: the first one that
 *  still has an unplayed game, or the last period once the season is done. */
function currentPeriod(data, periods) {
  for (const period of periods) {
    const unplayed = period.games.some((g) => {
      const r = resultForWeek(data, period.week, g.away, g.home);
      return !(r && r.final);
    });
    if (unplayed) return period;
  }
  return periods[periods.length - 1] || null;
}

function buildPlaybookSnapshotHtml(data, period, ladder) {
  const seasonYear = data.seasonYear;
  const weekSlug = slugify(period.label);
  const hubUrl = `/games/${seasonYear}/${weekSlug}/`;
  const gameUrl = (row) => `${hubUrl}${row.slug}/`;
  const label = escapeHtml(period.label);

  // Confidence ladder - points, pick, win%, with the matchup linked.
  const ladderItems = ladder
    .map((r) => `    <li><strong>${r.points} pts - ${escapeHtml(r.pickName)}</strong> (${r.winPct}%) - <a href="${gameUrl(r)}">${escapeHtml(r.away.name)} at ${escapeHtml(r.home.name)}</a></li>`)
    .join("\n");

  // Survivor - the three safest wins on the slate. The app narrows this to
  // the teams a member hasn't burned and weighs future weeks; the public
  // version is the raw safety ranking.
  const safest = ladder.slice(0, 3);
  const survivorItems = safest
    .map((r, i) => `    <li><strong>${escapeHtml(r.pickName)}</strong> - ${r.winPct}% to win${i === 0 ? " (safest play on the board)" : ""} - <a href="${gameUrl(r)}">vs ${escapeHtml(r.pickAbbr === r.game.home ? r.away.name : r.home.name)}</a></li>`)
    .join("\n");

  // Spread sheet via the same engine call the app's Playbook makes.
  const input = ladder
    .map((r) => ({
      awayId: r.away.id, awayName: r.away.name, homeId: r.home.id, homeName: r.home.name,
      prediction: r.prediction, odds: r.odds,
    }))
    .filter((g) => g.prediction && g.odds);
  const hot = input.length ? HotPicksEngine.computeHotPicks(input, 5) : null;
  const spreadPicks = hot ? hot.spreadPicks : [];
  const spreadItem = (pk) => `    <li><strong>${escapeHtml(pk.summary)}</strong> - ${escapeHtml(pk.advantage)}</li>`;
  let spreadBlock;
  if (!spreadPicks.length) {
    spreadBlock = `<p>Spread plays for ${label} post once sportsbook lines are up for the full slate.</p>`;
  } else {
    const [top, ...rest] = spreadPicks;
    spreadBlock = `<ol>\n${spreadItem(top)}\n  </ol>`;
    if (rest.length && GATED_WRITEUP_IN_HTML) {
      spreadBlock += `\n  <div class="playbook-gated"><p>The rest of this week's spread sheet, in order:</p>\n  <ol start="2">\n${rest.map(spreadItem).join("\n")}\n  </ol></div>`;
      lastSnapshotGated = true;
    } else if (rest.length) {
      spreadBlock += `\n  <p><em>${rest.length} more spread plays this week - sign in to see the full sheet.</em></p>`;
    }
  }

  return `
<div id="prerendered-content">
  <h1>NFL Pick'em Playbook - ${label} Confidence, Survivor &amp; Spread Picks (${seasonYear})</h1>
  <p>A finished pick sheet for your pool, every week, from the Blitz Odds model: every ${label} game ranked into a confidence ladder, the safest survivor spends, and the spread plays where the model's line is furthest from the market's. Win probabilities account for team rankings, injuries, home field and the betting line.</p>

  <h2>${label} confidence ladder</h2>
  <p>${ladder.length} games - assign ${ladder.length} points to the top pick down to 1 at the bottom. <a href="${hubUrl}">Full ${label} breakdown with spreads and kickoff times &raquo;</a></p>
  <ol>
${ladderItems}
  </ol>

  <h2>${label} survivor picks</h2>
  <p>The safest wins on the slate. In a league, Blitz Odds narrows this to the teams you haven't used yet and flags when a team is worth holding for a better week.</p>
  <ol>
${survivorItems}
  </ol>

  <h2>${label} against the spread</h2>
  ${spreadBlock}

  <p><a href="/leagues/">Join a free NFL pick'em pool</a> and these picks are one tap away in every format. <a href="/games/">This week's NFL games</a> · <a href="/">Blitz Odds home</a></p>
</div>`;
}

// ---- Homepage snapshot ---------------------------------------------------
// "/" is index.html itself - the app shell every other page is cut from -
// so it never had a prerendered block of its own, and on a phone nothing
// painted until React had finished. Lighthouse (slow 4G, Moto G) put LCP at
// 9.7 s with the hero paragraph as the LCP element.
//
// This stamps a static copy of the above-the-fold hero (the app's own
// classes, so css/app.css renders it identically) into index.html between
// the two markers below. The CSS is render-blocking anyway, so the hero
// paints the moment it arrives, before any script runs. When React mounts
// it draws the same hero at the same size and bootApp hides this one; LCP
// stays pinned to the first paint because a later candidate only replaces
// it when it is strictly larger.
//
// Every generated page strips the region out of its template copy first
// (stripHomeSnapshot) and injects its own snapshot instead.
const HOME_SNAPSHOT_START = "<!-- home-snapshot:start -->";
const HOME_SNAPSHOT_END = "<!-- home-snapshot:end -->";

function stripHomeSnapshot(html) {
  const a = html.indexOf(HOME_SNAPSHOT_START);
  const b = html.indexOf(HOME_SNAPSHOT_END);
  if (a < 0 || b < 0) return html;
  return html.slice(0, a) + html.slice(b + HOME_SNAPSHOT_END.length).replace(/^\n/, "");
}

/* Mirrored word for word from HOME_FAQ in src/app.jsx. */
const HOME_FAQ = [
  { q: "What is an NFL pick'em league?", a: "A pick'em league is a pool where everyone picks the winners of each week's NFL games. Picks are scored after the games finish, and the standings rank everyone across the season." },
  { q: "Is Blitz Odds free to use?", a: "Yes. Creating a league, joining a league, and making picks are free." },
  { q: "How do confidence pools work?", a: "You rank your picks from most to least confident. A correct pick earns the points you assigned to it, so your surest calls are worth the most." },
  { q: "Can I create a private pick'em league?", a: "Yes. A league can be public, private, or hidden. Private and hidden leagues are joined by invitation or code." },
  { q: "How does automatic scoring work?", a: "Picks lock at kickoff. When a game goes final, Blitz Odds grades every pick and updates the league standings." },
  { q: "What is Blitz Edge?", a: "Blitz Edge is the Blitz Odds prediction model. It estimates each NFL team's chance to win from offense and defense rankings, injuries, rest, and weather. It is an estimate, not a guarantee." },
  { q: "Does Blitz Odds show live NFL scores?", a: "Yes. Scores, quarter, and game clock update while games are in progress, next to the model's pregame pick." },
  { q: "Can I view college football scores and predictions?", a: "Yes. College football scores are shown with win probabilities based on the betting market. The Blitz Edge model currently covers the NFL." },
];

const HOME_FORMATS = [
  ["straight-up", "Straight-Up", "Pick the winning team in each game."],
  ["confidence", "Confidence", "Rank selections by confidence."],
  ["survivor", "Survivor", "Choose a team to survive each week."],
  ["ats", "Against the Spread", "Select teams against the point spread."],
];

/** Kickoff as a UTC timestamp from the schedule's "Thu, Nov 19" / "8:15 PM
 *  ET" strings. Only used to keep already-started games out of the static
 *  "upcoming" lists; the app replaces all of it with live status on mount. */
function approxKickoffMs(game, seasonYear) {
  const m = /([A-Za-z]{3}) (\d{1,2})/.exec(String(game.date || "").replace(/^[A-Za-z]{3},\s*/, ""));
  const t = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(game.time || ""));
  if (!m || !t) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months.indexOf(m[1]);
  if (mon < 0) return null;
  const year = mon <= 1 ? Number(seasonYear) + 1 : Number(seasonYear);
  let hour = Number(t[1]) % 12;
  if (/pm/i.test(t[3])) hour += 12;
  // Eastern: EDT (UTC-4) until early November, EST (UTC-5) after and in Jan/Feb.
  const day = Number(m[2]);
  const est = mon <= 1 || mon === 11 || (mon === 10 && day >= 8);
  return Date.UTC(year, mon, day, hour + (est ? 5 : 4), Number(t[2]));
}

/* ---- Mirrors of homeMarketPct / homeInsights / homeInsightText /
 * HOME_INSIGHT_TAG / HOME_EXAMPLE_STANDINGS in src/app.jsx. Keep in step. */
const HOME_EXAMPLE_STANDINGS = [
  { rank: 1, name: "Jordan", record: "104-46", points: 1182 },
  { rank: 2, name: "Priya", record: "101-49", points: 1167 },
  { rank: 3, name: "You", record: "99-51", points: 1139, you: true },
  { rank: 4, name: "Marcus", record: "97-53", points: 1121 },
  { rank: 5, name: "Elena", record: "92-58", points: 1068 },
];
const HOME_INSIGHT_TAG = {
  disagree: "Model and market disagree",
  gap: "Model and market far apart",
  tossup: "Closest call on the slate",
  agree: "Model and market agree",
  confident: "Most confident, no line posted",
};
function homeImplied(ml) {
  const n = Number(ml);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}
function homeMarketPct(r) {
  const o = r.odds;
  if (!o) return null;
  const ph = homeImplied(o.moneylineHome), pa = homeImplied(o.moneylineAway);
  if (ph == null || pa == null || ph + pa <= 0) return null;
  const home = ph / (ph + pa);
  return Math.round((r.pickAbbr === r.game.home ? home : 1 - home) * 100);
}
function buildHomeInsights(open, feat) {
  let pool = open;
  if (pool.filter((r) => r !== feat).length >= 3) pool = pool.filter((r) => r !== feat);
  const cand = pool.map((r) => { const market = homeMarketPct(r); return { row: r, market, gap: market == null ? null : r.winPct - market }; });
  const out = [];
  const used = new Set();
  const take = (c, kind) => { if (c && !used.has(c.row) && out.length < 3) { used.add(c.row); out.push({ ...c, kind }); } };
  const byGap = cand.filter((c) => c.gap != null).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  take(byGap.find((c) => c.market < 50), "disagree");
  take(byGap.find((c) => !used.has(c.row) && c.market >= 50 && Math.abs(c.gap) >= 6), "gap");
  take(cand.filter((c) => !used.has(c.row) && c.row.winPct <= 56).sort((a, b) => a.row.winPct - b.row.winPct)[0], "tossup");
  take(byGap.filter((c) => !used.has(c.row) && c.market >= 50 && Math.abs(c.gap) >= 6)[0], "gap");
  byGap.slice().reverse().forEach((c) => { if (Math.abs(c.gap) <= 4) take(c, "agree"); });
  cand.filter((c) => c.market == null).sort((a, b) => b.row.winPct - a.row.winPct).forEach((c) => take(c, "confident"));
  cand.slice().sort((a, b) => b.row.winPct - a.row.winPct).forEach((c) => take(c, c.market == null ? "confident" : Math.abs(c.gap) <= 4 ? "agree" : "gap"));
  return out;
}
function homeGapBadge(ins) {
  if (ins.gap == null) return { num: "n/a", label: "no market line yet", tone: "none" };
  if (ins.gap === 0) return { num: "0", label: "points apart: model matches market", tone: "flat" };
  const pts = Math.abs(ins.gap);
  return { num: (ins.gap > 0 ? "+" : "\u2212") + pts, label: `${pts === 1 ? "point" : "points"} ${ins.gap > 0 ? "above" : "below"} the market`, tone: pts >= 6 ? "wide" : "flat" };
}
function homeInsightText(ins) {
  const r = ins.row;
  const pickIsHome = r.pickAbbr === r.game.home;
  const pickNick = nickname(pickIsHome ? r.home : r.away);
  const otherNick = nickname(pickIsHome ? r.away : r.home);
  const homePct = Math.round(r.prediction.homeWinProbability * 100);
  const awayPct = Math.round(r.prediction.awayWinProbability * 100);
  if (ins.kind === "disagree") return `The model picks the ${pickNick}. The market favors the ${otherNick}.`;
  if (ins.kind === "gap") return `Both favor the ${pickNick}. The model is ${ins.gap > 0 ? "more" : "less"} sure than the market.`;
  if (ins.kind === "tossup") return `Near a coin flip for the model: ${r.game.away} ${awayPct}%, ${r.game.home} ${homePct}%.`;
  if (ins.kind === "agree") return `Model and market see the ${pickNick} about the same way.`;
  return `The model's most confident remaining call. No moneyline to compare yet.`;
}

/** Static copy of the signed-out homepage (src/app.jsx <HomeLanding>): same
 *  section order, classes and copy, so css/app.css paints it identically
 *  before any script runs and React's first render lands on the same layout.
 *  The scoreboard lists only games that have not kicked off, as "Upcoming" -
 *  live and final status needs the score feed, which only the app has. */
function buildHomeBodyHtml(data, period) {
  const label = period ? escapeHtml(period.label) : "This week";
  const ladder = period ? buildLadder(data, period) : [];
  const now = Date.now();
  const open = ladder.filter((r) => {
    if (r.result) return false;
    const ms = approxKickoffMs(r.game, data.seasonYear);
    return ms == null || ms > now;
  });
  const feat = open[0] || null;
  const insights = buildHomeInsights(open, feat);
  const sheet = open.slice(0, 4);
  const slateSize = ladder.length;
  const byKickoff = period ? period.games.map((g) => open.find((r) => r.game === g)).filter(Boolean).slice(0, 4) : [];
  const hub = period ? weekHubPath(data, period) : "/games/";
  const badge = (id, size) => `<img src="/team-badges/${escapeHtml(id)}.png" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" />`;
  const pcts = (r) => {
    const home = Math.round(r.prediction.homeWinProbability * 100);
    const away = Math.round(r.prediction.awayWinProbability * 100);
    return { home, away };
  };

  let preview = "";
  if (feat) {
    const p = pcts(feat);
    const pickIsHome = feat.pickAbbr === feat.game.home;
    const mt = (team, id, isPick) => `<div class="hl-mt${isPick ? " pick" : ""}"><img class="team-crest" src="/team-badges/${escapeHtml(id)}.png" alt="${escapeHtml(team.name)}" width="56" height="56" decoding="async" /><b>${escapeHtml(team.name)}</b>${isPick ? `<span class="hl-pickflag">Predicted winner</span>` : ""}</div>`;
    const line = feat.odds && feat.odds.favorite
      ? `\n          <p class="hl-line"><span><b>${escapeHtml(feat.odds.favorite)} ${escapeHtml(formatSpread(feat.odds.spread))}</b> Spread</span>${feat.odds.overUnder != null ? `<span><b>${escapeHtml(feat.odds.overUnder)}</b> O/U</span>` : ""}<span class="hl-dim">Market line</span></p>`
      : "";
    preview = `
        <div class="home-card hl-preview">
          <div class="hl-preview-head"><span class="home-eyebrow hl-eyebrow">${label} · Featured matchup</span><span class="hl-dim">${escapeHtml(feat.game.date || "")}${feat.game.time ? ` · ${escapeHtml(feat.game.time)}` : ""}</span></div>
          <div class="hl-matchup">${mt(feat.away, feat.game.away, !pickIsHome)}<span class="hl-at">@</span>${mt(feat.home, feat.game.home, pickIsHome)}</div>
          <div class="hl-edge">
            <div class="hl-edge-top"><img src="/branding/blitz-edge-logo.png" alt="Blitz Edge" class="hl-edge-logo" width="378" height="120" decoding="async" /><div class="hl-edge-num"><b>${feat.winPct}%</b><span>model win probability · ${escapeHtml(feat.pickAbbr)}</span></div></div>
            <div class="hl-bar" role="img" aria-label="Model win probability: ${escapeHtml(feat.away.name)} ${p.away} percent, ${escapeHtml(feat.home.name)} ${p.home} percent"><span${pickIsHome ? "" : ` class="on"`} style="width:${p.away}%"></span><span${pickIsHome ? ` class="on"` : ""} style="width:${p.home}%"></span></div>
            <div class="hl-bar-key"><span>${escapeHtml(feat.game.away)} ${p.away}%</span><span>${escapeHtml(feat.game.home)} ${p.home}%</span></div>
          </div>${line}
          <p class="hl-fine">The percentage is the Blitz Edge model's estimate of each team's chance to win. It is an estimate, not a guarantee.</p>
          <details class="hl-explain"><summary>How Blitz Edge works</summary><ul>
            <li><b>What the number is.</b> The model's estimate of each team's chance to win the game outright. The two percentages add up to 100.</li>
            <li><b>What goes in.</b> Each team's league ranks in total, rushing and passing yards on offense and defense, home field, players listed out or questionable, and the forecast for outdoor games. Early in the season, last year's final ranks are blended in.</li>
            <li><b>When it updates.</b> It recalculates as team stats, injury reports, and weather change, up to kickoff. A finished game keeps showing the pregame call.</li>
            <li><b>What it isn't.</b> A guarantee, or betting advice. It is an estimate.</li>
          </ul></details>
          <a class="hl-more" href="${gamePagePath(data, period, feat.game)}">See the full ${escapeHtml(nickname(feat.away))}–${escapeHtml(nickname(feat.home))} analysis &rarr;</a>
        </div>`;
  }

  const scoreCard = (r) => {
    const g = r.game;
    const side = (team, id, which) => `<span class="hs-team hs-${which}"><span class="hs-logo" aria-hidden="true">${badge(id, 30)}</span><span class="hs-name">${escapeHtml(nickname(team))} <small>${escapeHtml(id)}</small></span><span class="hs-abbr">${escapeHtml(id)}</span><span class="hs-score"></span></span>`;
    return `          <a class="home-card hs-game is-upcoming" href="${gamePagePath(data, period, g)}" aria-label="${escapeHtml(r.away.name)} at ${escapeHtml(r.home.name)}, ${escapeHtml(g.date || "")} ${escapeHtml(g.time || "")}"><span class="hs-status is-upcoming"><span class="hs-status-wide">Upcoming</span><span class="hs-status-narrow">${escapeHtml(g.time || "Scheduled")}</span></span><span class="hs-when"><span class="hs-status-wide">${escapeHtml(g.date || "")} · ${escapeHtml(g.time || "")}</span><span class="hs-status-narrow">${escapeHtml(g.date || "")}</span></span>${side(r.away, g.away, "away")}${side(r.home, g.home, "home")}<span class="hs-pick"><span class="hs-pick-lbl"><span class="hs-status-wide">Blitz Edge · pregame</span><span class="hs-status-narrow">Pregame pick</span></span><span class="hs-pick-val"><b>${escapeHtml(r.pickAbbr)} ${r.winPct}%</b></span></span><span class="hs-link" aria-hidden="true">Matchup analysis &rarr;</span></a>`;
  };
  const scores = byKickoff.length
    ? `        <div class="hs-grid">\n${byKickoff.map(scoreCard).join("\n")}\n        </div>`
    : `        <p class="hs-empty">Live scores load here. Browse <a href="/games/">NFL games and predictions</a> or the <a href="/historical/index.html">results archive</a>.</p>`;

  const insightCard = (ins) => {
    const r = ins.row;
    const g = r.game;
    const text = homeInsightText(ins);
    return `          <a class="home-card hl-pickcard hl-insight" href="${gamePagePath(data, period, g)}" aria-label="${escapeHtml(`${r.away.name} at ${r.home.name}. ${HOME_INSIGHT_TAG[ins.kind]}. ${text}`)}"><span class="hl-insight-tag is-${ins.kind}">${HOME_INSIGHT_TAG[ins.kind]}</span><span class="hl-insight-teams">${badge(g.away, 32)}<b>${escapeHtml(nickname(r.away))} <span>at</span> ${escapeHtml(nickname(r.home))}</b>${badge(g.home, 32)}</span><span class="hl-pickcard-when">${escapeHtml(g.date || "")}${g.time ? ` · ${escapeHtml(g.time)}` : ""}</span><span class="hl-insight-gap is-${homeGapBadge(ins).tone}"><b>${homeGapBadge(ins).num}</b><span>${homeGapBadge(ins).label}</span></span><span class="hl-insight-bars"><span class="hl-insight-row"><span>Model · ${escapeHtml(r.pickAbbr)}</span><span class="hl-insight-track"><span class="is-model" style="width:${r.winPct}%"></span></span><b>${r.winPct}%</b></span><span class="hl-insight-row"><span>Market · ${escapeHtml(r.pickAbbr)}</span><span class="hl-insight-track">${ins.market != null ? `<span class="is-market" style="width:${ins.market}%"></span>` : ""}</span><b>${ins.market != null ? ins.market + "%" : "n/a"}</b></span></span><span class="hl-insight-text">${escapeHtml(text)}</span><span class="hs-link" aria-hidden="true">Full matchup details &rarr;</span></a>`;
  };
  const picksSection = insights.length ? `
      <section class="hl-sec" aria-labelledby="hl-picks">
        <div class="hl-head"><div><h2 id="hl-picks">This Week's NFL Picks: Blitz Edge Insights</h2><p>${label} · games where the model and the betting market differ, or the model sees a toss-up.</p></div>${data.features.cfb ? `<a class="hl-more" href="/college/">College football odds &rarr;</a>` : ""}</div>
        <div class="hl-grid3">
${insights.map(insightCard).join("\n")}
        </div>
        <details class="hl-explain hl-insight-note"><summary>How to read these cards</summary><ul>
          <li><b>Model</b> is the Blitz Edge pregame win probability for its pick.</li>
          <li><b>Market</b> is the win probability the posted moneylines imply for the same team, with the sportsbook's margin removed.</li>
          <li><b>The big number</b> is model minus market, in percentage points. A wide gap means the two estimates disagree. It is a reason to look closer at a game, not a betting edge.</li>
          <li><b>A high win probability is not a gap.</b> A 90% favorite the market also has at 90% shows 0.</li>
        </ul></details>
        <div class="hl-center"><a class="home-btn hl-btn-lg" href="/games/">View All NFL Games &amp; Predictions</a></div>
      </section>` : "";

  const sheetRows = sheet.map((r, i) => {
    const pickIsHome = r.pickAbbr === r.game.home;
    return `<li><span class="hl-league-pts" aria-label="${slateSize - i} confidence points">${slateSize - i}</span>${badge(r.pickAbbr, 26)}<span class="hl-league-pick"><b>${escapeHtml(nickname(pickIsHome ? r.home : r.away))}</b><small>${pickIsHome ? "vs" : "at"} ${escapeHtml(nickname(pickIsHome ? r.away : r.home))}</small></span><span class="hl-league-pct">${r.winPct}%</span></li>`;
  }).join("");
  const leaguePreview = `<div class="home-card hl-league" role="group" aria-label="Example league preview">
            <div class="hl-league-head"><div><span class="hl-league-flag">Example league</span><b>Sunday Crew</b></div><span class="hl-league-fmt"><img src="/branding/format-badge-confidence-icon.png" alt="" width="240" height="180" loading="lazy" decoding="async" />Confidence · ${label}</span></div>
            <div class="hl-league-body">
              <div><h3>Standings <span>most points leads</span></h3><table class="hl-league-table"><thead><tr><th scope="col"><span class="sr-only">Rank</span></th><th scope="col">Player</th><th scope="col">Record</th><th scope="col">Points</th></tr></thead><tbody>${HOME_EXAMPLE_STANDINGS.map((r) => `<tr${r.you ? ` class="is-you"` : ""}><td>${r.rank}</td><th scope="row">${r.name}</th><td>${r.record}</td><td>${r.points.toLocaleString("en-US")}</td></tr>`).join("")}</tbody></table></div>
              <div><h3>Your ${label} picks <span>points if right</span></h3>${sheet.length ? `<ul class="hl-league-picks">${sheetRows}</ul>` : `<p class="hl-fine">This week's games are under way. Picks lock at kickoff, and next week's sheet opens when the slate does.</p>`}</div>
            </div>
            <details class="hl-explain"><summary>See How Scoring Works</summary><ul>
              <li><b>Rank your picks.</b> In a confidence league you give each game a different number of points, ${slateSize || "one per game"} down to 1. Put the most on the pick you trust most.</li>
              <li><b>Right picks pay.</b> A correct pick earns the points you put on it. A wrong pick earns none.</li>
              <li><b>Standings add it up.</b> Points total across the season, and the most points leads. Blitz Odds grades every game and updates the standings for you.</li>
              <li><b>Other formats.</b> Straight-Up counts correct picks, Against the Spread grades picks against the point spread, and Survivor is one team a week.</li>
            </ul></details>
            <div class="hl-league-foot"><a class="home-btn primary hl-btn-lg" href="/leagues/">Create a League Like This</a><p class="hl-fine">Example only: names, records and points are made up. Matchups and percentages are this week's real games and model picks.</p></div>
          </div>`;

  const faqLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: HOME_FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  }).replace(/</g, "\\u003c");
  const svg = (d) => `<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  return `  <div class="home-landing hl">
      <section class="hl-hero">
        <div class="hl-hero-copy">
          <span class="home-eyebrow hl-eyebrow">Free NFL pick'em leagues · picks · scores</span>
          <h1 class="hl-display">Run Your Pick'em League. <em>Make Smarter Picks.</em></h1>
          <p class="hl-lede">Create a free NFL pick'em league, invite your friends, and let Blitz Odds handle scoring and standings. Use model-powered predictions to make more informed picks every week.</p>
          <div class="hl-acts">
            <a class="home-btn primary hl-btn-lg" href="/leagues/">Create a Free League</a>
            <a class="home-btn hl-btn-lg" href="${hub}">Explore This Week's Picks</a>
            <a class="home-btn hl-btn-lg hl-btn-quiet" href="/leagues/">Join a League</a>
          </div>
          <p class="hl-trust"><span>Free to create and join</span><span>Four pool formats</span><span>Automatic scoring &amp; standings</span></p>
        </div>${preview}
      </section>

      <section class="hl-sec hs" aria-labelledby="hs-title">
        <div class="hl-head"><div><h2 id="hs-title">Football Scores &amp; Predictions</h2><p>Follow the action and see how Blitz Odds predictions compare with game results.</p></div><a class="hl-more hs-all-top" href="/games/">View All Football Scores &rarr;</a></div>
        <div class="hs-controls"><div class="hs-seg" role="group" aria-label="Game status"><button type="button" class="on" aria-pressed="true">All</button><button type="button" aria-pressed="false">Live</button><button type="button" aria-pressed="false">Upcoming</button><button type="button" aria-pressed="false">Final</button></div><span class="hs-updated">&nbsp;</span></div>
${scores}
        <p class="hl-fine hs-note">The percentage is the Blitz Edge pick made before kickoff, not a live win probability. One result does not show a percentage was right.</p>
        <a class="hl-more hs-all-bottom" href="/games/">View All Football Scores &rarr;</a>
      </section>

      <section class="hl-sec" aria-labelledby="hl-benefits">
        <h2 id="hl-benefits" class="sr-only">What you can do on Blitz Odds</h2>
        <div class="hl-grid3">
          <div class="home-card hl-benefit">${svg(`<path d="M3 20h18M7 16V9M12 16V4M17 16v-5" />`)}<h3>Make Smarter Picks</h3><p>Compare model predictions, team matchups, and key game factors before locking in your picks.</p><a class="hl-more" href="/games/">Explore NFL Picks &rarr;</a></div>
          <div class="home-card hl-benefit">${svg(`<circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.4 3.2-5 6.5-5s5.9 1.6 6.5 5M17 5.5a3 3 0 0 1 0 5.6M18.5 15.2c1.7.7 2.7 2.3 3 4.8" />`)}<h3>Run Your League</h3><p>Create a free pick'em pool, invite your friends, and manage everything in one place.</p><a class="hl-more" href="/leagues/">Create a League &rarr;</a></div>
          <div class="home-card hl-benefit">${svg(`<path d="M4 6h16M4 12h10M4 18h13" /><path d="M17 11l2 2 3-4" />`)}<h3>Track Every Result</h3><p>Follow picks, scores, and standings as the season unfolds.</p><a class="hl-more" href="/leagues/">Explore Leagues &rarr;</a></div>
        </div>
      </section>

      <section class="hl-sec" aria-labelledby="hl-how">
        <div class="hl-head"><div><h2 id="hl-how">How Blitz Odds Works</h2><p>Three steps, and what your league looks like once it is running.</p></div></div>
        <div class="hl-how">
          <ol class="home-card hl-steps">
            <li><span class="hl-step-n" aria-hidden="true">1</span><div><h3>Create or Join</h3><p>Start your own free pick'em league or join an existing one.</p></div></li>
            <li><span class="hl-step-n" aria-hidden="true">2</span><div><h3>Make Your Picks</h3><p>Use Blitz Edge predictions and matchup insights to select your teams.</p></div></li>
            <li><span class="hl-step-n" aria-hidden="true">3</span><div><h3>Track Results</h3><p>Follow game scores and league standings without manual spreadsheets.</p></div></li>
          </ol>
          ${leaguePreview}
        </div>
      </section>

      <section class="hl-sec" aria-labelledby="hl-why">
        <div class="hl-head"><h2 id="hl-why">Why Blitz Odds?</h2></div>
        <div class="hl-grid3 hl-why">
          <div class="hl-why-cell is-edge"><h3>Predictions on the Record</h3><p>Every Blitz Edge pregame call stays on the page next to the final score, right or wrong.</p><a class="hl-more" href="/games/">See this week's calls and results &rarr;</a></div>
          <div class="hl-why-cell is-league"><h3>Leagues That Score Themselves</h3><p>No spreadsheets. Picks lock at kickoff, games are graded for you, and standings update on their own.</p><a class="hl-more" href="/leagues/">Browse pick'em leagues &rarr;</a></div>
          <div class="hl-why-cell is-data"><h3>NFL Results Archive Since 2015</h3><p>Final scores and box scores back to the 2015 season, by season and by team.</p><a class="hl-more" href="/historical/index.html">Browse the results archive &rarr;</a></div>
        </div>
      </section>

      <section class="hl-sec" aria-labelledby="hl-formats">
        <div class="hl-head"><div><h2 id="hl-formats">Pick'em Formats</h2><p>Every format is free. Choose one when you create a league.</p></div></div>
        <div class="hl-grid4">
${HOME_FORMATS.map(([slug, name, blurb]) => `          <a class="home-card hl-format" href="/leagues/"><img src="/branding/format-badge-${slug}-icon.png" alt="" width="240" height="180" loading="lazy" decoding="async" /><h3>${name}</h3><p>${blurb}</p><span class="hl-more" aria-hidden="true">Play ${name} &rarr;</span></a>`).join("\n")}
        </div>
      </section>
${picksSection}

      <section class="home-card hl-close" aria-labelledby="hl-close">
        <div><h2 id="hl-close">Ready to Run Your Pick'em League?</h2><p>Create your free league, invite your friends, and let Blitz Odds handle the details.</p></div>
        <div class="hl-acts"><a class="home-btn primary hl-btn-lg" href="/leagues/">Create Your Free League</a><a class="home-btn hl-btn-lg" href="/games/">Explore NFL Picks</a><a class="hl-more hl-close-join" href="/leagues/">Have an invite code? Join a league &rarr;</a></div>
      </section>

      <section class="hl-sec hl-faq" aria-labelledby="hl-faq">
        <div class="hl-head"><h2 id="hl-faq">Frequently Asked Questions</h2></div>
        <div class="home-card hl-faq-list">
${HOME_FAQ.map((f, i) => `          <details${i === 0 ? " open" : ""}><summary><h3>${escapeHtml(f.q)}</h3></summary><p>${escapeHtml(f.a)}</p></details>`).join("\n")}
        </div>
        <script type="application/ld+json">${faqLd}</script>
      </section>
  </div>`;
}

function buildHomeSnapshotHtml(period, data) {
  const wordmark = (h, lazyBoth) => `<img src="/branding/blitz-odds-wordmark-dark.svg" alt="Blitz Odds" class="brand-logo-img brand-logo-dark" width="900" height="252" decoding="async" style="height:${h}px;width:auto;display:block" />
            <img src="/branding/blitz-odds-wordmark-light.svg" alt="Blitz Odds" class="brand-logo-img brand-logo-light" width="900" height="252" loading="lazy" decoding="async" style="height:${h}px;width:auto;display:none" />`;
  const tab = (href, label, img, extra = "") => `<a href="${href}" class="tab-btn${extra}"><span class="tab-icon has-img" aria-hidden="true"><img class="tab-icon-img" src="/branding/tab-icon-${img}.png" alt="" width="30" height="30" decoding="async" /></span><span class="tab-label">${label}</span></a>`;
  return `${HOME_SNAPSHOT_START}
<div id="prerendered-content" class="app app-home">
  <header class="top">
    <div class="hdr-bar">
      <div class="hdr-lead">
        <a href="/" class="hdr-mark" aria-label="Blitz Odds home">
          <span class="brand-logo-mini" style="display:inline-flex;align-items:center;flex-shrink:0">
            ${wordmark(21)}
          </span>
        </a>
      </div>
      <div class="hdr-center"></div>
      <div class="header-right-cluster"></div>
    </div>
    <div class="brand-row">
      <a href="/" class="brand-logo" style="display:inline-flex;align-items:center;flex-shrink:0">
            ${wordmark(76)}
      </a>
    </div>
    <nav class="tab-bar" aria-label="Primary">
      ${tab("/", "Home", "home", " active")}
      ${tab("/games/", "Games", "games")}
${data && data.features && data.features.bowls ? `      ${tab("/bowls/", "Bowls", "bowls")}\n` : ""}      ${tab("/picks/", "Playbook", "playbook")}
      ${tab("/news/", "News", "news")}
      ${tab("/leagues/", "Pick'em Leagues", "leagues", " tab-desktop-only")}
    </nav>
  </header>
${data ? buildHomeBodyHtml(data, period) : ""}
</div>
${HOME_SNAPSHOT_END}`;
}

/** Writes the current week's home snapshot into index.html (between the
 *  markers, creating them after <body> on first run). Returns whether the
 *  file changed. */
async function stampHomeSnapshot(period, data) {
  const indexPath = path.join(REPO_ROOT, "index.html");
  const current = await readFile(indexPath, "utf8");
  const stripped = stripHomeSnapshot(current);
  const next = injectAfterBody(stripped, buildHomeSnapshotHtml(period, data));
  if (next === current) return false;
  await writeFile(indexPath, next, "utf8");
  return true;
}

/** /games/ - the week view. It had a title and no body text or links at all
 *  without JavaScript. This is the NFL hub: the current slate with the
 *  model's pick, every week of the season, and every team. */
function buildGamesIndexSnapshotHtml(data, periods) {
  const period = currentPeriod(data, periods);
  if (!period) return null;
  const ladder = buildLadder(data, period);
  const byKickoff = period.games
    .map((g) => ladder.find((r) => r.game === g))
    .filter(Boolean);
  const rows = byKickoff
    .map((r) => {
      const res = r.result && r.result.final ? `Final: ${escapeHtml(r.game.away)} ${r.result.awayScore} - ${r.result.homeScore} ${escapeHtml(r.game.home)}` : `${escapeHtml(r.game.date)}${r.game.time ? " · " + escapeHtml(r.game.time) : ""}`;
      const spread = r.odds ? `${escapeHtml(r.odds.favorite)} ${escapeHtml(formatSpread(r.odds.spread))}` : "-";
      return `<tr><td><a href="${gamePagePath(data, period, r.game)}">${escapeHtml(r.away.name)} at ${escapeHtml(r.home.name)}</a></td><td>${res}</td><td>${escapeHtml(r.pickName)} ${r.winPct}%</td><td>${spread}</td></tr>`;
    })
    .join("\n      ");
  const weeks = periods.map((p) => `<a href="${weekHubPath(data, p)}">${escapeHtml(p.label)}</a>`).join(" · ");
  const teams = [...data.teams]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `<li><a href="/teams/${slugify(t.name)}/">${escapeHtml(t.name)} schedule &amp; predictions</a></li>`)
    .join("\n    ");
  const label = escapeHtml(period.label);
  return {
    period,
    html: `
<div id="prerendered-content">
  ${breadcrumbHtml([{ name: "Blitz Odds", path: "/" }, { name: "NFL games", path: "/games/" }])}
  <h1>NFL Games, Odds &amp; Model Predictions - ${label}, ${data.seasonYear}</h1>
  <p>Every NFL ${label} game with the Blitz Odds model's pick and win probability and the current point spread. Open a matchup for the injury report, team-ranking comparison and the reasoning behind the pick.</p>

  <h2>${label} games</h2>
  <table>
    <thead><tr><th>Matchup</th><th>Kickoff / result</th><th>Model pick</th><th>Spread</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <p><a href="${weekHubPath(data, period)}">${label} confidence pool ladder</a> · <a href="/picks/">Pick'em Playbook: confidence, survivor &amp; against-the-spread sheets</a> · <a href="/leagues/">Free pick'em leagues</a></p>

  <h2>${data.seasonYear} NFL season by week</h2>
  <p>${weeks}</p>

  <h2 id="nfl-teams">NFL teams</h2>
  <ul>
    ${teams}
  </ul>

  <h2>More football</h2>
  <p>${data.features.cfb ? `<a href="/college/games/">College football odds &amp; win probabilities</a> · <a href="/college/teams/">College football teams</a> · ` : ""}${data.features.bowls ? `<a href="/college/bowls/">Bowl game schedule</a> · ` : ""}<a href="/historical/index.html">Historical NFL results archive</a></p>
</div>`,
  };
}

/** /leagues/ - the public "what is a Blitz Odds league" page. The copy is
 *  the app's own (HOME_FORMAT_CARDS and the Home "Why Blitz Odds" cells in
 *  src/app.jsx); per-league pages under /leagues/{id} stay private. */
function buildLeaguesSnapshotHtml(data, periods) {
  const period = currentPeriod(data, periods);
  return {
    period,
    html: `
<div id="prerendered-content">
  ${breadcrumbHtml([{ name: "Blitz Odds", path: "/" }, { name: "Pick'em leagues", path: "/leagues/" }])}
  <h1>Free NFL Pick'em Pools - Join a League or Run Your Own</h1>
  <p>Blitz Odds gives every game a model win probability, then puts your whole pool on top of it. Invite by email or link. Picks lock at kickoff, scores update live, standings settle on their own.</p>

  <h2>Four pool formats</h2>
  <ul>
    <li><strong>Straight-Up</strong> - Pick winners. One point each. The classic office pool.</li>
    <li><strong>Confidence</strong> - Rank every game. Your best call is worth the most.</li>
    <li><strong>Survivor</strong> - One team a week. Never twice. Lose once and you're out.</li>
    <li><strong>Against the Spread</strong> - Beat the number, not just the team. Lines auto-update.</li>
  </ul>

  <h2>Start a league in about a minute</h2>
  <p>Name it, pick a format, send the link. That's the whole setup. Official public pools are open to anyone, no invite needed.</p>

  <h2>Picks to play</h2>
  <p>${period ? `<a href="${weekHubPath(data, period)}">NFL ${escapeHtml(period.label)} picks &amp; confidence pool ladder</a> · ` : ""}<a href="/picks/">Pick'em Playbook</a> · <a href="/games/">This week's NFL games &amp; odds</a>${data.features.bowls ? ` · <a href="/college/bowls/">College bowl schedule</a>` : ""}</p>
</div>`,
  };
}

// canonicalPath carries the trailing slash on purpose: each of these is a
// directory index (games/index.html etc.), and Netlify 301s the bare
// "/games" to "/games/". A canonical that points at a redirecting URL is a
// "page with redirect" in Search Console; the sitemap entries come from the
// same field and had the same problem.
const TAB_PAGES = [
  {
    // The week view's own route since HOME_TAB_ENABLED moved "/" to the Home
    // tab. Sits directly above the per-game pages this script already writes
    // to games/{season}/{week-slug}/{matchup}/, so this is that directory's
    // index rather than a new namespace. Netlify serves an existing file in
    // preference to the non-forced `/games/* /index.html 200` rewrite, which
    // is the same precedence the game pages themselves already rely on.
    dir: "games",
    canonicalPath: "/games/",
    snapshot: (data, periods) => buildGamesIndexSnapshotHtml(data, periods),
    title: "NFL Odds, Spreads & Model Predictions This Week | Blitz Odds",
    description: "Every NFL game this week with live sportsbook odds, model win probabilities, injury and weather adjustments, and the reasoning behind each pick.",
  },
  {
    // Retitled with the tab. This route used to be Hot Picks, a betting-market
    // page, and the old metadata still described "this week's best bets" -
    // which now names one of four sub-tabs, and the gated one at that. The
    // tab's actual job is a finished pick sheet for a pool, so the metadata
    // targets the audience the product is positioned for (pick'em players)
    // rather than the betting keywords the old section chased.
    dir: "picks",
    canonicalPath: "/picks/",
    // Prerendered sheets for the current week - see buildPlaybookSnapshotHtml.
    snapshot: (data, periods) => {
      const period = currentPeriod(data, periods);
      return period ? { period, html: buildPlaybookSnapshotHtml(data, period, buildLadder(data, period)) } : null;
    },
    title: "NFL Pick'em Playbook - Confidence, Survivor & ATS Sheets | Blitz Odds",
    description: "A finished pick sheet for your pool every week: a full confidence ladder, ranked spread plays, and a survivor pick planned around the rest of the season - with the model's reasoning behind each one.",
  },
  {
    // Retargeted when the official public pools shipped. The old metadata
    // only described running a pool with friends, which is the smaller
    // intent and the one that needs a group already assembled - "join an
    // NFL pick'em pool" is the higher-volume query and is now something the
    // page can actually deliver on, since the house leagues are open to
    // anyone without an invite.
    dir: "leagues",
    canonicalPath: "/leagues/",
    snapshot: (data, periods) => buildLeaguesSnapshotHtml(data, periods),
    title: "Free NFL Pick'em Pools - Join a League or Run Your Own | Blitz Odds",
    description: "Join a free NFL pick'em pool instantly - no invite needed - or run your own with friends. Confidence, survivor, straight-up, and against-the-spread formats, with automatic scoring and standings.",
  },
  {
    // Bowl Pick'em. The SPA only shows this tab when the "bowls" feature flag
    // covers the visitor (admin console > Features), so while it's being
    // tested the page exists for direct hits but is kept out of the index:
    // noindex here, and noindex entries are left out of sitemap.xml below.
    // Drop `noindex` when the flag goes to Everyone.
    dir: "bowls",
    canonicalPath: "/bowls/",
    noindex: true,
    title: "College Bowl Pick'em - Free Bowl Confidence Pools | Blitz Odds",
    description: "Every college bowl game and the full College Football Playoff on one free pick sheet. Run a confidence, straight-up or against-the-spread bowl pool with friends, scored automatically.",
  },
  {
    // College (FBS) games - the College side of the Games tab, behind the
    // "cfb" feature flag. Its sub-views (?week=, ?game=, ?team=) all resolve
    // to this one file. noindex for the same reason as /bowls/ while the flag
    // is being tested; drop it when the flag goes to Everyone.
    dir: "college",
    canonicalPath: "/college/",
    noindex: true,
    title: "College Football Odds, Spreads & Win Probabilities This Week | Blitz Odds",
    description: "Every FBS game this week with the betting line, market win probability, offense and defense stat ranks, weather and live scores.",
  },
  {
    // noindex: the page is a feed of other publishers' headlines that link
    // out, loaded client-side - there is nothing of the site's own to rank,
    // and prerendering someone else's headlines wouldn't change that. It
    // stays a normal tab; it just leaves the index and the sitemap.
    dir: "news",
    canonicalPath: "/news/",
    noindex: true,
    title: "NFL News | Blitz Odds",
    description: "The latest NFL headlines, injury news, and roster moves, alongside the odds and predictions they move.",
  },
];

async function buildTabPage(template, page, data, periods) {
  let html = applyMeta(template, page);
  if (page.noindex) html = html.replace("</head>", `<meta name="robots" content="noindex" />\n</head>`);
  if (page.snapshot) {
    lastSnapshotGated = false;
    const snap = page.snapshot(data, periods);
    if (snap) {
      if (lastSnapshotGated) {
        const articleLd = buildGatedArticleJsonLd({
          headline: `NFL Pick'em Playbook - ${snap.period.label} confidence, survivor and spread picks`,
          description: `The Blitz Odds model's ${snap.period.label} pick sheet: a full confidence ladder, the safest survivor spends and the week's ranked spread plays.`,
          canonicalPath: page.canonicalPath,
          gatedClass: "playbook-gated",
        });
        html = html.replace("</head>", `${articleLd}\n</head>`);
      }
      html = injectAfterBody(html, snap.html);
    }
  }
  const outPath = path.join(REPO_ROOT, page.dir, "index.html");
  const changed = await writeIfChanged(outPath, html);
  return { path: page.canonicalPath, changed };
}

// ---- /teams/ - the NFL teams index -------------------------------------------
// A standalone page (its own small shell, like the /college/ pages - not the
// app) so the 32 team pages have one hub that every page's footer can link to
// instead of the homepage carrying a 32-badge grid. Division alignment is the
// same static map the app uses (TEAM_DIVISION in src/app.jsx).
const TEAM_DIVISION = {
  BUF: "AFC East", MIA: "AFC East", NE: "AFC East", NYJ: "AFC East",
  BAL: "AFC North", CIN: "AFC North", CLE: "AFC North", PIT: "AFC North",
  HOU: "AFC South", IND: "AFC South", JAX: "AFC South", TEN: "AFC South",
  DEN: "AFC West", KC: "AFC West", LV: "AFC West", LAC: "AFC West",
  DAL: "NFC East", NYG: "NFC East", PHI: "NFC East", WAS: "NFC East",
  CHI: "NFC North", DET: "NFC North", GB: "NFC North", MIN: "NFC North",
  ATL: "NFC South", CAR: "NFC South", NO: "NFC South", TB: "NFC South",
  ARI: "NFC West", LAR: "NFC West", SF: "NFC West", SEA: "NFC West",
};
const DIVISION_ORDER = ["AFC East", "AFC North", "AFC South", "AFC West", "NFC East", "NFC North", "NFC South", "NFC West"];

const TEAMS_INDEX_CSS = `
:root{--bg:#0b1220;--card:#131c2e;--border:#223049;--s2:#1a2438;--text:#eef2f8;--dim:#9fb0c9;--accent:#4fd1c5}
html[data-theme="light"]{--bg:#dbe2ec;--card:#fff;--border:#c3cedd;--s2:#e7ecf3;--text:#16202f;--dim:#5b6b80;--accent:#0f8f83}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.45}
a{color:var(--accent)}.wrap{max-width:960px;margin:0 auto;padding:14px 16px 56px}
.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:6px 0 14px;border-bottom:1px solid var(--border);margin-bottom:14px}
.brand{display:flex;align-items:center;gap:8px;font-weight:800;font-size:19px;color:var(--text);text-decoration:none}.brand img{width:28px;height:28px}.brand b{color:var(--accent)}
.nav{display:flex;gap:4px;flex-wrap:wrap}.nav a{padding:6px 10px;border-radius:8px;text-decoration:none;color:var(--dim);font-weight:600;font-size:14px}.nav a:hover,.nav a.on{background:var(--s2);color:var(--text)}
.crumbs{font-size:13px;color:var(--dim);margin:0 0 8px}.crumbs a{color:var(--dim)}
h1{font-size:26px;line-height:1.2;margin:4px 0 6px}h2{font-size:15px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
.lede{color:var(--dim);margin:0 0 14px}.divs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.team{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--border)}.team:first-of-type{border-top:none}
.team img{width:34px;height:34px;flex:none}.team .nm{font-weight:700;color:var(--text);text-decoration:none}.team .nm:hover{color:var(--accent)}
.team .nx{display:block;font-size:12px;color:var(--dim)}.team .nx a{color:var(--dim)}
footer{margin-top:34px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--dim)}footer a{color:var(--dim)}
@media (max-width:600px){h1{font-size:22px}.divs{grid-template-columns:1fr}.top{gap:8px}.nav{margin-left:0;width:100%;gap:2px}.nav a{padding:6px 9px}}
`;

async function buildTeamsIndexPage(data, periods) {
  const canonicalPath = "/teams/";
  const url = `${SITE_BASE}${canonicalPath}`;
  const period = currentPeriod(data, periods);
  const title = `NFL Teams - Schedules, Odds & Predictions for All 32 Teams | Blitz Odds`;
  const description = `All 32 NFL teams by division. Open a team for its full ${data.seasonYear} schedule, model predictions and win probabilities, team rankings and injury report.`;
  const nextLine = (team) => {
    if (!period) return "";
    const g = period.games.find((x) => x.home === team.id || x.away === team.id);
    if (!g) return period.showByeIfMissing ? `<span class="nx">${escapeHtml(period.label)}: bye</span>` : "";
    const opp = findTeam(data.teams, g.home === team.id ? g.away : g.home);
    if (!opp) return "";
    return `<span class="nx">${escapeHtml(period.label)}: <a href="${gamePagePath(data, period, g)}">${g.home === team.id ? "vs" : "at"} ${escapeHtml(opp.name)}</a></span>`;
  };
  const sections = DIVISION_ORDER.map((div) => {
    const list = data.teams.filter((t) => TEAM_DIVISION[t.id] === div).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) return "";
    return `<section class="card"><h2>${escapeHtml(div)}</h2>${list
      .map((t) => `<div class="team"><img src="/team-badges/${escapeHtml(t.id)}.png" alt="" width="34" height="34" loading="lazy" decoding="async" /><div><a class="nm" href="/teams/${slugify(t.name)}/">${escapeHtml(t.name)}</a>${nextLine(t)}</div></div>`)
      .join("")}</section>`;
  }).join("\n");
  const trail = [{ name: "Blitz Odds", path: "/" }, { name: "NFL teams", path: canonicalPath }];
  const itemList = {
    "@context": "https://schema.org", "@type": "ItemList", name: "NFL teams", numberOfItems: data.teams.length,
    itemListElement: [...data.teams].sort((a, b) => a.name.localeCompare(b.name)).map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, url: `${SITE_BASE}/teams/${slugify(t.name)}/` })),
  };
  const nav = [
    // NFL-only page: no College link here (and no NFL link on the college teams pages).
    ["/", "Home", false], ["/games/", "NFL Games", false],
    ["/teams/", "Teams", true],
  ].map(([href, label, on]) => `<a href="${href}"${on ? ' class="on"' : ""}>${label}</a>`).join("");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-1KHS0JK39B"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-1KHS0JK39B');</script>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${url}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${url}" />
<meta property="og:site_name" content="Blitz Odds" />
<meta property="og:image" content="${SITE_BASE}/branding/blitz-odds-og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@RealBlitzOdds" />
<link rel="icon" type="image/svg+xml" href="/branding/blitz-odds-icon.svg" />
<link rel="apple-touch-icon" href="/branding/apple-touch-icon.png" />
<script>(function(){try{var s=localStorage.getItem("blitz-odds-theme");var m=s==="light"||s==="dark"||s==="system"?s:"dark";var r=m==="system"?(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;if(r==="light")document.documentElement.setAttribute("data-theme","light");}catch(e){}})();</script>
<style>${TEAMS_INDEX_CSS.trim()}.subnav{margin:0 0 12px;padding-bottom:10px;border-bottom:1px solid var(--border)}</style>
${SITE_NAV_LINK}
${breadcrumbJsonLd(trail)}
<script type="application/ld+json">${JSON.stringify(itemList)}</script>
</head>
<body>
<div class="wrap">
${siteHeaderHtml({ top: "14px", side: "16px" })}
<main>
<p class="crumbs"><a href="/">Blitz Odds</a> &rsaquo; NFL teams</p>
<h1>NFL Teams</h1>
<p class="lede">All 32 teams by division. Open a team for its full ${data.seasonYear} schedule, the model's prediction and win probability for every game, team rankings and the injury report.</p>
<div class="divs">
${sections}
</div>
</main>
<footer>
<p>Blitz Odds is for informational and entertainment purposes only and does not accept wagers. Gambling problem? Call or text 1-800-GAMBLER. Not affiliated with or endorsed by the National Football League. Team names and marks are the property of their respective owners.</p>
<p><a href="/games/">NFL games &amp; odds</a>${period ? ` · <a href="${weekHubPath(data, period)}">${escapeHtml(period.label)} picks</a>` : ""} · <a href="/picks/">Pick'em Playbook</a> · <a href="/leagues/">Pick'em leagues</a> · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a></p>
</footer>
</div>
</body>
</html>
`;
  const changed = await writeIfChanged(path.join(REPO_ROOT, "teams", "index.html"), html);
  return { path: canonicalPath, changed };
}

/** Paths that once had a prerendered page and no longer should. */
const RETIRED_PATHS = ["/archive"];

// ---- Sitemaps --------------------------------------------------------------
// Two files, since October 2026:
//
//   sitemap.xml          the live site: /, the tab pages, /privacy, /terms,
//                        32 team pages, the week hubs and every game page
//   sitemap-archive.xml  everything under /historical/ (~3,600 box scores
//                        from 2015-2025, written by backfill-historical-season.mjs)
//
// robots.txt lists both. Before the split all ~4,000 URLs sat in one urlset,
// 93% of them archive pages. On a domain this new, Google's crawl budget is a
// few hundred fetches a day; one flat list meant it spent most of that on
// decade-old box scores before reaching the week hub that could actually
// rank this week. Separate files let Google weight the two sets
// independently, let Search Console report coverage for each on its own,
// and make dropping or thinning the archive later a one-file decision.
//
// sitemap.xml keeps its name and stays a plain <urlset> (not a sitemap index)
// on purpose: static-pages-refresh commits exactly `teams/ games/ sitemap.xml`,
// and indexnow-submit.mts reads the live sitemap.xml as a flat URL list.
// Both keep working untouched, and the archive file only changes when the
// backfill script runs.
//
// changefreq/priority are gone - Google ignores both - and lastmod is kept
// honest: a URL is restamped only when its page content actually changed.

const SITEMAP_SITE = "sitemap.xml";
const SITEMAP_ARCHIVE = "sitemap-archive.xml";

const isArchiveLoc = (loc) => /^https?:\/\/[^/]+\/historical\//.test(loc) || loc.startsWith("/historical/");

/** Parse a <urlset> into an ordered Map of loc -> lastmod (or null). Entries
 *  may be one-line or pretty-printed; changefreq/priority are dropped. */
function parseUrlset(xml) {
  const out = new Map();
  if (!xml) return out;
  const re = /<url>\s*<loc>([^<]*)<\/loc>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = re.exec(xml))) {
    const loc = m[1].trim();
    const lm = m[2].match(/<lastmod>([^<]*)<\/lastmod>/);
    if (!out.has(loc)) out.set(loc, lm ? lm[1].trim() : null);
  }
  return out;
}

function renderUrlset(map) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const [loc, lastmod] of map) {
    lines.push(`  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`);
  }
  lines.push("</urlset>", "");
  return lines.join("\n");
}

async function readIfExists(p) {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

/** Write only when the content differs - a write is a commit is a deploy. */
async function writeIfDifferent(p, body) {
  const existing = await readIfExists(p);
  if (existing === body) return false;
  await writeFile(p, body, "utf8");
  return true;
}

/**
 * @param entries  [{ path, changed }] for every page regenerated this run.
 *                 `changed` decides whether the URL gets today's lastmod or
 *                 keeps the one it already had.
 */
async function updateSitemap(entries) {
  const today = new Date().toISOString().slice(0, 10);
  const siteP = path.join(REPO_ROOT, SITEMAP_SITE);
  const archiveP = path.join(REPO_ROOT, SITEMAP_ARCHIVE);

  // sitemap.xml held the archive too before the split; any /historical/
  // entry still found in it is moved across (that's the one-time migration,
  // and it also catches a stray entry if anything ever appends one there again).
  const site = parseUrlset(await readIfExists(siteP));
  const archive = parseUrlset(await readIfExists(archiveP));

  // Team, week-hub, game and tab pages are rebuilt every run, so the previous
  // run's entries come out before the fresh ones go in. Matched on *path*
  // whatever the host (a hardcoded-host regex once silently stopped matching
  // and the sitemap grew to 32,915 entries for 3,969 URLs). RETIRED_PATHS
  // covers routes that were briefly in TAB_PAGES and no longer are - a
  // sitemap entry that 301s is a soft error in Search Console.
  const isGenerated = (loc) => {
    let pathname;
    try { pathname = new URL(loc).pathname; } catch { pathname = loc.replace(/^https?:\/\/[^/]+/, ""); }
    const clean = pathname.replace(/\/$/, "");
    return /^\/(teams|games)\//.test(pathname)
      || TAB_PAGES.some((t) => t.canonicalPath.replace(/\/$/, "") === clean)
      || RETIRED_PATHS.includes(clean);
  };

  const previousLastmod = new Map(site);
  const kept = new Map();
  let migrated = 0;
  for (const [loc, lastmod] of site) {
    if (isArchiveLoc(loc)) { if (!archive.has(loc)) { archive.set(loc, lastmod); migrated++; } continue; }
    if (isGenerated(loc)) continue; // regenerated below
    kept.set(loc, lastmod);
  }
  if (migrated) log(`Sitemap: moved ${migrated} /historical/ entries out of sitemap.xml into ${SITEMAP_ARCHIVE}.`);
  // The hand-maintained roots always belong here even if a previous file lost them.
  for (const root of ["/", "/privacy/", "/terms/"]) {
    const loc = `${SITE_BASE}${root}`;
    if (!kept.has(loc)) kept.set(loc, previousLastmod.get(loc) || today);
  }
  // The homepage is the template every generated page is cut from and shows
  // the same data, so if any page changed this run the homepage did too.
  if (entries.some((e) => e.changed)) kept.set(`${SITE_BASE}/`, today);

  let restamped = 0;
  let fresh = 0;
  for (const entry of entries) {
    const loc = `${SITE_BASE}${entry.path}`;
    if (kept.has(loc)) continue;
    // Today only if the page really changed. Otherwise carry the existing
    // date forward - and fall back to today only for a URL that has never
    // been in the sitemap before, where there's nothing to carry.
    const lastmod = entry.changed ? today : (previousLastmod.get(loc) || today);
    if (entry.changed) restamped++;
    kept.set(loc, lastmod);
    fresh++;
  }

  const changedSite = await writeIfDifferent(siteP, renderUrlset(kept));
  const changedArchive = await writeIfDifferent(archiveP, renderUrlset(archive));
  return {
    kept: kept.size - fresh,
    fresh,
    archive: archive.size,
    restamped,
    changed: changedSite || changedArchive,
  };
}

async function main() {
  // Compile src/app.jsx -> js/app.js and stamp the asset hashes into
  // index.html BEFORE index.html is read as the template, so every generated
  // page references the bundle that matches the source. Needs esbuild (a
  // devDependency); the static-pages-refresh workflow runs this script in CI
  // without `npm install`, and there it just reuses the committed bundle -
  // correct, since src/app.jsx and js/app.js always land in the same commit.
  let haveEsbuild = true;
  try { await import("esbuild"); } catch { haveEsbuild = false; }
  if (haveEsbuild) {
    log("Building app bundle...");
    await buildApp({ log });
  } else {
    // No esbuild: fine for CI, where source and bundle land in the same
    // commit - but only if they actually match. A stale bundle once shipped
    // this way; assertArtifactsFresh compares the source hash each built
    // file records against the current source and refuses to continue.
    await assertArtifactsFresh();
    log("esbuild not installed - committed js/app.js and css/app.css verified against their sources, reusing them.");
  }

  log("Loading data...");
  const data = await loadData();
  const periodsForHome = getPeriods(data);
  const homeChanged = await stampHomeSnapshot(currentPeriod(data, periodsForHome), data);
  if (homeChanged) log("Homepage snapshot in index.html updated.");
  // Every other page is cut from the shell WITHOUT the homepage's own
  // prerendered hero - each gets its own snapshot instead.
  const template = stripHomeSnapshot(await readFile(path.join(REPO_ROOT, "index.html"), "utf8"));

  log(`Building ${data.teams.length} team pages...`);
  const teamEntries = [];
  for (const team of data.teams) {
    teamEntries.push(await buildTeamPage(template, data, team));
  }

  log("Building game pages...");
  const periods = getPeriods(data);
  const gameEntries = [];
  for (const period of periods) {
    for (const game of period.games) {
      const entry = await buildGamePage(template, data, period, game);
      if (entry) gameEntries.push(entry);
    }
  }

  log(`Building ${periods.length} week hub pages...`);
  const weekEntries = [];
  for (let i = 0; i < periods.length; i++) {
    const entry = await buildWeekHubPage(template, data, periods[i], periods[i - 1] || null, periods[i + 1] || null, periods);
    if (entry) weekEntries.push(entry);
  }

  log(`Building ${TAB_PAGES.length} tab pages...`);
  const tabEntries = [];
  for (const page of TAB_PAGES) {
    tabEntries.push(await buildTabPage(template, page, data, periods));
  }

  const teamsIndexEntry = await buildTeamsIndexPage(data, periods);
  const indexedTabEntries = tabEntries.filter((e, i) => !TAB_PAGES[i].noindex);
  const entries = [...indexedTabEntries, teamsIndexEntry, ...teamEntries, ...weekEntries, ...gameEntries];
  const changedCount = entries.filter((e) => e.changed).length;

  log("Updating sitemap...");
  const sitemap = await updateSitemap(entries);

  log(`Done. ${entries.length} pages checked, ${changedCount} rewritten (${entries.length - changedCount} unchanged).`);
  log(`Sitemap: ${sitemap.kept} kept + ${sitemap.fresh} regenerated = ${sitemap.kept + sitemap.fresh} site URLs (${sitemap.restamped} restamped) in sitemap.xml; ${sitemap.archive} archive URLs in sitemap-archive.xml.`);
  // The line the workflow's git-diff guard cares about: nothing written
  // means nothing to commit, which means no production deploy.
  log(sitemap.changed || changedCount > 0 || homeChanged
    ? "Changes on disk - static-pages-refresh will commit."
    : "No changes on disk - static-pages-refresh will skip the commit (no deploy).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
  return true;
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
  return {
    teams: teamsFile.teams,
    schedule: scheduleFile,
    preseason: preseasonFile,
    playoffs: playoffsFile,
    players: playersFile.players,
    history: historyFile,
    stadiums: stadiumsFile,
    odds: oddsFile,
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

function buildGameSnapshotHtml(data, period, game) {
  const away = teamForWeek(data, period.week, game.away);
  const home = teamForWeek(data, period.week, game.home);
  const awayPlayers = data.players[game.away] || [];
  const homePlayers = data.players[game.home] || [];
  const prediction = PredictionEngine.predictMatchup({
    homeTeam: home,
    awayTeam: away,
    homeImpactPlayers: homePlayers,
    awayImpactPlayers: awayPlayers,
    weather: null,
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
  let resultBlock = "";
  if (result && result.final) {
    const actualWinnerId = result.homeScore > result.awayScore ? game.home : game.away;
    const actualWinnerName = actualWinnerId === home.id ? home.name : away.name;
    const correct = actualWinnerId === prediction.predictedWinner;
    resultBlock = `<p><strong>Final:</strong> ${escapeHtml(away.name)} ${result.awayScore} - ${result.homeScore} ${escapeHtml(home.name)}. ${escapeHtml(actualWinnerName)} won. Model prediction was ${correct ? "correct" : "incorrect"}.</p>`;
  }

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
  <h1>${escapeHtml(away.name)} at ${escapeHtml(home.name)} — ${escapeHtml(period.label)} Odds, Injuries &amp; Prediction</h1>
  <p>${escapeHtml(away.name)} @ ${escapeHtml(home.name)}: live odds, injury report, team rankings comparison, and win probability for this matchup.</p>
  <p>${escapeHtml(game.date)}${game.time ? " · " + escapeHtml(game.time) : ""}${game.network ? " · " + escapeHtml(game.network) : ""}</p>

  ${resultBlock}
  ${oddsBlock}

  <h2>Model prediction</h2>
  <p>Predicted winner: <strong>${escapeHtml(predictedWinnerName)}</strong> - ${escapeHtml(game.away)} ${awayPct}% / ${escapeHtml(game.home)} ${homePct}%</p>

  <h2>Blitz Edge: why the model likes ${escapeHtml(predictedWinnerName)}</h2>
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

  ${injuries ? `<h2>Injury report</h2>\n  <ul>\n${injuries}\n  </ul>` : ""}

  <p>
    <a href="/teams/${slugify(away.name)}/">${escapeHtml(away.name)} full schedule</a> ·
    <a href="/teams/${slugify(home.name)}/">${escapeHtml(home.name)} full schedule</a> ·
    <a href="/">See this week's full NFL odds and predictions on Blitz Odds</a>
  </p>
</div>`;
}

function buildGameHead(template, away, home, canonicalPath) {
  const title = `${away.name} at ${home.name} — Odds, Injuries & Prediction | Blitz Odds`;
  const description = `${away.name} @ ${home.name}: live odds, injury report, team rankings comparison, and win probability for this matchup.`;
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

  let html = buildGameHead(template, away, home, canonicalPath);

  const jsonLd = buildGameJsonLd(data, game, data.seasonYear, canonicalPath);
  if (jsonLd) html = html.replace("</head>", `${jsonLd}\n</head>`);

  const snapshot = buildGameSnapshotHtml(data, period, game);
  if (lastSnapshotGated) {
    const articleLd = buildGatedArticleJsonLd({
      headline: `${away.name} at ${home.name} - ${period.label} prediction and Blitz Edge write-up`,
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
      homeImpactPlayers: data.players[game.home] || [],
      awayImpactPlayers: data.players[game.away] || [],
      weather: null,
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

function buildWeekHubSnapshotHtml(data, period, ladder, prev, next) {
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
    `<a href="/games">All ${seasonYear} weeks</a>`,
    `<a href="/picks">Confidence, survivor &amp; ATS sheets</a>`,
  ]
    .filter(Boolean)
    .join(" · ");

  return `
<div id="prerendered-content">
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

async function buildWeekHubPage(template, data, period, prev, next) {
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

  html = injectAfterBody(html, buildWeekHubSnapshotHtml(data, period, ladder, prev, next));
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
  const homePlayers = data.players[game.home] || [];
  const awayPlayers = data.players[game.away] || [];
  const prediction = PredictionEngine.predictMatchup({
    homeTeam,
    awayTeam,
    homeImpactPlayers: homePlayers,
    awayImpactPlayers: awayPlayers,
    weather: null,
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

  <p><a href="/">See this week's full NFL odds and predictions on Blitz Odds</a></p>
</div>`;
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
  html = html.replace("</head>", `${buildTeamJsonLd(team, canonicalPath)}\n</head>`);

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

  <p><a href="/leagues">Join a free NFL pick'em pool</a> and these picks are one tap away in every format.</p>
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

function buildHomeSnapshotHtml(period) {
  const label = period ? escapeHtml(period.label) : "this week";
  return `${HOME_SNAPSHOT_START}
<div id="prerendered-content" class="app">
  <header class="top">
    <div class="hdr-bar">
      <div class="hdr-lead">
        <a href="/" class="hdr-mark" aria-label="Blitz Odds home">
          <span class="brand-logo-mini" style="display:inline-flex;align-items:center;flex-shrink:0">
            <img src="/branding/blitz-odds-wordmark-dark.svg" alt="Blitz Odds" class="brand-logo-img brand-logo-dark" width="900" height="252" decoding="async" style="height:21px;width:auto;display:block" />
            <img src="/branding/blitz-odds-wordmark-light.svg" alt="Blitz Odds" class="brand-logo-img brand-logo-light" width="900" height="252" loading="lazy" decoding="async" style="height:21px;width:auto;display:none" />
          </span>
        </a>
      </div>
      <div class="hdr-center"></div>
      <div class="header-right-cluster"></div>
    </div>
    <div class="brand-row">
      <span class="brand-logo" style="display:inline-flex;align-items:center;flex-shrink:0">
        <img src="/branding/blitz-odds-wordmark-dark.svg" alt="Blitz Odds" class="brand-logo-img brand-logo-dark" width="900" height="252" decoding="async" style="height:76px;width:auto;display:block" />
        <img src="/branding/blitz-odds-wordmark-light.svg" alt="Blitz Odds" class="brand-logo-img brand-logo-light" width="900" height="252" loading="lazy" decoding="async" style="height:76px;width:auto;display:none" />
      </span>
      <h1 class="sr-only">Blitz Odds</h1>
    </div>
  </header>
  <div class="home-landing">
    <div class="home-hero">
      <div class="home-hero-copy">
        <span class="home-eyebrow">NFL pick'em pools</span>
        <h2 class="home-display">
          Run your pool. <em>Win it too.</em>
          <span class="sr-only"> Free NFL pick'em leagues, odds and model predictions — ${label}.</span>
        </h2>
        <p class="home-lede">
          Blitz Odds gives every game a model win probability, then puts your whole pool on top of
          it — straight-up, confidence, survivor, or against the spread. Set it up once and it
          scores itself all season.
        </p>
        <div class="home-acts">
          <a href="/leagues" class="home-btn primary">Create a free league</a>
          <a href="/games" class="home-btn">Browse this week's games</a>
        </div>
        <div class="home-trust">
          <span>⚡ Odds from 5 sportsbooks</span>
          <span>📊 Injury &amp; weather adjusted</span>
          <span>🏆 Four pool formats</span>
        </div>
      </div>
    </div>
  </div>
</div>
${HOME_SNAPSHOT_END}`;
}

/** Writes the current week's home snapshot into index.html (between the
 *  markers, creating them after <body> on first run). Returns whether the
 *  file changed. */
async function stampHomeSnapshot(period) {
  const indexPath = path.join(REPO_ROOT, "index.html");
  const current = await readFile(indexPath, "utf8");
  const stripped = stripHomeSnapshot(current);
  const next = injectAfterBody(stripped, buildHomeSnapshotHtml(period));
  if (next === current) return false;
  await writeFile(indexPath, next, "utf8");
  return true;
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
    title: "Free NFL Pick'em Pools - Join a League or Run Your Own | Blitz Odds",
    description: "Join a free NFL pick'em pool instantly - no invite needed - or run your own with friends. Confidence, survivor, straight-up, and against-the-spread formats, with automatic scoring and standings.",
  },
  {
    dir: "news",
    canonicalPath: "/news/",
    title: "NFL News | Blitz Odds",
    description: "The latest NFL headlines, injury news, and roster moves, alongside the odds and predictions they move.",
  },
];

async function buildTabPage(template, page, data, periods) {
  let html = applyMeta(template, page);
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
  const homeChanged = await stampHomeSnapshot(currentPeriod(data, periodsForHome));
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
    const entry = await buildWeekHubPage(template, data, periods[i], periods[i - 1] || null, periods[i + 1] || null);
    if (entry) weekEntries.push(entry);
  }

  log(`Building ${TAB_PAGES.length} tab pages...`);
  const tabEntries = [];
  for (const page of TAB_PAGES) {
    tabEntries.push(await buildTabPage(template, page, data, periods));
  }

  const entries = [...tabEntries, ...teamEntries, ...weekEntries, ...gameEntries];
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

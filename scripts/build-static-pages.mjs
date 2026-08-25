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
 *   1. Take the FULL production index.html as a template - same embedded
 *      JSON data blocks, same script tags - so the exact same React app can
 *      still boot on top and take over for live interactivity (scores,
 *      odds, the box score modal, etc).
 *   2. Swap only the <head> tags that need to be page-specific (title,
 *      meta description, canonical, OG/Twitter mirrors) using the SAME
 *      copy useDocumentMeta() would set client-side, so there's no
 *      title/description flash on load.
 *   3. Insert a real, visible content snapshot (team stats, full schedule
 *      with predictions/results, injury report) right after <body> -
 *      this is what a non-JS-executing crawler or link-preview scraper
 *      actually sees.
 *   4. Insert a tiny inline script as the very last thing before </body>
 *      that hides the snapshot once the React app has mounted, so real
 *      visitors only ever see the one, fully-interactive version.
 *
 * Run: node scripts/build-static-pages.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const SITE_BASE = "https://blitz-odds.com";

const PredictionEngine = require(path.join(REPO_ROOT, "js/predictionEngine.js"));

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
/** Mirrors index.html's iso8601GameStart exactly (fixed -05:00 ET offset,
 *  month<=5 rolls to seasonYear+1) - returns null for "TBD" kickoff times
 *  (unflexed weeks 16-18) rather than guessing, same as the client. */
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
  return `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-05:00`;
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
  html = html.replace("<body>", `<body>\n${snapshot}`);

  html = html.replace(
    "</body>",
    `<script>(function(){var el=document.getElementById('prerendered-content');if(el)el.style.display='none';})();</script>\n</body>`
  );

  const outPath = path.join(REPO_ROOT, "games", String(data.seasonYear), weekSlug, `${slugify(away.name)}-at-${slugify(home.name)}`, "index.html");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  return canonicalPath;
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
  });
  const teamWins = prediction.predictedWinner === teamId;
  const teamWinProb = Math.round((isHome ? prediction.homeWinProbability : prediction.awayWinProbability) * 100);
  const result = resultForWeek(data, period.week, game.away, game.home);

  let resultText = "Not played yet";
  if (result && result.final) {
    const actualWinnerId = result.homeScore > result.awayScore ? game.home : game.away;
    const teamWon = actualWinnerId === teamId;
    const correct = teamWon === teamWins;
    resultText = `${game.away} ${result.awayScore} - ${result.homeScore} ${game.home} (${teamWon ? "W" : "L"}${correct ? ", prediction correct" : ", prediction missed"})`;
  }

  const teamName = (findTeam(data.teams, teamId) || {}).name || teamId;
  const oppName = (opp || {}).name || oppId;
  const predictedWinnerName = teamWins ? teamName : oppName;

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
    rows.push(
      `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.location)} ${escapeHtml(row.opponent)}</td><td>${escapeHtml(row.date)}${row.time ? " " + escapeHtml(row.time) : ""}</td><td>${escapeHtml(row.predictedText)} (${row.winProbPct}%)</td><td>${escapeHtml(row.resultText)}</td></tr>`
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
  html = html.replace("<body>", `<body>\n${snapshot}`);

  // Hide the snapshot once React has mounted into #root. Placed as the very
  // last script in <body> (after the app bundle and analytics.js), so by
  // the time it runs, createRoot(...).render() has already painted the same
  // content via the live, fully-interactive app.
  html = html.replace(
    "</body>",
    `<script>(function(){var el=document.getElementById('prerendered-content');if(el)el.style.display='none';})();</script>\n</body>`
  );

  const outPath = path.join(REPO_ROOT, "teams", slug, "index.html");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  return canonicalPath;
}

/* The tab routes. These were hash fragments ("/#news") until the URL-scheme
 * change, which meant the server never saw them: no crawlable page, and
 * nothing a notification or a native app could link to. Prerendering them
 * gives each one a real, indexable document. /leagues doubles as the SEO
 * route that was already on the roadmap.
 *
 * No content snapshot here, unlike team and game pages - these screens are
 * driven by live per-user data (your leagues, this week's hot picks), so
 * there's nothing stable to bake in. The value is the metadata and the 200. */
const TAB_PAGES = [
  {
    dir: "picks",
    canonicalPath: "/picks",
    title: "Hot Picks - This Week's Best NFL Bets | Blitz Odds",
    description: "The model's highest-confidence NFL picks for this week, with win probability, spread value, and the reasoning behind each one.",
  },
  {
    dir: "leagues",
    canonicalPath: "/leagues",
    title: "Pick'em Leagues - Free NFL Pools | Blitz Odds",
    description: "Run a free NFL pick'em pool with friends. Straight-up, confidence, survivor, and against-the-spread formats, with automatic scoring and standings.",
  },
  {
    dir: "news",
    canonicalPath: "/news",
    title: "NFL News | Blitz Odds",
    description: "The latest NFL headlines, injury news, and roster moves, alongside the odds and predictions they move.",
  },
];

async function buildTabPage(template, page) {
  const html = applyMeta(template, page);
  const outPath = path.join(REPO_ROOT, page.dir, "index.html");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  return page.canonicalPath;
}

/** Paths that once had a prerendered page and no longer should. */
const RETIRED_PATHS = ["/archive"];

async function updateSitemap(teamPaths, gamePaths, tabPaths = []) {
  const sitemapPath = path.join(REPO_ROOT, "sitemap.xml");
  const xml = await readFile(sitemapPath, "utf8");
  const today = new Date().toISOString().slice(0, 10);

  // Team and game pages get rebuilt every run (schedule/injuries/odds/
  // predictions change week to week), so the previous run's entries have to
  // come out before the fresh ones go in.
  //
  // This used to be two regexes matching a hardcoded
  // https://blitz-odds.netlify.app/... prefix. SITE_BASE moved to the
  // custom domain, and the strip patterns were never updated - so they
  // stopped matching anything the script itself writes, and every run
  // appended a full set of team + game URLs without removing the last one.
  // By the time this was caught the sitemap had grown to 32,915 entries for
  // 3,969 unique URLs: each team and game listed 83 times, once per run.
  //
  // Rebuilt as a parse-filter-rebuild rather than another prefix regex, so
  // it can't silently no-op again if the domain changes: entries are
  // matched on their *path* whatever the host, and the surviving entries
  // are deduped by URL. That also clears out a legacy generation of
  // /teams/{slug}/index.html URLs (duplicate content alongside the
  // canonical directory form) and three relocated-franchise slugs
  // (oak, sd, stl) that no longer have pages built for them.
  const urlLine = /^\s*<url><loc>([^<]*)<\/loc>(?:<lastmod>[^<]*<\/lastmod>)?<\/url>\s*$/;
  // Anchored at the path root on purpose: /historical/teams/... and
  // /historical/games/... are a separate archive that this script does not
  // generate and must not touch. Both branches resolve a pathname first so
  // an unparseable URL can't fall through to a looser substring match.
  const isTeamOrGame = (loc) => {
    let pathname;
    try {
      pathname = new URL(loc).pathname;
    } catch {
      pathname = loc.replace(/^https?:\/\/[^/]+/, "");
    }
    // Tab pages are rebuilt every run too, so they're stripped and
    // regenerated alongside team and game pages rather than accumulating.
    // RETIRED_PATHS covers routes that were briefly in TAB_PAGES and no
    // longer are - without it they'd be silently "kept" forever, and a
    // sitemap entry that 301s is a soft error in Search Console.
    const clean = pathname.replace(/\/$/, "");
    return /^\/(teams|games)\//.test(pathname)
      || TAB_PAGES.some(t => t.canonicalPath === clean)
      || RETIRED_PATHS.includes(clean);
  };

  const header = [];
  const kept = [];
  const seen = new Set();
  let inUrlSet = false;

  for (const line of xml.split("\n")) {
    if (line.includes("</urlset>")) break;
    const m = line.match(urlLine);
    if (!m) {
      if (!inUrlSet) header.push(line);
      continue;
    }
    inUrlSet = true;
    const loc = m[1];
    if (isTeamOrGame(loc)) continue;      // regenerated below
    if (seen.has(loc)) continue;          // de-dupe anything already accumulated
    seen.add(loc);
    kept.push(line.replace(/\s+$/, ""));
  }

  const fresh = [];
  for (const p of [...tabPaths, ...teamPaths, ...gamePaths]) {
    const loc = `${SITE_BASE}${p}`;
    if (seen.has(loc)) continue;
    seen.add(loc);
    fresh.push(`  <url><loc>${loc}</loc><lastmod>${today}</lastmod></url>`);
  }

  const out = [...header, ...kept, ...fresh, "</urlset>", ""].join("\n");
  await writeFile(sitemapPath, out, "utf8");
  return { kept: kept.length, fresh: fresh.length };
}

async function main() {
  log("Loading data...");
  const data = await loadData();
  const template = await readFile(path.join(REPO_ROOT, "index.html"), "utf8");

  log(`Building ${data.teams.length} team pages...`);
  const teamPaths = [];
  for (const team of data.teams) {
    const p = await buildTeamPage(template, data, team);
    teamPaths.push(p);
  }

  log("Building game pages...");
  const periods = getPeriods(data);
  const gamePaths = [];
  for (const period of periods) {
    for (const game of period.games) {
      const p = await buildGamePage(template, data, period, game);
      if (p) gamePaths.push(p);
    }
  }

  log(`Building ${TAB_PAGES.length} tab pages...`);
  const tabPaths = [];
  for (const page of TAB_PAGES) {
    tabPaths.push(await buildTabPage(template, page));
  }

  log("Updating sitemap...");
  const sitemap = await updateSitemap(teamPaths, gamePaths, tabPaths);

  log(`Done. Wrote ${teamPaths.length} team pages, ${gamePaths.length} game pages, ${tabPaths.length} tab pages.`);
  log(`Sitemap: ${sitemap.kept} kept + ${sitemap.fresh} regenerated = ${sitemap.kept + sitemap.fresh} URLs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

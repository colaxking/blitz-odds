#!/usr/bin/env node
/**
 * build-static-pages.mjs
 *
 * Phase 3 Stage 2a: generates a real, crawlable static HTML file per team
 * (/teams/{team-slug}/index.html) so search engines have an actual indexable
 * page for "kansas city chiefs schedule odds" style queries, instead of only
 * the single homepage URL.
 *
 * Scope note: team pages only for this pass (32 files) - per-game pages
 * (~272/season) are a deliberately separate follow-up once these are live
 * and indexing, per the "teams first, ship, measure, then decide on games"
 * decision from the Phase 3 scoping conversation.
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
const SITE_BASE = "https://blitz-odds.netlify.app";

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
  const [teamsFile, scheduleFile, preseasonFile, playoffsFile, playersFile, historyFile, stadiumsFile] = await Promise.all([
    readJson("data/teams.json"),
    readJson("data/schedule-full-2026.json"),
    readJson("data/schedule-preseason-2026.json"),
    readJson("data/schedule-playoffs-2026.json"),
    readJson("data/impact-players.json"),
    readJson("data/history.json"),
    readJson("data/stadiums.json"),
  ]);
  return {
    teams: teamsFile.teams,
    schedule: scheduleFile,
    preseason: preseasonFile,
    playoffs: playoffsFile,
    players: playersFile.players,
    history: historyFile,
    stadiums: stadiumsFile,
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

async function updateSitemap(newPaths) {
  const sitemapPath = path.join(REPO_ROOT, "sitemap.xml");
  let xml = await readFile(sitemapPath, "utf8");
  const today = new Date().toISOString().slice(0, 10);
  // Team pages get rebuilt every run (schedule/injuries/predictions change
  // week to week) - strip any previous /teams/ entries before re-adding so
  // reruns update lastmod instead of duplicating or going stale.
  xml = xml.replace(/ {2}<url><loc>https:\/\/blitz-odds\.netlify\.app\/teams\/[^<]*<\/loc><lastmod>[^<]*<\/lastmod><\/url>\n/g, "");
  const newEntries = newPaths.map((p) => `  <url><loc>${SITE_BASE}${p}</loc><lastmod>${today}</lastmod></url>`).join("\n");
  xml = xml.replace("</urlset>", `${newEntries}\n</urlset>`);
  await writeFile(sitemapPath, xml, "utf8");
}

async function main() {
  log("Loading data...");
  const data = await loadData();
  const template = await readFile(path.join(REPO_ROOT, "index.html"), "utf8");

  log(`Building ${data.teams.length} team pages...`);
  const paths = [];
  for (const team of data.teams) {
    const p = await buildTeamPage(template, data, team);
    paths.push(p);
  }

  log("Updating sitemap...");
  await updateSitemap(paths);

  log(`Done. Wrote ${paths.length} team pages.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

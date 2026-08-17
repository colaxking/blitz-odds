#!/usr/bin/env node
/**
 * Blitz Odds - historical season backfill (static page generator).
 *
 * Pulls a PRIOR season's preseason and/or postseason results from ESPN and
 * generates static HTML game pages, served directly by Netlify (this repo
 * has no [build] command in netlify.toml, so any HTML file committed here
 * is served as-is at its path - no build step, no Netlify Function needed).
 *
 * Deliberately built as standalone static pages rather than folded into the
 * live app's history.json/HISTORY_DATA: that data model is single-season
 * (week numbers, no season field) and the live app's box-score fetch logic
 * only works for the CURRENT season (see note on ESPN's `year` param below).
 * Extending both to be season-aware is real future work (the in-app
 * "History tab" + cross-season UI, scoped separately) - this script's job
 * is narrower: get real historical content indexed and linkable now,
 * without touching the live app at all.
 *
 * IMPORTANT ESPN API NOTE: the scoreboard endpoint's `year`/`seasontype`/
 * `week` params (what the live app and odds-refresh use) are IGNORED for
 * anything but the current season - confirmed by testing: year=2024 and
 * year=2025 both silently returned 2026 data. The only way to get real
 * historical results is the `dates=YYYYMMDD-YYYYMMDD` range param instead.
 * The per-game summary endpoint (keyed by event id) is unaffected by this -
 * once you have a real event id, box score data works fine.
 *
 * "Season year" convention: a season's preseason falls in Jul/Aug of that
 * calendar year; its postseason falls in Jan/Feb of the FOLLOWING calendar
 * year (e.g. the "2025 season" postseason is Jan/Feb 2026). Pass the season
 * year either way - the date ranges below account for the shift.
 *
 * Usage: node scripts/backfill-historical-season.mjs <year> [phase]
 *   phase: "preseason" | "postseason" | "all" (default: "all")
 *   e.g. node scripts/backfill-historical-season.mjs 2025
 *        node scripts/backfill-historical-season.mjs 2024 postseason
 *
 * Writes:
 *   historical/{year}/{preseason|playoffs}/{round-slug}/{away}-at-{home}.html
 *   historical/{year}/{preseason|playoffs}/index.html   (per-phase season index)
 *   historical/index.html                                (root index, all years/phases)
 *   sitemap.xml                                           (appends new <url> entries)
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const YEAR = Number(process.argv[2]);
const PHASE_ARG = (process.argv[3] || "all").toLowerCase();
if (!YEAR || YEAR < 2000 || YEAR > 2100 || !["preseason", "postseason", "all"].includes(PHASE_ARG)) {
  console.error("Usage: node scripts/backfill-historical-season.mjs <year> [preseason|postseason|all]");
  process.exit(1);
}

const SITE_BASE = "https://blitz-odds.netlify.app";
const ESPN_FETCH_HEADERS = { "User-Agent": "curl/8.4.0" }; // see header note - browser-style UAs get 403'd from server IPs
const ESPN_ABBR_FIX = { WSH: "WAS", LA: "LAR" };

// Mirrors BOXSCORE_KEY_STATS / BOXSCORE_PLAYER_CATEGORIES in index.html's
// BoxScoreModal - keep these two in sync if the live modal's stat picks
// ever change, so the archive pages show the same "full box score" as the
// live app rather than a reduced version.
const BOXSCORE_KEY_STATS = [
  { key: "totalYards", label: "Total Yards" },
  { key: "netPassingYards", label: "Passing Yards" },
  { key: "rushingYards", label: "Rushing Yards" },
  { key: "thirdDownEff", label: "3rd Down Eff." },
  { key: "turnovers", label: "Turnovers" },
  { key: "totalPenaltiesYards", label: "Penalties" },
  { key: "possessionTime", label: "Possession" },
];
const BOXSCORE_PLAYER_CATEGORIES = [
  { key: "passing", label: "Passing", columns: ["C/ATT", "YDS", "TD", "INT"] },
  { key: "rushing", label: "Rushing", columns: ["CAR", "YDS", "TD", "LONG"] },
  { key: "receiving", label: "Receiving", columns: ["REC", "YDS", "TD", "LONG"] },
  { key: "fumbles", label: "Fumbles", columns: ["FUM", "LOST"] },
];

// Two phases, each with its own ESPN seasontype, round-number-to-label
// mapping, URL path segment, and date window relative to the season year.
// "playoffs" (not "postseason") as the path segment/copy term matches the
// existing convention already used elsewhere in this repo (schedule-
// playoffs-2026.json, PLAYOFFS_DATA) - keeping one vocabulary rather than
// introducing a second term for the same thing.
const PHASES = {
  preseason: {
    seasonType: 1,
    pathSegment: "preseason",
    label: "Preseason",
    dateRange: (year) => `${year}0701-${year}0905`,
    rounds: {
      1: { slug: "hall-of-fame-game", label: "Hall of Fame Game" },
      2: { slug: "preseason-week-1", label: "Preseason Week 1" },
      3: { slug: "preseason-week-2", label: "Preseason Week 2" },
      4: { slug: "preseason-week-3", label: "Preseason Week 3" },
    },
  },
  postseason: {
    seasonType: 3,
    pathSegment: "playoffs",
    label: "Playoffs",
    // Postseason for season year Y falls in Jan/Feb of Y+1.
    dateRange: (year) => `${year + 1}0101-${year + 1}0301`,
    rounds: {
      1: { slug: "wild-card-round", label: "Wild Card Round" },
      2: { slug: "divisional-round", label: "Divisional Round" },
      3: { slug: "conference-championships", label: "Conference Championships" },
      // week 4 = Pro Bowl, deliberately omitted - not a real playoff game,
      // gets skipped automatically same as any other unrecognized round.
      5: { slug: "super-bowl", label: "Super Bowl" },
    },
  },
};

const TEAM_FULL_NAMES = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills",
  CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", LV: "Las Vegas Raiders", MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders",
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function fixAbbr(a) {
  return ESPN_ABBR_FIX[a] || a;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function teamSlug(abbr) {
  return slugify(TEAM_FULL_NAMES[abbr] || abbr);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: ESPN_FETCH_HEADERS });
  if (!res.ok) throw new Error(`ESPN request failed (${res.status}): ${url}`);
  return res.json();
}

// Team offense/defense rankings (rush/pass/total, both sides of the ball)
// for a given calendar season, sourced from data/historical-team-rankings.json
// - itself built once from footballdb.com (same source the live app uses for
// current rankings), NOT fetched live by this script. footballdb.com sits
// behind Cloudflare bot protection that blocks plain server-side fetches
// (confirmed by testing - curl-style UA works for ESPN but not this site),
// so this had to be a one-time gather rather than a live scrape step here.
// To add more seasons later, gather the same way and extend that file.
let RANKINGS_DATA = null;
async function loadRankingsData() {
  if (RANKINGS_DATA) return RANKINGS_DATA;
  try {
    RANKINGS_DATA = JSON.parse(await readFile(path.join(REPO_ROOT, "data/historical-team-rankings.json"), "utf8"));
  } catch {
    RANKINGS_DATA = {};
  }
  return RANKINGS_DATA;
}

// Which calendar season's final rankings apply to a game in `year`/`phaseKey`.
// Preseason games predate that season's own stats entirely, so they use the
// PRIOR season's final numbers (the only "current" data available at the
// time) - same convention data/history.json already uses for real 2026
// preseason snapshots. Playoff games happen right after their own season's
// regular season ends, so that season's own final numbers are exactly right.
function rankingsSeasonFor(year, phaseKey) {
  return phaseKey === "preseason" ? year - 1 : year;
}

async function fetchPhaseEvents(year, phaseDef) {  const data = await fetchJson(
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${phaseDef.dateRange(year)}`
  );
  return (data.events || []).filter((e) => e.season && e.season.type === phaseDef.seasonType);
}

async function fetchBoxScoreEssentials(eventId) {
  const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`);
  const comp = data.header && data.header.competitions && data.header.competitions[0];
  const competitors = (comp && comp.competitors) || [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  const linescores = (side) => (side && side.linescores ? side.linescores.map((q) => q.displayValue) : []);

  const boxTeams = (data.boxscore && data.boxscore.teams) || [];
  const findTeamBox = (abbr) => boxTeams.find((t) => fixAbbr(t.team.abbreviation) === abbr);

  function teamStatsFor(abbr) {
    const teamBox = findTeamBox(abbr);
    if (!teamBox) return [];
    const statVal = (key) => {
      const s = teamBox.statistics.find((s) => s.name === key);
      return s ? s.displayValue : "—";
    };
    return BOXSCORE_KEY_STATS.map((stat) => ({ label: stat.label, value: statVal(stat.key) }));
  }

  const boxPlayers = (data.boxscore && data.boxscore.players) || [];
  const findPlayerTeam = (abbr) => boxPlayers.find((t) => fixAbbr(t.team.abbreviation) === abbr);

  function playerStatsFor(abbr) {
    const teamBox = findPlayerTeam(abbr);
    if (!teamBox) return [];
    return BOXSCORE_PLAYER_CATEGORIES.map((catDef) => {
      const stat = teamBox.statistics.find((s) => s.name === catDef.key);
      if (!stat || !stat.athletes || !stat.athletes.length) return null;
      const cols = catDef.columns.map((label) => ({ label, idx: stat.labels.indexOf(label) })).filter((c) => c.idx !== -1);
      if (!cols.length) return null;
      return {
        label: catDef.label,
        columns: cols.map((c) => c.label),
        rows: stat.athletes.map((a) => ({
          name: a.athlete.displayName,
          values: cols.map((c) => (a.stats[c.idx] != null ? a.stats[c.idx] : "—")),
        })),
      };
    }).filter(Boolean);
  }

  return {
    homeLinescores: linescores(home),
    awayLinescores: linescores(away),
    homeTeamStats: home ? teamStatsFor(fixAbbr(home.team.abbreviation)) : [],
    awayTeamStats: away ? teamStatsFor(fixAbbr(away.team.abbreviation)) : [],
    homePlayerStats: home ? playerStatsFor(fixAbbr(home.team.abbreviation)) : [],
    awayPlayerStats: away ? playerStatsFor(fixAbbr(away.team.abbreviation)) : [],
  };
}

const PAGE_CSS = `
:root {
  --bg: #0b1220; --card-bg: #131c2e; --card-border: #223049; --surface-2: #1a2438;
  --text: #eef2f8; --text-dim: #9fb0c9; --accent: #4fd1c5; --accent-rgb: 79,209,197;
  --win: #2ecc71; --win-rgb: 46,204,113; --lose: #55617a; --demo: #a855f7; --demo-rgb: 168,85,247;
}
* { box-sizing: border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); }
.app { max-width: 900px; margin: 0 auto; padding: 20px 16px 60px; }
a { color: var(--accent); }
header.top { text-align: center; margin-bottom: 18px; }
header.top h1 { font-size: 1.85rem; margin: 0 0 4px; font-weight: 800; }
header.top h1 a { text-decoration: none; color: inherit; }
.brand-odds { color: var(--accent); }
.breadcrumb { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 18px; }
.breadcrumb a { color: var(--text-dim); }
.archive-badge { display:inline-block; font-size:0.68rem; font-weight:800; text-transform:uppercase; letter-spacing:.4px;
  padding: 3px 9px; border-radius: 999px; background: rgba(var(--demo-rgb),0.16); color: var(--demo); margin-bottom: 14px; }
.detail { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 22px; margin-bottom: 24px; }
.detail-header { display:flex; align-items:center; justify-content:center; gap: 26px; margin-bottom: 8px; flex-wrap:wrap; }
.detail-team { display:flex; flex-direction:column; align-items:center; gap:6px; width: 180px; }
.detail-score { font-size:2.2rem; font-weight:800; }
.detail-vs { text-align:center; }
.detail-vs .final-label { display:block; color: var(--demo); font-weight:800; font-size:0.78rem; letter-spacing:.5px; margin-bottom:2px; }
.detail-vs .kickoff-label { color: var(--text-dim); font-size: 0.75rem; }
.section-title { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin: 20px 0 10px; font-weight:700; }
.linescore-table { width:100%; border-collapse: collapse; font-size: 0.85rem; }
.linescore-table th, .linescore-table td { padding: 7px 10px; text-align:center; border-bottom: 1px solid var(--card-border); }
.linescore-table th { color: var(--text-dim); font-weight:600; font-size:0.72rem; text-transform:uppercase; }
.linescore-table td:first-child, .linescore-table th:first-child { text-align:left; }
.leaders-cols { display:grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.leader-row { font-size:0.85rem; margin-bottom: 6px; }
.leader-cat { color: var(--text-dim); font-size: 0.72rem; text-transform:uppercase; }
.teamstats-table { width:100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 6px; }
.teamstats-table th, .teamstats-table td { padding: 7px 10px; border-bottom: 1px solid var(--card-border); }
.teamstats-table th { color: var(--text-dim); font-weight:600; font-size:0.72rem; text-transform:uppercase; }
.teamstats-table td:first-child, .teamstats-table th:first-child { text-align:left; color: var(--text-dim); }
.teamstats-table td:not(:first-child), .teamstats-table th:not(:first-child) { text-align:center; }
.playerstats-team { margin-bottom: 18px; }
.playerstats-team h3 { font-size: 0.95rem; margin: 0 0 8px; }
.playerstats-cat { margin-bottom: 12px; }
.playerstats-cat h4 { font-size: 0.75rem; text-transform:uppercase; letter-spacing:.4px; color: var(--text-dim); margin: 0 0 6px; font-weight:700; }
.playerstats-table { width:100%; border-collapse: collapse; font-size: 0.82rem; }
.playerstats-table th, .playerstats-table td { padding: 5px 8px; text-align:center; border-bottom: 1px solid var(--card-border); }
.playerstats-table th { color: var(--text-dim); font-weight:600; font-size:0.68rem; text-transform:uppercase; }
.playerstats-table td:first-child, .playerstats-table th:first-child { text-align:left; }
.season-index-list { list-style:none; padding:0; margin:0; }
.season-index-round { margin-bottom: 22px; }
.season-index-round h3 { font-size: 0.95rem; margin-bottom: 8px; }
.season-index-game { display:flex; justify-content:space-between; padding: 8px 10px; background: var(--card-bg);
  border: 1px solid var(--card-border); border-radius: 10px; margin-bottom: 6px; font-size: 0.85rem; text-decoration:none; color: var(--text); }
.season-index-game:hover { border-color: var(--accent); }
.week-picker { display:flex; align-items:center; gap: 10px; margin-bottom: 22px; }
.week-select { background: var(--card-bg); border: 1px solid var(--card-border); color: var(--text);
  border-radius: 10px; padding: 9px 14px; font-size: 0.85rem; font-weight: 600; }
.rankings-table { width:100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 6px; }
.rankings-table th, .rankings-table td { padding: 7px 10px; border-bottom: 1px solid var(--card-border); }
.rankings-table th { color: var(--text-dim); font-weight:600; font-size:0.72rem; text-transform:uppercase; }
.rankings-table td:first-child, .rankings-table th:first-child { text-align:left; color: var(--text-dim); }
.rankings-table td:not(:first-child), .rankings-table th:not(:first-child) { text-align:center; }
.rank-good { color: var(--win); font-weight: 700; }
.rank-mid { color: var(--text); }
.rank-bad { color: var(--out, #ef4444); font-weight: 700; }
.rankings-note { font-size: 0.75rem; color: var(--text-dim); margin-top: 6px; }
footer.app-footer { color: var(--text-dim); font-size: 0.75rem; margin-top: 30px; text-align:center; }
`;

function pageShell({ title, description, canonicalPath, breadcrumb, bodyHtml, jsonLd, pageScript }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${SITE_BASE}${canonicalPath}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${SITE_BASE}${canonicalPath}" />
<meta name="twitter:card" content="summary" />
<style>${PAGE_CSS}</style>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
</head>
<body>
<div class="app">
  <header class="top">
    <h1><a href="/">Blitz<span class="brand-odds">Odds</span></a></h1>
  </header>
  <div class="breadcrumb">${breadcrumb}</div>
  ${bodyHtml}
  <footer class="app-footer">Historical archive - final scores and box scores via ESPN's public scoreboard API. Part of Blitz Odds.</footer>
</div>
<script src="/js/analytics.js"></script>
${pageScript ? `<script>${pageScript}</script>` : ""}
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function teamStatsTable(awayAbbr, homeAbbr, awayStats, homeStats) {
  const rows = awayStats.map((s, i) => `<tr><td>${escapeHtml(s.label)}</td><td>${escapeHtml(s.value)}</td><td>${escapeHtml((homeStats[i] || {}).value)}</td></tr>`);
  return `<table class="teamstats-table">
    <thead><tr><th></th><th>${escapeHtml(awayAbbr)}</th><th>${escapeHtml(homeAbbr)}</th></tr></thead>
    <tbody>${rows.join("\n")}</tbody>
  </table>`;
}

function playerStatsBlock(abbr, categories) {
  if (!categories.length) return `<div class="playerstats-team"><h3>${escapeHtml(abbr)}</h3><p style="color:var(--text-dim); font-size:0.85rem;">No player stats available.</p></div>`;
  const catsHtml = categories
    .map(
      (cat) => `<div class="playerstats-cat">
        <h4>${escapeHtml(cat.label)}</h4>
        <table class="playerstats-table">
          <thead><tr><th>Player</th>${cat.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
          <tbody>${cat.rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td>${r.values.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("\n")}</tbody>
        </table>
      </div>`
    )
    .join("\n");
  return `<div class="playerstats-team"><h3>${escapeHtml(abbr)}</h3>${catsHtml}</div>`;
}

function linescoreRow(label, scores, total) {
  return `<tr><td>${escapeHtml(label)}</td>${scores.map((s) => `<td>${escapeHtml(s)}</td>`).join("")}<td><strong>${escapeHtml(total)}</strong></td></tr>`;
}

function rankClass(rank) {
  if (rank <= 10) return "rank-good";
  if (rank >= 23) return "rank-bad";
  return "rank-mid";
}

function rankingsTable(awayAbbr, homeAbbr, awayRankings, homeRankings, rankingsSeason) {
  if (!awayRankings || !homeRankings) {
    return `<p style="color:var(--text-dim); font-size:0.85rem;">Team rankings not available for this game.</p>`;
  }
  const row = (label, awayVal, awayRank, homeVal, homeRank) => `<tr>
    <td>${label}</td>
    <td>${awayVal} <span class="${rankClass(awayRank)}">#${awayRank}</span></td>
    <td>${homeVal} <span class="${rankClass(homeRank)}">#${homeRank}</span></td>
  </tr>`;
  return `<table class="rankings-table">
    <thead><tr><th></th><th>${escapeHtml(awayAbbr)}</th><th>${escapeHtml(homeAbbr)}</th></tr></thead>
    <tbody>
      ${row("Total Offense", awayRankings.offense.totalYdsPerGame, awayRankings.offense.rankTotal, homeRankings.offense.totalYdsPerGame, homeRankings.offense.rankTotal)}
      ${row("Rush Offense", awayRankings.offense.rushYdsPerGame, awayRankings.offense.rankRush, homeRankings.offense.rushYdsPerGame, homeRankings.offense.rankRush)}
      ${row("Pass Offense", awayRankings.offense.passYdsPerGame, awayRankings.offense.rankPass, homeRankings.offense.passYdsPerGame, homeRankings.offense.rankPass)}
      ${row("Total Defense", awayRankings.defense.totalYdsPerGame, awayRankings.defense.rankTotal, homeRankings.defense.totalYdsPerGame, homeRankings.defense.rankTotal)}
      ${row("Rush Defense", awayRankings.defense.rushYdsPerGame, awayRankings.defense.rankRush, homeRankings.defense.rushYdsPerGame, homeRankings.defense.rankRush)}
      ${row("Pass Defense", awayRankings.defense.passYdsPerGame, awayRankings.defense.rankPass, homeRankings.defense.passYdsPerGame, homeRankings.defense.rankPass)}
    </tbody>
  </table>
  <div class="rankings-note">Rankings out of 32, 1 = best. Reflects final ${rankingsSeason} regular-season totals (source: The Football Database).</div>`;
}

async function buildGamePage(year, phaseKey, round, game) {
  const phaseDef = PHASES[phaseKey];
  const roundInfo = phaseDef.rounds[round];
  const { awayAbbr, homeAbbr, awayScore, homeScore, date, awayName, homeName } = game;
  const winner = awayScore > homeScore ? "away" : "home";
  let box;
  try {
    box = await fetchBoxScoreEssentials(game.eventId);
  } catch (err) {
    log(`WARN: box score fetch failed for ${awayAbbr}@${homeAbbr} (${game.eventId}) - ${err.message}`);
    box = { homeLinescores: [], awayLinescores: [], homeTeamStats: [], awayTeamStats: [], homePlayerStats: [], awayPlayerStats: [] };
  }

  const title = `${awayName} vs. ${homeName} Final Score & Box Score — ${roundInfo.label}, ${year} ${phaseDef.label} | Blitz Odds`;
  const description = `${awayName} ${awayScore}, ${homeName} ${homeScore} — final score, quarter-by-quarter box score, and top performers from the ${year} ${roundInfo.label}.`;
  const canonicalPath = `/historical/${year}/${phaseDef.pathSegment}/${roundInfo.slug}/${teamSlug(awayAbbr)}-at-${teamSlug(homeAbbr)}.html`;

  const rankingsSeason = rankingsSeasonFor(year, phaseKey);
  const rankingsData = await loadRankingsData();
  const seasonRankings = rankingsData[String(rankingsSeason)];
  const awayRankings = seasonRankings && seasonRankings[awayAbbr];
  const homeRankings = seasonRankings && seasonRankings[homeAbbr];

  const numQuarters = Math.max(box.awayLinescores.length, box.homeLinescores.length, 4);
  const qHeaders = Array.from({ length: numQuarters }, (_, i) => `Q${i + 1}`);

  const bodyHtml = `
    <span class="archive-badge">Historical Archive — ${year} ${phaseDef.label}</span>
    <div class="detail">
      <div class="detail-header">
        <div class="detail-team">
          <div style="font-weight:700;">${escapeHtml(awayName)}</div>
          <div class="detail-score" style="${winner === "away" ? "color:var(--win)" : ""}">${awayScore}</div>
        </div>
        <div class="detail-vs">
          <span class="final-label">FINAL</span>
          <span class="kickoff-label">${escapeHtml(date)}</span>
        </div>
        <div class="detail-team">
          <div style="font-weight:700;">${escapeHtml(homeName)}</div>
          <div class="detail-score" style="${winner === "home" ? "color:var(--win)" : ""}">${homeScore}</div>
        </div>
      </div>

      <div class="section-title">Box Score</div>
      <table class="linescore-table">
        <thead><tr><th>Team</th>${qHeaders.map((q) => `<th>${q}</th>`).join("")}<th>Final</th></tr></thead>
        <tbody>
          ${linescoreRow(awayAbbr, box.awayLinescores, awayScore)}
          ${linescoreRow(homeAbbr, box.homeLinescores, homeScore)}
        </tbody>
      </table>

      <div class="section-title">Team Stats</div>
      ${teamStatsTable(awayAbbr, homeAbbr, box.awayTeamStats, box.homeTeamStats)}

      <div class="section-title">Team Rankings (Offense &amp; Defense)</div>
      ${rankingsTable(awayAbbr, homeAbbr, awayRankings, homeRankings, rankingsSeason)}

      <div class="section-title">Player Stats</div>
      ${playerStatsBlock(awayAbbr, box.awayPlayerStats)}
      ${playerStatsBlock(homeAbbr, box.homePlayerStats)}
    </div>
  `;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: `${awayName} at ${homeName}`,
    startDate: game.isoDate,
    sport: "American Football",
    homeTeam: { "@type": "SportsTeam", name: homeName },
    awayTeam: { "@type": "SportsTeam", name: awayName },
    location: { "@type": "Place", name: game.venue || undefined },
  };

  const breadcrumb = `<a href="/">Home</a> &raquo; <a href="/historical/${year}/${phaseDef.pathSegment}/index.html">${year} ${phaseDef.label}</a> &raquo; ${escapeHtml(roundInfo.label)} &raquo; ${escapeHtml(awayAbbr)} @ ${escapeHtml(homeAbbr)}`;

  return { html: pageShell({ title, description, canonicalPath, breadcrumb, bodyHtml, jsonLd }), canonicalPath };
}

function buildSeasonIndexPage(year, phaseKey, gamesByRound) {
  const phaseDef = PHASES[phaseKey];
  const title = `${year} NFL ${phaseDef.label} Results — Every Score & Box Score | Blitz Odds`;
  const description = `Final scores and box scores for every ${year} NFL ${phaseDef.label.toLowerCase()} game.`;
  const canonicalPath = `/historical/${year}/${phaseDef.pathSegment}/index.html`;
  const breadcrumb = `<a href="/">Home</a> &raquo; ${year} ${phaseDef.label}`;

  const rounds = Object.entries(gamesByRound);
  const options = rounds.map(([round]) => `<option value="round-${round}">${escapeHtml(phaseDef.rounds[round].label)}</option>`).join("\n");

  const bodyHtml = `
    <span class="archive-badge">Historical Archive — ${year} ${phaseDef.label}</span>
    <h2 style="margin-top:0;">${year} NFL ${phaseDef.label} Results</h2>
    <div class="week-picker">
      <label for="week-select" style="color:var(--text-dim); font-size:0.82rem;">Jump to:</label>
      <select id="week-select" class="week-select">
        <option value="all">All Weeks</option>
        ${options}
      </select>
    </div>
    <div class="season-index-list">
      ${rounds
        .map(
          ([round, games]) => `
        <div class="season-index-round" id="round-${round}">
          <h3>${escapeHtml(phaseDef.rounds[round].label)}</h3>
          ${games
            .map(
              (g) => `<a class="season-index-game" href="${g.canonicalPath}">
                <span>${escapeHtml(g.awayName)} @ ${escapeHtml(g.homeName)}</span>
                <span>${g.awayScore}-${g.homeScore}</span>
              </a>`
            )
            .join("\n")}
        </div>`
        )
        .join("\n")}
    </div>
  `;

  // Plain client-side filter - no framework needed for a static page. Shows
  // only the selected round's section, or all of them for "All Weeks".
  const pageScript = `
    document.getElementById('week-select').addEventListener('change', function (e) {
      var sections = document.querySelectorAll('.season-index-round');
      var target = e.target.value;
      sections.forEach(function (s) {
        s.style.display = (target === 'all' || s.id === target) ? '' : 'none';
      });
    });
  `;

  return { html: pageShell({ title, description, canonicalPath, breadcrumb, bodyHtml, pageScript }), canonicalPath };
}

async function writeFileEnsureDir(relPath, content) {
  const full = path.join(REPO_ROOT, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function updateSitemap(newPaths) {
  const sitemapPath = path.join(REPO_ROOT, "sitemap.xml");
  let xml = await readFile(sitemapPath, "utf8");
  const today = new Date().toISOString().slice(0, 10);
  const newEntries = newPaths
    .filter((p) => !xml.includes(p)) // don't duplicate on re-run
    .map((p) => `  <url><loc>${SITE_BASE}${p}</loc><lastmod>${today}</lastmod></url>`)
    .join("\n");
  if (!newEntries) return 0;
  xml = xml.replace("</urlset>", `${newEntries}\n</urlset>`);
  await writeFile(sitemapPath, xml, "utf8");
  return newPaths.length;
}

// Root archive index (/historical/index.html) - scans the historical/
// directory on disk for every season/type index page that exists so far
// (currently just {year}/preseason/index.html) and lists them. Rebuilt in
// full on every run so it always reflects whatever's actually on disk,
// including years backfilled in earlier runs of this script.
async function rebuildRootIndex() {
  const { readdir } = await import("node:fs/promises");
  const historicalDir = path.join(REPO_ROOT, "historical");
  let entries = []; // { year, phaseKey }
  try {
    const yearDirs = (await readdir(historicalDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => Number(b) - Number(a)); // newest first
    for (const year of yearDirs) {
      const phaseDirs = await readdir(path.join(historicalDir, year), { withFileTypes: true });
      for (const phaseKey of Object.keys(PHASES)) {
        if (phaseDirs.some((d) => d.isDirectory() && d.name === PHASES[phaseKey].pathSegment)) {
          entries.push({ year, phaseKey });
        }
      }
    }
  } catch {
    entries = [];
  }

  const title = "Historical NFL Results Archive | Blitz Odds";
  const description = "Browse final scores and box scores from past NFL seasons, archived by Blitz Odds.";
  const canonicalPath = "/historical/index.html";
  const breadcrumb = `<a href="/">Home</a> &raquo; Historical Archive`;
  const bodyHtml = `
    <span class="archive-badge">Historical Archive</span>
    <h2 style="margin-top:0;">Historical Results Archive</h2>
    <div class="season-index-list">
      ${entries
        .map(
          ({ year, phaseKey }) => `<a class="season-index-game" href="/historical/${year}/${PHASES[phaseKey].pathSegment}/index.html">
            <span>${year} ${PHASES[phaseKey].label}</span><span>&rsaquo;</span>
          </a>`
        )
        .join("\n")}
    </div>
  `;
  const html = pageShell({ title, description, canonicalPath, breadcrumb, bodyHtml });
  await writeFileEnsureDir(`.${canonicalPath}`, html);
  return canonicalPath;
}

async function runPhase(year, phaseKey) {
  const phaseDef = PHASES[phaseKey];
  log(`fetching ${year} ${phaseDef.label} events from ESPN...`);
  const events = await fetchPhaseEvents(year, phaseDef);
  const finished = events.filter((e) => {
    const comp = e.competitions && e.competitions[0];
    return comp && comp.status && comp.status.type && comp.status.type.state === "post";
  });
  log(`found ${events.length} ${phaseDef.label.toLowerCase()} events, ${finished.length} finished.`);

  if (finished.length === 0) {
    log(`nothing finished yet for ${year} ${phaseDef.label} - skipping.`);
    return [];
  }

  const gamesByRound = {};
  const newPaths = [];

  for (const event of finished) {
    const round = event.week ? event.week.number : null;
    if (!round || !phaseDef.rounds[round]) {
      log(`WARN: skipping event ${event.id} - unrecognized ${phaseKey} round (week.number=${round}, e.g. Pro Bowl in postseason - expected)`);
      continue;
    }
    const comp = event.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const homeAbbr = fixAbbr(home.team.abbreviation);
    const awayAbbr = fixAbbr(away.team.abbreviation);

    const game = {
      eventId: event.id,
      isoDate: event.date,
      date: new Date(event.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
      venue: comp.venue ? comp.venue.fullName : null,
      awayAbbr, homeAbbr,
      awayName: TEAM_FULL_NAMES[awayAbbr] || away.team.displayName,
      homeName: TEAM_FULL_NAMES[homeAbbr] || home.team.displayName,
      awayScore: Number(away.score),
      homeScore: Number(home.score),
    };

    log(`building page: ${game.awayAbbr} @ ${game.homeAbbr} (${phaseDef.rounds[round].label})...`);
    const { html, canonicalPath } = await buildGamePage(year, phaseKey, round, game);
    await writeFileEnsureDir(`.${canonicalPath}`, html);
    newPaths.push(canonicalPath);

    if (!gamesByRound[round]) gamesByRound[round] = [];
    gamesByRound[round].push({ ...game, canonicalPath });
  }

  // Sort rounds numerically (round 1 = earliest) for the index page.
  const sortedGamesByRound = Object.fromEntries(Object.entries(gamesByRound).sort(([a], [b]) => Number(a) - Number(b)));

  const seasonIndex = buildSeasonIndexPage(year, phaseKey, sortedGamesByRound);
  await writeFileEnsureDir(`.${seasonIndex.canonicalPath}`, seasonIndex.html);
  newPaths.push(seasonIndex.canonicalPath);

  return newPaths;
}

async function main() {
  const phaseKeys = PHASE_ARG === "all" ? Object.keys(PHASES) : [PHASE_ARG];
  let allNewPaths = [];

  for (const phaseKey of phaseKeys) {
    const paths = await runPhase(YEAR, phaseKey);
    allNewPaths = allNewPaths.concat(paths);
  }

  if (allNewPaths.length === 0) {
    log("nothing was backfilled - nothing to index or sitemap.");
    return;
  }

  const rootIndexPath = await rebuildRootIndex();
  allNewPaths.push(rootIndexPath);

  const added = await updateSitemap(allNewPaths);
  log(`wrote ${allNewPaths.length} pages total, added ${added} sitemap entries.`);
}

main().catch((err) => {
  console.error("backfill-historical-season failed:", err);
  process.exit(1);
});

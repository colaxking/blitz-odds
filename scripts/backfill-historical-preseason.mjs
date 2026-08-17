#!/usr/bin/env node
/**
 * Blitz Odds - historical preseason backfill (static page generator).
 *
 * Pulls a PRIOR season's preseason results from ESPN and generates static
 * HTML game pages, served directly by Netlify (this repo has no [build]
 * command in netlify.toml, so any HTML file committed here is served as-is
 * at its path - no build step, no Netlify Function needed).
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
 * Usage: node scripts/backfill-historical-preseason.mjs <year>
 *   e.g. node scripts/backfill-historical-preseason.mjs 2025
 *
 * Writes:
 *   historical/{year}/preseason/{round-slug}/{away}-at-{home}.html  (one per finished game)
 *   historical/{year}/preseason/index.html                          (season index)
 *   sitemap.xml                                                      (appends new <url> entries)
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const YEAR = Number(process.argv[2]);
if (!YEAR || YEAR < 2000 || YEAR > 2100) {
  console.error("Usage: node scripts/backfill-historical-preseason.mjs <year>");
  process.exit(1);
}

const SITE_BASE = "https://blitz-odds.netlify.app";
const ESPN_FETCH_HEADERS = { "User-Agent": "curl/8.4.0" }; // see header note - browser-style UAs get 403'd from server IPs
const ESPN_ABBR_FIX = { WSH: "WAS", LA: "LAR" };

const ROUND_INFO = {
  1: { slug: "hall-of-fame-game", label: "Hall of Fame Game" },
  2: { slug: "preseason-week-1", label: "Preseason Week 1" },
  3: { slug: "preseason-week-2", label: "Preseason Week 2" },
  4: { slug: "preseason-week-3", label: "Preseason Week 3" },
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

async function fetchSeasonEvents(year) {
  // Wide net (Jul 1 - Sep 5) to reliably catch the Hall of Fame Game (late
  // July/early Aug) through Preseason Week 3 (late Aug) regardless of the
  // exact year-to-year calendar shift.
  const data = await fetchJson(
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${year}0701-${year}0905`
  );
  return (data.events || []).filter((e) => e.season && e.season.type === 1);
}

async function fetchBoxScoreEssentials(eventId) {
  const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`);
  const comp = data.header && data.header.competitions && data.header.competitions[0];
  const competitors = (comp && comp.competitors) || [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  const linescores = (side) => (side && side.linescores ? side.linescores.map((q) => q.displayValue) : []);

  function topLeaders(teamAbbr) {
    const teamLeaders = (data.leaders || []).find((l) => l.team && fixAbbr(l.team.abbreviation) === teamAbbr);
    if (!teamLeaders) return [];
    const wanted = ["passingYards", "rushingYards", "receivingYards"];
    return wanted
      .map((cat) => teamLeaders.leaders.find((l) => l.name === cat))
      .filter(Boolean)
      .map((l) => ({
        category: l.displayName,
        athlete: l.leaders[0] && l.leaders[0].athlete ? l.leaders[0].athlete.displayName : null,
        stat: l.leaders[0] ? l.leaders[0].displayValue : null,
      }))
      .filter((l) => l.athlete);
  }

  return {
    homeLinescores: linescores(home),
    awayLinescores: linescores(away),
    homeLeaders: home ? topLeaders(fixAbbr(home.team.abbreviation)) : [],
    awayLeaders: away ? topLeaders(fixAbbr(away.team.abbreviation)) : [],
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
.season-index-list { list-style:none; padding:0; margin:0; }
.season-index-round { margin-bottom: 22px; }
.season-index-round h3 { font-size: 0.95rem; margin-bottom: 8px; }
.season-index-game { display:flex; justify-content:space-between; padding: 8px 10px; background: var(--card-bg);
  border: 1px solid var(--card-border); border-radius: 10px; margin-bottom: 6px; font-size: 0.85rem; text-decoration:none; color: var(--text); }
.season-index-game:hover { border-color: var(--accent); }
footer.app-footer { color: var(--text-dim); font-size: 0.75rem; margin-top: 30px; text-align:center; }
`;

function pageShell({ title, description, canonicalPath, breadcrumb, bodyHtml, jsonLd }) {
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
    <h1><a href="${SITE_BASE}/">Blitz<span class="brand-odds">Odds</span></a></h1>
  </header>
  <div class="breadcrumb">${breadcrumb}</div>
  ${bodyHtml}
  <footer class="app-footer">Historical archive - final scores and box scores via ESPN's public scoreboard API. Part of Blitz Odds.</footer>
</div>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function leadersBlock(leaders) {
  if (!leaders.length) return `<p style="color:var(--text-dim); font-size:0.85rem;">No leader data available.</p>`;
  return leaders
    .map((l) => `<div class="leader-row"><span class="leader-cat">${escapeHtml(l.category)}:</span> ${escapeHtml(l.athlete)} — ${escapeHtml(l.stat)}</div>`)
    .join("\n");
}

function linescoreRow(label, scores, total) {
  return `<tr><td>${escapeHtml(label)}</td>${scores.map((s) => `<td>${escapeHtml(s)}</td>`).join("")}<td><strong>${escapeHtml(total)}</strong></td></tr>`;
}

async function buildGamePage(year, round, game) {
  const { awayAbbr, homeAbbr, awayScore, homeScore, date, awayName, homeName } = game;
  const winner = awayScore > homeScore ? "away" : "home";
  let box;
  try {
    box = await fetchBoxScoreEssentials(game.eventId);
  } catch (err) {
    log(`WARN: box score fetch failed for ${awayAbbr}@${homeAbbr} (${game.eventId}) - ${err.message}`);
    box = { homeLinescores: [], awayLinescores: [], homeLeaders: [], awayLeaders: [] };
  }

  const title = `${awayName} vs. ${homeName} Final Score & Box Score — ${ROUND_INFO[round].label}, ${year} Preseason | Blitz Odds`;
  const description = `${awayName} ${awayScore}, ${homeName} ${homeScore} — final score, quarter-by-quarter box score, and top performers from the ${year} ${ROUND_INFO[round].label}.`;
  const canonicalPath = `/historical/${year}/preseason/${ROUND_INFO[round].slug}/${teamSlug(awayAbbr)}-at-${teamSlug(homeAbbr)}.html`;

  const numQuarters = Math.max(box.awayLinescores.length, box.homeLinescores.length, 4);
  const qHeaders = Array.from({ length: numQuarters }, (_, i) => `Q${i + 1}`);

  const bodyHtml = `
    <span class="archive-badge">Historical Archive — ${year} Preseason</span>
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

      <div class="section-title">Top Performers</div>
      <div class="leaders-cols">
        <div><strong>${escapeHtml(awayAbbr)}</strong>${leadersBlock(box.awayLeaders)}</div>
        <div><strong>${escapeHtml(homeAbbr)}</strong>${leadersBlock(box.homeLeaders)}</div>
      </div>
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

  const breadcrumb = `<a href="${SITE_BASE}/">Home</a> &raquo; <a href="${SITE_BASE}/historical/${year}/preseason/index.html">${year} Preseason</a> &raquo; ${escapeHtml(ROUND_INFO[round].label)} &raquo; ${escapeHtml(awayAbbr)} @ ${escapeHtml(homeAbbr)}`;

  return { html: pageShell({ title, description, canonicalPath, breadcrumb, bodyHtml, jsonLd }), canonicalPath };
}

function buildSeasonIndexPage(year, gamesByRound) {
  const title = `${year} NFL Preseason Results — Every Score & Box Score | Blitz Odds`;
  const description = `Final scores and box scores for every ${year} NFL preseason game — Hall of Fame Game through Preseason Week 3.`;
  const canonicalPath = `/historical/${year}/preseason/index.html`;
  const breadcrumb = `<a href="${SITE_BASE}/">Home</a> &raquo; ${year} Preseason`;

  const bodyHtml = `
    <span class="archive-badge">Historical Archive — ${year} Preseason</span>
    <h2 style="margin-top:0;">${year} NFL Preseason Results</h2>
    <div class="season-index-list">
      ${Object.entries(gamesByRound)
        .map(
          ([round, games]) => `
        <div class="season-index-round">
          <h3>${escapeHtml(ROUND_INFO[round].label)}</h3>
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

  return { html: pageShell({ title, description, canonicalPath, breadcrumb, bodyHtml }), canonicalPath };
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
  let years = [];
  try {
    years = (await readdir(historicalDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => Number(b) - Number(a)); // newest first
  } catch {
    years = [];
  }

  const title = "Historical NFL Results Archive | Blitz Odds";
  const description = "Browse final scores and box scores from past NFL seasons, archived by Blitz Odds.";
  const canonicalPath = "/historical/index.html";
  const breadcrumb = `<a href="${SITE_BASE}/">Home</a> &raquo; Historical Archive`;
  const bodyHtml = `
    <h2 style="margin-top:0;">Historical Results Archive</h2>
    <div class="season-index-list">
      ${years
        .map(
          (year) => `<a class="season-index-game" href="${SITE_BASE}/historical/${year}/preseason/index.html">
            <span>${year} Preseason</span><span>&rsaquo;</span>
          </a>`
        )
        .join("\n")}
    </div>
  `;
  const html = pageShell({ title, description, canonicalPath, breadcrumb, bodyHtml });
  await writeFileEnsureDir(`.${canonicalPath}`, html);
  return canonicalPath;
}

async function main() {
  log(`fetching ${YEAR} preseason events from ESPN...`);
  const events = await fetchSeasonEvents(YEAR);
  const finished = events.filter((e) => {
    const comp = e.competitions && e.competitions[0];
    return comp && comp.status && comp.status.type && comp.status.type.state === "post";
  });
  log(`found ${events.length} preseason events, ${finished.length} finished.`);

  if (finished.length === 0) {
    log("nothing finished yet for this year/season - nothing to backfill.");
    return;
  }

  const gamesByRound = {};
  const allNewPaths = [];

  for (const event of finished) {
    const round = event.week ? event.week.number : null;
    if (!round || !ROUND_INFO[round]) {
      log(`WARN: skipping event ${event.id} - unrecognized preseason round (week.number=${round})`);
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

    log(`building page: ${game.awayAbbr} @ ${game.homeAbbr} (${ROUND_INFO[round].label})...`);
    const { html, canonicalPath } = await buildGamePage(YEAR, round, game);
    await writeFileEnsureDir(`.${canonicalPath}`, html);
    allNewPaths.push(canonicalPath);

    if (!gamesByRound[round]) gamesByRound[round] = [];
    gamesByRound[round].push({ ...game, canonicalPath });
  }

  // Sort rounds numerically (1=HOF, 2/3/4=preseason weeks) for the index page.
  const sortedGamesByRound = Object.fromEntries(Object.entries(gamesByRound).sort(([a], [b]) => Number(a) - Number(b)));

  const seasonIndex = buildSeasonIndexPage(YEAR, sortedGamesByRound);
  await writeFileEnsureDir(`.${seasonIndex.canonicalPath}`, seasonIndex.html);
  allNewPaths.push(seasonIndex.canonicalPath);

  const rootIndexPath = await rebuildRootIndex();
  allNewPaths.push(rootIndexPath);

  const added = await updateSitemap(allNewPaths);
  log(`wrote ${allNewPaths.length} pages, added ${added} sitemap entries.`);
}

main().catch((err) => {
  console.error("backfill-historical-preseason failed:", err);
  process.exit(1);
});

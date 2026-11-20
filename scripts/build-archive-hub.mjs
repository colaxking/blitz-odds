#!/usr/bin/env node
/**
 * Blitz Odds - historical archive hub pages.
 *
 * Rebuilds every archive page that is a LIST of games rather than a single
 * box score, from data/historical-games-index.json (the flat record of every
 * game page scripts/backfill-historical-season.mjs has generated from ESPN):
 *
 *   /historical/index.html                         landing: finder, seasons, teams
 *   /historical/{year}/index.html                  one season, every phase
 *   /historical/{year}/{preseason|regular-season|playoffs}/index.html
 *   /historical/teams/{slug}/index.html            one team, every season
 *
 * No network, no ESPN calls: it only re-presents results already on file, so
 * it can be re-run at any time. The individual game / box-score pages are not
 * touched. Every URL above already existed before this script did - paths,
 * slugs (including the legacy /teams/oak|sd|stl/) and canonicals are kept.
 *
 * Page chrome (GA tag, theme script, shared site header, account menu,
 * settings modal, footer) is taken from the existing historical/index.html
 * rather than re-declared here: those parts are maintained in place by
 * sync-site-header.mjs and the retrofit-archive-* scripts, and a second copy
 * would drift. Only <title>/meta/canonical/JSON-LD and the region between
 * the breadcrumb and the footer are replaced.
 *
 * Styles: css/archive.css. Behaviour: js/archive.js. Both are linked with a
 * content-hash ?v= so a change busts the cache without touching anything else.
 *
 * Run: node scripts/build-archive-hub.mjs [--check]
 * Also called at the end of backfill-historical-season.mjs.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_BASE = "https://blitz-odds.com";
const GAMES_INDEX_PATH = "data/historical-games-index.json";
const SHELL_PATH = "historical/index.html";
const ARCHIVE_HOME = "/historical/index.html";
const DATE_TZ = "America/New_York";

// ---- Reference data ---------------------------------------------------------

// Same 32 names as TEAM_FULL_NAMES in backfill-historical-season.mjs. Slugs
// are derived from these, so this list decides the team URLs - do not add the
// relocated franchises below to it, or /teams/oak/ would silently become
// /teams/oakland-raiders/.
const TEAM_NAMES = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills",
  CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", LV: "Las Vegas Raiders", MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders",
};

// = TEAM_DIVISION in src/app.jsx.
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

// Franchises that appear in the archive under the abbreviation ESPN used
// before they relocated. They keep their own pages and records (their games
// are NOT merged into the current team's page); this only gives them a real
// name and a pointer to where the franchise's later seasons are.
const LEGACY_TEAMS = {
  OAK: { name: "Oakland Raiders", city: "Oakland", nick: "Raiders", successor: "LV" },
  SD: { name: "San Diego Chargers", city: "San Diego", nick: "Chargers", successor: "LAC" },
  STL: { name: "St. Louis Rams", city: "St. Louis", nick: "Rams", successor: "LAR" },
};

const PHASES = {
  preseason: { label: "Preseason", pathSegment: "preseason" },
  regular: { label: "Regular Season", pathSegment: "regular-season" },
  postseason: { label: "Playoffs", pathSegment: "playoffs" },
};
const PHASE_ORDER = ["preseason", "regular", "postseason"];
const SUPER_BOWL_ROUND = 5;

// ---- Small helpers ----------------------------------------------------------

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const teamSlug = (abbr) => slugify(TEAM_NAMES[abbr] || abbr);
const teamName = (abbr) => TEAM_NAMES[abbr] || (LEGACY_TEAMS[abbr] && LEGACY_TEAMS[abbr].name) || abbr;
const isLegacy = (abbr) => !TEAM_NAMES[abbr];
const teamPath = (abbr) => `/historical/teams/${teamSlug(abbr)}/index.html`;
const yearPath = (y) => `/historical/${y}/index.html`;
const phasePath = (y, phaseKey) => `/historical/${y}/${PHASES[phaseKey].pathSegment}/index.html`;
const byName = (a, b) => teamName(a).localeCompare(teamName(b));
const ARROW = `<span class="ah-arrow" aria-hidden="true">&rarr;</span>`;

/** [2015,2016,2017,2019] -> "2015–2017, 2019" */
function yearRanges(years) {
  const ys = [...years].map(Number).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < ys.length; i++) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++;
    out.push(i === j ? `${ys[i]}` : `${ys[i]}–${ys[j]}`);
    i = j;
  }
  return out.join(", ");
}

// Kickoff timestamps are UTC; a US night game is already "tomorrow" in UTC,
// so the calendar date is taken in Eastern time (the NFL's own schedule zone).
const DATE_SHORT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: DATE_TZ });
const DATE_LONG = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: DATE_TZ });
function dateHtml(g, withYear) {
  const d = new Date(g.isoDate);
  if (isNaN(d)) return esc(g.date || "");
  return `<time datetime="${esc(g.isoDate)}">${esc((withYear ? DATE_LONG : DATE_SHORT).format(d))}</time>`;
}

function badge(abbr, size = 24) {
  if (TEAM_NAMES[abbr]) {
    return `<img class="ah-badge" src="/team-badges/${abbr}.png" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" />`;
  }
  return `<span class="ah-badge ah-badge-init" aria-hidden="true">${esc(abbr)}</span>`;
}

/** Round label without the phase repeated ("Preseason Week 1", "Week 5", "Wild Card Round"). */
const roundLabel = (g) => g.roundLabel;
const groupKey = (g) => `${g.phaseKey}-${g.round}`;

// ---- Data -------------------------------------------------------------------

async function loadGames() {
  const games = JSON.parse(await readFile(path.join(ROOT, GAMES_INDEX_PATH), "utf8"));
  // A game ESPN lists as finished at 0-0 that also exists, same teams and
  // venue side, elsewhere in the same season phase is the original slot of a
  // rescheduled game (2017 Week 1 TB @ MIA, moved to Week 11 by Hurricane
  // Irma) - not a scoreless final. It keeps its row and its page link but is
  // shown as postponed, with no score and no winner.
  const seen = new Map();
  for (const g of games) {
    const k = `${g.year}|${g.phaseKey}|${g.awayAbbr}|${g.homeAbbr}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(g);
  }
  return games.map((g) => {
    const twins = seen.get(`${g.year}|${g.phaseKey}|${g.awayAbbr}|${g.homeAbbr}`);
    const played = twins.find((t) => t !== g && (t.awayScore || t.homeScore));
    const postponed = g.awayScore === 0 && g.homeScore === 0 && !!played;
    return postponed ? { ...g, postponed: true, playedIn: played.roundLabel } : g;
  });
}

function summarize(games) {
  const years = [...new Set(games.map((g) => g.year))].sort((a, b) => b - a);
  const teamYears = {};
  for (const g of games) {
    for (const a of [g.awayAbbr, g.homeAbbr]) (teamYears[a] ||= new Set()).add(g.year);
  }
  // The newest season on file counts as current until its Super Bowl is in
  // the archive - never assume it has finished.
  const newest = years[0];
  const newestDone = games.some((g) => g.year === newest && g.phaseKey === "postseason" && g.round === SUPER_BOWL_ROUND);
  return { years, teamYears, currentYear: newestDone ? null : newest };
}

// ---- Shell ------------------------------------------------------------------

const OLD_PAGE_SCRIPT = /<script>(?:(?!<\/script>)[\s\S])*?(?:goTo\('year-nav'\)|getElementById\('week-select'\))(?:(?!<\/script>)[\s\S])*?<\/script>\n?/g;

function makeShell(template, assets) {
  const bodyAt = template.indexOf("<body");
  let head = template.slice(0, bodyAt);
  const body = template.slice(bodyAt);
  const crumbAt = body.indexOf('<div class="breadcrumb">');
  const footAt = body.indexOf('<footer class="app-footer">');
  if (bodyAt < 0 || crumbAt < 0 || footAt < 0) throw new Error(`${SHELL_PATH}: breadcrumb/footer markers not found - cannot reuse it as the page shell.`);

  const pre = body.slice(0, crumbAt).replace(/<div class="app(?: ah)?">/, '<div class="app ah">');
  const post = body.slice(footAt)
    .replace(OLD_PAGE_SCRIPT, "")
    .replace(/<script src="\/js\/archive\.js[^>]*><\/script>\n?/g, "")
    .replace("</body>", `<script src="/js/archive.js?v=${assets.js}" defer></script>\n</body>`);

  head = head
    .replace(/<link rel="stylesheet" href="\/css\/archive\.css[^>]*>\n?/g, "")
    .replace(/<script type="application\/ld\+json" data-archive-hub>[\s\S]*?<\/script>\n?/g, "")
    .replace("</head>", `<link rel="stylesheet" href="/css/archive.css?v=${assets.css}" />\n</head>`);

  return ({ title, description, canonicalPath, jsonLd, bodyHtml }) => {
    const url = SITE_BASE + canonicalPath;
    const h = head
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
      .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(description)}" />`)
      .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${url}" />`)
      .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${esc(title)}" />`)
      .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(description)}" />`)
      .replace(/<meta property="og:type"[^>]*>/, `<meta property="og:type" content="website" />`)
      .replace(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${url}" />`)
      .replace("</head>", `<script type="application/ld+json" data-archive-hub>${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>\n</head>`);
    return h + pre + bodyHtml + "\n  " + post;
  };
}

/** crumbs: [{name, path?}] - the last one is the current page. */
function breadcrumbs(crumbs, canonicalPath) {
  // The wrapper stays `<div class="breadcrumb">`: makeShell() cuts the
  // template at that exact string, and the existing page CSS styles it.
  const html = `<div class="breadcrumb"><nav aria-label="Breadcrumb"><ol class="ah-crumbs">${crumbs
    .map((c, i) => (i < crumbs.length - 1
      ? `<li><a href="${c.path}">${esc(c.name)}</a></li>`
      : `<li aria-current="page">${esc(c.name)}</li>`))
    .join("")}</ol></nav></div>`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: SITE_BASE + (i < crumbs.length - 1 ? c.path : canonicalPath),
    })),
  };
  return { html, jsonLd };
}

const HOME_CRUMB = { name: "Home", path: "/" };
const ARCHIVE_CRUMB = { name: "Historical NFL Scores", path: ARCHIVE_HOME };

// ---- Game rows --------------------------------------------------------------

function statusOf(g) {
  if (g.postponed) return { label: "Postponed", note: g.playedIn ? `Played in ${g.playedIn}` : "" };
  if (g.awayScore === g.homeScore) return { label: "Final", note: "Tie" };
  return { label: "Final", note: "" };
}

/** Season / phase listing row: away over home, score per line. */
function seasonRow(g) {
  const st = statusOf(g);
  const awayWin = !g.postponed && g.awayScore > g.homeScore;
  const homeWin = !g.postponed && g.homeScore > g.awayScore;
  const line = (abbr, score, win, home) => `<span class="ah-g-team${win ? " is-win" : ""}">${badge(abbr)}<span class="ah-g-name">${esc(teamName(abbr))}${home ? ` <span class="ah-g-ha">Home</span>` : ""}</span><span class="ah-g-score">${g.postponed ? "&ndash;" : score}</span>${win ? `<span class="sr-only"> (winner)</span>` : ""}</span>`;
  return `<a class="season-index-game ah-game" data-origin="index" data-away="${g.awayAbbr}" data-home="${g.homeAbbr}" href="${g.canonicalPath}">
            <span class="ah-g-date">${dateHtml(g, false)}</span>
            <span class="ah-g-teams">${line(g.awayAbbr, g.awayScore, awayWin, false)}${line(g.homeAbbr, g.homeScore, homeWin, true)}</span>
            <span class="ah-g-meta"><span class="ah-g-status${g.postponed ? " is-off" : ""}">${st.label}${st.note ? ` <span class="ah-g-note">&middot; ${esc(st.note)}</span>` : ""}</span><span class="ah-g-cta">${g.postponed ? "Game page" : "Box score"} ${ARROW}</span></span>
          </a>`;
}

/** Team history row: opponent, W/L/T from this team's side. */
function teamRow(g, abbr) {
  const away = g.awayAbbr === abbr;
  const opp = away ? g.homeAbbr : g.awayAbbr;
  const us = away ? g.awayScore : g.homeScore;
  const them = away ? g.homeScore : g.awayScore;
  const res = g.postponed ? null : us > them ? "W" : us < them ? "L" : "T";
  const resWord = { W: "Win", L: "Loss", T: "Tie" }[res];
  const result = g.postponed
    ? `<span class="ah-g-status is-off">Postponed${g.playedIn ? ` <span class="ah-g-note">&middot; Played in ${esc(g.playedIn)}</span>` : ""}</span>`
    : `<span class="ah-g-res team-result-${res.toLowerCase()}"><span aria-hidden="true">${res}</span><span class="sr-only">${resWord}</span> ${us}&ndash;${them}</span><span class="ah-g-status">Final</span>`;
  return `<a class="season-index-game ah-game ah-game-team" data-origin="team" data-away="${g.awayAbbr}" data-home="${g.homeAbbr}" data-team="${abbr}" data-season="${g.year}" data-type="${g.phaseKey}" href="${g.canonicalPath}">
            <span class="ah-g-date">${dateHtml(g, false)}<span class="ah-g-round">${esc(roundLabel(g))}</span></span>
            <span class="ah-g-teams"><span class="ah-g-team"><span class="ah-g-vs">${away ? "at" : "vs"}</span>${badge(opp)}<span class="ah-g-name">${esc(teamName(opp))}</span></span></span>
            <span class="ah-g-meta">${result}<span class="ah-g-cta">${g.postponed ? "Game page" : "Box score"} ${ARROW}</span></span>
          </a>`;
}

/** Games grouped phase -> round, in season order. */
function groupByPhaseRound(games) {
  const phases = [];
  for (const phaseKey of PHASE_ORDER) {
    const inPhase = games.filter((g) => g.phaseKey === phaseKey);
    if (!inPhase.length) continue;
    const rounds = [...new Set(inPhase.map((g) => g.round))].sort((a, b) => a - b).map((round) => {
      const list = inPhase.filter((g) => g.round === round).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
      return { key: `${phaseKey}-${round}`, label: list[0].roundLabel, games: list };
    });
    phases.push({ phaseKey, label: PHASES[phaseKey].label, rounds });
  }
  return phases;
}

const emptyState = (what) => `<div class="ah-empty" data-ah-empty hidden>
      <p><strong>No games match these filters.</strong> ${what}</p>
      <button type="button" class="ah-btn ah-btn-ghost" data-ah-reset>Clear filters</button>
    </div>`;

// ---- Season + phase pages ---------------------------------------------------

function seasonNav({ prev, next, prevLabel, nextLabel, extra = "" }) {
  return `<nav class="ah-pager" aria-label="Season navigation">
      ${prev ? `<a class="ah-pager-link" href="${prev}" rel="prev"><span aria-hidden="true">&larr;</span> ${esc(prevLabel)}</a>` : `<span class="ah-pager-link is-disabled" aria-hidden="true"></span>`}
      <a class="ah-pager-link ah-pager-mid" href="${ARCHIVE_HOME}">All seasons &amp; teams</a>
      ${next ? `<a class="ah-pager-link" href="${next}" rel="next">${esc(nextLabel)} ${ARROW}</a>` : `<span class="ah-pager-link is-disabled" aria-hidden="true"></span>`}
    </nav>${extra}`;
}

function resultsFilters(phases, teams, { showPhaseInRound }) {
  const roundOptions = phases.map((p) => {
    const opts = p.rounds.map((r) => `<option value="group-${r.key}">${esc(r.label)}</option>`).join("");
    return showPhaseInRound ? `<optgroup label="${esc(p.label)}">${opts}</optgroup>` : opts;
  }).join("");
  const teamOptions = teams.map((a) => `<option value="${a}" data-slug="${teamSlug(a)}">${esc(teamName(a))}</option>`).join("");
  return `<form class="ah-filters" data-ah-filters="season" aria-label="Filter games" onsubmit="return false">
      <div class="ah-field">
        <label for="week-select">Week or round</label>
        <select id="week-select" class="ah-select"><option value="all">All games</option>${roundOptions}</select>
      </div>
      <div class="ah-field">
        <label for="team-select">Team</label>
        <select id="team-select" class="ah-select"><option value="all">All teams</option>${teamOptions}</select>
      </div>
      <p class="ah-count" data-ah-count role="status" aria-live="polite"></p>
    </form>`;
}

function roundsHtml(phases, { phaseHeadings }) {
  return phases.map((p) => {
    const rounds = p.rounds.map((r) => `
        <section class="season-index-round ah-round" id="group-${r.key}" aria-labelledby="h-${r.key}">
          <${phaseHeadings ? "h3" : "h2"} class="ah-round-title" id="h-${r.key}">${esc(r.label)}</${phaseHeadings ? "h3" : "h2"}>
          ${r.games.map(seasonRow).join("\n          ")}
        </section>`).join("");
    return phaseHeadings
      ? `<section class="ah-phase" data-ah-phase aria-labelledby="h-${p.phaseKey}">
      <h2 class="ah-phase-title" id="h-${p.phaseKey}">${esc(p.label)}</h2>${rounds}
    </section>`
      : `<div class="ah-phase" data-ah-phase>${rounds}</div>`;
  }).join("\n    ");
}

function currentSeasonNote(year, phases) {
  const have = phases.map((p) => p.label.toLowerCase());
  const list = have.length > 1 ? `${have.slice(0, -1).join(", ")} and ${have[have.length - 1]}` : have[0];
  return `<p class="ah-note"><span class="ah-pill ah-pill-live">Current season</span> The ${year} season is still being played. This archive currently holds its ${list} results; this season's other scores are on the <a href="/games/">NFL games page</a> until they are archived here.</p>`;
}

function buildYearPage(year, games, ctx) {
  const mine = games.filter((g) => g.year === year);
  const phases = groupByPhaseRound(mine);
  const teams = [...new Set(mine.flatMap((g) => [g.awayAbbr, g.homeAbbr]))].sort(byName);
  const isCurrent = ctx.currentYear === year;
  const canonicalPath = yearPath(year);
  const phaseList = phases.map((p) => p.label.toLowerCase());
  const phaseText = phaseList.length > 1 ? `${phaseList.slice(0, -1).join(", ")} and ${phaseList[phaseList.length - 1]}` : phaseList[0];
  const title = `${year} NFL Scores & Results: Every Game & Box Score | Blitz Odds`;
  const description = isCurrent
    ? `${year} NFL scores so far: final results and box scores from the ${phaseText}, by week and by team. Updated as the season is archived.`
    : `Every ${year} NFL final score in order - ${phaseText} - with a box score for each game. Filter by week or team.`;
  const { html: crumbHtml, jsonLd } = breadcrumbs([HOME_CRUMB, ARCHIVE_CRUMB, { name: `${year} Season` }], canonicalPath);
  const older = ctx.years.includes(year - 1) ? year - 1 : null;
  const newer = ctx.years.includes(year + 1) ? year + 1 : null;
  const phaseLinks = phases.map((p) => `<a href="${phasePath(year, p.phaseKey)}">${year} ${esc(p.label.toLowerCase())} results</a>`).join("");

  const bodyHtml = `${crumbHtml}
  <header class="ah-head">
    <span class="archive-badge">NFL Results Archive</span>
    <h1 class="archive-title">${year} NFL Scores &amp; Results</h1>
    <p class="ah-lede">Final scores from the ${year} NFL ${phaseText}, in the order the games were played. Select any game for its box score.</p>
    ${isCurrent ? currentSeasonNote(year, phases) : ""}
  </header>
  ${seasonNav({ prev: older && yearPath(older), next: newer && yearPath(newer), prevLabel: `${older} season`, nextLabel: `${newer} season` })}
  ${resultsFilters(phases, teams, { showPhaseInRound: true })}
  <div class="season-index-list ah-results" data-ah-results>
    ${roundsHtml(phases, { phaseHeadings: true })}
    ${emptyState("Try a different week or team.")}
  </div>
  <nav class="ah-related" aria-label="More ${year} results">
    <h2 class="ah-related-title">More from ${year}</h2>
    <div class="ah-links">${phaseLinks}<a href="${ARCHIVE_HOME}#teams">Results by team</a></div>
  </nav>
  <p class="ah-fine">Dates are shown in Eastern Time.</p>`;
  return { canonicalPath, title, description, jsonLd, bodyHtml };
}

function buildPhasePage(year, phaseKey, games, ctx) {
  const mine = games.filter((g) => g.year === year && g.phaseKey === phaseKey);
  const phases = groupByPhaseRound(mine);
  const label = PHASES[phaseKey].label;
  const teams = [...new Set(mine.flatMap((g) => [g.awayAbbr, g.homeAbbr]))].sort(byName);
  const canonicalPath = phasePath(year, phaseKey);
  const title = `${year} NFL ${label} Scores & Results | Blitz Odds`;
  const description = phaseKey === "postseason"
    ? `${year} NFL playoff scores by round, with a box score for every game on file.`
    : `${year} NFL ${label.toLowerCase()} final scores by week, with a box score for every game. Filter by week or team.`;
  const { html: crumbHtml, jsonLd } = breadcrumbs([HOME_CRUMB, ARCHIVE_CRUMB, { name: `${year} Season`, path: yearPath(year) }, { name: label }], canonicalPath);
  const has = (y) => games.some((g) => g.year === y && g.phaseKey === phaseKey);
  const older = has(year - 1) ? year - 1 : null;
  const newer = has(year + 1) ? year + 1 : null;
  const siblings = PHASE_ORDER.filter((k) => k !== phaseKey && games.some((g) => g.year === year && g.phaseKey === k))
    .map((k) => `<a href="${phasePath(year, k)}">${year} ${esc(PHASES[k].label.toLowerCase())} results</a>`).join("");
  const isCurrent = ctx.currentYear === year;

  const bodyHtml = `${crumbHtml}
  <header class="ah-head">
    <span class="archive-badge">NFL Results Archive</span>
    <h1 class="archive-title">${year} NFL ${esc(label)} Scores &amp; Results</h1>
    <p class="ah-lede">Final scores from the ${year} NFL ${esc(label.toLowerCase())}${phaseKey === "postseason" ? ", round by round" : ", week by week"}. Select any game for its box score.</p>
    ${isCurrent ? `<p class="ah-note"><span class="ah-pill ah-pill-live">Current season</span> The ${year} season is still being played, so this list may not be complete yet.</p>` : ""}
  </header>
  ${seasonNav({ prev: older && phasePath(older, phaseKey), next: newer && phasePath(newer, phaseKey), prevLabel: `${older} ${label.toLowerCase()}`, nextLabel: `${newer} ${label.toLowerCase()}` })}
  ${resultsFilters(phases, teams, { showPhaseInRound: false })}
  <div class="season-index-list ah-results" data-ah-results>
    ${roundsHtml(phases, { phaseHeadings: false })}
    ${emptyState("Try a different week or team.")}
  </div>
  <nav class="ah-related" aria-label="More ${year} results">
    <h2 class="ah-related-title">More from ${year}</h2>
    <div class="ah-links"><a href="${yearPath(year)}">All ${year} NFL results</a>${siblings}<a href="${ARCHIVE_HOME}#teams">Results by team</a></div>
  </nav>
  <p class="ah-fine">Dates are shown in Eastern Time.</p>`;
  return { canonicalPath, title, description, jsonLd, bodyHtml };
}

// ---- Team pages -------------------------------------------------------------

/** Where a relocated franchise's other seasons live, from what is on file. */
function relatedHistory(abbr, ctx) {
  const span = (a) => yearRanges(ctx.teamYears[a] || []);
  if (LEGACY_TEAMS[abbr]) {
    const l = LEGACY_TEAMS[abbr];
    if (!ctx.teamYears[l.successor]) return "";
    return `<p class="ah-note">The ${esc(l.nick)} played as the ${esc(l.name)} in the seasons listed here (${span(abbr)}). The franchise's later results (${span(l.successor)}) are listed under the <a href="${teamPath(l.successor)}">${esc(teamName(l.successor))}</a>.</p>`;
  }
  const prior = Object.entries(LEGACY_TEAMS).find(([a, l]) => l.successor === abbr && ctx.teamYears[a]);
  if (!prior) return "";
  const [a, l] = prior;
  return `<p class="ah-note">Looking for earlier seasons? ${esc(l.nick)} results from ${span(a)} are archived under the <a href="${teamPath(a)}">${esc(l.name)}</a>.</p>`;
}

function buildTeamPage(abbr, games, ctx) {
  const name = teamName(abbr);
  const mine = games.filter((g) => g.awayAbbr === abbr || g.homeAbbr === abbr).sort((a, b) => b.isoDate.localeCompare(a.isoDate));
  const years = [...new Set(mine.map((g) => g.year))].sort((a, b) => b - a);
  const span = yearRanges(years);
  const types = PHASE_ORDER.filter((k) => mine.some((g) => g.phaseKey === k));
  const canonicalPath = teamPath(abbr);
  const title = `${name} Scores & Results by Season, ${span} | Blitz Odds`;
  const description = `${name} final scores and box scores for every archived game from ${span}: preseason, regular season and playoffs, newest first.`;
  const { html: crumbHtml, jsonLd } = breadcrumbs([HOME_CRUMB, ARCHIVE_CRUMB, { name: "Teams", path: `${ARCHIVE_HOME}#teams` }, { name }], canonicalPath);
  const division = TEAM_DIVISION[abbr];
  const livePage = TEAM_NAMES[abbr] ? `/teams/${teamSlug(abbr)}/` : null;

  const sections = years.map((y) => {
    const rows = mine.filter((g) => g.year === y);
    return `
    <section class="season-index-round ah-round" id="season-${y}" data-ah-season="${y}" aria-labelledby="h-season-${y}">
      <div class="ah-round-head">
        <h2 class="ah-round-title" id="h-season-${y}">${y} season${ctx.currentYear === y ? ` <span class="ah-pill ah-pill-live">Current</span>` : ""}</h2>
        <a class="ah-round-more" href="${yearPath(y)}">All ${y} NFL results ${ARROW}</a>
      </div>
      ${rows.map((g) => teamRow(g, abbr)).join("\n      ")}
    </section>`;
  }).join("");

  const bodyHtml = `${crumbHtml}
  <header class="ah-head ah-head-team">
    <span class="archive-badge">NFL Results Archive</span>
    <div class="ah-team-id">${badge(abbr, 44)}<div>
      <h1 class="archive-title">${esc(name)} Scores &amp; Results</h1>
      <p class="ah-team-meta">${division ? `${esc(division)} &middot; ` : `<span class="ah-pill">Historical franchise</span> `}Archived seasons: ${span}</p>
    </div></div>
    <p class="ah-lede">Every archived ${esc(name)} game, newest first, with the final score and a link to the box score.</p>
    ${relatedHistory(abbr, ctx)}
  </header>
  <nav class="ah-pager" aria-label="Archive navigation">
    <a class="ah-pager-link" href="${ARCHIVE_HOME}#teams"><span aria-hidden="true">&larr;</span> All teams</a>
    <a class="ah-pager-link ah-pager-mid" href="${ARCHIVE_HOME}">All seasons &amp; teams</a>
    ${livePage ? `<a class="ah-pager-link" href="${livePage}">${esc(name)} this season ${ARROW}</a>` : `<span class="ah-pager-link is-disabled" aria-hidden="true"></span>`}
  </nav>
  <form class="ah-filters" data-ah-filters="team" aria-label="Filter games" onsubmit="return false">
    <div class="ah-field">
      <label for="season-select">Season</label>
      <select id="season-select" class="ah-select"><option value="all">All seasons</option>${years.map((y) => `<option value="${y}">${y}${ctx.currentYear === y ? " (current season)" : ""}</option>`).join("")}</select>
    </div>
    <div class="ah-field">
      <label for="type-select">Game type</label>
      <select id="type-select" class="ah-select"><option value="all">All games</option>${types.map((k) => `<option value="${k}">${esc(PHASES[k].label)}</option>`).join("")}</select>
    </div>
    <p class="ah-count" data-ah-count role="status" aria-live="polite"></p>
  </form>
  <div class="season-index-list ah-results" data-ah-results>${sections}
    ${emptyState(`The archive has no ${esc(name)} games for that combination.`)}
  </div>
  <p class="ah-fine">Dates are shown in Eastern Time.</p>`;
  return { canonicalPath, title, description, jsonLd, bodyHtml };
}

// ---- Landing page -----------------------------------------------------------

function buildLandingPage(games, ctx) {
  const canonicalPath = ARCHIVE_HOME;
  const title = "Historical NFL Scores & Results by Season and Team | Blitz Odds";
  const description = "Browse historical NFL scores, game results, and box scores by season or team. Explore past NFL matchups and final scores on Blitz Odds.";
  const { html: crumbHtml, jsonLd } = breadcrumbs([HOME_CRUMB, { name: "Historical NFL Scores" }], canonicalPath);
  const { years, teamYears, currentYear } = ctx;
  const active = Object.keys(TEAM_NAMES).filter((a) => teamYears[a]).sort(byName);
  const legacy = Object.keys(teamYears).filter(isLegacy).sort(byName);

  // Finder
  const seasonOptions = years.map((y) => `<option value="${y}">${y}${currentYear === y ? " (current season)" : ""}</option>`).join("");
  const teamOption = (a, i) => `<li class="ah-opt" role="option" id="finder-team-opt-${i}" aria-selected="false" data-abbr="${a}" data-slug="${teamSlug(a)}" data-name="${esc(teamName(a))}" data-years="${[...teamYears[a]].sort().join(",")}">${badge(a, 22)}<span class="ah-opt-name">${esc(teamName(a))}</span>${isLegacy(a) ? `<span class="ah-opt-tag">${yearRanges(teamYears[a])}</span>` : ""}</li>`;
  const finderTeams = [...active, ...legacy].map(teamOption).join("");

  // Seasons
  const seasonCard = (y) => `<a class="ah-card ah-season" href="${yearPath(y)}">
        <span class="ah-season-year">${y}</span>
        <span class="ah-season-label">NFL Results</span>
        ${currentYear === y ? `<span class="ah-pill ah-pill-live">Current season</span>` : ""}
        ${ARROW}
      </a>`;
  const newest = years.slice(0, 6);
  const older = years.slice(6);

  // Teams
  const teamCard = (a) => {
    const div = TEAM_DIVISION[a];
    const l = LEGACY_TEAMS[a];
    const sub = div
      ? esc(div)
      : `${yearRanges(teamYears[a])}${l && teamYears[l.successor] ? ` &middot; now ${esc(teamName(l.successor))}` : ""}`;
    return `<a class="ah-card ah-team" href="${teamPath(a)}" data-ah-team data-name="${esc(teamName(a).toLowerCase())} ${a.toLowerCase()}" data-conf="${div ? div.slice(0, 3) : "legacy"}">
        ${badge(a, 32)}
        <span class="ah-team-text"><span class="ah-team-name">${esc(teamName(a))}</span><span class="ah-team-sub">${sub}</span></span>
        ${ARROW}
      </a>`;
  };

  const bodyHtml = `${crumbHtml}
  <header class="ah-head">
    <span class="archive-badge">NFL Results Archive</span>
    <h1 class="archive-title">Historical NFL Scores &amp; Results</h1>
    <p class="ah-lede">Explore past NFL seasons, final scores, game results, and box scores. Browse by season or team to find historical matchups.</p>
  </header>

  <section class="ah-panel ah-finder" aria-labelledby="finder-title">
    <h2 class="ah-panel-title" id="finder-title">Find Historical Games</h2>
    <form class="ah-finder-form" data-ah-finder novalidate>
      <div class="ah-field">
        <label for="finder-season">Season</label>
        <select id="finder-season" class="ah-select" aria-describedby="finder-msg">
          <option value="">Any season</option>${seasonOptions}
        </select>
      </div>
      <div class="ah-field ah-combo" data-ah-combo>
        <label for="finder-team" id="finder-team-label">Team</label>
        <div class="ah-combo-box">
          <input id="finder-team" class="ah-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="finder-team-list" aria-describedby="finder-msg" autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="Any team &mdash; type to search" />
          <button type="button" class="ah-combo-clear" data-ah-combo-clear aria-label="Clear team" hidden>&times;</button>
          <ul class="ah-listbox" id="finder-team-list" role="listbox" aria-labelledby="finder-team-label" hidden>${finderTeams}<li class="ah-opt-none" data-ah-combo-none hidden>No team matches</li></ul>
        </div>
      </div>
      <button type="submit" class="ah-btn ah-btn-primary">View Results ${ARROW}</button>
      <p class="ah-msg" id="finder-msg" role="alert" data-ah-finder-msg></p>
    </form>
    <noscript><p class="ah-fine">The finder needs JavaScript. Every season and team is also linked below.</p></noscript>
  </section>

  <section class="ah-section" id="seasons" aria-labelledby="seasons-title">
    <h2 class="ah-section-title" id="seasons-title">Browse by Season</h2>
    <div class="ah-grid ah-grid-seasons">
      ${newest.map(seasonCard).join("\n      ")}
    </div>
    ${older.length ? `<details class="ah-more">
      <summary><span class="ah-more-closed">Show older seasons (${yearRanges(older)})</span><span class="ah-more-open">Hide older seasons</span></summary>
      <div class="ah-grid ah-grid-seasons">
      ${older.map(seasonCard).join("\n      ")}
      </div>
    </details>` : ""}
  </section>

  <section class="ah-section" id="teams" aria-labelledby="teams-title">
    <h2 class="ah-section-title" id="teams-title">Browse by NFL Team</h2>
    <div class="ah-teamtools" data-ah-teamtools>
      <div class="ah-field ah-field-search">
        <label for="team-search">Search teams</label>
        <input id="team-search" class="ah-input" type="search" autocomplete="off" spellcheck="false" placeholder="Team name or city" />
      </div>
      <div class="ah-seg" role="group" aria-label="Conference">
        <button type="button" class="ah-seg-btn" data-ah-conf="all" aria-pressed="true">All</button>
        <button type="button" class="ah-seg-btn" data-ah-conf="AFC" aria-pressed="false">AFC</button>
        <button type="button" class="ah-seg-btn" data-ah-conf="NFC" aria-pressed="false">NFC</button>
      </div>
    </div>
    <p class="sr-only" role="status" aria-live="polite" data-ah-team-count></p>
    <div class="ah-grid ah-grid-teams" data-ah-teamgrid>
      ${active.map(teamCard).join("\n      ")}
    </div>
    ${legacy.length ? `<div class="ah-legacy" data-ah-legacy>
      <h3 class="ah-sub-title">Historical franchises</h3>
      <p class="ah-fine">Teams that have since relocated. Their games from those seasons are kept under the name they played as.</p>
      <div class="ah-grid ah-grid-teams">
      ${legacy.map(teamCard).join("\n      ")}
      </div>
    </div>` : ""}
    <p class="ah-empty ah-empty-inline" data-ah-team-empty hidden>No teams match that search.</p>
  </section>

  <section class="ah-section ah-about" aria-labelledby="about-title">
    <h2 class="ah-section-title" id="about-title">About the archive</h2>
    <p>The Blitz Odds archive covers NFL seasons from ${years[years.length - 1]} to ${years[0]}: preseason, regular season and playoff games, each with its final score and a box score with team and player statistics. Results come from ESPN's public scoreboard data. For this week's matchups and win probabilities, see the <a href="/games/">NFL games page</a>.</p>
  </section>`;
  return { canonicalPath, title, description, jsonLd, bodyHtml };
}

// ---- Build ------------------------------------------------------------------

const hashOf = (s) => createHash("sha1").update(s).digest("hex").slice(0, 10);

/** Rebuild every hub page. Returns the canonical paths of pages whose content changed. */
export async function buildArchiveHub({ check = false, log = console.log } = {}) {
  const [template, css, js, games] = await Promise.all([
    readFile(path.join(ROOT, SHELL_PATH), "utf8"),
    readFile(path.join(ROOT, "css/archive.css"), "utf8"),
    readFile(path.join(ROOT, "js/archive.js"), "utf8"),
    loadGames(),
  ]);
  if (!games.length) throw new Error(`${GAMES_INDEX_PATH} is empty - refusing to write an empty archive.`);
  const render = makeShell(template, { css: hashOf(css), js: hashOf(js) });
  const ctx = summarize(games);

  const pages = [buildLandingPage(games, ctx)];
  for (const y of ctx.years) {
    pages.push(buildYearPage(y, games, ctx));
    for (const k of PHASE_ORDER) {
      if (games.some((g) => g.year === y && g.phaseKey === k)) pages.push(buildPhasePage(y, k, games, ctx));
    }
  }
  for (const a of Object.keys(ctx.teamYears).sort()) pages.push(buildTeamPage(a, games, ctx));

  const changed = [];
  for (const p of pages) {
    const file = path.join(ROOT, p.canonicalPath);
    const html = render(p);
    let prev = null;
    try { prev = await readFile(file, "utf8"); } catch { /* new page */ }
    if (prev === html) continue;
    changed.push(p.canonicalPath);
    if (!check) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, html, "utf8");
    }
  }
  if (!check && changed.length) await touchSitemap(changed);
  log(`build-archive-hub: ${pages.length} pages, ${changed.length} ${check ? "would change" : "written"}.`);
  return { pages: pages.map((p) => p.canonicalPath), changed };
}

/** Add any missing hub URL to sitemap-archive.xml and stamp today's lastmod on the ones that changed. */
async function touchSitemap(paths) {
  const file = path.join(ROOT, "sitemap-archive.xml");
  let xml;
  try { xml = await readFile(file, "utf8"); } catch { return; }
  const today = new Date().toISOString().slice(0, 10);
  const add = [];
  for (const p of paths) {
    const loc = `<loc>${SITE_BASE}${p}</loc>`;
    const at = xml.indexOf(loc);
    if (at < 0) { add.push(`  <url>${loc}<lastmod>${today}</lastmod></url>`); continue; }
    const end = xml.indexOf("</url>", at);
    xml = xml.slice(0, at) + `${loc}<lastmod>${today}</lastmod>` + xml.slice(end);
  }
  if (add.length) xml = xml.replace("</urlset>", `${add.join("\n")}\n</urlset>`);
  await writeFile(file, xml, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  buildArchiveHub({ check })
    .then(({ changed }) => { if (check && changed.length) process.exit(1); })
    .catch((err) => { console.error("build-archive-hub FAILED:", err); process.exit(1); });
}

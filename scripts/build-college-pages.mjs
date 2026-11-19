#!/usr/bin/env node
/**
 * build-college-pages.mjs - standalone, indexable college football pages.
 *
 * WHY STANDALONE. The app's College view and bowl pick'em sit behind the
 * `cfb` and `bowls` feature flags, and App sends any visitor those flags don't
 * cover from /college/ and /bowls back to the NFL pages. Google renders
 * JavaScript, so a college URL served through the app shell would render as
 * the NFL slate. These pages are self-contained HTML (like /historical/):
 * no app bundle, no React, no flag check - they read the same for everyone,
 * with or without JS. Decided 2026-11-18 (Dan: "Standalone pages").
 *
 * WHAT IT WRITES
 *   /college/teams/                          every FBS team, by conference
 *   /college/teams/{slug}/                   one page per FBS team (~138)
 *   /college/games/                          weeks index + this week's Top 25
 *   /college/games/{season}/week-{n}/        week hub: every FBS game, odds
 *   /college/games/{season}/week-{n}/{away}-vs-{home}/   one per game
 *   /college/bowls/                          bowl + CFP schedule hub
 *   /college/bowls/{season}/{bowl-slug}/     one page per bowl / CFP game
 *   sitemap-college.xml                      every page above
 *   data/cfb-lines-{season}.json             last pre-kickoff line per game
 *                                            (ESPN drops the line at kickoff)
 *   data/cfb-pages-{season}.json             event id -> page path index
 *
 * Only the previous, current and next regular-season weeks are refetched on
 * each run; older week pages stay as committed (final scores already in).
 *
 * DATA. ESPN's public college endpoints (groups=80 = FBS), the same ones the
 * app and netlify/functions/lib/cfb.mts + lib/bowls.mts use. The parsing
 * below (stats ranks, team/odds normalisation, market win %) is a plain-JS
 * mirror of those two libs - keep them in step. Win % is the MARKET's
 * (vig-removed moneyline, else spread with SD 15.5), labelled "Market",
 * never "Edge": there is no college Blitz Edge model yet.
 *
 * Usage: node scripts/build-college-pages.mjs [--offline]
 *   --offline  rebuild from data/cfb-cache-{season}.json without fetching
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const SITE_BASE = "https://blitz-odds.com";
const SEASON = 2026;
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const ESPN_HEADERS = { "User-Agent": "curl/8.4.0", Accept: "application/json" };
const OFFLINE = process.argv.includes("--offline");

/* Bowl links (the "Bowls" nav item, the footer and "More" links, and the
 * "Start a bowl pool" CTAs into the app) follow the same `bowls` feature flag
 * that shows and hides Bowls in the app (admin console > Features), read the
 * way a signed-out visitor gets it. Off - or unreadable, or past bowl season -
 * means none of them is rendered. The bowl pages themselves are still built. */
const BOWLS_VISIBLE_UNTIL = Date.parse("2027-02-01T12:00:00Z"); // = src/app.jsx
let FEATURES = { cfb: false, bowls: false };
async function fetchPublicFeatures() {
  const off = { cfb: false, bowls: false };
  if (OFFLINE) return off;
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

const CONFERENCES = {
  "8": "SEC", "5": "Big Ten", "4": "Big 12", "1": "ACC",
  "151": "American", "12": "Conference USA", "15": "MAC", "17": "Mountain West",
  "37": "Sun Belt", "9": "Pac-12", "18": "FBS Independents",
};
const CONF_ORDER = ["8", "5", "4", "1", "151", "12", "15", "17", "37", "9", "18"];
/* ESPN files a team in a conference that has divisions under the division's
 * group id, not the conference's - the Sun Belt's East (167) and West (168)
 * showed up as two separate "Other FBS" sections on /college/teams/, and
 * those teams had no conference on their own pages. Resolve a group to its
 * conference: a known conference id, else its parent's, else this table. */
const DIVISION_TO_CONF = { "167": "37", "168": "37" };
function confIdOf(groups, fallback = null) {
  const id = groups?.id != null ? String(groups.id) : null;
  if (id && CONFERENCES[id]) return id;
  const parent = groups?.parent?.id != null ? String(groups.parent.id) : null;
  if (parent && CONFERENCES[parent]) return parent;
  if (id && DIVISION_TO_CONF[id]) return DIVISION_TO_CONF[id];
  if (fallback && DIVISION_TO_CONF[fallback]) return DIVISION_TO_CONF[fallback];
  return id || fallback;
}

function log(...a) { console.log("[college-pages]", ...a); }

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function slugify(str) {
  return String(str).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function pct(p) { return `${Math.round(p * 100)}%`; }
function fmtSpread(n) { return n === 0 ? "PK" : (n > 0 ? `+${n}` : String(n)); }
function fmtMl(n) { return n == null ? "—" : (n > 0 ? `+${n}` : String(n)); }

const ET_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
const ET_LONG = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const ET_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
function kickoffText(iso, tbd, long = false) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "TBD";
  const day = (long ? ET_LONG : ET_DATE).format(d);
  return tbd ? `${day}, time TBD` : `${day}, ${ET_TIME.format(d)} ET`;
}
function isoDate(iso) { return String(iso || "").slice(0, 10); }

async function fetchJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: ESPN_HEADERS });
      if (res.ok) return await res.json();
      last = new Error(`${res.status} ${url}`);
      if (res.status === 404) break;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw last;
}

/** Runs fn over items, `limit` at a time. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function readJsonFile(rel, fallback) {
  try { return JSON.parse(await readFile(path.join(REPO_ROOT, rel), "utf8")); } catch { return fallback; }
}
async function writeJsonFile(rel, obj) {
  const p = path.join(REPO_ROOT, rel);
  const body = JSON.stringify(obj, null, 1) + "\n";
  let old = null;
  try { old = await readFile(p, "utf8"); } catch {}
  if (old === body) return false;
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, body, "utf8");
  return true;
}

/** Writes a page and reports whether its CONTENT changed. The build stamp in
 *  the footer ("Updated ...") is ignored for that answer so an unchanged
 *  page keeps its sitemap lastmod - and the file isn't rewritten at all. */
const STAMP_RE = /<!--stamp-->[\s\S]*?<!--\/stamp-->/g;
async function writePage(relPath, html) {
  const p = path.join(REPO_ROOT, relPath);
  let old = null;
  try { old = await readFile(p, "utf8"); } catch {}
  if (old !== null && old.replace(STAMP_RE, "") === html.replace(STAMP_RE, "")) return false;
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, html, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// ESPN parsing - mirrors netlify/functions/lib/cfb.mts and lib/bowls.mts
// ---------------------------------------------------------------------------

function valueOf(defs, cats, catName, split, stat) {
  const names = defs.get(catName);
  if (!names) return null;
  const block = cats.find((c) => c.name === catName && (split === "own" ? String(c.splitId) === "0" : String(c.splitId) === "900"));
  if (!block || !Array.isArray(block.values)) return null;
  const i = names.indexOf(stat);
  return i < 0 ? null : num(block.values[i]);
}
function rankBy(ids, value, higherIsBetter) {
  const rows = ids.map((id) => ({ id, v: value(id) }));
  rows.sort((a, b) => {
    if (a.v === null && b.v === null) return 0;
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    return higherIsBetter ? b.v - a.v : a.v - b.v;
  });
  const out = new Map();
  let lastV, lastRank = 0;
  rows.forEach((r, i) => {
    const rank = r.v !== null && r.v === lastV ? lastRank : i + 1;
    out.set(r.id, rank); lastV = r.v; lastRank = rank;
  });
  return out;
}
function buildStats(json) {
  const defs = new Map();
  for (const c of json?.categories || []) defs.set(c.name, c.names || []);
  const raw = new Map();
  for (const row of json?.teams || []) {
    const id = row?.team?.id ? String(row.team.id) : null;
    if (!id) continue;
    const cats = row.categories || [];
    raw.set(id, {
      gp: valueOf(defs, cats, "general", "own", "gamesPlayed") || 0,
      oRush: valueOf(defs, cats, "rushing", "own", "rushingYardsPerGame"),
      oPass: valueOf(defs, cats, "passing", "own", "passingYardsPerGame"),
      oTotal: valueOf(defs, cats, "passing", "own", "yardsPerGame"),
      oPts: valueOf(defs, cats, "passing", "own", "totalPointsPerGame"),
      dRush: valueOf(defs, cats, "rushing", "opp", "rushingYardsPerGame"),
      dPass: valueOf(defs, cats, "passing", "opp", "passingYardsPerGame"),
      dTotal: valueOf(defs, cats, "passing", "opp", "yardsPerGame"),
      dPts: valueOf(defs, cats, "passing", "opp", "totalPointsPerGame"),
    });
  }
  const ids = [...raw.keys()];
  const get = (k) => (id) => raw.get(id)[k];
  const keys = { oRush: true, oPass: true, oTotal: true, oPts: true, dRush: false, dPass: false, dTotal: false, dPts: false };
  const ranks = Object.fromEntries(Object.entries(keys).map(([k, hi]) => [k, rankBy(ids, get(k), hi)]));
  const out = {};
  for (const id of ids) {
    const v = raw.get(id);
    out[id] = { gp: v.gp, values: v, ranks: Object.fromEntries(Object.keys(keys).map((k) => [k, ranks[k].get(id)])) };
  }
  return { count: ids.length, teams: out };
}

function mlToProb(ml) {
  if (ml === null || ml === 0) return null;
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}
function erf(x) {
  const sign = x < 0 ? -1 : 1, ax = Math.abs(x), t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
const CFB_MARGIN_SD = 15.5;
function homeWinProbFrom(o, homeId) {
  const ph = mlToProb(o.homeML), pa = mlToProb(o.awayML);
  if (ph !== null && pa !== null && ph + pa > 0) return Math.min(0.99, Math.max(0.01, ph / (ph + pa)));
  if (!homeId) return null;
  if (!o.favoriteId || o.spread === 0) return 0.5;
  const favP = Math.min(0.99, normCdf(o.spread / CFB_MARGIN_SD));
  return o.favoriteId === homeId ? favP : 1 - favP;
}

function teamOf(c) {
  const t = c?.team;
  if (!t || !t.id || t.id === "-1" || t.abbreviation === "TBD") return null;
  const rank = num(c?.curatedRank?.current);
  const rec = Array.isArray(c?.records) ? (c.records.find((r) => r.type === "total") || c.records[0]) : null;
  return {
    id: String(t.id),
    abbr: String(t.abbreviation || "").slice(0, 6),
    name: t.displayName || t.name || t.abbreviation,
    short: t.shortDisplayName || t.location || t.abbreviation,
    color: t.color ? `#${t.color}` : null,
    altColor: t.alternateColor ? `#${t.alternateColor}` : null,
    conf: t.conferenceId ? String(t.conferenceId) : null,
    record: rec?.summary || null,
    rank: rank !== null && rank >= 1 && rank <= 25 ? rank : null,
  };
}
function oddsOf(comp, home, away) {
  const o = Array.isArray(comp?.odds) ? comp.odds[0] : null;
  if (!o || (o.spread === undefined && !o.details)) return null;
  const spreadRaw = num(o.spread);
  if (spreadRaw === null) return null;
  let favoriteId = null;
  if (o.homeTeamOdds?.favorite && home) favoriteId = home.id;
  else if (o.awayTeamOdds?.favorite && away) favoriteId = away.id;
  else if (spreadRaw !== 0 && home && away) favoriteId = spreadRaw < 0 ? home.id : away.id;
  const base = {
    favoriteId,
    spread: Math.abs(spreadRaw),
    homeML: num(o.moneyline?.home?.close?.odds ?? o.homeTeamOdds?.moneyLine),
    awayML: num(o.moneyline?.away?.close?.odds ?? o.awayTeamOdds?.moneyLine),
  };
  return {
    ...base,
    details: o.details || null,
    total: num(o.overUnder),
    provider: o.provider?.displayName || o.provider?.name || null,
    homeWinProb: homeWinProbFrom(base, home ? home.id : null),
  };
}

/** One ESPN scoreboard event -> the game shape every page here draws. */
function normalizeEvent(e, extra = {}) {
  const comp = e?.competitions?.[0];
  if (!comp) return null;
  const hc = (comp.competitors || []).find((c) => c.homeAway === "home");
  const ac = (comp.competitors || []).find((c) => c.homeAway === "away");
  const home = teamOf(hc), away = teamOf(ac);
  const st = comp.status?.type || e.status?.type || {};
  const state = st.state === "in" ? "in" : st.state === "post" ? "post" : "pre";
  const started = state !== "pre";
  const winner = (comp.competitors || []).find((c) => c.winner === true);
  const venue = comp.venue || null;
  const headline = (comp.notes || []).map((n) => n?.headline).find(Boolean) || null;
  const bc = Array.isArray(comp.broadcasts) ? comp.broadcasts.flatMap((b) => b.names || []).join(", ") : null;
  return {
    id: String(e.id),
    date: comp.date || e.date,
    timeTbd: comp.timeValid === false,
    week: e.week?.number ?? extra.week ?? null,
    headline,
    venue: venue?.fullName || null,
    city: venue?.address ? [venue.address.city, venue.address.state].filter(Boolean).join(", ") || null : null,
    neutral: !!comp.neutralSite,
    conferenceGame: !!comp.conferenceCompetition,
    broadcast: bc || comp.broadcast || null,
    state,
    completed: !!st.completed,
    detail: st.shortDetail || st.detail || null,
    away, home,
    awayScore: started ? num(ac?.score?.value ?? ac?.score) : null,
    homeScore: started ? num(hc?.score?.value ?? hc?.score) : null,
    winnerId: st.completed && winner?.team?.id ? String(winner.team.id) : null,
    odds: oddsOf(comp, home, away),
  };
}

// ---------------------------------------------------------------------------
// Load everything
// ---------------------------------------------------------------------------

const CACHE_REL = `data/cfb-cache-${SEASON}.json`;

async function loadRaw() {
  if (OFFLINE) {
    const c = await readJsonFile(CACHE_REL, null);
    if (!c) throw new Error(`--offline needs ${CACHE_REL}`);
    return c;
  }
  log("fetching ESPN...");
  const stats = await fetchJson(`https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/statistics/byteam?region=us&lang=en&contentorigin=espn&limit=200&group=80&season=${SEASON}&seasontype=2`);
  const teamList = await fetchJson(`${ESPN}/teams?limit=1000`);
  const current = await fetchJson(`${ESPN}/scoreboard?groups=80&limit=300`);
  const bowls = await fetchJson(`${ESPN}/scoreboard?seasontype=3&week=1&groups=80&limit=300&dates=${SEASON}`);

  const seasonType = current?.season?.type ?? 2;
  const curWeek = current?.week?.number ?? null;
  const regCal = (current?.leagues?.[0]?.calendar || []).find((c) => String(c.value) === "2" || /regular/i.test(c.label || ""));
  const regWeeks = (regCal?.entries || []).map((x) => Number(x.value)).filter(Number.isFinite);
  const lastReg = regWeeks.length ? Math.max(...regWeeks) : 15;
  let weeks;
  if (seasonType === 2 && curWeek) weeks = [curWeek - 1, curWeek, curWeek + 1].filter((w) => w >= 1 && w <= lastReg);
  else weeks = seasonType === 3 ? [lastReg] : [];
  const scoreboards = {};
  for (const w of weeks) {
    try { scoreboards[w] = await fetchJson(`${ESPN}/scoreboard?groups=80&limit=300&week=${w}&seasontype=2&dates=${SEASON}`); }
    catch (e) { log(`week ${w} scoreboard failed: ${e.message}`); }
  }

  const fbsIds = (stats?.teams || []).map((r) => String(r?.team?.id)).filter(Boolean);
  const schedules = {};
  await pool(fbsIds, 8, async (id) => {
    try { schedules[id] = await fetchJson(`${ESPN}/teams/${id}/schedule?season=${SEASON}`); }
    catch (e) { log(`schedule ${id} failed: ${e.message}`); }
  });
  const raw = { fetchedAt: new Date().toISOString(), stats, teamList, current, bowls, seasonType, curWeek, lastReg, scoreboards, schedules };
  // Kept out of git (see .gitignore) - only for --offline rebuilds.
  await writeFile(path.join(REPO_ROOT, CACHE_REL), JSON.stringify(raw));
  return raw;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

let TEAM_SLUGS = new Map(); // espn id -> slug (FBS only)
function teamPath(id) { const s = TEAM_SLUGS.get(String(id)); return s ? `/college/teams/${s}/` : null; }
function weekPath(w) { return `/college/games/${SEASON}/week-${w}/`; }
function gameSlug(g) { return `${slugify(g.away.name)}-vs-${slugify(g.home.name)}`; }
function gamePath(g) { return `${weekPath(g.week)}${gameSlug(g)}/`; }
/** "College Football Playoff Quarterfinal at the Rose Bowl Presented by
 *  Prudential" -> "Rose Bowl (CFP Quarterfinal)"; "... First Round Game" ->
 *  "CFP First Round". Used for both slugs and titles, so keep it stable. */
function bowlShortName(headline) {
  const h = String(headline).replace(/ Presented by .*$/i, "").trim();
  const at = h.match(/^College Football Playoff (.+?) at the (.+)$/);
  if (at) return `${at[2]} (CFP ${at[1]})`;
  return h.replace(/^College Football Playoff /, "CFP ").replace(/ Game$/, "").trim();
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

const CSS = `
:root{--bg:#0b1220;--card:#131c2e;--border:#223049;--s2:#1a2438;--text:#eef2f8;--dim:#9fb0c9;--accent:#4fd1c5;--win:#2ecc71;--lose:#ef6b6b;--warn:#f5a524}
html[data-theme="light"]{--bg:#dbe2ec;--card:#fff;--border:#c3cedd;--s2:#e7ecf3;--text:#16202f;--dim:#5b6b80;--accent:#0f8f83;--win:#1f9d54;--lose:#c0392b;--warn:#b5720a}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.45}
a{color:var(--accent)}.wrap{max-width:960px;margin:0 auto;padding:14px 16px 56px}
.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:6px 0 14px;border-bottom:1px solid var(--border);margin-bottom:14px}
.brand{display:flex;align-items:center;gap:8px;font-weight:800;font-size:19px;color:var(--text);text-decoration:none}.brand img{width:28px;height:28px}
.brand b{color:var(--accent)}.nav{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
.nav a{padding:6px 10px;border-radius:8px;text-decoration:none;color:var(--dim);font-weight:600;font-size:14px}.nav a:hover,.nav a.on{background:var(--s2);color:var(--text)}
.crumbs{font-size:13px;color:var(--dim);margin:0 0 8px}.crumbs a{color:var(--dim)}
h1{font-size:26px;line-height:1.2;margin:4px 0 6px}h2{font-size:19px;margin:26px 0 10px}h3{font-size:16px;margin:16px 0 6px}
.lede{color:var(--dim);margin:0 0 14px}.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:7px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}
th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}.rk{color:var(--dim);font-size:12px;font-weight:700;margin-right:3px}
.crest{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;font-size:8px;font-weight:800;color:#fff;vertical-align:middle;margin-right:6px;flex:none;overflow:hidden}
.crest img{width:100%;height:100%;object-fit:contain}.crest.lg{width:64px;height:64px;font-size:16px;margin:0}
.team-cell{display:flex;align-items:center;min-width:0}
.matchup{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;text-align:center}
.matchup .side{display:flex;flex-direction:column;align-items:center;gap:6px}.matchup .name{font-weight:800;font-size:18px}
.matchup .meta{color:var(--dim);font-size:13px}.matchup .vs{color:var(--dim);font-weight:700}.matchup .score{font-size:30px;font-weight:800}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--s2);margin:6px 0 4px}.bar span{display:block;height:100%}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kv div{background:var(--s2);border-radius:10px;padding:9px 11px}
.kv b{display:block;font-size:12px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.03em}.kv span{font-size:17px;font-weight:700}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;background:var(--s2);color:var(--dim)}
.pill.w{color:var(--win)}.pill.l{color:var(--lose)}.pill.mk{color:var(--accent)}
.good{color:var(--win);font-weight:700}.bad{color:var(--lose);font-weight:700}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:6px 18px}.grid2 a{text-decoration:none;color:var(--text)}
.grid2 a:hover{color:var(--accent)}.cta{display:inline-block;margin-top:6px;padding:9px 14px;border-radius:10px;background:var(--accent);color:#06201d;font-weight:800;text-decoration:none}
.note{font-size:12px;color:var(--dim)}.faq dt{font-weight:700;margin-top:10px}.faq dd{margin:3px 0 0;color:var(--dim)}
footer{margin-top:34px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--dim)}footer a{color:var(--dim)}
@media (max-width:600px){h1{font-size:22px}.matchup .name{font-size:15px}.hide-sm{display:none}
.top{gap:8px}.nav{margin-left:0;width:100%;gap:2px}.nav a{padding:6px 9px}
/* Games table: each game becomes a two-line block (away | home, then kickoff
   and spread | market and link) so nothing has to scroll sideways. */
.gm thead{display:none}.gm,.gm tbody{display:block}
.gm tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px 12px;padding:11px 0;border-bottom:1px solid var(--border)}
.gm tr:last-child{border-bottom:none}.gm td{border:none;padding:0;min-width:0}
.gm .team-cell{font-weight:700}.gm .g-away{grid-area:1/1}.gm .g-home{grid-area:1/2}
.gm .g-when{grid-area:2/1;font-size:12px;color:var(--dim)}.gm .g-spread{grid-area:3/1;font-size:13px;color:var(--dim)}
.gm .g-mkt{grid-area:2/2;text-align:left;font-weight:700;color:var(--accent)}.gm .g-link{grid-area:3/2;font-size:13px}
/* Team schedule: opponent and result on the first line, date, line and link under them. */
.sch thead{display:none}.sch,.sch tbody{display:block}
.sch tr{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:3px 12px;padding:10px 0;border-bottom:1px solid var(--border)}
.sch tr:last-child{border-bottom:none}.sch td{border:none;padding:0;min-width:0}
.sch .s-opp{grid-area:1/1;font-weight:700}.sch .s-res{grid-area:1/2;text-align:right}
.sch .s-date{grid-area:2/1;font-size:12px;color:var(--dim)}.sch .s-line{grid-area:2/2;text-align:right;font-size:12px;color:var(--dim)}
.sch .s-link{grid-area:3/1;font-size:13px}.sch .s-link:empty{display:none}}
`;

let BADGE_IDS = new Set();
function crest(t, cls = "") {
  if (!t) return `<span class="crest ${cls}" style="background:var(--s2);color:var(--dim)">TBD</span>`;
  if (BADGE_IDS.has(String(t.id))) return `<span class="crest ${cls}"><img src="/team-badges/cfb/${esc(t.id)}.png" alt="" width="64" height="64" loading="lazy"></span>`;
  const a = t.color || "#334155", b = t.altColor && t.altColor.toLowerCase() !== a.toLowerCase() ? t.altColor : "#0b1220";
  return `<span class="crest ${cls}" style="background:linear-gradient(135deg,${esc(a)} 50%,${esc(b)} 50%)">${esc(t.abbr)}</span>`;
}
function teamLink(t, label) {
  if (!t) return "TBD";
  const p = teamPath(t.id);
  const text = esc(label || t.short || t.name);
  return p ? `<a href="${p}">${text}</a>` : text;
}
function teamCell(t, { rank = true, prefix = "" } = {}) {
  const pre = prefix ? `<span class="note" style="margin-right:6px">${prefix}</span>` : "";
  if (!t) return `<span class="team-cell">${pre}${crest(null)}TBD</span>`;
  return `<span class="team-cell">${pre}${crest(t)}${rank && t.rank ? `<span class="rk">${t.rank}</span>` : ""}${teamLink(t)}</span>`;
}

const GA = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-1KHS0JK39B"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-1KHS0JK39B');</script>`;
const THEME = `<script>(function(){try{var s=localStorage.getItem("blitz-odds-theme");var m=s==="light"||s==="dark"||s==="system"?s:"dark";var r=m==="system"?(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;if(r==="light")document.documentElement.setAttribute("data-theme","light");}catch(e){}})();</script>`;

function breadcrumbLd(trail) {
  return {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: trail.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: `${SITE_BASE}${c.path}` })),
  };
}

function page({ title, description, canonicalPath, h1, lede, body, trail, jsonLd = [], navOn = "", ogType = "website" }) {
  const url = `${SITE_BASE}${canonicalPath}`;
  const crumbs = trail.map((c, i) => (i === trail.length - 1 ? esc(c.name) : `<a href="${c.path}">${esc(c.name)}</a>`)).join(" › ");
  const lds = [breadcrumbLd(trail), ...jsonLd].filter(Boolean).map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`).join("\n");
  const nav = [
    // With the cfb flag on, "College" is the app's Games tab on its College
    // side (the same place the Home tile and the app's own links go); the
    // standalone landing page stays reachable from the breadcrumbs and footer.
    // The college teams pages are college-only: no NFL link in the nav or footer.
    ["/", "Home", ""], ...(navOn === "teams" ? [] : [["/games/", "NFL Games", ""]]), [FEATURES.cfb ? "/college/" : "/college/games/", "College Games", "games"],
    ["/college/teams/", "Teams", "teams"], ...(FEATURES.bowls ? [["/college/bowls/", "Bowls", "bowls"]] : []),
  ].map(([href, label, key]) => `<a href="${href}"${key && key === navOn ? ' class="on"' : ""}>${label}</a>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
${GA}
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(url)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:type" content="${ogType}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:site_name" content="Blitz Odds" />
<meta property="og:image" content="${SITE_BASE}/branding/blitz-odds-og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@RealBlitzOdds" />
<link rel="icon" type="image/svg+xml" href="/branding/blitz-odds-icon.svg" />
<link rel="apple-touch-icon" href="/branding/apple-touch-icon.png" />
${THEME}
<style>${CSS.trim()}</style>
${lds}
</head>
<body>
<div class="wrap">
<header class="top"><a class="brand" href="/"><img src="/branding/blitz-odds-icon.svg" alt="" width="28" height="28">Blitz <b>Odds</b></a><nav class="nav" aria-label="Site">${nav}</nav></header>
<main>
<p class="crumbs">${crumbs}</p>
<h1>${esc(h1)}</h1>
${lede ? `<p class="lede">${lede}</p>` : ""}
${body}
</main>
<footer>
<p>Lines from ESPN's college feed (DraftKings unless noted). "Market" win chances are the betting market's implied odds with the vig removed - Blitz Odds has no college model of its own yet. For entertainment only; not betting advice. 21+ where legal, 1-800-GAMBLER. Blitz Odds is not affiliated with the NCAA or any school or conference.</p>
<p><a href="/college/games/">College football odds</a> · <a href="/college/teams/">FBS teams</a> · ${FEATURES.bowls ? `<a href="/college/bowls/">Bowl schedule</a> · ` : ""}${navOn === "teams" ? "" : `<a href="/games/">NFL picks</a> · `}<a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <!--stamp-->Updated ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC<!--/stamp--></p>
</footer>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Game content
// ---------------------------------------------------------------------------

/** Fills in the line from the carried-forward cache once ESPN drops it. */
function withLine(g, lines) {
  if (!g || !g.away || !g.home) return g;
  const key = g.id;
  const cached = lines[key];
  const sameTeams = cached && cached.homeId === g.home.id && cached.awayId === g.away.id;
  if (g.odds && g.state === "pre") {
    lines[key] = { homeId: g.home.id, awayId: g.away.id, odds: g.odds, at: new Date().toISOString() };
    return g;
  }
  if (sameTeams && (g.state !== "pre" || !g.odds)) return { ...g, odds: cached.odds, lineFromCache: true };
  return g;
}

function marketSides(g) {
  const o = g.odds;
  if (!o || o.homeWinProb == null || !g.home || !g.away) return null;
  const ph = o.homeWinProb;
  const fav = ph >= 0.5 ? g.home : g.away, dog = fav === g.home ? g.away : g.home;
  return { ph, pa: 1 - ph, fav, dog, favP: Math.max(ph, 1 - ph) };
}
function favSpreadText(g) {
  const o = g.odds;
  if (!o) return null;
  if (!o.favoriteId || o.spread === 0) return "Pick'em";
  const fav = o.favoriteId === g.home?.id ? g.home : g.away;
  return `${fav.short} -${o.spread}`;
}
function statLine(stats, t) {
  return t ? stats.teams[t.id] || null : null;
}

/** The plain-language read, built only from facts on the page. */
function marketRead(g, stats) {
  const parts = [];
  const o = g.odds, m = marketSides(g);
  if (g.state === "post" && g.winnerId && g.homeScore != null) {
    const w = g.winnerId === g.home.id ? g.home : g.away, l = w === g.home ? g.away : g.home;
    const ws = w === g.home ? g.homeScore : g.awayScore, ls = w === g.home ? g.awayScore : g.homeScore;
    parts.push(`${esc(w.short)} beat ${esc(l.short)} ${ws}-${ls}.`);
    if (o && o.favoriteId && o.spread > 0) {
      const fav = o.favoriteId === g.home.id ? g.home : g.away;
      const favMargin = (fav === g.home ? g.homeScore - g.awayScore : g.awayScore - g.homeScore);
      const cover = favMargin > o.spread ? `${esc(fav.short)} covered` : favMargin < o.spread ? `${esc(fav === g.home ? g.away.short : g.home.short)} covered` : "the spread pushed";
      parts.push(`${esc(fav.short)} closed as a ${o.spread}-point favorite, so ${cover}${fav.id === w.id ? "" : " and the underdog won outright"}.`);
      if (o.total != null) parts.push(`The ${g.homeScore + g.awayScore} combined points went ${g.homeScore + g.awayScore > o.total ? "over" : g.homeScore + g.awayScore < o.total ? "under" : "exactly to"} the ${o.total} total.`);
    }
  } else if (m) {
    const close = m.favP < 0.6 ? "close to a coin flip" : m.favP < 0.75 ? "a clear but beatable favorite" : m.favP < 0.9 ? "a strong favorite" : "a heavy favorite";
    const spread = o.favoriteId && o.spread > 0 ? `a ${o.spread}-point favorite` : "even on the spread";
    parts.push(`The market has ${esc(m.fav.short)} as ${spread}${o.provider ? ` at ${esc(o.provider)}` : ""}, which works out to about a ${pct(m.favP)} chance to win - ${close}.`);
    if (o.total != null) parts.push(`The over/under is ${o.total}.`);
  } else if (g.away && g.home) {
    parts.push(`No line is posted for this game yet. Check back closer to kickoff.`);
  }
  // Matchup edges from the season stat ranks.
  const sa = statLine(stats, g.away), sh = statLine(stats, g.home);
  if (sa && sh && g.state !== "post") {
    const n = stats.count;
    const edge = (off, def, offT, defT) => {
      const ro = off.ranks.oTotal, rd = def.ranks.dTotal;
      if (ro == null || rd == null) return null;
      return `${esc(offT.short)}'s offense ranks ${ordinal(ro)} of ${n} in yards per game against a ${esc(defT.short)} defense that ranks ${ordinal(rd)}`;
    };
    const e1 = edge(sa, sh, g.away, g.home), e2 = edge(sh, sa, g.home, g.away);
    if (e1 && e2) parts.push(`On paper: ${e1}; ${e2}.`);
  }
  return parts.join(" ");
}

function rankRow(label, a, h, key, valKey, lowerBetter = false, n = 138) {
  if (!a || !h) return "";
  const ra = a.ranks[key], rh = h.ranks[key];
  const va = a.values[valKey], vh = h.values[valKey];
  const cls = (x, y) => (x == null || y == null || x === y ? "" : x < y ? "good" : "bad");
  const f = (v) => (v == null ? "—" : v.toFixed(1));
  return `<tr><td>${label}</td><td class="n ${cls(ra, rh)}">${ra ? ordinal(ra) : "—"}</td><td class="n hide-sm">${f(va)}</td><td class="n ${cls(rh, ra)}">${rh ? ordinal(rh) : "—"}</td><td class="n hide-sm">${f(vh)}</td></tr>`;
}
function statsTable(g, stats) {
  const a = statLine(stats, g.away), h = statLine(stats, g.home);
  if (!a || !h) return "";
  return `<h2>Team rankings</h2>
<div class="card scroll"><table>
<thead><tr><th>Per game (rank of ${stats.count} FBS)</th><th class="n">${esc(g.away.abbr)} rank</th><th class="n hide-sm">Avg</th><th class="n">${esc(g.home.abbr)} rank</th><th class="n hide-sm">Avg</th></tr></thead>
<tbody>
${rankRow("Points scored", a, h, "oPts", "oPts")}
${rankRow("Total offense (yds)", a, h, "oTotal", "oTotal")}
${rankRow("Rushing offense", a, h, "oRush", "oRush")}
${rankRow("Passing offense", a, h, "oPass", "oPass")}
${rankRow("Points allowed", a, h, "dPts", "dPts")}
${rankRow("Total defense (yds)", a, h, "dTotal", "dTotal")}
${rankRow("Rushing defense", a, h, "dRush", "dRush")}
${rankRow("Passing defense", a, h, "dPass", "dPass")}
</tbody></table>
<p class="note">Green = the better rank in this matchup. Season to date, regular season.</p></div>`;
}

function recentForm(team, schedules, beforeIso, pathsById) {
  const s = schedules[team.id];
  if (!s) return "";
  const rows = [];
  for (const e of s.events || []) {
    const g = normalizeEvent(e);
    if (!g || g.state !== "post" || !(g.date < beforeIso)) continue;
    const isHome = g.home?.id === team.id;
    const opp = isHome ? g.away : g.home;
    const us = isHome ? g.homeScore : g.awayScore, them = isHome ? g.awayScore : g.homeScore;
    if (us == null || them == null || !opp) continue;
    const wl = us > them ? "W" : us < them ? "L" : "T";
    const link = pathsById[g.id];
    rows.push(`<li><span class="pill ${wl === "W" ? "w" : wl === "L" ? "l" : ""}">${wl}</span> ${link ? `<a href="${link}">${us}-${them}</a>` : `${us}-${them}`} ${isHome ? "vs" : "@"} ${teamLink(opp)}</li>`);
  }
  if (!rows.length) return "";
  return `<div><h3>${esc(team.short)} last ${Math.min(3, rows.length)}</h3><ul style="list-style:none;padding:0;margin:0;display:grid;gap:5px">${rows.slice(-3).reverse().join("")}</ul></div>`;
}

function matchupBlock(g) {
  const score = g.state !== "pre" && g.homeScore != null;
  const side = (t, sc, win) => `<div class="side">${crest(t, "lg")}<div class="name">${t?.rank ? `<span class="rk">${t.rank}</span>` : ""}${teamLink(t, t?.short)}</div><div class="meta">${t?.record ? esc(t.record) : ""}${t?.conf && CONFERENCES[t.conf] ? ` · ${CONFERENCES[t.conf]}` : ""}</div>${score ? `<div class="score${win ? " good" : ""}">${sc}</div>` : ""}</div>`;
  return `<div class="card"><div class="matchup">${side(g.away, g.awayScore, g.winnerId && g.winnerId === g.away?.id)}<div class="vs">${g.state === "post" ? "Final" : g.state === "in" ? esc(g.detail || "Live") : g.neutral ? "vs" : "at"}</div>${side(g.home, g.homeScore, g.winnerId && g.winnerId === g.home?.id)}</div></div>`;
}

function marketCard(g) {
  const o = g.odds, m = marketSides(g);
  if (!o) return `<div class="card"><b>Line</b><p class="note" style="margin:4px 0 0">${g.state === "pre" ? "No line posted yet." : "No pre-game line on file for this game."}</p></div>`;
  const a = g.away, h = g.home;
  const bar = m ? `<div class="bar" role="img" aria-label="Market win chance: ${esc(a.short)} ${pct(m.pa)}, ${esc(h.short)} ${pct(m.ph)}"><span style="width:${(m.pa * 100).toFixed(1)}%;background:${esc(a.color || "#64748b")}"></span><span style="width:${(m.ph * 100).toFixed(1)}%;background:${esc(h.color || "#94a3b8")}"></span></div>
<div style="display:flex;justify-content:space-between;font-weight:700"><span>${esc(a.short)} ${pct(m.pa)}</span><span class="pill mk">Market</span><span>${esc(h.short)} ${pct(m.ph)}</span></div>` : "";
  const awaySpread = !o.favoriteId || o.spread === 0 ? 0 : o.favoriteId === a.id ? -o.spread : o.spread;
  return `<div class="card">${bar}
<div class="kv" style="margin-top:12px">
<div><b>Spread</b><span>${esc(favSpreadText(g))}</span></div>
<div><b>Over/under</b><span>${o.total != null ? o.total : "—"}</span></div>
<div><b>${esc(a.abbr)} moneyline</b><span>${fmtMl(o.awayML)}</span></div>
<div><b>${esc(h.abbr)} moneyline</b><span>${fmtMl(o.homeML)}</span></div>
</div>
<p class="note" style="margin:8px 0 0">${esc(a.short)} ${fmtSpread(awaySpread)} / ${esc(h.short)} ${fmtSpread(-awaySpread)}${o.provider ? ` · ${esc(o.provider)}` : ""}${g.lineFromCache || g.state !== "pre" ? " · last line before kickoff" : ""}</p></div>`;
}

function faq(g) {
  const items = [];
  const a = g.away, h = g.home, o = g.odds, m = marketSides(g);
  const when = kickoffText(g.date, g.timeTbd, true);
  const where = [g.venue, g.city].filter(Boolean).join(", ");
  if (a && h) {
    if (o && o.favoriteId && o.spread > 0 && m) items.push([`Who is favored in ${a.short} vs ${h.short}?`, `${m.fav.short} is a ${o.spread}-point favorite, about a ${pct(m.favP)} chance to win by the market's numbers.`]);
    else if (o) items.push([`Who is favored in ${a.short} vs ${h.short}?`, `Neither - the game is a pick'em.`]);
    if (o?.total != null) items.push([`What is the over/under for ${a.short} vs ${h.short}?`, `${o.total} total points.`]);
    items.push([`When and where is ${a.short} vs ${h.short}?`, `${when}${where ? `, at ${where}` : ""}${g.broadcast ? `. TV: ${g.broadcast}` : ""}.`]);
  }
  if (!items.length) return "";
  return `<h2>Quick answers</h2><dl class="card faq">${items.map(([q, ans]) => `<dt>${esc(q)}</dt><dd>${esc(ans)}</dd>`).join("")}</dl>`;
}

function sportsEventLd(g, canonicalPath, name) {
  // Google's Event markup requires a location; a game whose site isn't set
  // yet (CFP first-round campus games) gets no SportsEvent until it is.
  if (!g.venue) return null;
  const team = (t) => (t ? { "@type": "SportsTeam", name: t.name, ...(teamPath(t.id) ? { url: `${SITE_BASE}${teamPath(t.id)}` } : {}) } : undefined);
  const o = {
    "@context": "https://schema.org", "@type": "SportsEvent",
    name, sport: "American Football", url: `${SITE_BASE}${canonicalPath}`,
    startDate: g.date,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
  };
  if (g.home) o.homeTeam = team(g.home);
  if (g.away) o.awayTeam = team(g.away);
  if (g.home && g.away) o.competitor = [team(g.away), team(g.home)];
  if (g.venue) o.location = { "@type": "Place", name: g.venue, ...(g.city ? { address: g.city } : {}) };
  o.organizer = { "@type": "SportsOrganization", name: "NCAA Division I FBS" };
  return o;
}

async function buildGamePage(g, ctx) {
  const p = gamePath(g);
  const a = g.away, h = g.home;
  const label = `Week ${g.week}`;
  const final = g.state === "post";
  const title = final
    ? `${a.short} vs ${h.short} Final Score & Spread Result - ${label} ${SEASON} | Blitz Odds`
    : `${a.short} vs ${h.short} Prediction, Odds & Spread - ${label} ${SEASON} | Blitz Odds`;
  const o = g.odds, m = marketSides(g);
  const description = final && g.homeScore != null
    ? `${a.name} ${g.awayScore}, ${h.name} ${g.homeScore}. Final score, the closing line and whether the favorite covered in ${label} of the ${SEASON} college football season.`
    : `${a.name} vs ${h.name} odds and prediction: ${o ? `${favSpreadText(g)}${o.total != null ? `, O/U ${o.total}` : ""}` : "line, spread"}${m ? `, ${m.fav.short} ${pct(m.favP)} to win` : ""}. Kickoff ${kickoffText(g.date, g.timeTbd)}, team rankings and recent form.`;
  const h1 = final ? `${a.name} vs ${h.name}: Final` : `${a.name} vs ${h.name} Prediction & Odds`;
  const where = [g.venue, g.city].filter(Boolean).join(", ");
  const lede = `${esc(label)} · ${esc(kickoffText(g.date, g.timeTbd, true))}${where ? ` · ${esc(where)}` : ""}${g.broadcast ? ` · ${esc(g.broadcast)}` : ""}`;
  const forms = [recentForm(a, ctx.schedules, g.date, ctx.pathsById), recentForm(h, ctx.schedules, g.date, ctx.pathsById)].filter(Boolean);
  const body = `${matchupBlock(g)}
<h2>${final ? "How it finished against the line" : "The market read"}</h2>
<div class="card"><p style="margin:0">${marketRead(g, ctx.stats)}</p></div>
${marketCard(g)}
${statsTable(g, ctx.stats)}
${forms.length ? `<h2>Recent form</h2><div class="card grid2">${forms.join("")}</div>` : ""}
${faq(g)}
<p><a href="${weekPath(g.week)}">All ${esc(label)} college football odds →</a></p>`;
  const html = page({
    title, description, canonicalPath: p, h1, lede, body, navOn: "games", ogType: "article",
    trail: [{ name: "College football", path: "/college/games/" }, { name: label, path: weekPath(g.week) }, { name: `${a.short} vs ${h.short}`, path: p }],
    jsonLd: [sportsEventLd(g, p, `${a.name} vs ${h.name}`)],
  });
  return { path: p, changed: await writePage(`${p.slice(1)}index.html`, html) };
}

// ---------------------------------------------------------------------------
// Week hubs
// ---------------------------------------------------------------------------

function bestRank(g) { return Math.min(g.away?.rank || 99, g.home?.rank || 99); }
function gameRow(g, linkPath) {
  const o = g.odds, m = marketSides(g);
  const res = g.state === "post" && g.homeScore != null
    ? `${g.awayScore}-${g.homeScore}`
    : g.state === "in" ? "Live" : esc(kickoffText(g.date, g.timeTbd));
  return `<tr><td class="g-away">${teamCell(g.away)}</td><td class="g-home">${teamCell(g.home)}</td><td class="g-when">${res}</td><td class="g-spread">${o ? esc(favSpreadText(g)) : "—"}</td><td class="n hide-sm">${o?.total ?? "—"}</td><td class="n g-mkt">${m && g.state === "pre" ? `${esc(m.fav.abbr)} ${pct(m.favP)}` : "—"}</td><td class="g-link"><a href="${linkPath}">${g.state === "post" ? "Recap" : "Preview"}</a></td></tr>`;
}
function gamesTable(games, paths) {
  return `<div class="card scroll"><table class="gm"><thead><tr><th>Away</th><th>Home</th><th>Kickoff / score</th><th>Spread</th><th class="n hide-sm">O/U</th><th class="n">Market</th><th></th></tr></thead><tbody>
${games.map((g) => gameRow(g, paths.get(g.id))).join("\n")}
</tbody></table></div>`;
}

async function buildWeekHub(week, games, ctx, prevNext) {
  const p = weekPath(week);
  const paths = new Map(games.map((g) => [g.id, gamePath(g)]));
  const ranked = games.filter((g) => bestRank(g) <= 25).sort((x, y) => bestRank(x) - bestRank(y));
  const rest = games.filter((g) => bestRank(g) > 25).sort((x, y) => (x.date < y.date ? -1 : 1));
  const done = games.every((g) => g.state === "post");
  const title = `College Football Week ${week} Odds, Spreads & Predictions ${SEASON} | Blitz Odds`;
  const big = ranked.slice(0, 3).map((g) => `${g.away.short} vs ${g.home.short}`).join(", ");
  const description = `Every FBS game in Week ${week} of the ${SEASON} college football season: spreads, totals, moneylines and market win chances${big ? `, including ${big}` : ""}.`;
  const nav = `<p>${prevNext.prev ? `<a href="${weekPath(prevNext.prev)}">← Week ${prevNext.prev}</a>` : ""}${prevNext.prev && prevNext.next ? " · " : ""}${prevNext.next ? `<a href="${weekPath(prevNext.next)}">Week ${prevNext.next} →</a>` : ""}</p>`;
  const body = `${nav}
${ranked.length ? `<h2>Top 25 games</h2>${gamesTable(ranked, paths)}` : ""}
<h2>${ranked.length ? "All other FBS games" : "Games"}</h2>${gamesTable(rest, paths)}
<p class="note">Market = the favorite's implied chance to win from the moneyline (vig removed), or from the spread when no moneyline is posted.</p>
${nav}`;
  const html = page({
    title, description, canonicalPath: p,
    h1: `College Football Week ${week} Odds & Predictions`,
    lede: `${games.length} FBS games${done ? ", all final" : ""}. Tap any matchup for the line, team rankings and recent form.`,
    body, navOn: "games",
    trail: [{ name: "College football", path: "/college/games/" }, { name: `Week ${week}`, path: p }],
    jsonLd: [{ "@context": "https://schema.org", "@type": "ItemList", name: `College football Week ${week} ${SEASON} games`,
      itemListElement: [...ranked, ...rest].slice(0, 100).map((g, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE_BASE}${paths.get(g.id)}`, name: `${g.away.name} vs ${g.home.name}` })) }],
  });
  return { path: p, changed: await writePage(`${p.slice(1)}index.html`, html) };
}

// ---------------------------------------------------------------------------
// Team pages
// ---------------------------------------------------------------------------

async function buildTeamPage(team, ctx) {
  const p = teamPath(team.id);
  const s = ctx.schedules[team.id];
  const st = ctx.stats.teams[team.id];
  const info = s?.team || {};
  const confId = confIdOf(info.groups, team.conf);
  const conf = CONFERENCES[confId] || null;
  const record = info.recordSummary || null;
  const standing = info.standingSummary || null;
  const rank = ctx.apRanks.get(team.id) || null;

  const events = (s?.events || []).map((e) => normalizeEvent(e)).filter(Boolean).map((g) => withLine(g, ctx.lines));
  const rows = events.map((g) => {
    const isHome = g.home?.id === team.id;
    const opp = isHome ? g.away : g.home;
    let result = "";
    if (g.state === "post" && g.homeScore != null) {
      const us = isHome ? g.homeScore : g.awayScore, them = isHome ? g.awayScore : g.homeScore;
      const wl = us > them ? "W" : us < them ? "L" : "T";
      result = `<span class="pill ${wl === "W" ? "w" : wl === "L" ? "l" : ""}">${wl}</span> ${us}-${them}`;
    } else if (g.state === "in") result = "Live";
    else {
      const m = marketSides(g);
      result = m ? `${m.fav.id === team.id ? `<span class="good">${pct(m.favP)}</span>` : `<span class="bad">${pct(1 - m.favP)}</span>`} <span class="note">market</span>` : "—";
    }
    const link = ctx.pathsById[g.id];
    const line = g.odds ? esc(favSpreadText(g)) : "—";
    return `<tr><td class="hide-sm">${g.week ? `Wk ${g.week}` : ""}</td><td class="s-date">${esc(kickoffText(g.date, g.timeTbd)).replace(/, \d.*$/, "")}</td><td class="s-opp">${teamCell(opp, { prefix: isHome ? "vs" : "@" })}</td><td class="s-line">${line}</td><td class="s-res">${result}</td><td class="s-link">${link ? `<a href="${link}">${g.state === "post" ? "Recap" : "Preview"}</a>` : ""}</td></tr>`;
  });
  const next = events.find((g) => g.state !== "post");
  const nextOpp = next ? (next.home?.id === team.id ? next.away : next.home) : null;
  const statRow = (label, k, vk, isDef) => {
    if (!st) return "";
    const r = st.ranks[k], v = st.values[vk];
    return `<tr><td>${label}</td><td class="n">${v == null ? "—" : v.toFixed(1)}</td><td class="n">${r ? ordinal(r) : "—"}</td></tr>`;
  };
  const title = `${team.name} Schedule, Odds & Predictions ${SEASON} | Blitz Odds`;
  const description = `${team.name} ${SEASON} schedule with results, betting lines and market win chances for every game${nextOpp ? `, plus the next game vs ${nextOpp.short}` : ""}. ${conf ? `${conf} · ` : ""}offense and defense rankings.`;
  const nextCard = next && nextOpp
    ? `<div class="card"><b>Next game</b><p style="margin:6px 0 0">${next.home?.id === team.id ? "vs" : "at"} ${teamLink(nextOpp, nextOpp.name)} · ${esc(kickoffText(next.date, next.timeTbd, true))}${next.odds ? ` · ${esc(favSpreadText(next))}` : ""}${ctx.pathsById[next.id] ? ` · <a href="${ctx.pathsById[next.id]}">Preview →</a>` : ""}</p></div>` : "";
  const body = `<div class="card" style="display:flex;gap:14px;align-items:center">${crest(team, "lg")}<div><div style="font-size:20px;font-weight:800">${rank ? `<span class="rk">#${rank}</span>` : ""}${esc(team.name)}</div><div class="note">${[conf, record ? `${record}` : null, standing].filter(Boolean).map(esc).join(" · ")}</div></div></div>
${nextCard}
<h2>${SEASON} schedule & results</h2>
<div class="card scroll"><table class="sch"><thead><tr><th class="hide-sm">Wk</th><th>Date</th><th>Opponent</th><th>Line</th><th>Result / win chance</th><th></th></tr></thead><tbody>
${rows.join("\n") || `<tr><td colspan="6">Schedule not available.</td></tr>`}
</tbody></table></div>
${st ? `<h2>Offense & defense rankings</h2>
<div class="grid2"><div class="card"><h3 style="margin-top:0">Offense</h3><table><thead><tr><th>Per game</th><th class="n">Avg</th><th class="n">Rank</th></tr></thead><tbody>
${statRow("Points", "oPts", "oPts")}${statRow("Total yards", "oTotal", "oTotal")}${statRow("Rushing yards", "oRush", "oRush")}${statRow("Passing yards", "oPass", "oPass")}
</tbody></table></div><div class="card"><h3 style="margin-top:0">Defense</h3><table><thead><tr><th>Allowed per game</th><th class="n">Avg</th><th class="n">Rank</th></tr></thead><tbody>
${statRow("Points", "dPts", "dPts")}${statRow("Total yards", "dTotal", "dTotal")}${statRow("Rushing yards", "dRush", "dRush")}${statRow("Passing yards", "dPass", "dPass")}
</tbody></table></div></div><p class="note">Ranks are out of ${ctx.stats.count} FBS teams, regular season to date.</p>` : ""}
${conf ? `<p><a href="/college/teams/#conf-${esc(confId)}">More ${esc(conf)} teams →</a></p>` : ""}`;
  const html = page({
    title, description, canonicalPath: p, h1: `${team.name} Schedule, Odds & Predictions`,
    lede: `Every ${SEASON} game with the betting line, result or market win chance.`,
    body, navOn: "teams",
    trail: [{ name: "College football", path: "/college/games/" }, { name: "Teams", path: "/college/teams/" }, { name: team.short, path: p }],
    jsonLd: [{ "@context": "https://schema.org", "@type": "SportsTeam", name: team.name, sport: "American Football", url: `${SITE_BASE}${p}`,
      ...(conf ? { memberOf: { "@type": "SportsOrganization", name: conf } } : {}) }],
  });
  return { path: p, changed: await writePage(`${p.slice(1)}index.html`, html) };
}

async function buildTeamsIndex(teams, ctx) {
  const p = "/college/teams/";
  const by = new Map();
  for (const t of teams) {
    // Anything still unrecognised shares ONE "Other FBS" section.
    const resolved = confIdOf(ctx.schedules[t.id]?.team?.groups, t.conf) || "18";
    const c = CONFERENCES[resolved] ? resolved : "other";
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(t);
  }
  const order = [...CONF_ORDER, ...[...by.keys()].filter((k) => !CONF_ORDER.includes(k))];
  const sections = order.filter((c) => by.has(c)).map((c) => {
    const list = by.get(c).sort((a, b) => a.short.localeCompare(b.short));
    return `<h2 id="conf-${esc(c)}">${esc(CONFERENCES[c] || "Other FBS")}</h2><div class="card grid2">${list.map((t) => `<a href="${teamPath(t.id)}" class="team-cell">${crest(t)}${esc(t.name)}</a>`).join("")}</div>`;
  });
  const html = page({
    title: `College Football Teams ${SEASON}: Schedules, Odds & Rankings | Blitz Odds`,
    description: `All ${teams.length} FBS college football teams by conference - each with its ${SEASON} schedule, results, betting lines and offense/defense rankings.`,
    canonicalPath: p, h1: `FBS College Football Teams ${SEASON}`,
    lede: `Pick a team for its schedule, lines and rankings.`,
    body: sections.join("\n"), navOn: "teams",
    trail: [{ name: "College football", path: "/college/games/" }, { name: "Teams", path: p }],
  });
  return { path: p, changed: await writePage(`${p.slice(1)}index.html`, html) };
}

// ---------------------------------------------------------------------------
// Bowls
// ---------------------------------------------------------------------------

function bowlGames(raw, lines) {
  const evs = raw?.bowls?.events || [];
  const games = evs.map((e) => normalizeEvent(e)).filter(Boolean).map((g) => ({ ...g, bowl: g.headline || "Bowl game" }));
  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
  // Slugs: from the bowl name; repeated names (four CFP first-round games)
  // get -game-1..n in kickoff order, which stays fixed once the bracket is set.
  const count = new Map(), seen = new Map();
  for (const g of games) { const s = slugify(bowlShortName(g.bowl)); count.set(s, (count.get(s) || 0) + 1); }
  for (const g of games) {
    const s = slugify(bowlShortName(g.bowl));
    if (count.get(s) > 1) { const n = (seen.get(s) || 0) + 1; seen.set(s, n); g.slug = `${s}-game-${n}`; }
    else g.slug = s;
    g.cfp = /playoff/i.test(g.bowl);
  }
  return games.map((g) => withLine(g, lines));
}
function bowlPath(g) { return `/college/bowls/${SEASON}/${g.slug}/`; }
function bowlTitleName(g) {
  const base = bowlShortName(g.bowl);
  return /game-\d+$/.test(g.slug) ? `${base} Game ${g.slug.match(/(\d+)$/)[1]}` : base;
}
/** People search a bowl by the year it's played ("rose bowl 2027"), not the
 *  season it belongs to - so January games carry the next year in titles.
 *  The URL keeps the season. */
function bowlYear(g) {
  const y = Number(String(g.date || "").slice(0, 4));
  return Number.isFinite(y) && y > 2000 ? y : SEASON;
}

async function buildBowlPage(g, ctx) {
  const p = bowlPath(g);
  const name = bowlTitleName(g);
  const set = !!(g.away && g.home);
  const when = kickoffText(g.date, g.timeTbd, true);
  const where = [g.venue, g.city].filter(Boolean).join(", ");
  const o = g.odds, m = marketSides(g);
  const title = set
    ? `${name} ${bowlYear(g)}: ${g.away.short} vs ${g.home.short} Prediction & Odds | Blitz Odds`
    : `${name} ${bowlYear(g)}: Date, Location, Matchup & Odds | Blitz Odds`;
  const description = set
    ? `${name} odds and prediction: ${g.away.name} vs ${g.home.name}${o ? `, ${favSpreadText(g)}${o.total != null ? `, O/U ${o.total}` : ""}` : ""}${m ? `, ${m.fav.short} ${pct(m.favP)} to win` : ""}. ${when}${where ? ` at ${where}` : ""}.`
    : `The ${bowlYear(g)} ${name} is ${when}${where ? ` at ${where}` : ""}. Teams are TBD - matchup, line and market odds post here as soon as they're set.`;
  const body = `${set ? matchupBlock(g) : `<div class="card"><p style="margin:0"><b>Matchup to be announced.</b> ${g.cfp ? "Teams come from the College Football Playoff bracket." : "Bowl pairings are announced after the conference championship games."} This page fills in with both teams, the line and the market's win chances as soon as ESPN posts them.</p></div>`}
<div class="card kv">
<div><b>Date</b><span>${esc(kickoffText(g.date, g.timeTbd))}</span></div>
<div><b>Stadium</b><span>${esc(g.venue || "TBD")}</span></div>
<div><b>Location</b><span>${esc(g.city || "TBD")}</span></div>
<div><b>TV</b><span>${esc(g.broadcast || "TBD")}</span></div>
</div>
${set ? `<h2>${g.state === "post" ? "How it finished against the line" : "The market read"}</h2><div class="card"><p style="margin:0">${marketRead(g, ctx.stats)}</p></div>${marketCard(g)}${statsTable(g, ctx.stats)}${faq(g)}` : ""}
${FEATURES.bowls ? `<div class="card"><b>Running a bowl pool?</b><p style="margin:6px 0">Free confidence, straight-up and against-the-spread bowl pools that score themselves.</p><a class="cta" href="/bowls">Start a bowl pick'em</a></div>` : ""}
<p><a href="/college/bowls/">Full ${SEASON}-${String(SEASON + 1).slice(2)} bowl schedule →</a></p>`;
  const html = page({
    title, description, canonicalPath: p, h1: set ? `${name} ${bowlYear(g)}: ${g.away.short} vs ${g.home.short}` : `${name} ${bowlYear(g)}`,
    lede: `${esc(when)}${where ? ` · ${esc(where)}` : ""}`,
    body, navOn: "bowls", ogType: "article",
    trail: [{ name: "College football", path: "/college/games/" }, { name: "Bowls", path: "/college/bowls/" }, { name, path: p }],
    jsonLd: [sportsEventLd(g, p, set ? `${name} ${bowlYear(g)}: ${g.away.name} vs ${g.home.name}` : `${name} ${bowlYear(g)}`)],
  });
  return { path: p, changed: await writePage(`${p.slice(1)}index.html`, html) };
}

async function buildBowlsHub(games, ctx) {
  const p = "/college/bowls/";
  const row = (g) => {
    const m = marketSides(g);
    const matchup = g.away && g.home ? `${teamCell(g.away)} <span class="note">vs</span> ${teamCell(g.home)}` : `<span class="note">TBD vs TBD</span>`;
    const res = g.state === "post" && g.homeScore != null ? `${g.awayScore}-${g.homeScore}` : m && g.state === "pre" ? `${esc(m.fav.abbr)} ${pct(m.favP)}` : "—";
    return `<tr><td>${esc(kickoffText(g.date, true).replace(/, time TBD$/, ""))}</td><td><a href="${bowlPath(g)}">${esc(bowlTitleName(g))}</a><div class="note">${esc(g.city || "")}</div></td><td>${matchup}</td><td class="hide-sm">${g.odds ? esc(favSpreadText(g)) : "—"}</td><td class="n">${res}</td></tr>`;
  };
  const table = (list) => `<div class="card scroll"><table><thead><tr><th>Date</th><th>Game</th><th>Matchup</th><th class="hide-sm">Spread</th><th class="n">Market / final</th></tr></thead><tbody>${list.map(row).join("\n")}</tbody></table></div>`;
  const cfp = games.filter((g) => g.cfp), bowls = games.filter((g) => !g.cfp);
  const setCount = games.filter((g) => g.away && g.home).length;
  const yr = `${SEASON}-${String(SEASON + 1).slice(2)}`;
  const html = page({
    title: `College Football Bowl Schedule ${yr}: Matchups, Odds & Predictions | Blitz Odds`,
    description: `All ${games.length} bowl games and the College Football Playoff for ${yr}: dates, stadiums, TV, matchups, spreads and market win chances${setCount ? "" : " - matchups post as soon as they're announced"}.`,
    canonicalPath: p, h1: `${yr} Bowl Schedule, Matchups & Odds`,
    lede: `${games.length} games from mid-December through the national championship.${setCount ? ` ${setCount} matchups set.` : " Matchups fill in as they're announced."}`,
    body: `${FEATURES.bowls ? `<div class="card"><b>Free bowl pick'em</b><p style="margin:6px 0">Run a confidence, straight-up or ATS pool for every bowl and the CFP - scored automatically.</p><a class="cta" href="/bowls">Start a bowl pool</a></div>` : ""}
<h2>College Football Playoff</h2>${table(cfp)}
<h2>Bowl games</h2>${table(bowls)}`,
    navOn: "bowls",
    trail: [{ name: "College football", path: "/college/games/" }, { name: "Bowls", path: p }],
    jsonLd: [{ "@context": "https://schema.org", "@type": "ItemList", name: `${yr} college football bowl games`,
      itemListElement: games.map((g, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE_BASE}${bowlPath(g)}`, name: bowlTitleName(g) })) }],
  });
  return { path: p, changed: await writePage(`${p.slice(1)}index.html`, html) };
}

// ---------------------------------------------------------------------------
// /college/games/ landing
// ---------------------------------------------------------------------------

async function existingWeeks() {
  const dir = path.join(REPO_ROOT, "college", "games", String(SEASON));
  try {
    return (await readdir(dir)).map((d) => d.match(/^week-(\d+)$/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  } catch { return []; }
}

async function buildGamesLanding(curWeek, curGames, weeks, bowlsCount) {
  const p = "/college/games/";
  const paths = new Map(curGames.map((g) => [g.id, gamePath(g)]));
  const top = curGames.filter((g) => bestRank(g) <= 25).sort((x, y) => bestRank(x) - bestRank(y));
  const html = page({
    title: `College Football Odds This Week: Spreads, Lines & Predictions | Blitz Odds`,
    description: `College football odds for Week ${curWeek ?? ""} of ${SEASON}: spreads, over/unders, moneylines and market win chances for every FBS game, plus the full bowl schedule.`,
    canonicalPath: p, h1: `College Football Odds & Predictions`,
    lede: curWeek ? `This week: <a href="${weekPath(curWeek)}">Week ${curWeek}</a> - ${curGames.length} FBS games.` : "",
    body: `${top.length ? `<h2>Week ${curWeek} Top 25 games</h2>${gamesTable(top, paths)}<p><a href="${weekPath(curWeek)}">All ${curGames.length} Week ${curWeek} games →</a></p>` : ""}
<h2>By week</h2><div class="card grid2">${weeks.slice().reverse().map((w) => `<a href="${weekPath(w)}">Week ${w} odds & results</a>`).join("")}</div>
<h2>More</h2><div class="card grid2">${FEATURES.bowls ? `<a href="/college/bowls/">${SEASON}-${String(SEASON + 1).slice(2)} bowl schedule (${bowlsCount} games)</a>` : ""}<a href="/college/teams/">All FBS teams</a><a href="/games/">NFL picks & odds</a></div>`,
    navOn: "games",
    trail: [{ name: "College football", path: p }],
  });
  return { path: p, changed: await writePage(`${p.slice(1)}index.html`, html) };
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

async function updateSitemap(entries) {
  const rel = "sitemap-college.xml";
  let old = "";
  try { old = await readFile(path.join(REPO_ROOT, rel), "utf8"); } catch {}
  const prev = new Map([...old.matchAll(/<loc>([^<]*)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?/g)].map((m) => [m[1], m[2] || null]));
  const today = new Date().toISOString().slice(0, 10);
  const map = new Map();
  for (const e of entries) {
    const loc = `${SITE_BASE}${e.path}`;
    map.set(loc, e.changed || !prev.get(loc) ? today : prev.get(loc));
  }
  // Pages from earlier runs that this run didn't touch (finished weeks).
  for (const [loc, lm] of prev) if (!map.has(loc) && existsSync(path.join(REPO_ROOT, loc.slice(SITE_BASE.length + 1), "index.html"))) map.set(loc, lm);
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...map].sort((a, b) => a[0].localeCompare(b[0])).map(([loc, lm]) => `  <url><loc>${loc}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`;
  if (body !== old) await writeFile(path.join(REPO_ROOT, rel), body, "utf8");
  return map.size;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try { BADGE_IDS = new Set((await readdir(path.join(REPO_ROOT, "team-badges", "cfb"))).map((f) => f.replace(/\.png$/, ""))); } catch {}
  FEATURES = await fetchPublicFeatures();
  log(`feature flags for signed-out visitors: bowls ${FEATURES.bowls ? "on" : "off"}`);
  const raw = await loadRaw();
  const stats = buildStats(raw.stats);
  if (stats.count < 100) throw new Error(`Only ${stats.count} FBS teams in the stats feed - refusing to build`);

  // FBS teams: identity from the stats feed, colours from the team list.
  const listById = new Map();
  for (const w of raw.teamList?.sports?.[0]?.leagues?.[0]?.teams || []) if (w?.team?.id) listById.set(String(w.team.id), w.team);
  const teams = (raw.stats.teams || []).map((r) => {
    const t = r.team, L = listById.get(String(t.id)) || {};
    return {
      id: String(t.id), abbr: String(t.abbreviation || L.abbreviation || ""), name: t.displayName || L.displayName,
      short: t.shortDisplayName || L.shortDisplayName || t.displayName,
      color: L.color ? `#${L.color}` : null, altColor: L.alternateColor ? `#${L.alternateColor}` : null,
      conf: confIdOf(raw.schedules[String(t.id)]?.team?.groups),
    };
  }).filter((t) => t.name);
  // Slugs: full display name; a repeat (none today) gets the ESPN id.
  const used = new Set();
  TEAM_SLUGS = new Map();
  for (const t of teams.slice().sort((a, b) => Number(a.id) - Number(b.id))) {
    let s = slugify(t.name);
    if (used.has(s)) s = `${s}-${t.id}`;
    used.add(s); TEAM_SLUGS.set(t.id, s);
  }

  const lines = await readJsonFile(`data/cfb-lines-${SEASON}.json`, {});
  const pageIndex = await readJsonFile(`data/cfb-pages-${SEASON}.json`, { events: {} });
  const pathsById = pageIndex.events || {};

  // Weekly games.
  const weekGames = {};
  for (const [w, sb] of Object.entries(raw.scoreboards || {})) {
    weekGames[w] = (sb?.events || []).map((e) => normalizeEvent(e, { week: Number(w) }))
      .filter((g) => g && g.away && g.home).map((g) => withLine({ ...g, week: Number(w) }, lines));
    for (const g of weekGames[w]) pathsById[g.id] = gamePath(g);
  }
  const bowls = bowlGames(raw, lines);
  for (const g of bowls) pathsById[g.id] = bowlPath(g);

  // AP ranks as of the latest scoreboard.
  const apRanks = new Map();
  // Newest poll wins: current week's scoreboard, then next, then last week.
  const rankOrder = Object.keys(weekGames).map(Number).sort((a, b) => (a === raw.curWeek ? -1 : b === raw.curWeek ? 1 : b - a));
  for (const w of rankOrder) for (const g of weekGames[w]) for (const t of [g.away, g.home]) if (t?.rank && !apRanks.has(t.id)) apRanks.set(t.id, t.rank);

  const ctx = { stats, schedules: raw.schedules, lines, pathsById, apRanks };
  const entries = [];

  const weeksBuilt = Object.keys(weekGames).map(Number).sort((a, b) => a - b);
  const allWeeks = [...new Set([...(await existingWeeks()), ...weeksBuilt])].sort((a, b) => a - b);
  for (const w of weeksBuilt) {
    for (const g of weekGames[w]) entries.push(await buildGamePage(g, ctx));
    const i = allWeeks.indexOf(w);
    const next = w + 1 <= raw.lastReg ? (allWeeks.includes(w + 1) || weeksBuilt.includes(w + 1) ? w + 1 : null) : null;
    entries.push(await buildWeekHub(w, weekGames[w], ctx, { prev: i > 0 ? allWeeks[i - 1] : null, next }));
  }
  for (const t of teams) entries.push(await buildTeamPage(t, ctx));
  entries.push(await buildTeamsIndex(teams, ctx));
  for (const g of bowls) entries.push(await buildBowlPage(g, ctx));
  entries.push(await buildBowlsHub(bowls, ctx));
  const curWeek = raw.seasonType === 2 ? raw.curWeek : null;
  entries.push(await buildGamesLanding(curWeek, curWeek ? weekGames[curWeek] || [] : [], allWeeks, bowls.length));

  await writeJsonFile(`data/cfb-lines-${SEASON}.json`, lines);
  await writeJsonFile(`data/cfb-pages-${SEASON}.json`, { events: Object.fromEntries(Object.entries(pathsById).sort()) });
  const total = await updateSitemap(entries);
  log(`${entries.length} pages built (${entries.filter((e) => e.changed).length} changed); weeks ${weeksBuilt.join(",") || "none"}; ${bowls.length} bowls; sitemap-college.xml has ${total} URLs`);
}

main().catch((err) => { console.error("[college-pages] FAILED:", err); process.exit(1); });

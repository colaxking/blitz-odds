#!/usr/bin/env node
/**
 * model-backtest.mjs
 *
 * Scores js/predictionEngine.js the way it actually runs: every game is
 * rated with the ranks that existed at ITS kickoff (season-to-date yardage
 * through the previous week, blended with the prior season exactly as
 * computeBaseRatings does), never with ranks that already include the game.
 * The earlier fit used each season's final rankings for every game in it,
 * which leaked the outcome into the inputs and overstated the slope by ~40%.
 *
 * Inputs (all in data/): historical-team-game-yards.json (per team-game rush
 * and net passing yards, 2014-2025, identical to footballdb's numbers) and
 * historical-closing-lines.json (scores + closing spread/ML/total, 2015-2025).
 * No injury or weather data exists for past seasons, so the backtest runs
 * with empty impact-player lists; absolute numbers are mildly optimistic but
 * every comparison here is apples to apples.
 *
 *   node scripts/model-backtest.mjs            # report on the shipped constants
 *   node scripts/model-backtest.mjs --fit      # also print fresh OLS fits by phase
 *
 * Use --fit before changing MARGIN_FIT_EARLY / MARGIN_FIT_REGULAR / MARGIN_SD.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PE = require(path.join(ROOT, "js/predictionEngine.js"));
const YARDS = JSON.parse(readFileSync(path.join(ROOT, "data/historical-team-game-yards.json"), "utf8")).seasons;
const LINES = JSON.parse(readFileSync(path.join(ROOT, "data/historical-closing-lines.json"), "utf8")).games;
const DO_FIT = process.argv.includes("--fit");
const HFA = PE.constants.HOME_FIELD_BONUS;

// ---- as-of-kickoff ranks ----------------------------------------------------
function ranks(vals, higherIsBetter) {
  const ids = Object.keys(vals).sort((a, b) =>
    (higherIsBetter ? vals[b] - vals[a] : vals[a] - vals[b]) || a.localeCompare(b));
  const out = {};
  ids.forEach((t, i) => { out[t] = i + 1; });
  return out;
}
function statsFromAverages(avg) {
  const rush = {}, pass = {}, tot = {}, rushA = {}, passA = {}, totA = {};
  for (const t in avg) {
    const v = avg[t];
    rush[t] = v.rush; pass[t] = v.pass; tot[t] = v.rush + v.pass;
    rushA[t] = v.rushA; passA[t] = v.passA; totA[t] = v.rushA + v.passA;
  }
  const rT = ranks(tot, true), rR = ranks(rush, true), rP = ranks(pass, true);
  const dT = ranks(totA, false), dR = ranks(rushA, false), dP = ranks(passA, false);
  const out = {};
  for (const t in avg) {
    out[t] = {
      offense: { rankTotal: rT[t], rankRush: rR[t], rankPass: rP[t] },
      defense: { rankTotal: dT[t], rankRush: dR[t], rankPass: dP[t] },
    };
  }
  return out;
}
// season -> { final: stats, byWeek: { week -> { stats (through week-1), games: {team: n} } } }
const SEASON = {};
for (const season in YARDS) {
  const rows = YARDS[season];
  const byTeamWeek = {};
  for (const [week, team, opp, rush, pass] of rows) byTeamWeek[`${week}:${team}`] = { week, team, opp, rush, pass };
  const totals = {};
  const add = (acc, r) => {
    const o = byTeamWeek[`${r.week}:${r.opp}`];
    const a = acc[r.team] || (acc[r.team] = { g: 0, rush: 0, pass: 0, rushA: 0, passA: 0 });
    a.g++; a.rush += r.rush; a.pass += r.pass; a.rushA += o.rush; a.passA += o.pass;
  };
  const avgOf = (acc) => {
    const out = {};
    for (const t in acc) { const a = acc[t]; out[t] = { rush: a.rush / a.g, pass: a.pass / a.g, rushA: a.rushA / a.g, passA: a.passA / a.g }; }
    return out;
  };
  const maxWeek = Math.max(...rows.map((r) => r[0]));
  const byWeek = {};
  for (let w = 1; w <= maxWeek; w++) {
    const acc = {};
    for (const r of rows) if (r[0] < w) add(acc, byTeamWeek[`${r[0]}:${r[1]}`]);
    const games = {}; for (const t in acc) games[t] = acc[t].g;
    byWeek[w] = { stats: Object.keys(acc).length ? statsFromAverages(avgOf(acc)) : null, games };
  }
  for (const r of rows) add(totals, byTeamWeek[`${r[0]}:${r[1]}`]);
  SEASON[season] = { final: statsFromAverages(avgOf(totals)), byWeek };
}

/** The team object predictMatchup sees for `team` at `season` week `week`. */
function teamAt(team, season, week) {
  const prior = SEASON[String(season - 1)].final[team];
  const wk = SEASON[String(season)].byWeek[week];
  const cur = wk && wk.stats && wk.stats[team];
  const n = (wk && wk.games[team]) || 0;
  return { id: team, stats: { ...(cur || prior), gamesPlayed: cur ? n : 0 }, priorStats: prior };
}

// ---- score every game -------------------------------------------------------
const games = [];
for (const key in LINES) {
  const [season, week, away, home] = key.split("_");
  const g = LINES[key];
  const s = Number(season), w = Number(week);
  if (!SEASON[String(s - 1)] || !SEASON[String(s)]) continue;
  const p = PE.predictMatchup({ homeTeam: teamAt(home, s, w), awayTeam: teamAt(away, s, w), week: w });
  const edge = p.edge - (g.neutral ? HFA : 0); // engine always adds home field; strip it on neutral sites
  const margin = PE.edgeToMargin(edge, w);
  games.push({ season: s, week: w, edge, margin, prob: PE.marginToWinProbability(margin, w),
    actual: g.homeScore - g.awayScore, spread: g.homeSpread, mlHome: g.mlHome, mlAway: g.mlAway });
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
function report(label, rows) {
  let n = 0, acc = 0, brier = 0, mae = 0, mkt = 0, mktN = 0;
  for (const g of rows) {
    if (g.actual === 0) continue;
    n++;
    if ((g.margin > 0) === (g.actual > 0)) acc++;
    brier += (g.prob - (g.actual > 0 ? 1 : 0)) ** 2;
    mae += Math.abs(g.margin - g.actual);
    if (g.spread != null && g.spread !== 0) { mktN++; if ((g.spread > 0) === (g.actual > 0)) mkt++; }
  }
  console.log(`${label.padEnd(10)} n=${String(n).padStart(4)}  SU ${pct(acc / n)}  Brier ${(brier / n).toFixed(4)}  MAE ${(mae / n).toFixed(2)}   | closing line SU ${pct(mkt / mktN)}`);
}
console.log(`Engine: early ${JSON.stringify(PE.constants.MARGIN_FIT_EARLY)} (weeks <= ${PE.constants.EARLY_SEASON_LAST_WEEK}), regular ${JSON.stringify(PE.constants.MARGIN_FIT_REGULAR)}, SD ${PE.constants.MARGIN_SD}, blend K ${PE.constants.SEASON_BLEND_K}\n`);
report("all", games);
for (const [label, f] of [["wk1", (w) => w === 1], ["wk2", (w) => w === 2], ["wk3-4", (w) => w >= 3 && w <= 4], ["wk5-6", (w) => w >= 5 && w <= 6], ["wk7-18", (w) => w >= 7]])
  report(label, games.filter((g) => f(g.week)));

console.log("\nCalibration by confidence bin:");
const bins = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.75], [0.75, 1.01]];
for (const [lo, hi] of bins) {
  const rows = games.filter((g) => { const c = Math.max(g.prob, 1 - g.prob); return c >= lo && c < hi && g.actual !== 0; });
  if (!rows.length) continue;
  const hit = rows.filter((g) => (g.margin > 0) === (g.actual > 0)).length;
  const pred = rows.reduce((s, g) => s + Math.max(g.prob, 1 - g.prob), 0) / rows.length;
  console.log(`  ${pct(lo)}-${pct(hi)}  n=${String(rows.length).padStart(4)}  predicted ${pct(pred)}  actual ${pct(hit / rows.length)}`);
}

console.log("\nAgainst the closing spread (model's side of the number, by |model - market| gap):");
const gaps = { "<1": [0, 1], "1-3": [1, 3], "3-5": [3, 5], "5-8": [5, 8], "8+": [8, 99] };
for (const label in gaps) {
  const [lo, hi] = gaps[label];
  let n = 0, cover = 0;
  for (const g of games) {
    if (g.spread == null) continue;
    const gap = g.margin - g.spread, ag = Math.abs(gap);
    if (ag < lo || ag >= hi || g.actual === g.spread) continue;
    n++; if ((g.actual > g.spread) === (gap > 0)) cover++;
  }
  console.log(`  gap ${label.padEnd(4)} n=${String(n).padStart(4)}  covers ${pct(cover / n)}`);
}

if (DO_FIT) {
  const ols = (rows) => {
    const n = rows.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const g of rows) { sx += g.edge; sy += g.actual; sxx += g.edge * g.edge; sxy += g.edge * g.actual; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), intercept = (sy - slope * sx) / n;
    let ss = 0; for (const g of rows) ss += (g.actual - intercept - slope * g.edge) ** 2;
    return { slope, intercept, sd: Math.sqrt(ss / (n - 2)), n };
  };
  console.log("\nFresh OLS fits of actual home margin on rating edge (what the constants should be):");
  for (const [label, f] of [["weeks 1-6", (w) => w <= 6], ["weeks 7-18", (w) => w >= 7], ["all", () => true]]) {
    const r = ols(games.filter((g) => f(g.week)));
    console.log(`  ${label.padEnd(10)} margin = ${r.slope.toFixed(3)} * edge + ${r.intercept.toFixed(2)}   residual SD ${r.sd.toFixed(2)}   n=${r.n}`);
  }
}

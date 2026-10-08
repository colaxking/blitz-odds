#!/usr/bin/env node
/**
 * ensure-team-fields.mjs
 *
 * Makes sure data/teams.json carries the two fields the prediction engine's
 * prior-season blend needs (refit of 2026-10-08, see claude_model-refit-notes.md):
 *
 *   team.priorStats      - last season's final ranks, from data/historical-team-rankings.json
 *   team.stats.gamesPlayed - games this team has played this season, counted from
 *                            the schedule through teams.json's asOfWeek (a bye week
 *                            simply has no entry for the team)
 *
 * The Tuesday weekly-update task regenerates teams.json from footballdb and may
 * write it without either field; build-static-pages.mjs calls this before it
 * loads the data, so the committed file and the prerendered pages are repaired
 * in the same run. Safe to run any time: a complete file is left byte-for-byte
 * alone. (site-data-update.mts does the same repair for the live Blob copy.)
 *
 *   node scripts/ensure-team-fields.mjs          # repair in place, print what changed
 *   node scripts/ensure-team-fields.mjs --check  # exit 1 if anything is missing, change nothing
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEAMS_PATH = path.join(ROOT, "data/teams.json");

export function gamesPlayedFromSchedule(schedule, asOfWeek) {
  if (!schedule || !Array.isArray(schedule.weeks) || !Number.isFinite(asOfWeek) || asOfWeek < 0) return null;
  const counts = {};
  for (const w of schedule.weeks) {
    if (!w || typeof w.week !== "number" || w.week < 1 || w.week > asOfWeek) continue;
    for (const g of Array.isArray(w.games) ? w.games : []) {
      if (!g) continue;
      if (typeof g.home === "string") counts[g.home] = (counts[g.home] || 0) + 1;
      if (typeof g.away === "string") counts[g.away] = (counts[g.away] || 0) + 1;
    }
  }
  return counts;
}

/** Returns { doc, filledPrior, filledGames, unresolved }; `doc` is the input when nothing was missing. */
export function completeTeamsDoc(doc, rankings, schedule) {
  const out = { doc, filledPrior: [], filledGames: [], unresolved: [] };
  if (!doc || !Array.isArray(doc.teams)) return out;
  const priorSeason = typeof doc.season === "number" ? String(doc.season - 1) : null;
  const prior = priorSeason && rankings ? rankings[priorSeason] : null;
  const counts = gamesPlayedFromSchedule(schedule, typeof doc.asOfWeek === "number" ? doc.asOfWeek : NaN);
  let changed = false;
  const teams = doc.teams.map((t) => {
    if (!t || typeof t !== "object") return t;
    let next = t;
    if (!(t.priorStats && t.priorStats.offense && t.priorStats.defense)) {
      const p = prior && prior[t.id];
      if (p && p.offense && p.defense) {
        const pick = (s) => ({ rankRush: s.rankRush, rankPass: s.rankPass, rankTotal: s.rankTotal });
        next = { ...next, priorStats: { season: Number(priorSeason), offense: pick(p.offense), defense: pick(p.defense) } };
        out.filledPrior.push(t.id);
        changed = true;
      } else {
        out.unresolved.push(`${t.id}:priorStats`);
      }
    }
    if (next.stats && typeof next.stats.gamesPlayed !== "number") {
      const n = counts ? counts[t.id] : undefined;
      if (typeof n === "number") {
        next = { ...next, stats: { ...next.stats, gamesPlayed: n } };
        out.filledGames.push(t.id);
        changed = true;
      } else {
        out.unresolved.push(`${t.id}:gamesPlayed`);
      }
    }
    return next;
  });
  if (changed) out.doc = { ...doc, teams };
  return out;
}

export function ensureTeamFieldsOnDisk({ check = false, log = console.log } = {}) {
  const doc = JSON.parse(readFileSync(TEAMS_PATH, "utf8"));
  const rankings = JSON.parse(readFileSync(path.join(ROOT, "data/historical-team-rankings.json"), "utf8"));
  let schedule = null;
  try {
    schedule = JSON.parse(readFileSync(path.join(ROOT, `data/schedule-full-${doc.season}.json`), "utf8"));
  } catch {
    schedule = null;
  }
  const res = completeTeamsDoc(doc, rankings, schedule);
  const missing = res.filledPrior.length + res.filledGames.length + res.unresolved.length;
  if (!missing) {
    log("ensure-team-fields: data/teams.json already carries priorStats and gamesPlayed for every team.");
    return { changed: false, unresolved: [] };
  }
  const summary =
    `priorStats missing for ${res.filledPrior.length}, gamesPlayed missing for ${res.filledGames.length}` +
    (res.unresolved.length ? `; could not resolve ${res.unresolved.join(", ")}` : "");
  if (check) {
    log(`ensure-team-fields --check: ${summary}`);
    return { changed: false, unresolved: res.unresolved, missing };
  }
  if (res.doc !== doc) {
    writeFileSync(TEAMS_PATH, JSON.stringify(res.doc, null, 1) + "\n");
    log(`ensure-team-fields: repaired data/teams.json (${summary}).`);
  } else {
    log(`ensure-team-fields: nothing repairable (${summary}).`);
  }
  return { changed: res.doc !== doc, unresolved: res.unresolved };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const r = ensureTeamFieldsOnDisk({ check });
  if (check && r.missing) process.exit(1);
  if (r.unresolved.length) process.exit(1);
}

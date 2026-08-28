// One place that answers "what games exist, and when do they kick off" for
// the alert dispatchers.
//
// WHY THIS EXISTS. The site stores the season in three separate blob keys
// with two different shapes:
//
//   "schedule"  -> { weeks: [ { week: 1..18, games: [...] } ] }
//   "preseason" -> { rounds: [ { week: -4..-1, label, espnSeasonType,
//                                espnWeek, games: [...] } ] }
//   "playoffs"  -> { rounds: [ { week: 19..22, ... same shape ... } ] }
//
// Both dispatchers used to read only "schedule", so every preseason and
// playoff game was invisible to push alerts - not by decision, just by
// omission. Anyone with alerts on got silence through August and would have
// got silence again through January. This merges all three into one list so
// a caller can't accidentally see part of the season.
//
// PHASES ARE NOT INTERCHANGEABLE. Pick'em runs on the regular season only,
// so anything deadline-shaped (pick reminders, the Tuesday recap, last call)
// must keep using loadRegularWeeks(). Anything game-shaped (kickoff, final
// score, live scoring) uses loadAllWeeks(). isPickemWeek() is the test, and
// it lives here so the two dispatchers can't drift on the answer.
//
// FALLBACK TO THE GIT SEED. "preseason" and "playoffs" have never actually
// been published to Blobs - the front end reads them from a JSON block
// embedded in index.html, so nothing ever needed them in the store. A
// function has no such block, so the seed files are imported here and used
// when the blob key is absent. Same two-layer rule as everywhere else: the
// blob wins when it exists, the git file is the floor. That also means this
// works on deploy without anyone having to run site-data-update first.

import preseasonSeed from "../../../data/schedule-preseason-2026.json";
import playoffsSeed from "../../../data/schedule-playoffs-2026.json";
import scheduleSeed from "../../../data/schedule-full-2026.json";

export interface ScheduleGame {
  away: string;
  home: string;
  date: string;
  time: string;
  network?: string;
}

export type Phase = "preseason" | "regular" | "postseason";

export interface PhaseWeek {
  /** The app's own week number: -4..-1 preseason, 1..18 regular, 19..22 post. */
  week: number;
  label: string;
  phase: Phase;
  /** ESPN's scoreboard numbering, which is not ours. See espnParamsFor(). */
  espnSeasonType: number;
  espnWeek: number;
  games: ScheduleGame[];
}

/** Regular-season weeks are the only ones pick'em pools run on. */
export function isPickemWeek(week: number): boolean {
  return week >= 1 && week <= 18;
}

export function labelForWeek(week: number): string {
  if (isPickemWeek(week)) return `Week ${week}`;
  return `Week ${week}`;
}

function roundsToWeeks(doc: any, phase: Phase): PhaseWeek[] {
  const rounds = doc?.rounds;
  if (!Array.isArray(rounds)) return [];
  const out: PhaseWeek[] = [];
  for (const r of rounds) {
    const games = Array.isArray(r?.games) ? (r.games as ScheduleGame[]) : [];
    // A round with no matchups yet (matchupsAnnounced: false, which is every
    // playoff round until January) contributes nothing but is harmless to
    // carry - it just never produces a candidate.
    if (typeof r?.week !== "number") continue;
    out.push({
      week: r.week,
      label: String(r.label || labelForWeek(r.week)),
      phase,
      espnSeasonType: Number(r.espnSeasonType) || (phase === "preseason" ? 1 : 3),
      espnWeek: Number(r.espnWeek) || 1,
      games,
    });
  }
  return out;
}

function regularToWeeks(doc: any): PhaseWeek[] {
  const weeks = doc?.weeks;
  if (!Array.isArray(weeks)) return [];
  const out: PhaseWeek[] = [];
  for (const w of weeks) {
    if (typeof w?.week !== "number") continue;
    out.push({
      week: w.week,
      label: labelForWeek(w.week),
      phase: "regular",
      espnSeasonType: 2,
      espnWeek: w.week,
      games: Array.isArray(w.games) ? (w.games as ScheduleGame[]) : [],
    });
  }
  return out;
}

/** Blob first, git seed as the floor. A thrown read degrades to the seed
 *  rather than to nothing - a stale schedule still beats a silent one. */
async function readDoc(store: any, key: string, seed: any): Promise<any> {
  try {
    const doc = await store.get(key, { type: "json" });
    return doc || seed;
  } catch {
    return seed;
  }
}

/**
 * Regular season only (weeks 1-18). Use for anything tied to a pick'em
 * deadline: pick reminders, the weekly recap, last call.
 */
export async function loadRegularWeeks(siteDataStore: any): Promise<PhaseWeek[]> {
  const doc = await readDoc(siteDataStore, "schedule", scheduleSeed);
  return regularToWeeks(doc).sort((a, b) => a.week - b.week);
}

/**
 * Every game in the season - preseason, regular, and playoffs - in week
 * order. Use for anything about a game itself: kickoff warnings, final
 * scores, live scoring.
 */
export async function loadAllWeeks(siteDataStore: any): Promise<PhaseWeek[]> {
  const [regular, preseason, playoffs] = await Promise.all([
    readDoc(siteDataStore, "schedule", scheduleSeed),
    readDoc(siteDataStore, "preseason", preseasonSeed),
    readDoc(siteDataStore, "playoffs", playoffsSeed),
  ]);
  return [
    ...roundsToWeeks(preseason, "preseason"),
    ...regularToWeeks(regular),
    ...roundsToWeeks(playoffs, "postseason"),
  ].sort((a, b) => a.week - b.week);
}

/** ESPN scoreboard params for a week we already resolved. */
export function espnParamsFor(w: PhaseWeek): { seasontype: number; week: number } {
  return { seasontype: w.espnSeasonType, week: w.espnWeek };
}

// ESPN depth charts, server-side, for two jobs the injury review queue has:
// deciding whether an unfamiliar name is worth showing Dan at all, and
// pre-filling the impact score the queue row asks for.
//
// THE TRAP THIS LIBRARY EXISTS TO AVOID. ESPN demotes a player on the depth
// chart at the same moment it designates him out. Measured against
// impact-players.json the day this was written: of 74 curated players carried
// as "out", 44 were listed third-or-deeper in their slot with nobody behind
// them - Josh Jacobs, Laremy Tunsil, Jeremiah Owusu-Koramoah among them. Of
// 71 carried active or questionable, ZERO were. So "deep on the depth chart
// with no one under him" is not a description of a depth piece. It is a
// description of an injured starter, and filtering on today's reading would
// silently drop the exact rows the queue exists to surface.
//
// So nothing here trusts a live reading of an injured player. A player's
// depth is recorded ONLY on a tick where ESPN lists him healthy, and only
// ever improves (the lowest index ever seen). That's "where he sits when
// he's playing", which is the question actually being asked. A player with
// no healthy reading on file is unknown, not deep - he is never filtered.

import { fixAbbr } from "./espn-injuries.mts";

/** ESPN's URL slug differs from its own abbreviation for exactly one team. */
const ESPN_URL_SLUG: Record<string, string> = { WAS: "wsh" };
export const espnTeamSlug = (abbr: string): string =>
  (ESPN_URL_SLUG[fixAbbr(abbr)] || fixAbbr(abbr)).toLowerCase();

export const ESPN_HEADERS: Record<string, string> = {
  "User-Agent": "curl/8.4.0",
  Accept: "application/json",
};

const depthUrl = (slug: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${slug}/depthcharts`;

/** Where one athlete sits in one slot. */
export interface DepthSpot {
  /** 0-based position within the slot. 0 is the starter. */
  index: number;
  /** How many players ESPN lists in that slot. */
  size: number;
  /** Slot abbreviation - "RT", "WR", "LCB". */
  pos: string | null;
  /** Whether the slot came out of a special-teams formation. */
  special: boolean;
}

/** The persisted map: athlete id -> best spot ever seen while healthy. */
export interface HealthyDepth {
  index: number;
  size: number;
  pos: string | null;
  seenAt: string;
}
export interface DepthSnapshot {
  updatedAt: string;
  /** team abbr -> ISO timestamp of the last fetch, so a tick doesn't refetch
   *  a team it already read minutes ago. */
  teams: Record<string, string>;
  players: Record<string, HealthyDepth>;
}

export const DEPTH_SNAPSHOT_KEY = "espn-depth-healthy";

/** A team is refetched at most this often. Depth charts move on a
 *  practice-report cadence, not a two-minute one. */
export const DEPTH_REFETCH_MS = 45 * 60 * 1000;

const isSpecialFormation = (name: unknown) =>
  /(special|punt|kick|field ?goal|\bfg\b|return)/i.test(String(name || ""));

/**
 * Every slot every athlete on one team appears in, keyed by ESPN athlete id.
 * A player legitimately appears in more than one (a WR3 who's also the KR2).
 */
export async function fetchTeamDepth(teamAbbr: string): Promise<Record<string, DepthSpot[]>> {
  const res = await fetch(depthUrl(espnTeamSlug(teamAbbr)), { headers: ESPN_HEADERS });
  if (!res.ok) throw new Error(`ESPN depth chart failed for ${teamAbbr}: ${res.status}`);
  const data: any = await res.json();

  const out: Record<string, DepthSpot[]> = {};
  for (const formation of data.depthchart || []) {
    const special = isSpecialFormation(formation?.name);
    for (const entry of Object.values<any>(formation?.positions || {})) {
      const athletes = entry?.athletes || [];
      const pos = entry?.position?.abbreviation || null;
      athletes.forEach((a: any, index: number) => {
        const id = a?.id != null ? String(a.id) : null;
        if (!id) return;
        (out[id] = out[id] || []).push({ index, size: athletes.length, pos, special });
      });
    }
  }
  return out;
}

/**
 * The one spot that describes a player, out of the several he may hold.
 *
 * Ranked the same way the admin depth-chart sheet ranks them: his own
 * position first, then any non-special-teams slot, then returner/kicking
 * duty, and only then by depth. Sorting on depth alone would call a WR3 "the
 * backup punt returner".
 */
export function bestSpot(spots: DepthSpot[] | undefined, position: string | null): DepthSpot | null {
  if (!spots || !spots.length) return null;
  const primary = String(position || "").toUpperCase();
  const tier = (s: DepthSpot) => {
    if (primary && String(s.pos || "").toUpperCase() === primary) return 0;
    return s.special ? 2 : 1;
  };
  return spots.slice().sort((a, b) => tier(a) - tier(b) || a.index - b.index)[0];
}

/**
 * Starter-level impact score by position, calibrated against the 145 scores
 * already in impact-players.json rather than invented: QB runs 5-10 (median
 * 7), WR 2-10 (median 6), edge rushers 6-9, interior O-line 4-5, and so on.
 * This is a starting number in an editable box, not a verdict.
 */
const POSITION_BASE: Record<string, number> = {
  QB: 7,
  EDGE: 7, LT: 7,
  DT: 6, NT: 6, RB: 6, WR: 6, S: 6, FS: 6, SS: 6,
  TE: 5, CB: 5, DE: 5, LB: 5, OLB: 5, ILB: 5, MLB: 5, RT: 5, OT: 5, OG: 5, LG: 5, RG: 5, C: 5,
  FB: 3, K: 3,
  P: 2, LS: 1,
};
const DEFAULT_BASE = 5;

/**
 * How far a score falls off the starter's, by depth, and the floor it can't
 * fall through.
 *
 * Both numbers were fitted, not guessed. Scored against the 49 curated
 * players who have a healthy depth reading today, this lands within 1 of
 * Dan's own number 57% of the time and within 2 for 86%, mean absolute error
 * 1.35. Steeper penalties (-3/-4/-5) measured worse and produced 1s for
 * players carried at 7, which is the kind of miss that matters when the
 * number arrives pre-filled in a box next to an Apply button.
 *
 * The depth signal is weak on that sample by construction - almost every
 * curated player is a starter, so there are barely any true depth pieces to
 * separate. It earns its place for the population this actually runs on:
 * unfamiliar names, where "third at his slot" is most of what's knowable.
 */
const DEPTH_PENALTY = [0, 1, 2, 3];
const SCORE_FLOOR = 3;

/**
 * A suggested 1-10 impact score. `spot` should be the HEALTHY reading where
 * one exists - passing a live reading of an injured player scores him as the
 * third-stringer ESPN just demoted him to.
 */
export function suggestImpactScore(position: string | null, spot: HealthyDepth | DepthSpot | null): number {
  const base = POSITION_BASE[String(position || "").toUpperCase()] ?? DEFAULT_BASE;
  // No depth reading is not the same as being buried: shade it down one and
  // let the operator correct it, rather than guessing him onto the bench.
  const penalty = spot ? (DEPTH_PENALTY[spot.index] ?? DEPTH_PENALTY[DEPTH_PENALTY.length - 1]) : 1;
  return Math.min(10, Math.max(SCORE_FLOOR, base - penalty));
}

/**
 * Whether a player is deep enough, with nobody behind him, that an untracked
 * status change isn't worth a queue row.
 *
 * ONLY EVER CALLED WITH A HEALTHY READING. See the header: on a live reading
 * this returns true for 59% of genuinely injured players.
 */
export function isBuriedDepthPiece(spot: HealthyDepth | DepthSpot | null): boolean {
  if (!spot) return false;
  return spot.index >= 2 && spot.index === spot.size - 1;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

/** Plain English for a queue row's hint line: "3rd string at WR, 3 of 3".
 *  "Starter" and "backup" are spelled out because those two lines are what
 *  actually decide a score; anything deeper is just a number. Same wording
 *  the admin depth-chart sheet uses. */
export function describeSpot(spot: HealthyDepth | DepthSpot | null): string | null {
  if (!spot) return null;
  const word = spot.index === 0 ? "Starter"
    : spot.index === 1 ? "Backup"
    : `${ordinal(spot.index + 1)} string`;
  return `${word} at ${spot.pos || "his slot"}, ${spot.index + 1} of ${spot.size}`;
}

/**
 * Fold a freshly fetched team into the persisted healthy map.
 *
 * `healthyIds` is the set of athlete ids ESPN currently lists as playable.
 * Anyone else is skipped outright - recording a demoted reading is the whole
 * failure mode this library is built around. Recorded indexes only ever
 * improve, so one bad tick can't bury someone permanently.
 */
export function foldHealthyDepth(
  snapshot: DepthSnapshot,
  teamAbbr: string,
  spotsById: Record<string, DepthSpot[]>,
  isHealthy: (athleteId: string) => boolean,
  now: Date,
): number {
  let recorded = 0;
  for (const [id, spots] of Object.entries(spotsById)) {
    if (!isHealthy(id)) continue;
    const spot = bestSpot(spots, null);
    if (!spot) continue;
    const prev = snapshot.players[id];
    if (prev && prev.index <= spot.index) {
      // Keep the better reading, but refresh the slot size - a slot that
      // grew or shrank changes whether he has anyone behind him.
      if (prev.index === spot.index) prev.size = spot.size;
      continue;
    }
    snapshot.players[id] = { index: spot.index, size: spot.size, pos: spot.pos, seenAt: now.toISOString() };
    recorded++;
  }
  snapshot.teams[fixAbbr(teamAbbr)] = now.toISOString();
  snapshot.updatedAt = now.toISOString();
  return recorded;
}

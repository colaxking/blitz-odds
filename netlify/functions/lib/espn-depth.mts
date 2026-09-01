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
/** One slot's running order: who ESPN lists ahead of whom. */
export interface DepthSlot {
  pos: string | null;
  ids: string[];
}
export interface DepthSnapshot {
  updatedAt: string;
  /** team abbr -> ISO timestamp of the last fetch, so a tick doesn't refetch
   *  a team it already read minutes ago. */
  teams: Record<string, string>;
  players: Record<string, HealthyDepth>;
  /** team abbr -> its slots, persisted so the next-man-up test works on
   *  every tick and not only the one that happened to refetch. Depth charts
   *  move on a practice-report cadence, so a reading up to
   *  DEPTH_REFETCH_MS old is still the right running order. */
  slots?: Record<string, DepthSlot[]>;
}

export const DEPTH_SNAPSHOT_KEY = "espn-depth-healthy";

/** Athlete ids ESPN currently lists as anything but active, written every
 *  tick by the dispatcher. Small (a few hundred ids) and kept out of the
 *  depth snapshot on purpose: that document carries slots and is ~150 KB,
 *  and this one has to be fresh, not big. It exists so injury-review can
 *  answer "is anyone ahead of him able to play" without its own ESPN fetch
 *  on every panel load. */
export const DOWN_SET_KEY = "espn-down-set";
export interface DownSet { updatedAt: string; ids: string[] }

/** A team is refetched at most this often. Depth charts move on a
 *  practice-report cadence, not a two-minute one. */
export const DEPTH_REFETCH_MS = 45 * 60 * 1000;

const isSpecialFormation = (name: unknown) =>
  /(special|punt|kick|field ?goal|\bfg\b|return)/i.test(String(name || ""));

/**
 * One team's depth chart, in both shapes the callers need: `byAthlete` for
 * "where does this player sit", `slots` for "who is ahead of him".
 *
 * Special-teams formations are excluded from `slots` - being third on the
 * kick-return unit says nothing about whether anyone's snaps change hands.
 * They stay in `byAthlete`, which ranks them last anyway.
 */
export async function fetchTeamDepth(teamAbbr: string): Promise<{
  byAthlete: Record<string, DepthSpot[]>;
  slots: DepthSlot[];
}> {
  const res = await fetch(depthUrl(espnTeamSlug(teamAbbr)), { headers: ESPN_HEADERS });
  if (!res.ok) throw new Error(`ESPN depth chart failed for ${teamAbbr}: ${res.status}`);
  const data: any = await res.json();

  const byAthlete: Record<string, DepthSpot[]> = {};
  const slots: DepthSlot[] = [];
  for (const formation of data.depthchart || []) {
    const special = isSpecialFormation(formation?.name);
    for (const entry of Object.values<any>(formation?.positions || {})) {
      const athletes = entry?.athletes || [];
      const pos = entry?.position?.abbreviation || null;
      const ids: string[] = [];
      athletes.forEach((a: any, index: number) => {
        const id = a?.id != null ? String(a.id) : null;
        if (!id) return;
        ids.push(id);
        (byAthlete[id] = byAthlete[id] || []).push({ index, size: athletes.length, pos, special });
      });
      if (ids.length && !special) slots.push({ pos, ids });
    }
  }
  return { byAthlete, slots };
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

/** Where a player sits relative to the people ahead of him, and whether any
 *  of them can still play. */
export interface StandingCheck {
  /** ESPN lists him first in at least one slot. */
  starter: boolean;
  /** He isn't first, but everyone ahead of him is down - so his snaps are
   *  the ones that just changed hands. */
  nextManUp: boolean;
  /** Somebody healthy is still ahead of him in every slot he holds. */
  covered: boolean;
  /** No slot data for his team at all. Unknown, never "covered". */
  unknown: boolean;
}

/**
 * THE RULE THAT DECIDES WHETHER AN UNFAMILIAR NAME IS WORTH ASKING ABOUT.
 *
 * Not "is he deep" - "does his absence change who plays". Measured against
 * the live feed: of 126 untracked premium-position players carrying a
 * designation, 121 had a healthy body still ahead of them. A backup WR3
 * tweaking a hamstring doesn't move a line, because the player taking that
 * snap is fine. Five did not, and those are the real ones.
 *
 * This supersedes the earlier "third-or-deeper with nobody behind him" test,
 * which asked about the wrong end of the depth chart: what matters is who's
 * in FRONT of him, and whether they can play.
 */
export function checkStanding(
  slots: DepthSlot[] | undefined,
  athleteId: string,
  isDown: (id: string) => boolean,
): StandingCheck {
  const base = { starter: false, nextManUp: false, covered: false, unknown: false };
  if (!slots || !slots.length) return { ...base, unknown: true };

  let held = false;
  for (const slot of slots) {
    const i = slot.ids.indexOf(athleteId);
    if (i === -1) continue;
    held = true;
    if (i === 0) return { ...base, starter: true };
    if (slot.ids.slice(0, i).every(isDown)) return { ...base, nextManUp: true };
  }
  // In no slot at all: practice squad, IR, or a chart ESPN hasn't refreshed.
  // Not the same as being covered, so it doesn't get filtered on that basis.
  return held ? { ...base, covered: true } : { ...base, unknown: true };
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
  slots?: DepthSlot[],
): number {
  if (slots) {
    // Overwritten rather than merged: a running order is only meaningful as
    // a whole, and a stale half of one is worse than none.
    snapshot.slots = snapshot.slots || {};
    snapshot.slots[fixAbbr(teamAbbr)] = slots;
  }
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

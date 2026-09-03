// House (official) public leagues - the catalog and the record builder.
//
// WHY THIS EXISTS
// A new user arriving with no friends on the site has nowhere to play: every
// league is either invite-code or approval-gated, so the Leagues tab is a
// dead end until they recruit someone. House leagues are site-run public
// pools, one series per format, that anyone can join instantly.
//
// These are REAL leagues with REAL members. Nothing here fabricates members,
// standings, picks or activity - a house league opens empty and fills with
// actual users, exactly like any other league. `memberCount` is derived from
// the members doc by house-leagues-maintain.mts and is never written by hand.
// If that ever changes, the standings the scoring engine produces stop
// describing anything true and league-picks/results-process start grading
// entrants that don't exist.
//
// DATA MODEL
// House leagues live in the same "blitz-leagues" store as user leagues and
// use the same league:/members:/invite: key shape, so every existing reader
// (leagues-search, league-join, league-picks, results-process, rescore)
// works on them unchanged. The differences are three fields:
//
//   ownerId: null      - nobody owns it, so the owner-only paths in
//                        league-delete / league-settings-update / the
//                        "owner can't leave" rule in league-leave all fail
//                        closed for everyone (they compare with !== / ===
//                        against an authenticated string id, which can never
//                        equal null). Members can leave freely.
//   official: true     - drives the badge in the UI and ordering in search.
//   houseSlug/houseSeq - identifies which catalog series and which instance,
//                        so the maintain job can find its own leagues again
//                        without guessing from names.
//
// IDs are deterministic (`house-{season}-{slug}-{seq}`) rather than UUIDs so
// the maintain job is idempotent: re-running it can never create a duplicate
// of an instance that already exists.

export const LEAGUE_STORE = "blitz-leagues";

/** Fraction of capacity at which the next instance in a series opens. */
export const ROLLOVER_AT = 0.8;

/** Hard ceiling on instances per series, so a bug can't open leagues forever. */
export const MAX_INSTANCES = 20;

export interface HouseSeries {
  slug: string;
  format: "straight_up" | "confidence" | "survivor" | "ats";
  /** Name of the first instance. Later instances get " #2", " #3", ... */
  baseName: string;
  description: string;
  maxMembers: number;
  /**
   * True for formats where entering mid-season is incoherent. Survivor is
   * the only one: every entrant must have made a pick in every week, so a
   * Week 6 joiner would be sitting on five unplayed weeks in a format where
   * one loss ends your season. Dan's call is season-long leagues with Week 1
   * entry only, so the maintain job locks these at the season opener and
   * opens no further instances after it.
   */
  closesAtSeasonOpener: boolean;
  scoringSettings: Record<string, unknown>;
}

/**
 * One series per format. Deliberately small: the rollover mechanism grows
 * the number of leagues with actual demand, so seeding a long list up front
 * would just produce a page of empty leagues - the exact impression of a
 * quiet site that house leagues exist to fix.
 */
export const HOUSE_SERIES: HouseSeries[] = [
  {
    slug: "confidence",
    format: "confidence",
    baseName: "Blitz Confidence Pool",
    description:
      "Official Blitz Odds pool. Rank every game 1 through 16 - your most confident pick is worth the most. Free, open to everyone, no invite needed.",
    maxMembers: 50,
    closesAtSeasonOpener: false,
    scoringSettings: {
      pointsPerCorrect: 1,
      tieHandling: "void",
      uniqueConfidence: true,
      atsEnabled: false,
    },
  },
  {
    slug: "pickem",
    format: "straight_up",
    baseName: "Blitz Pick'em Pool",
    description:
      "Official Blitz Odds pool. Pick a winner in every game, most correct wins. The simplest format - a good first league. Free and open to everyone.",
    maxMembers: 50,
    closesAtSeasonOpener: false,
    scoringSettings: {
      pointsPerCorrect: 1,
      tieHandling: "void",
      atsEnabled: false,
    },
  },
  {
    slug: "spread",
    format: "ats",
    baseName: "Blitz Spread Pool",
    description:
      "Official Blitz Odds pool. Pick every game against the spread, graded on the line at the moment you picked. Free and open to everyone.",
    maxMembers: 50,
    closesAtSeasonOpener: false,
    scoringSettings: {
      pointsPerCorrect: 1,
      tieHandling: "void",
      atsEnabled: true,
    },
  },
  {
    slug: "survivor",
    format: "survivor",
    baseName: "Blitz Survivor",
    description:
      "Official Blitz Odds pool. One team a week, each team only once all season, two strikes and you're out. Entry closes when the season opener kicks off.",
    maxMembers: 200,
    closesAtSeasonOpener: true,
    scoringSettings: {
      pointsPerCorrect: 1,
      tieHandling: "void",
      survivorTieHandling: "eliminate",
      survivorShowEliminated: true,
      // Two strikes rather than classic one-and-done. A house survivor pool
      // is most people's first survivor league, and a Week 1 upset ending
      // someone's entire season is a bad first experience of the site. This
      // freezes at the opener like any other league's strikes setting.
      survivorStrikes: 2,
    },
  },
];

export function houseLeagueId(season: number, slug: string, seq: number): string {
  return `house-${season}-${slug}-${seq}`;
}

export function houseLeagueName(series: HouseSeries, seq: number): string {
  return seq === 1 ? series.baseName : `${series.baseName} #${seq}`;
}

/**
 * Builds a house league record. `memberCount` starts at 0 and is only ever
 * recomputed from the members doc afterwards - see the note at the top.
 */
export function buildHouseLeague(series: HouseSeries, season: number, seq: number) {
  const now = new Date().toISOString();
  return {
    id: houseLeagueId(season, series.slug, seq),
    name: houseLeagueName(series, seq),
    description: series.description,
    // No owner: house leagues are site-run. Every owner-gated path compares
    // an authenticated string id against this, so null fails closed.
    ownerId: null,
    ownerName: "Blitz Odds",
    official: true,
    houseSlug: series.slug,
    houseSeq: seq,
    season,
    // No invite code. Public leagues are joined by id via league-join.mts,
    // and minting a code for a league nobody needs one for would just be an
    // extra secret to leak.
    inviteCode: null,
    memberCount: 0,
    format: series.format,
    visibility: "public",
    maxMembers: series.maxMembers,
    pickDeadline: "per_game",
    tieBreaker: null,
    scoringSettings: series.scoringSettings,
    locked: false,
    createdAt: now,
    updatedAt: now,
  };
}

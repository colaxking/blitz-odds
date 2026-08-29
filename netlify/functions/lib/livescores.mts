// Server-side view of what's happening on the field right now.
//
// The app has polled ESPN's scoreboard from the browser since long before
// any of this, but only while someone has a tab open - which is no use for
// a notification. This is the same endpoint, read from the server on a
// short tick so an alert can fire whether or not anyone is looking.

/** ESPN's scoreboard 403s requests from server IPs without a curl-ish
 *  User-Agent. Found the hard way; results-process-trigger.mjs carries the
 *  same header for the same reason. */
export const ESPN_FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "curl/8.4.0",
  Accept: "application/json",
};

/** ESPN's abbreviations differ from ours in two places. */
const ESPN_ABBR_FIX: Record<string, string> = { WSH: "WAS", LA: "LAR" };
export function fixAbbr(a: string): string {
  const up = String(a || "").toUpperCase();
  return ESPN_ABBR_FIX[up] || up;
}

export interface LiveGame {
  /** ESPN's event id, needed to ask for this game's scoring plays. */
  eventId: string | null;
  away: string;
  home: string;
  awayScore: number;
  homeScore: number;
  /** ESPN's own game state: "pre" (not started), "in" (live), "post" (final). */
  state: "pre" | "in" | "post";
  period: number;
  displayClock: string;
  /** Only present while live, and dropped during dead-ball moments. */
  lastPlayId: string | null;
  lastPlayText: string | null;
}

/** ESPN's public scoreboard uses its own season-type/week numbering.
 *  Mirrors getEspnParams in index.html for the regular season. Preseason and
 *  playoff weeks can't be derived from our week number alone - the mapping
 *  lives in the schedule data (espnSeasonType / espnWeek per round), so
 *  callers with a resolved PhaseWeek should pass espnParamsFor(w) instead of
 *  relying on this. */
export function espnParamsForWeek(week: number): { seasontype: number; week: number } | null {
  if (week >= 1 && week <= 18) return { seasontype: 2, week };
  return null;
}

/**
 * @param params - explicit ESPN scoreboard params. Omit for a regular-season
 *   week and they're derived; required for preseason/playoff weeks, which
 *   have no derivable mapping.
 */
export async function fetchLiveWeek(
  season: number,
  week: number,
  params?: { seasontype: number; week: number } | null
): Promise<LiveGame[]> {
  const resolved = params || espnParamsForWeek(week);
  if (!resolved) return [];
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${season}&seasontype=${resolved.seasontype}&week=${resolved.week}`;

  const res = await fetch(url, { headers: ESPN_FETCH_HEADERS });
  if (!res.ok) throw new Error(`ESPN scoreboard failed (week ${week}): ${res.status}`);
  const data: any = await res.json();

  const out: LiveGame[] = [];
  for (const event of data.events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const home = comp.competitors?.find((c: any) => c.homeAway === "home");
    const away = comp.competitors?.find((c: any) => c.homeAway === "away");
    if (!home || !away) continue;

    const state = comp.status?.type?.state;
    if (state !== "pre" && state !== "in" && state !== "post") continue;

    out.push({
      eventId: event.id ? String(event.id) : null,
      away: fixAbbr(away.team?.abbreviation),
      home: fixAbbr(home.team?.abbreviation),
      awayScore: Number(away.score) || 0,
      homeScore: Number(home.score) || 0,
      state,
      period: Number(comp.status?.period) || 0,
      displayClock: String(comp.status?.displayClock || ""),
      lastPlayId: comp.situation?.lastPlay?.id ? String(comp.situation.lastPlay.id) : null,
      lastPlayText: comp.situation?.lastPlay?.text ? String(comp.situation.lastPlay.text) : null,
    });
  }
  return out;
}

/** Who's ahead, or null for a tie (including 0-0). */
export function leaderOf(g: { away: string; home: string; awayScore: number; homeScore: number }): string | null {
  if (g.awayScore === g.homeScore) return null;
  return g.awayScore > g.homeScore ? g.away : g.home;
}

/** "Q3 6:22", or the plain state for anything that isn't a live quarter.
 *  Overtime is labelled OT/OT2 rather than counting on past Q4 - the same
 *  choice the box score modal already makes. */
export function clockLabel(g: LiveGame): string {
  if (g.state === "pre") return "Not started";
  if (g.state === "post") return "Final";
  if (g.period > 4) return `OT${g.period > 5 ? g.period - 4 : ""} ${g.displayClock}`.trim();
  return `Q${g.period} ${g.displayClock}`.trim();
}

/* ------------------------------------------------------------------------ */
/* Scoring plays                                                             */
/* ------------------------------------------------------------------------ */

export interface ScoringPlay {
  id: string;
  /** ESPN's own classification, e.g. "Rushing Touchdown", "Field Goal Good". */
  type: string;
  team: string | null;
  text: string;
  period: number;
  clock: string;
  awayScore: number;
  homeScore: number;
}

/**
 * Every scoring play in a game, oldest first.
 *
 * WHY THIS RATHER THAN THE SCOREBOARD. The scoreboard feed carries only
 * `situation.lastPlay`, which is whatever happened most recently - and the
 * poller runs every 90 seconds, so by the time a score is noticed that is
 * usually the ensuing kickoff. It also can't distinguish a rushing touchdown
 * from a passing one, and it collapses two scores in one tick into a single
 * unexplained points jump. This list is exact, ordered, and carries a stable
 * id per play, which is what lets the dispatcher keep a cursor and know
 * precisely which plays it hasn't told anyone about yet.
 *
 * Called only when a score has actually changed - roughly ten times per game,
 * not once per tick per game.
 */
export async function fetchScoringPlays(eventId: string): Promise<ScoringPlay[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { headers: ESPN_FETCH_HEADERS });
  if (!res.ok) throw new Error(`ESPN summary failed (event ${eventId}): ${res.status}`);
  const data: any = await res.json();

  const out: ScoringPlay[] = [];
  for (const play of data.scoringPlays || []) {
    if (!play?.id) continue;
    out.push({
      id: String(play.id),
      type: String(play.type?.text || "").trim(),
      team: play.team?.abbreviation ? fixAbbr(play.team.abbreviation) : null,
      text: String(play.text || "").trim(),
      period: Number(play.period?.number) || 0,
      clock: String(play.clock?.displayValue || "").trim(),
      awayScore: Number(play.awayScore) || 0,
      homeScore: Number(play.homeScore) || 0,
    });
  }
  return out;
}

/** "Q1 3:28" for the moment a play happened, which is not necessarily the
 *  clock now - a play we're catching up on is minutes old. */
export function playClockLabel(play: ScoringPlay): string {
  if (!play.period) return "";
  const label = play.period > 4 ? `OT${play.period > 5 ? play.period - 4 : ""}` : `Q${play.period}`;
  return `${label} ${play.clock}`.trim();
}

/* ------------------------------------------------------------------------ */
/* Scoring play copy (fallback)                                              */
/* ------------------------------------------------------------------------ */

/** How many points each kind of scoring play is worth, most specific first.
 *  A 6 and an 8 are both touchdowns - the difference is only whether the try
 *  had landed yet when the tick caught it. */
const POINT_LABELS: Record<number, string> = {
  8: "Touchdown + two",
  7: "Touchdown",
  6: "Touchdown",
  3: "Field goal",
  2: "2 points",
  1: "Extra point",
};

/** Words that mean ESPN's last play IS the play that scored. Checked because
 *  the poll runs every 90 seconds and the drive doesn't stop for it: by the
 *  time a score is noticed, `lastPlay` is often already the ensuing kickoff
 *  or the first snap of the next drive. Attaching that text to a scoring
 *  alert would describe the wrong play with total confidence, which is worse
 *  than describing no play at all. */
const SCORING_PLAY_WORDS = /\b(touchdown|field goal|safety|extra point|two-point|2-point|PAT)\b/i;

export interface ScoreDelta {
  /** Team abbreviation that put the points up, or null if it can't be told. */
  team: string | null;
  points: number;
  /** "Touchdown", "Field goal" - derived from the score itself, so it's as
   *  trustworthy as the scoreline in the title. */
  kind: string | null;
  /** ESPN's description of the play, only when it's confidently the scoring
   *  one. */
  detail: string | null;
}

/**
 * What just happened, for a scoring alert.
 *
 * The score and the clock alone say a score changed but not what to picture -
 * "DEN 10, MIN 3 / Q2 8:41" makes a reader open the app to find out whether
 * that was a touchdown or a field goal, which is the one thing the alert
 * existed to save them. The points delta answers it without depending on
 * ESPN's play feed, and the play text enriches it when it can be trusted.
 */
export function scoreDelta(
  prev: { awayScore: number; homeScore: number },
  live: LiveGame
): ScoreDelta {
  const awayGain = live.awayScore - prev.awayScore;
  const homeGain = live.homeScore - prev.homeScore;

  // Both sides scoring inside one 90-second tick is rare but real (a pick-six
  // answered immediately, or a tick that straddles a possession change).
  // Credit the bigger swing rather than inventing a combined event.
  const bothScored = awayGain > 0 && homeGain > 0;
  const team = bothScored
    ? (awayGain >= homeGain ? live.away : live.home)
    : awayGain > 0 ? live.away : homeGain > 0 ? live.home : null;
  const points = Math.max(awayGain, homeGain, 0);

  const text = live.lastPlayText || "";
  const detail = text && SCORING_PLAY_WORDS.test(text) ? tidyPlayText(text) : null;

  return { team, points, kind: POINT_LABELS[points] || null, detail };
}

/** ESPN's play text runs long and often repeats the score we're already
 *  showing in the title. Trimmed at a word boundary so a notification body
 *  doesn't get cut mid-name by the OS instead. */
function tidyPlayText(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim().replace(/\s*\(\d+-\d+\)\s*$/, "");
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return (boundary > 40 ? cut.slice(0, boundary) : cut).replace(/[.,;:]$/, "") + "\u2026";
}

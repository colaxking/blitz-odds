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

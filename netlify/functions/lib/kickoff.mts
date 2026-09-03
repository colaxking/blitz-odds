// Turns the schedule data's display-only date/time strings into an actual
// UTC Date the pick functions can compare `Date.now()` against.
//
// Why this exists: data/schedule-full-2026.json (and the "schedule" key in
// the blitz-site-data blob store) stores games as
//   { date: "Sun, Sep 13", time: "1:00 PM ET", ... }
// which is fine for display but has no year and no real timezone - not
// usable for a server-side deadline check. This is the one place that
// logic lives; every pick'em function should import it rather than
// re-deriving kickoff time.
//
// Per-game deadline (not whole-week): each game locks at its own kickoff,
// per the league-settings default.

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Resolves the actual UTC offset (in minutes, negative = behind UTC) that
 * America/New_York is observing on a given UTC instant, by asking Intl what
 * the wall-clock time in that zone is and diffing against the UTC instant
 * itself. Avoids hand-maintaining DST transition dates.
 */
function nyOffsetMinutesAt(utcGuess: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(utcGuess).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asIfUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asIfUTC - utcGuess.getTime()) / 60000;
}

/**
 * @param seasonYear - the NFL season's starting year, e.g. 2026 for the
 *   2026-27 season. Games in Jan/Feb belong to the following calendar year.
 * @param dateStr - e.g. "Sun, Sep 13" (weekday prefix is ignored)
 * @param timeStr - e.g. "1:00 PM ET" (always Eastern in this app's data)
 * @returns UTC Date for kickoff, or null if either string is unparseable
 *   (e.g. a flexed/TBD week 16-18 game with a placeholder time).
 */
export function parseKickoffUTC(seasonYear: number, dateStr: string, timeStr: string): Date | null {
  if (!dateStr || !timeStr) return null;

  const dateMatch = dateStr.match(/([A-Za-z]{3})\s+(\d{1,2})/);
  if (!dateMatch) return null;
  const month = MONTHS[dateMatch[1]];
  const day = Number(dateMatch[2]);
  if (month === undefined || !day) return null;

  const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!timeMatch) return null;
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  // Jan/Feb games belong to the following calendar year (playoffs/Super Bowl).
  const calendarYear = month <= 1 ? seasonYear + 1 : seasonYear;

  // First pass: treat the wall-clock time as if it were UTC to get a
  // same-day instant, then look up the real NY offset for that instant and
  // correct. One pass is sufficient here since game times never fall near
  // the 2am DST transition boundary.
  const guess = new Date(Date.UTC(calendarYear, month, day, hour, minute));
  const offsetMin = nyOffsetMinutesAt(guess);
  return new Date(Date.UTC(calendarYear, month, day, hour, minute) - offsetMin * 60000);
}

/** True once `now` is at or past the game's kickoff (or kickoff is unparseable - fail locked, not open). */
export function isPastKickoff(seasonYear: number, dateStr: string, timeStr: string, now: Date = new Date()): boolean {
  const kickoff = parseKickoffUTC(seasonYear, dateStr, timeStr);
  if (!kickoff) return true;
  return now.getTime() >= kickoff.getTime();
}

/**
 * True once the season's very first game has kicked off. Two callers rely on
 * this and they must agree, which is why it lives here rather than in either
 * of them: league-settings-update.mts freezes a survivor league's
 * survivorStrikes at this instant, and house-leagues-maintain.mts closes
 * entry to the house survivor pool at it. If those two used separate copies
 * and one drifted, a league could take a new entrant after its elimination
 * rules had already frozen.
 *
 * Deliberately season-wide rather than per-league: a league created in
 * week 6 is joining a season already in progress, so its strike rule is
 * fixed at creation the same way a week 1 league's is fixed at kickoff.
 * A missing or unreadable schedule returns false (fail open) - the
 * alternative would lock every league out of a setting because of a blob
 * read failure.
 *
 * @param schedule - the raw schedule doc ({ weeks: [{ week, games: [...] }] })
 * @param season - season starting year, e.g. 2026
 */
export function seasonHasStarted(schedule: any, season: number, now: Date = new Date()): boolean {
  const weeks: any[] = schedule?.weeks || [];
  if (!weeks.length) return false;
  let earliest: any = null;
  for (const w of weeks) {
    for (const g of w?.games || []) {
      if (!g?.date || !g?.time) continue;
      if (!earliest || (w.week ?? Infinity) < (earliest.week ?? Infinity)) {
        earliest = { week: w.week, game: g };
      }
      break; // games within a week are already in kickoff order
    }
  }
  if (!earliest) return false;
  return isPastKickoff(season, earliest.game.date, earliest.game.time, now);
}

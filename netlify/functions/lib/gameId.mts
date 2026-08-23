// The schedule data (data/schedule-full-2026.json / the "schedule" blob key)
// has no stable per-game ID - just { away, home, date, time, network } under
// each week. League picks need one ID per game that never changes, so this
// is the single place that ID gets derived. The frontend's js/gameId.js
// mirrors this exact format for rendering - keep the two in sync if this
// ever changes.
//
// Format: {season}-w{week}-{away}-{home}
// e.g. "2026-w3-LAC-KC" for the Week 3 Chargers @ Chiefs game.

export function makeGameId(season: number, week: number, away: string, home: string): string {
  return `${season}-w${week}-${away}-${home}`;
}

export interface ScheduleGame {
  away: string;
  home: string;
  date: string;
  time: string;
  network?: string;
  [key: string]: unknown;
}

/** Looks up a single game by its derived ID within a week's game list. */
export function findGameById(games: ScheduleGame[], season: number, week: number, gameId: string): ScheduleGame | null {
  return games.find((g) => makeGameId(season, week, g.away, g.home) === gameId) || null;
}

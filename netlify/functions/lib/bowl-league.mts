import type { BowlGame, BowlSlate } from "./bowls.mts";
import { isLocked } from "./bowls.mts";

// Bowl pool scoring, standings and the pick grid. Pure functions over the
// slate and the members' pick docs - no storage here, so the same code backs
// the league endpoint and can be exercised offline.
//
// A bowl league is a normal league record with sport: "bowls". Its picks
// live in ONE doc per member (bowlpicks:{leagueId}:{userId}), not one key
// per game like the NFL leagues. That's deliberate: the bowl sheet is saved
// as a whole with an explicit Save button (one writer per member, the button
// disabled while in flight), so the read-modify-write race that forced the
// NFL picks onto per-game keys doesn't arise. One doc also makes a ~45-game
// confidence sheet a single read instead of 45.
//
// Standings are computed on every read rather than stored. A pool is at most
// a few hundred members by ~48 games, and computing it live means a result
// correction from ESPN, or a late-added bowl, is reflected immediately with
// no rescore job to run.

export const BOWL_FORMATS = new Set(["straight_up", "confidence", "ats"]);

export interface BowlPick {
  teamId: string | null;   // null = not picked yet (confidence can still be ranked)
  confidence?: number;
  spread?: number;         // ATS: points added to the picked team's score, snapshotted at pick time
  updatedAt: string;
}

export interface BowlPicksDoc {
  picks: Record<string, BowlPick>;
  tiebreaker: number | null;
  updatedAt: string | null;
}

export function emptyPicksDoc(): BowlPicksDoc {
  return { picks: {}, tiebreaker: null, updatedAt: null };
}

export function bowlSettingsOf(league: any) {
  const s = league?.bowlSettings || {};
  return {
    includePlayoff: s.includePlayoff !== false,
    tiebreaker: s.tiebreaker !== false,
  };
}

/** The games this league plays: the whole slate, or the slate minus the
 *  Playoff when the commissioner turned it off. */
export function leagueGames(slate: BowlSlate, league: any): BowlGame[] {
  const { includePlayoff } = bowlSettingsOf(league);
  return slate.games.filter((g) => includePlayoff || !g.cfp);
}

/** The title game - the tiebreaker target, whether or not the league picks
 *  the Playoff. */
export function titleGame(slate: BowlSlate): BowlGame | null {
  return slate.games.find((g) => g.round === "final") || null;
}

export type Outcome = "W" | "L" | "P" | null;

/** Grade one pick against one game. null = not gradable yet (not final, no
 *  pick, or no winner recorded). */
export function gradePick(format: string, g: BowlGame, pick: BowlPick | undefined): Outcome {
  if (!pick || !pick.teamId || g.state !== "post" || !g.completed) return null;
  if (!g.home || !g.away || g.homeScore === null || g.awayScore === null) return null;
  const pickedHome = pick.teamId === g.home.id;
  const pickedAway = pick.teamId === g.away.id;
  if (!pickedHome && !pickedAway) return null;
  if (format === "ats") {
    if (typeof pick.spread !== "number") return null;
    const mine = pickedHome ? g.homeScore : g.awayScore;
    const theirs = pickedHome ? g.awayScore : g.homeScore;
    const m = mine + pick.spread - theirs;
    return m > 0 ? "W" : m < 0 ? "L" : "P";
  }
  if (!g.winnerId) return null;
  return pick.teamId === g.winnerId ? "W" : "L";
}

export function pointsFor(format: string, league: any, pick: BowlPick | undefined, outcome: Outcome): number {
  if (outcome !== "W" || !pick) return 0;
  if (format === "confidence") return typeof pick.confidence === "number" ? pick.confidence : 0;
  return Number(league?.scoringSettings?.pointsPerCorrect) > 0 ? Number(league.scoringSettings.pointsPerCorrect) : 1;
}

/** What a still-open pick could add if it wins. */
function potentialFor(format: string, league: any, pick: BowlPick | undefined): number {
  if (!pick) return 0;
  if (format === "confidence") return typeof pick.confidence === "number" ? pick.confidence : 0;
  return Number(league?.scoringSettings?.pointsPerCorrect) > 0 ? Number(league.scoringSettings.pointsPerCorrect) : 1;
}

export interface StandingsRow {
  userId: string;
  displayName: string;
  avatar: string | null;
  rank: number;
  points: number;
  max: number;
  correct: number;
  incorrect: number;
  pushes: number;
  picked: number;
  tiebreaker: number | null;  // only revealed once the title game has locked (always for the viewer)
  tiebreakerDiff: number | null;
}

export function computeStandings(
  league: any,
  games: BowlGame[],
  title: BowlGame | null,
  members: Array<{ userId: string; displayName: string; avatar?: string | null }>,
  docs: Record<string, BowlPicksDoc>,
  viewerId: string,
  now: number = Date.now()
): StandingsRow[] {
  const format = league.format;
  const titleTotal = title && title.state === "post" && title.homeScore !== null && title.awayScore !== null
    ? title.homeScore + title.awayScore : null;
  const titleLocked = title ? isLocked(title, now) : false;
  const useTb = bowlSettingsOf(league).tiebreaker;

  const rows: StandingsRow[] = members.map((m) => {
    const doc = docs[m.userId] || emptyPicksDoc();
    let points = 0, max = 0, correct = 0, incorrect = 0, pushes = 0, picked = 0;
    for (const g of games) {
      const p = doc.picks[g.id];
      if (p && p.teamId) picked++;
      const o = gradePick(format, g, p);
      if (o === "W") { correct++; const pts = pointsFor(format, league, p, o); points += pts; max += pts; }
      else if (o === "L") incorrect++;
      else if (o === "P") pushes++;
      else if (g.state !== "post" && p) {
        // Not decided yet. A locked game with no team picked can't score.
        if (p.teamId || !isLocked(g, now)) max += potentialFor(format, league, p);
      }
    }
    const tb = useTb && typeof doc.tiebreaker === "number" ? doc.tiebreaker : null;
    const reveal = m.userId === viewerId || titleLocked;
    return {
      userId: m.userId,
      displayName: m.displayName || "Player",
      avatar: m.avatar || null,
      rank: 0,
      points, max, correct, incorrect, pushes, picked,
      tiebreaker: reveal ? tb : null,
      tiebreakerDiff: titleTotal !== null && tb !== null ? Math.abs(tb - titleTotal) : null,
    };
  });

  const cmp = (a: StandingsRow, b: StandingsRow) => {
    if (b.points !== a.points) return b.points - a.points;
    if (titleTotal !== null && useTb) {
      const ad = a.tiebreakerDiff ?? Infinity, bd = b.tiebreakerDiff ?? Infinity;
      if (ad !== bd) return ad - bd;
    }
    if (b.correct !== a.correct) return b.correct - a.correct;
    return 0;
  };
  rows.sort((a, b) => cmp(a, b) || a.displayName.localeCompare(b.displayName));
  rows.forEach((r, i) => {
    r.rank = i > 0 && cmp(rows[i - 1], r) === 0 ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

export interface GridCell {
  hidden?: boolean;     // someone else's pick on a game that hasn't locked
  picked?: boolean;     // with hidden: whether they've made one (shows a dot, not the team)
  teamId?: string | null;
  confidence?: number;
  spread?: number;
  outcome?: Outcome;
}

/** Everyone's picks, game by game. Another member's pick stays hidden until
 *  that game locks - the server never sends it, so it can't be read out of
 *  the network tab either. The viewer always sees their own. */
export function buildGrid(
  league: any,
  games: BowlGame[],
  members: Array<{ userId: string }>,
  docs: Record<string, BowlPicksDoc>,
  viewerId: string,
  now: number = Date.now()
): Record<string, Record<string, GridCell>> {
  const out: Record<string, Record<string, GridCell>> = {};
  for (const m of members) {
    const doc = docs[m.userId] || emptyPicksDoc();
    const row: Record<string, GridCell> = {};
    for (const g of games) {
      const p = doc.picks[g.id];
      const visible = m.userId === viewerId || isLocked(g, now);
      if (!visible) {
        row[g.id] = { hidden: true, picked: !!(p && p.teamId) };
        continue;
      }
      if (!p) { row[g.id] = { teamId: null }; continue; }
      row[g.id] = {
        teamId: p.teamId,
        ...(typeof p.confidence === "number" ? { confidence: p.confidence } : {}),
        ...(typeof p.spread === "number" ? { spread: p.spread } : {}),
        outcome: gradePick(league.format, g, p),
      };
    }
    out[m.userId] = row;
  }
  return out;
}

/** ATS line for a pick: points added to the picked team's score. */
export function atsSpreadFor(g: BowlGame, teamId: string): number | null {
  if (!g.odds) return null;
  if (!g.odds.favoriteId) return 0;
  return g.odds.favoriteId === teamId ? -g.odds.spread : g.odds.spread;
}

export interface MergeResult {
  doc: BowlPicksDoc;
  errors: string[];
}

/**
 * Applies a submitted sheet to the stored one. The submitted sheet is the
 * member's complete intent for every game that is still open; locked games
 * are carried over from the stored doc untouched no matter what was sent.
 */
export function mergeSheet(
  league: any,
  games: BowlGame[],
  title: BowlGame | null,
  stored: BowlPicksDoc,
  incoming: { picks?: Record<string, any>; tiebreaker?: any },
  now: number = Date.now()
): MergeResult {
  const format = league.format;
  const errors: string[] = [];
  const nowIso = new Date(now).toISOString();
  const next: BowlPicksDoc = { picks: {}, tiebreaker: stored.tiebreaker ?? null, updatedAt: nowIso };
  const inPicks = incoming.picks && typeof incoming.picks === "object" ? incoming.picks : {};
  const gameIds = new Set(games.map((g) => g.id));
  const maxConf = games.length;

  for (const g of games) {
    const old = stored.picks[g.id];
    if (isLocked(g, now)) {
      if (old) next.picks[g.id] = old;
      continue;
    }
    const raw = inPicks[g.id];
    if (!raw || typeof raw !== "object") continue; // cleared
    let teamId: string | null = typeof raw.teamId === "string" && raw.teamId ? raw.teamId : null;
    if (teamId) {
      const valid = (g.home && g.home.id === teamId) || (g.away && g.away.id === teamId);
      if (!valid) { errors.push(`${g.bowl}: that team isn't playing in this game`); teamId = null; }
    }
    const pick: BowlPick = { teamId, updatedAt: old && old.teamId === teamId && old.confidence === raw.confidence ? old.updatedAt : nowIso };
    if (format === "confidence") {
      const c = Number(raw.confidence);
      if (Number.isInteger(c) && c >= 1 && c <= maxConf) pick.confidence = c;
      else if (raw.confidence !== undefined && raw.confidence !== null) errors.push(`${g.bowl}: points must be between 1 and ${maxConf}`);
    }
    if (format === "ats" && teamId) {
      if (old && old.teamId === teamId && typeof old.spread === "number") pick.spread = old.spread;
      else {
        const s = atsSpreadFor(g, teamId);
        if (s === null) { errors.push(`${g.bowl}: no line posted yet`); continue; }
        pick.spread = s;
      }
    }
    if (!pick.teamId && pick.confidence === undefined) continue;
    next.picks[g.id] = pick;
  }

  // Picks on games that have left the league's slate (a cancelled bowl, the
  // Playoff switched off) are kept as-is so they reappear if the game does.
  for (const [gid, p] of Object.entries(stored.picks)) {
    if (!gameIds.has(gid)) next.picks[gid] = p;
  }

  if (format === "confidence" && league?.scoringSettings?.uniqueConfidence !== false) {
    const seen = new Map<number, string>();
    for (const g of games) {
      const p = next.picks[g.id];
      if (!p || typeof p.confidence !== "number") continue;
      if (seen.has(p.confidence)) {
        errors.push(`${p.confidence} points is used twice (${seen.get(p.confidence)} and ${g.bowl})`);
      } else seen.set(p.confidence, g.bowl);
    }
  }

  if (incoming.tiebreaker !== undefined && bowlSettingsOf(league).tiebreaker) {
    const titleLocked = title ? isLocked(title, now) : false;
    if (!titleLocked) {
      if (incoming.tiebreaker === null || incoming.tiebreaker === "") next.tiebreaker = null;
      else {
        const t = Number(incoming.tiebreaker);
        if (Number.isInteger(t) && t >= 0 && t <= 200) next.tiebreaker = t;
        else errors.push("Tiebreaker must be a whole number of points");
      }
    }
  }

  return { doc: next, errors };
}

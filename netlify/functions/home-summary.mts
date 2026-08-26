import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { makeGameId } from "./lib/gameId.mts";
import ScoringEngine from "../../js/scoringEngine.js";

// GET /.netlify/functions/home-summary?week={n}
//   -> { ok, week, leagues: [...], totals: {...}, followRate: null }
//
// Everything the Home tab's signed-in dashboard needs, in one authenticated
// call. Built as a single endpoint rather than letting the client fan out
// because the per-league alternative is leagues-mine + one standings-get +
// one picks-mine each: for six leagues that's thirteen requests, every one
// of which pays its own Identity round trip.
//
// What it does NOT return, deliberately:
//   - followRate. Comparing a member's pick to the model's requires the
//     model's pick, which only exists client-side (PredictionEngine in
//     index.html). Returned as null so the tile can render a dash rather
//     than a fabricated number; see the phase-5 note in the plan - the fix
//     is to snapshot predictions at lock time, not to port the engine.
//   - activity. There's no event log anywhere in the app to read one from.
//
// Reads are strong-consistency throughout: this is the screen someone lands
// on immediately after submitting a pick or joining a league, so an eventual
// read would show up directly as "I just did that and it isn't here."

const LEAGUE_STORE = "blitz-leagues";
const USER_STORE = "blitz-users";
const SITE_DATA_STORE = "blitz-site-data";

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const LEADERBOARD_SIZE = 5;

interface WeekScore { points: number; correct: number; incorrect: number }

/**
 * Consecutive most-recent weeks with a winning record, and the longest such
 * run all season.
 *
 * "Streak" has no single obvious meaning in a pick'em pool - there's no
 * head-to-head to win or lose. The two candidates were consecutive correct
 * picks (game level) and consecutive winning weeks. Game level isn't
 * derivable here: standings:{id}.weeks stores per-week aggregates, not the
 * per-game sequence, so counting a run of correct picks would need every
 * pick and every result re-read and re-ordered. Winning weeks is derivable
 * from what's already stored, and it's the unit a pool actually talks in.
 *
 * A week with no entry (didn't play, joined later, not yet scored) ends the
 * current run rather than being skipped over - claiming an unbroken streak
 * across a week someone sat out would overstate it.
 */
function computeWeekStreak(weeks: Record<string, Record<string, WeekScore>>, userId: string) {
  const weekNums = Object.keys(weeks)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  let current = 0;
  let best = 0;
  let run = 0;
  for (const w of weekNums) {
    const row = weeks[String(w)]?.[userId];
    const won = !!row && row.correct > row.incorrect;
    if (won) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  // `run` after the loop is the streak that is still alive at the most
  // recent scored week, which is what "current" means.
  current = run;
  return { current, best };
}

/**
 * The caller's rank as of the end of the previous week, so the dashboard can
 * show a movement arrow. Recomputed by summing every week strictly before
 * `week` and re-ranking, rather than stored - results-process already
 * recomputes season totals from scratch on every run for idempotency, so
 * deriving the prior state the same way keeps the two in agreement instead
 * of introducing a second, separately-maintained record of it.
 */
function rankAsOfPreviousWeek(
  weeks: Record<string, Record<string, WeekScore>>,
  week: number,
  tieBreaker: string,
  userId: string
): number | null {
  const priorWeeks = Object.keys(weeks)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n < week);
  if (!priorWeeks.length) return null;

  const totals: Record<string, WeekScore> = {};
  for (const w of priorWeeks) {
    const wkScores = weeks[String(w)] || {};
    for (const uid of Object.keys(wkScores)) {
      const t = totals[uid] || (totals[uid] = { points: 0, correct: 0, incorrect: 0 });
      t.points += wkScores[uid].points;
      t.correct += wkScores[uid].correct;
      t.incorrect += wkScores[uid].incorrect;
    }
  }
  if (!totals[userId]) return null;
  const ranked = ScoringEngine.rankStandings(totals, tieBreaker);
  const row = ranked.find((r: any) => r.userId === userId);
  return row ? row.rank : null;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week");
  const week = weekParam == null ? null : Number(weekParam);
  if (weekParam != null && !Number.isFinite(week)) {
    return jsonResponse(400, { ok: false, error: "week must be a number" }, CORS_HEADERS);
  }

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId: string = claims.id;

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const userStore = getStore(USER_STORE, { consistency: "strong" });
  const siteDataStore = getStore(SITE_DATA_STORE, { consistency: "strong" });

  try {
    const profile: any = await userStore.get(`users:${userId}`, { type: "json" });
    const leagueIds: string[] = profile && Array.isArray(profile.leagues) ? profile.leagues : [];

    // The week's schedule, fetched once and shared across every league -
    // the pick keys below are derived from it (see picks-mine.mts for why
    // list() isn't a safe way to enumerate freshly-written pick keys).
    let weekGames: Array<{ away: string; home: string }> = [];
    let seasonYear: number | null = null;
    if (week != null) {
      const schedule: any = await siteDataStore.get("schedule", { type: "json" });
      seasonYear = schedule?.season ?? null;
      weekGames = schedule?.weeks?.find((w: any) => w.week === week)?.games || [];
    }

    const leagues = (
      await Promise.all(
        leagueIds.map(async (leagueId) => {
          const [league, membersDoc, standingsRaw, survivorRaw] = await Promise.all([
            leagueStore.get(`league:${leagueId}`, { type: "json" }) as Promise<any>,
            leagueStore.get(`members:${leagueId}`, { type: "json" }) as Promise<any>,
            leagueStore.get(`standings:${leagueId}`, { type: "json" }) as Promise<any>,
            leagueStore.get(`survivor:${leagueId}`, { type: "json" }) as Promise<any>,
          ]);
          // A league the user has since left, or that was deleted, is
          // skipped rather than erroring the whole dashboard - same
          // tolerance leagues-mine.mts already applies.
          if (!league) return null;
          const members: any[] = membersDoc?.members || [];
          if (!members.some((m) => m.userId === userId)) return null;

          const standings: any = standingsRaw || { weeks: {}, season: [] };
          const season: any[] = standings.season || [];
          const mine = season.find((r: any) => r.userId === userId) || null;

          // Names and avatars come from each member's live profile, with
          // the members-doc snapshot as the fallback - the same precedence
          // standings-get.mts uses, and for the same reason: the snapshot
          // is only best-effort synced by user-profile.mts's fan-out.
          const top = season.slice(0, LEADERBOARD_SIZE);
          const needProfiles = new Set<string>(top.map((r: any) => r.userId));
          if (mine) needProfiles.add(userId);
          const profiles: Record<string, { displayName: string; avatar: string | null }> = {};
          await Promise.all(
            Array.from(needProfiles).map(async (uid) => {
              const snap = members.find((m) => m.userId === uid);
              let displayName = snap?.displayName || "Player";
              let avatar = snap?.avatar ?? null;
              try {
                const p: any = await userStore.get(`users:${uid}`, { type: "json" });
                if (p) {
                  if (typeof p.displayName === "string" && p.displayName.trim()) displayName = p.displayName;
                  if (typeof p.avatar === "string" || p.avatar === null) avatar = p.avatar;
                }
              } catch {
                // Best-effort; the members-doc snapshot already applied.
              }
              profiles[uid] = { displayName, avatar };
            })
          );

          const survivorState: any = survivorRaw || {};
          const myS = survivorState[userId] || { alive: true, usedTeams: [], eliminatedWeek: null };
          const scoredWeeks = Object.keys(standings.weeks || {}).map(Number).filter(Number.isFinite);

          // How much of this week the caller has actually picked. One
          // direct get per game per league - more requests than a single
          // list(), but every one is an exact known key, which is the only
          // read path proven to see a write immediately.
          let weekProgress: { picked: number; total: number } | null = null;
          if (week != null && weekGames.length && seasonYear != null) {
            const picks = await Promise.all(
              weekGames.map((g) =>
                leagueStore
                  .get(`picks:${leagueId}:${week}:${userId}:${makeGameId(seasonYear as number, week, g.away, g.home)}`, { type: "json" })
                  .catch(() => null)
              )
            );
            weekProgress = { picked: picks.filter(Boolean).length, total: weekGames.length };
          }

          const streak = computeWeekStreak(standings.weeks || {}, userId);
          const priorRank = week != null ? rankAsOfPreviousWeek(standings.weeks || {}, week, league.tieBreaker, userId) : null;

          return {
            leagueId,
            name: league.name,
            format: league.format,
            visibility: league.visibility,
            memberCount: members.length,
            isOwner: league.ownerId === userId,
            me: mine
              ? {
                  rank: mine.rank,
                  rankDelta: priorRank != null && mine.rank != null ? priorRank - mine.rank : null,
                  points: mine.points,
                  correct: mine.correct,
                  incorrect: mine.incorrect,
                  hasResults: true,
                }
              : { rank: null, rankDelta: null, points: 0, correct: 0, incorrect: 0, hasResults: false },
            streak,
            survivor:
              league.format === "survivor"
                ? {
                    alive: myS.alive !== false,
                    eliminatedWeek: myS.eliminatedWeek ?? null,
                    weeksSurvived: myS.alive === false && myS.eliminatedWeek != null
                      ? scoredWeeks.filter((w) => w < myS.eliminatedWeek).length
                      : scoredWeeks.length,
                    aliveCount: members.filter((m) => survivorState[m.userId]?.alive !== false).length,
                  }
                : null,
            week: weekProgress,
            leaderboard: top.map((r: any) => ({
              userId: r.userId,
              displayName: profiles[r.userId]?.displayName || "Player",
              avatar: profiles[r.userId]?.avatar ?? null,
              rank: r.rank,
              points: r.points,
              correct: r.correct,
              incorrect: r.incorrect,
              isMe: r.userId === userId,
              alive: league.format === "survivor" ? survivorState[r.userId]?.alive !== false : null,
              eliminatedWeek: league.format === "survivor" ? (survivorState[r.userId]?.eliminatedWeek ?? null) : null,
            })),
          };
        })
      )
    ).filter(Boolean) as any[];

    // Cross-league aggregates. Only leagues that have actually been scored
    // contribute to the average rank - an unscored league has no rank to
    // average, and counting it as last (or as first) would both be wrong.
    const scoredLeagues = leagues.filter((l) => l.me.hasResults && l.me.rank != null);
    const correct = leagues.reduce((n, l) => n + (l.me.correct || 0), 0);
    const incorrect = leagues.reduce((n, l) => n + (l.me.incorrect || 0), 0);
    const totals = {
      leagueCount: leagues.length,
      correct,
      incorrect,
      pickCount: correct + incorrect,
      winPct: correct + incorrect > 0 ? correct / (correct + incorrect) : null,
      avgRank: scoredLeagues.length
        ? scoredLeagues.reduce((n, l) => n + l.me.rank, 0) / scoredLeagues.length
        : null,
      rankedLeagueCount: scoredLeagues.length,
    };

    return jsonResponse(200, { ok: true, week, leagues, totals, followRate: null }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/home-summary",
};

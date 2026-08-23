import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { makeGameId, findGameById } from "./lib/gameId.mts";
import { isPastKickoff } from "./lib/kickoff.mts";

// Submits (or autosaves-over) one pick for one game in one league/week.
// This is the only place a pick is allowed to be written - the client never
// writes picks:{leagueId}:{week} directly, so every rule below is actually
// enforced rather than just suggested by the UI.
//
// POST /.netlify/functions/picks-submit
// Body: { leagueId, week, gameId, team, confidence? }
//
// Storage (blitz-leagues store, same as league-create/join/leagues-mine):
//   picks:{leagueId}:{week} -> { [userId]: { [gameId]: { team, confidence?, updatedAt } } }
// Lock state is never stored - it's derived live from kickoff.mts on every
// request, so there's no separate "is this locked" flag that can go stale.

const LEAGUE_STORE = "blitz-leagues";
const SITE_DATA_STORE = "blitz-site-data";

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId = claims.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" }, CORS_HEADERS);
  }

  const leagueId = typeof body.leagueId === "string" ? body.leagueId : "";
  const week = Number(body.week);
  const gameId = typeof body.gameId === "string" ? body.gameId : "";
  const team = typeof body.team === "string" ? body.team.toUpperCase() : "";
  const confidence = body.confidence !== undefined ? Number(body.confidence) : undefined;

  if (!leagueId || !week || !gameId || !team) {
    return jsonResponse(400, { ok: false, error: "leagueId, week, gameId, and team are required" }, CORS_HEADERS);
  }

  const leagueStore = getStore(LEAGUE_STORE);
  const siteDataStore = getStore(SITE_DATA_STORE);

  try {
    // 1. League + membership check.
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);
    if (league.locked) return jsonResponse(403, { ok: false, error: "This league is locked" }, CORS_HEADERS);

    const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
    const isMember = membersDoc?.members?.some((m: any) => m.userId === userId);
    if (!isMember) return jsonResponse(403, { ok: false, error: "Not a member of this league" }, CORS_HEADERS);

    // 2. Game must actually exist in the schedule for this week, and the
    //    picked team must actually be one of the two teams playing.
    const schedule: any = await siteDataStore.get("schedule", { type: "json" });
    const weekEntry = schedule?.weeks?.find((w: any) => w.week === week);
    if (!weekEntry) return jsonResponse(400, { ok: false, error: `No schedule found for week ${week}` }, CORS_HEADERS);

    const game = findGameById(weekEntry.games || [], league.season, week, gameId);
    if (!game) return jsonResponse(400, { ok: false, error: "Game not found for this week" }, CORS_HEADERS);
    if (team !== game.away.toUpperCase() && team !== game.home.toUpperCase()) {
      return jsonResponse(400, { ok: false, error: "Selected team is not playing in this game" }, CORS_HEADERS);
    }

    // 3. Deadline check - per-game, at that game's own kickoff.
    if (isPastKickoff(league.season, game.date, game.time)) {
      return jsonResponse(403, { ok: false, error: "Pick deadline has passed for this game" }, CORS_HEADERS);
    }

    // 4. Confidence-format validation.
    if (league.format === "confidence") {
      const maxConfidence = (weekEntry.games || []).length;
      if (!Number.isInteger(confidence) || confidence < 1 || confidence > maxConfidence) {
        return jsonResponse(400, { ok: false, error: `Confidence must be an integer between 1 and ${maxConfidence}` }, CORS_HEADERS);
      }
    }

    const picksKey = `picks:${leagueId}:${week}`;
    const weekPicksDoc: any = (await leagueStore.get(picksKey, { type: "json" })) || {};
    const userPicks: any = weekPicksDoc[userId] || {};

    // (No separate "already locked" check needed here beyond step 3: lock
    // state isn't stored, it's derived live from kickoff time every request,
    // so there's nothing that can go stale between an earlier save and now.)

    // 5. Confidence uniqueness, if the league requires it - the new value
    //    can't collide with confidence already assigned to a DIFFERENT game
    //    this week.
    if (league.format === "confidence" && league.scoringSettings?.uniqueConfidence) {
      const collision = Object.entries(userPicks).find(
        ([gid, p]: [string, any]) => gid !== gameId && p.confidence === confidence
      );
      if (collision) {
        return jsonResponse(409, { ok: false, error: `Confidence value ${confidence} is already used on another game this week` }, CORS_HEADERS);
      }
    }

    // 6. Survivor: the picked team can't have been used already this season
    //    (any prior week, not just this one) - default rule, always on
    //    unless a future league setting relaxes it.
    if (league.format === "survivor") {
      for (let w = 1; w < week; w++) {
        const priorDoc: any = await leagueStore.get(`picks:${leagueId}:${w}`, { type: "json" });
        const priorPick = priorDoc?.[userId] && Object.values(priorDoc[userId])[0];
        if (priorPick && (priorPick as any).team === team) {
          return jsonResponse(409, { ok: false, error: `You've already used ${team} in week ${w} - Survivor teams can only be used once per season` }, CORS_HEADERS);
        }
      }
      // Survivor is one pick per week - submitting a new game this week
      // replaces any other game already picked this week rather than
      // stacking multiple picks.
      Object.keys(userPicks).forEach((gid) => {
        if (gid !== gameId) delete userPicks[gid];
      });
    }

    const now = new Date().toISOString();
    userPicks[gameId] = {
      team,
      ...(league.format === "confidence" ? { confidence } : {}),
      updatedAt: now,
    };
    weekPicksDoc[userId] = userPicks;

    await leagueStore.setJSON(picksKey, weekPicksDoc);

    return jsonResponse(200, { ok: true, gameId, pick: userPicks[gameId] }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/picks-submit",
};

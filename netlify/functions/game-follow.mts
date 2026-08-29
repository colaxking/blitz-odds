import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { getFollows, toggleFollow, MAX_FOLLOWS_PER_WEEK } from "./lib/follows.mts";
import { loadAllWeeks } from "./lib/schedule.mts";
import { makeGameId } from "./lib/gameId.mts";
import { parseKickoffUTC } from "./lib/kickoff.mts";

// Read and write the games this account is following for a given week.
//
// GET  /.netlify/functions/game-follow?week=6
//        -> { ok, season, week, games: string[], max }
// POST /.netlify/functions/game-follow
//        Body: { week, gameId, follow: boolean }
//        -> { ok, season, week, games: string[], max }
//
// Follows are week-scoped by construction - see lib/follows.mts - so there
// is no unfollow-by-expiry path here and no "until when" to pass. The week
// in the request is the whole of the scope.

const SITE_DATA_STORE = "blitz-site-data";
const CURRENT_SEASON = 2026;

/** How long after kickoff a game is still worth following. Long enough to
 *  cover overtime and a slow final whistle, after which the only alert left
 *  (the final score) has already fired and a follow buys nothing. */
const FOLLOW_TAIL_MS = 5 * 60 * 60 * 1000;

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function parseWeek(raw: unknown): number | null {
  const n = Number(raw);
  // Preseason weeks are negative in this schedule, so the bound is a
  // magnitude check rather than n > 0.
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 30) return null;
  return n;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) {
    return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  }
  const userId = claims.id;

  try {
    if (req.method === "GET") {
      const week = parseWeek(new URL(req.url).searchParams.get("week"));
      if (week === null) return jsonResponse(400, { ok: false, error: "Missing or invalid week" }, CORS_HEADERS);
      const games = [...(await getFollows(CURRENT_SEASON, week, userId))];
      return jsonResponse(200, { ok: true, season: CURRENT_SEASON, week, games, max: MAX_FOLLOWS_PER_WEEK }, CORS_HEADERS);
    }

    if (req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { ok: false, error: "Invalid JSON body" }, CORS_HEADERS);
      }

      const week = parseWeek(body.week);
      if (week === null) return jsonResponse(400, { ok: false, error: "Missing or invalid week" }, CORS_HEADERS);

      const gameId = typeof body.gameId === "string" ? body.gameId : "";
      if (!gameId) return jsonResponse(400, { ok: false, error: "Missing gameId" }, CORS_HEADERS);
      if (typeof body.follow !== "boolean") {
        return jsonResponse(400, { ok: false, error: "Missing follow (true or false)" }, CORS_HEADERS);
      }

      // Unfollowing is allowed unconditionally, and deliberately skips every
      // check below. Someone whose followed game has just kicked off, or
      // which has been flexed out of the schedule entirely, must still be
      // able to turn the alerts off - refusing to unfollow a game the
      // validation no longer recognises would strand them with alerts they
      // asked to stop and no way to stop them.
      if (body.follow === false) {
        const games = await toggleFollow(CURRENT_SEASON, week, userId, gameId, false);
        return jsonResponse(200, { ok: true, season: CURRENT_SEASON, week, games, max: MAX_FOLLOWS_PER_WEEK }, CORS_HEADERS);
      }

      // Following, on the other hand, is checked against the real schedule.
      // One blob read on a user-initiated tap, in exchange for never
      // writing a follow key for a game that doesn't exist - which would
      // otherwise sit in the store being read by every dispatcher pass for
      // the rest of the week and match nothing.
      const weeks = await loadAllWeeks(getStore(SITE_DATA_STORE));
      const target = weeks.find((w) => w.week === week);
      const game = (target?.games || []).find((g) => makeGameId(CURRENT_SEASON, week, g.away, g.home) === gameId);
      if (!game) {
        return jsonResponse(404, { ok: false, error: "No such game in that week" }, CORS_HEADERS);
      }

      // A game that's over can't produce another alert, so following it is
      // a control that would silently do nothing. A game already in
      // progress still can - scoring alerts and the final - so the cutoff
      // is the end of the game, not kickoff. A placeholder kickoff time
      // (flex-scheduled weeks parse to null) is treated as followable:
      // those are always future games.
      const kickoff = parseKickoffUTC(CURRENT_SEASON, game.date, game.time);
      if (kickoff && Date.now() > kickoff.getTime() + FOLLOW_TAIL_MS) {
        return jsonResponse(409, { ok: false, error: "That game is over." }, CORS_HEADERS);
      }

      try {
        const games = await toggleFollow(CURRENT_SEASON, week, userId, gameId, true);
        return jsonResponse(200, { ok: true, season: CURRENT_SEASON, week, games, max: MAX_FOLLOWS_PER_WEEK }, CORS_HEADERS);
      } catch (err) {
        // The per-week cap is the only thing toggleFollow throws for, and
        // it's a message written to be shown, so it goes back as a 409 with
        // its own text rather than a generic 500.
        return jsonResponse(409, { ok: false, error: err instanceof Error ? err.message : "Could not follow that game" }, CORS_HEADERS);
      }
    }

    return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/game-follow",
};

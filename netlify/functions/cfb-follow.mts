import type { Context, Config } from "@netlify/functions";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { isFeatureOnFor } from "./lib/features.mts";
import { getCfbFollows, toggleCfbFollow, markCfbAlertInterest, CFB_MAX_FOLLOWS_PER_WEEK, CFB_SEASON } from "./lib/cfb.mts";

// "Alert me" for one college game, for one week.
//
// GET  /.netlify/functions/cfb-follow?week=12   -> { ok, season, week, games: eventId[], max }
// POST /.netlify/functions/cfb-follow           Body: { week, eventId, follow }
//
// The college twin of game-follow.mts, in its own key space (see lib/cfb.mts).
// Alerts are sent by the live pass in notif-live-dispatch-background.
// Unfollowing is always allowed, flag or no flag, so nobody can be stranded
// with alerts they can't turn off.

const CORS_HEADERS: Record<string, string> = { ...CORS_HEADERS_BASE, "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

function parseWeek(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const claims: any = await getAuthenticatedUser(req).catch(() => null);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId = claims.id;

  try {
    if (req.method === "GET") {
      const week = parseWeek(new URL(req.url).searchParams.get("week"));
      if (week === null) return jsonResponse(400, { ok: false, error: "Missing or invalid week" }, CORS_HEADERS);
      const games = await getCfbFollows(week, userId);
      return jsonResponse(200, { ok: true, season: CFB_SEASON, week, games, max: CFB_MAX_FOLLOWS_PER_WEEK }, CORS_HEADERS);
    }
    if (req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return jsonResponse(400, { ok: false, error: "Invalid JSON body" }, CORS_HEADERS); }
      const week = parseWeek(body.week);
      if (week === null) return jsonResponse(400, { ok: false, error: "Missing or invalid week" }, CORS_HEADERS);
      const eventId = typeof body.eventId === "string" && /^\d{5,12}$/.test(body.eventId) ? body.eventId : "";
      if (!eventId) return jsonResponse(400, { ok: false, error: "Missing eventId" }, CORS_HEADERS);
      if (typeof body.follow !== "boolean") return jsonResponse(400, { ok: false, error: "Missing follow (true or false)" }, CORS_HEADERS);

      if (body.follow) {
        if (!(await isFeatureOnFor("cfb", req, claims))) return jsonResponse(404, { ok: false, error: "Not found" }, CORS_HEADERS);
        const current = await getCfbFollows(week, userId);
        if (!current.includes(eventId) && current.length >= CFB_MAX_FOLLOWS_PER_WEEK) {
          return jsonResponse(409, { ok: false, error: `You can follow up to ${CFB_MAX_FOLLOWS_PER_WEEK} college games a week.` }, CORS_HEADERS);
        }
      }
      const games = await toggleCfbFollow(week, userId, eventId, body.follow);
      if (body.follow) await markCfbAlertInterest();
      return jsonResponse(200, { ok: true, season: CFB_SEASON, week, games, max: CFB_MAX_FOLLOWS_PER_WEEK }, CORS_HEADERS);
    }
    return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: "Couldn't update alerts right now" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/cfb-follow",
};

import type { Context, Config } from "@netlify/functions";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { isFeatureOnFor } from "./lib/features.mts";
import { loadStats, loadWeather, CFB_SEASON } from "./lib/cfb.mts";

// GET /.netlify/functions/cfb-data?view=stats
//   -> { ok, season, fetchedAt, teamCount, teams: { [espnTeamId]: CfbTeamStats } }
// GET /.netlify/functions/cfb-data?view=weather&week=12&seasontype=2
//   -> { ok, fetchedAt, games: { [espnEventId]: weather } }
//
// The two pieces of the college Games view the browser can't sensibly do for
// itself (see lib/cfb.mts). Behind the "cfb" feature flag; anyone the flag
// doesn't cover gets a 404 as if this didn't exist.

const CORS_HEADERS: Record<string, string> = { ...CORS_HEADERS_BASE, "Access-Control-Allow-Methods": "GET, OPTIONS" };

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  let claims: any = null;
  try { claims = await getAuthenticatedUser(req); } catch { claims = null; }
  if (!(await isFeatureOnFor("cfb", req, claims))) {
    return jsonResponse(404, { ok: false, error: "Not found" }, CORS_HEADERS);
  }

  const url = new URL(req.url);
  const view = url.searchParams.get("view");
  try {
    if (view === "stats") {
      const doc = await loadStats();
      return jsonResponse(200, { ok: true, ...doc }, CORS_HEADERS);
    }
    if (view === "weather") {
      const week = Number(url.searchParams.get("week"));
      const seasontype = Number(url.searchParams.get("seasontype") || 2);
      if (!Number.isInteger(week) || week < 1 || week > 20 || (seasontype !== 2 && seasontype !== 3)) {
        return jsonResponse(400, { ok: false, error: "Missing or invalid week" }, CORS_HEADERS);
      }
      const doc = await loadWeather(week, seasontype);
      return jsonResponse(200, { ok: true, season: CFB_SEASON, week, ...doc }, CORS_HEADERS);
    }
    return jsonResponse(400, { ok: false, error: "Unknown view" }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(502, { ok: false, error: "College data is unavailable right now" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/cfb-data",
};

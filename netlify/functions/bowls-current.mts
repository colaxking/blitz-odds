import type { Context, Config } from "@netlify/functions";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { isFeatureOnFor } from "./lib/features.mts";
import { loadSlate, BOWL_SEASON } from "./lib/bowls.mts";

// GET /.netlify/functions/bowls-current
//   -> { ok, season, fetchedAt, games: BowlGame[] }
//
// The bowl slate for the Bowls tab: every bowl and Playoff game with teams
// (or null while TBD), kickoff, live score, result and the market line.
// Behind the "bowls" feature flag - with the flag on "admins", anyone else
// gets a 404 as if the endpoint didn't exist.
//
// Not CDN-cached: the gate depends on who is asking. lib/bowls.mts keeps its
// own short Blobs cache in front of ESPN, so this stays one cheap read.

const CORS_HEADERS: Record<string, string> = { ...CORS_HEADERS_BASE, "Access-Control-Allow-Methods": "GET, OPTIONS" };

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  let claims: any = null;
  try { claims = await getAuthenticatedUser(req); } catch { claims = null; }
  if (!(await isFeatureOnFor("bowls", req, claims))) {
    return jsonResponse(404, { ok: false, error: "Not found" }, CORS_HEADERS);
  }

  try {
    const slate = await loadSlate(BOWL_SEASON);
    return jsonResponse(200, { ok: true, ...slate }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(502, { ok: false, error: "Couldn't load the bowl schedule right now" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/bowls-current",
};

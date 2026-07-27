import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Write endpoint for the blitz-odds-odds-refresh scheduled task. Replaces the
// old flow of git-committing data/odds-2026.json + rebuilding index.html on
// every line change, which was a full Netlify "production deploy" each time
// (15 credits/deploy on the free plan, ~20 free deploys/month total - a
// 15-minute refresh cadence in season would exhaust that in a day or two and
// pause the whole site). Writing to a Blobs store here costs Functions
// compute credits instead (10 credits/GB-hour), which is negligible for a
// JSON document this size, however often it's called.
//
// The live site's client-side code fetches current odds at runtime from
// odds-current.mts (same store), the same way it already polls ESPN for live
// scores - so odds can update as often as needed without ever triggering a
// new deploy.

const STORE_NAME = "blitz-odds-live";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-odds-update-secret",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

// Minimal shape checks - just enough to stop obviously-wrong payloads from
// clobbering the store. Not a full schema validation.
function looksLikeOddsDoc(v: any): boolean {
  return !!v && typeof v === "object" && typeof v.weeks === "object" && v.weeks !== null;
}

function looksLikeHistoryDoc(v: any): boolean {
  return !!v && typeof v === "object" && typeof v.games === "object" && v.games !== null;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const expectedSecret = process.env.ODDS_UPDATE_SECRET;
  if (!expectedSecret) {
    // Fail closed: if the secret isn't configured on the site, refuse writes
    // rather than silently accepting unauthenticated ones.
    return jsonResponse(500, { ok: false, error: "ODDS_UPDATE_SECRET not configured on this site" });
  }

  const providedSecret = req.headers.get("x-odds-update-secret");
  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-odds-update-secret header" });
  }

  let body: any;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const updated: string[] = [];
  const store = getStore(STORE_NAME);

  if (body.odds !== undefined) {
    if (!looksLikeOddsDoc(body.odds)) {
      return jsonResponse(400, { ok: false, error: "body.odds must be an object with a 'weeks' map" });
    }
    await store.setJSON("odds", body.odds);
    updated.push("odds");
  }

  if (body.history !== undefined) {
    if (!looksLikeHistoryDoc(body.history)) {
      return jsonResponse(400, { ok: false, error: "body.history must be an object with a 'games' map" });
    }
    await store.setJSON("history", body.history);
    updated.push("history");
  }

  if (updated.length === 0) {
    return jsonResponse(400, { ok: false, error: "Provide at least one of body.odds or body.history" });
  }

  return jsonResponse(200, { ok: true, updated });
};

export const config: Config = {
  path: "/.netlify/functions/odds-update",
};

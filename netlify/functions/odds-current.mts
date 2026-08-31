import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Public read endpoint the live site polls at runtime for current odds, the
// same way it already polls ESPN's scoreboard for live scores and
// data/teams.json for updated ranks. Companion to odds-update.mts, which is
// how the odds-refresh scheduled task writes new lines into the same store -
// no git commit or redeploy involved on either side of that loop.

const STORE_NAME = "blitz-odds-live";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-odds-update-secret",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

// Returned only if the blob store has never been written to yet (e.g. right
// after this endpoint is first deployed, before the odds-refresh task has
// run). Shape matches data/odds-2026.json / data/odds-history.json so the
// client's merge logic doesn't need a special case.
const EMPTY_ODDS = { season: 2026, sourceNote: "No odds pushed to the live store yet.", weeks: {} };
const EMPTY_HISTORY = { season: 2026, sourceNote: "No odds pushed to the live store yet.", games: {} };

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const url = new URL(req.url);
  const type = url.searchParams.get("type") === "history" ? "history" : "odds";

  // Blobs reads are eventually consistent by default, which is exactly what
  // the public site wants - it polls this endpoint constantly and a few
  // seconds of lag on a line change costs nothing. odds-refresh needs the
  // opposite: it reads this back immediately after publishing to confirm the
  // write landed, and an eventually-consistent read there reports a stale
  // doc for 15-20s and fails a publish that actually succeeded. So a strong
  // read is opt-in, and gated behind the same secret that authorises writes
  // in odds-update - otherwise any caller could force the expensive path.
  const expectedSecret = process.env.ODDS_UPDATE_SECRET;
  const strong = !!expectedSecret && req.headers.get("x-odds-update-secret") === expectedSecret;

  try {
    const store = getStore(STORE_NAME);
    const doc = await store.get(type, { type: "json", ...(strong ? { consistency: "strong" as const } : {}) });
    if (doc) {
      return jsonResponse(200, doc);
    }
    return jsonResponse(200, type === "history" ? EMPTY_HISTORY : EMPTY_ODDS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/odds-current",
};

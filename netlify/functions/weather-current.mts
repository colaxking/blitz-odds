import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Public read endpoint for weather data - companion to weather-update.mts.
// The live site polls this the same way it polls odds-current, and the
// weather-refresh script fetches from here first so its merge is
// fetch-before-merge (never a blind overwrite of games it didn't touch).

const STORE_NAME = "blitz-odds-live";
const KEY = "weather";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const store = getStore(STORE_NAME);
    const doc = await store.get(KEY, { type: "json" });
    return jsonResponse(200, doc || { weeks: {} });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/weather-current",
};

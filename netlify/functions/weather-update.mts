import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Write endpoint for the weather refresh script (scripts/weather-refresh.mjs,
// run on the same cron-job.org -> GitHub Actions dispatch pattern as
// odds-refresh). Body shape mirrors ODDS_DATA exactly:
//   { weeks: { "<week>": { games: { "<away>-<home>": WeatherEntry } } } }
// (week numbers are globally unique - negative for preseason, 1-18 regular,
// 19-22 playoffs - so no separate phase key is needed). Full-document
// overwrite is fine here (unlike site-data-update's players bug) because the
// refresh script always fetches-before-merge from weather-current, so the
// body it sends is already the complete, correct document.

const STORE_NAME = "blitz-odds-live";
const KEY = "weather";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-weather-update-secret",
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

function looksLikeWeatherDoc(v: any): boolean {
  return !!v && typeof v === "object" && typeof v.weeks === "object" && v.weeks !== null;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const expectedSecret = process.env.WEATHER_UPDATE_SECRET;
  if (!expectedSecret) {
    return jsonResponse(500, { ok: false, error: "WEATHER_UPDATE_SECRET not configured on this site" });
  }

  const providedSecret = req.headers.get("x-weather-update-secret");
  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-weather-update-secret header" });
  }

  let body: any;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  if (!looksLikeWeatherDoc(body)) {
    return jsonResponse(400, { ok: false, error: "Body must be an object with a 'weeks' map" });
  }

  const store = getStore(STORE_NAME);
  await store.setJSON(KEY, body);

  const weekCount = Object.keys(body.weeks).length;
  return jsonResponse(200, { ok: true, weekCount });
};

export const config: Config = {
  path: "/.netlify/functions/weather-update",
};

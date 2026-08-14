import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(extraHeaders || {}),
    },
  });
}

const VALID_TYPES = new Set([
  "pageview",
  "team_click",
  "favorite",
  "team_tab",
  "roster_side",
  "player_view",
]);

// Best-effort extraction of Netlify's built-in geolocation (derived from the
// edge node that served the request, via the `x-nf-geo` header). This is
// approximate (city-level at best) and never involves storing a raw IP.
function extractLocation(context: Context): Record<string, unknown> | null {
  try {
    const geo = context && (context as any).geo;
    if (!geo) return null;

    const location: Record<string, unknown> = {};
    if (geo.city) location.city = String(geo.city).slice(0, 128);
    if (geo.country && geo.country.name) location.country = String(geo.country.name).slice(0, 128);
    if (geo.country && geo.country.code) location.countryCode = String(geo.country.code).slice(0, 8);
    if (geo.subdivision && geo.subdivision.name) location.region = String(geo.subdivision.name).slice(0, 128);
    if (geo.subdivision && geo.subdivision.code) location.regionCode = String(geo.subdivision.code).slice(0, 16);
    if (geo.timezone) location.timezone = String(geo.timezone).slice(0, 64);
    if (typeof geo.latitude === "number" && Number.isFinite(geo.latitude)) location.lat = geo.latitude;
    if (typeof geo.longitude === "number" && Number.isFinite(geo.longitude)) location.lon = geo.longitude;

    return Object.keys(location).length > 0 ? location : null;
  } catch {
    return null;
  }
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const raw = await req.text();
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
    }

    const { type, visitorId, ts, team, teamName, adding, week, tab, side, player, source } = body || {};

    if (!VALID_TYPES.has(type)) {
      return jsonResponse(400, { ok: false, error: "Invalid or missing type" });
    }

    if (!visitorId || typeof visitorId !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing visitorId" });
    }

    const timestamp =
      typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();

    const record: Record<string, unknown> = {
      type,
      visitorId: String(visitorId).slice(0, 128),
      ts: timestamp,
    };

    if (
      type === "team_click" ||
      type === "favorite" ||
      type === "team_tab" ||
      type === "roster_side" ||
      type === "player_view"
    ) {
      record.team = team ? String(team).slice(0, 64) : "unknown";
      if (teamName) record.teamName = String(teamName).slice(0, 128);
    }

    if (type === "favorite") {
      record.adding = adding === true;
    }

    if (type === "team_tab" && tab) {
      record.tab = String(tab).slice(0, 64);
    }

    if (type === "roster_side" && side) {
      record.side = String(side).slice(0, 64);
    }

    if (type === "player_view") {
      if (player) record.player = String(player).slice(0, 128);
      if (source) record.source = String(source).slice(0, 32);
    }

    if (week !== undefined && week !== null && week !== "") {
      record.week = String(week).slice(0, 32);
    }

    const location = extractLocation(context);
    if (location) {
      record.location = location;
    }

    const store = getStore("blitz-analytics");
    const randomId = Math.random().toString(36).slice(2, 10);
    const key = `${timestamp}-${randomId}`;
    await store.setJSON(key, record);

    return jsonResponse(200, { ok: true });
  } catch (err) {
    // Never let a malformed/unexpected request take the endpoint down hard;
    // respond with a soft failure the client already treats as fire-and-forget.
    return jsonResponse(200, { ok: false });
  }
};

export const config: Config = {
  path: "/.netlify/functions/track",
};

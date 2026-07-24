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

const VALID_TYPES = new Set(["pageview", "team_click", "favorite"]);

export default async (req: Request, _context: Context) => {
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

    const { type, visitorId, ts, team, teamName, adding, week } = body || {};

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

    if (type === "team_click" || type === "favorite") {
      record.team = team ? String(team).slice(0, 64) : "unknown";
      if (teamName) record.teamName = String(teamName).slice(0, 128);
    }

    if (type === "favorite") {
      record.adding = adding === true;
    }

    if (week !== undefined && week !== null && week !== "") {
      record.week = String(week).slice(0, 32);
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

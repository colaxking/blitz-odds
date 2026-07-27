import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Write endpoint for the nfl-matchup-analyzer-weekly-update scheduled task.
// Same idea as odds-update.mts, applied to the rest of the app's data: team
// stats/ranks, injury statuses, the weekly history archive, and the playoff
// bracket. Publishing here makes the change live immediately, without
// waiting on a git push + Netlify build - the task still writes files to
// disk and commits/pushes afterward for a durable, versioned record, but a
// slow or failed git push no longer means stale data on the live site.
//
// Uses a separate secret (SITE_DATA_UPDATE_SECRET) from odds-update.mts's
// ODDS_UPDATE_SECRET, so this function can be added/changed without any risk
// to the already-running odds pipeline.

const STORE_NAME = "blitz-site-data";
const VALID_KEYS = new Set(["teams", "players", "schedule", "history", "preseason", "playoffs"]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-site-data-update-secret",
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

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const expectedSecret = process.env.SITE_DATA_UPDATE_SECRET;
  if (!expectedSecret) {
    return jsonResponse(500, { ok: false, error: "SITE_DATA_UPDATE_SECRET not configured on this site" });
  }

  const providedSecret = req.headers.get("x-site-data-update-secret");
  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-site-data-update-secret header" });
  }

  let body: any;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  if (!body || typeof body !== "object") {
    return jsonResponse(400, { ok: false, error: "Body must be a JSON object" });
  }

  const providedKeys = Object.keys(body).filter((k) => body[k] !== undefined);
  const unknownKeys = providedKeys.filter((k) => !VALID_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return jsonResponse(400, { ok: false, error: `Unknown key(s): ${unknownKeys.join(", ")}. Valid keys: ${[...VALID_KEYS].join(", ")}` });
  }

  const relevantKeys = providedKeys.filter((k) => VALID_KEYS.has(k));
  if (relevantKeys.length === 0) {
    return jsonResponse(400, { ok: false, error: `Provide at least one of: ${[...VALID_KEYS].join(", ")}` });
  }

  const store = getStore(STORE_NAME);
  const updated: string[] = [];

  for (const key of relevantKeys) {
    const value = body[key];
    if (!value || typeof value !== "object") {
      return jsonResponse(400, { ok: false, error: `body.${key} must be an object` });
    }
    await store.setJSON(key, value);
    updated.push(key);
  }

  return jsonResponse(200, { ok: true, updated });
};

export const config: Config = {
  path: "/.netlify/functions/site-data-update",
};

import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Write endpoint for the hotpicks-snapshot / hotpicks-grade scheduled
// scripts. Same pattern as odds-update.mts / site-data-update.mts: writing
// to Blobs here goes live immediately without a git push + Netlify build,
// while each script still writes an on-disk mirror and commits it
// afterward for a durable, versioned record.

const STORE_NAME = "blitz-picks-track-record";
const VALID_KEYS = new Set(["snapshots", "grades", "aggregate"]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-hotpicks-update-secret",
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
// clobbering the store, not full schema validation.
function looksLikeWeeksDoc(v: any): boolean {
  return !!v && typeof v === "object" && typeof v.weeks === "object" && v.weeks !== null;
}

function looksLikeAggregateDoc(v: any): boolean {
  return !!v && typeof v === "object" && typeof v.confidencePicks === "object" && Array.isArray(v.byWeek);
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const expectedSecret = process.env.HOTPICKS_UPDATE_SECRET;
  if (!expectedSecret) {
    return jsonResponse(500, { ok: false, error: "HOTPICKS_UPDATE_SECRET not configured on this site" });
  }

  const providedSecret = req.headers.get("x-hotpicks-update-secret");
  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-hotpicks-update-secret header" });
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
    if (key === "aggregate") {
      if (!looksLikeAggregateDoc(value)) {
        return jsonResponse(400, { ok: false, error: "body.aggregate must have confidencePicks and a byWeek array" });
      }
    } else if (!looksLikeWeeksDoc(value)) {
      return jsonResponse(400, { ok: false, error: `body.${key} must be an object with a 'weeks' map` });
    }
    await store.setJSON(key, value);
    updated.push(key);
  }

  return jsonResponse(200, { ok: true, updated });
};

export const config: Config = {
  path: "/.netlify/functions/hotpicks-update",
};

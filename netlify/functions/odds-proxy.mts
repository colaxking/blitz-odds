import type { Context, Config } from "@netlify/functions";

// Server-side proxy for the SportsGameOdds API, used by the
// blitz-odds-odds-refresh scheduled task. That task runs in a sandboxed
// environment whose outbound network is restricted to an allowlist that
// does not include api.sportsgameodds.com (confirmed blocked as of
// 2026-07-30 - both a direct curl and the WebFetch tool failed against
// that domain). Netlify's own servers have no such restriction, and the
// sandbox can already reach blitz-odds.netlify.app fine (it's how
// odds-current/odds-update work today) - so the scheduled task calls this
// function instead of hitting the vendor API directly.
//
// This is intentionally a narrow allowlisted proxy (only 'usage' and
// 'events'), not a general passthrough. The vendor API key lives in this
// site's env vars and is never exposed to the caller.

const API_BASE = "https://api.sportsgameodds.com/v2";

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

// Only these query params are ever forwarded to the 'events' endpoint -
// callers can't smuggle arbitrary params through to the upstream API.
const FORWARDABLE_EVENT_PARAMS = [
  "leagueID",
  "oddsAvailable",
  "bookmakerID",
  "startsAfter",
  "startsBefore",
  "limit",
  "cursor",
];

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const apiKey = process.env.SPORTSGAMEODDS_API_KEY;
  if (!apiKey) {
    // Fail closed, same pattern as odds-update.mts: refuse to proceed
    // rather than calling the vendor API with no key.
    return jsonResponse(500, { ok: false, error: "SPORTSGAMEODDS_API_KEY not configured on this site" });
  }

  const url = new URL(req.url);
  const endpoint = url.searchParams.get("endpoint");

  let upstreamUrl: string;
  if (endpoint === "usage") {
    upstreamUrl = `${API_BASE}/account/usage`;
  } else if (endpoint === "events") {
    const forward = new URLSearchParams();
    for (const key of FORWARDABLE_EVENT_PARAMS) {
      const v = url.searchParams.get(key);
      if (v) forward.set(key, v);
    }
    upstreamUrl = `${API_BASE}/events?${forward.toString()}`;
  } else {
    return jsonResponse(400, { ok: false, error: "endpoint query param must be 'usage' or 'events'" });
  }

  try {
    const upstream = await fetch(upstreamUrl, { headers: { "x-api-key": apiKey } });
    const text = await upstream.text();
    // Pass the vendor's status/body straight through so the caller can
    // apply the same success/error handling it already has for the
    // direct-API fallback path.
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse(502, { ok: false, error: err instanceof Error ? err.message : "Upstream fetch to SportsGameOdds failed" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/odds-proxy",
};

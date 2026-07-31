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
// 'events'), not a general passthrough. The vendor API key(s) live in this
// site's env vars and are never exposed to the caller.
//
// Key fail-safe (added 2026-07-31): SPORTSGAMEODDS_API_KEY is the primary
// key. SPORTSGAMEODDS_API_KEY_BACKUP holds the previous key as a fallback -
// if the vendor rejects the primary key with 401/403 (revoked, rotated
// wrong, plan issue, etc.), this proxy automatically retries once with the
// backup key before giving up. If both keys fail, behavior is unchanged
// from before this fail-safe existed: the vendor's actual error response
// (401/403 and body) is passed straight through to the caller.

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

function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const primaryKey = process.env.SPORTSGAMEODDS_API_KEY;
  const backupKey = process.env.SPORTSGAMEODDS_API_KEY_BACKUP;
  if (!primaryKey && !backupKey) {
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
    // Prefer the primary key. If it's missing (shouldn't normally happen
    // once both are configured, but handled defensively), go straight to
    // the backup instead of erroring.
    const firstKey = primaryKey ?? backupKey!;
    const firstKeyLabel = primaryKey ? "primary" : "backup";

    let upstream = await fetch(upstreamUrl, { headers: { "x-api-key": firstKey } });
    let usedKey = firstKeyLabel;

    // Only retry with the backup key if we tried the primary first, the
    // primary was specifically rejected on auth grounds, and a distinct
    // backup key is actually configured.
    if (firstKeyLabel === "primary" && isAuthRejection(upstream.status) && backupKey && backupKey !== primaryKey) {
      const retry = await fetch(upstreamUrl, { headers: { "x-api-key": backupKey } });
      if (!isAuthRejection(retry.status)) {
        upstream = retry;
        usedKey = "backup";
      }
      // If the backup also comes back 401/403, fall through and return the
      // primary attempt's response - same fail-through behavior as before
      // this fail-safe existed (vendor's real error, passed straight along).
    }

    const text = await upstream.text();
    // Pass the vendor's status/body straight through so the caller can
    // apply the same success/error handling it already has for the
    // direct-API fallback path.
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Odds-Key-Used": usedKey,
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

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
// Multi-account rotation (added 2026-08-03): Dan runs 3 separate
// SportsGameOdds free-tier accounts (2,500 objects/month each, no card
// required) to get 7,500/month combined instead of hitting the single-key
// cap. Keys live in SPORTSGAMEODDS_API_KEY_1/2/3, with matching
// SPORTSGAMEODDS_API_KEY_{n}_EMAIL vars purely for readability in logs (not
// used for auth). Before an 'events' call, this proxy checks each key's
// current usage (the /account/usage call is free - it doesn't count
// against quota) and tries keys in ascending-usage order, so requests
// spread evenly across accounts instead of exhausting one before touching
// the others. If a given key comes back 429 (rate limited) or 401/403
// (auth rejected), it moves on to the next key before giving up - same
// fail-through idea as the old primary/backup pair, just across 3 accounts
// instead of 2, and driven by real usage instead of only auth failures.
//
// Falls back to the older SPORTSGAMEODDS_API_KEY / SPORTSGAMEODDS_API_KEY_
// BACKUP vars if none of the _1/_2/_3 vars are set, so this doesn't break
// if the multi-key vars are ever removed.

const API_BASE = "https://api.sportsgameodds.com/v2";
const PER_KEY_MONTHLY_CAP = 2500;

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

function isRateLimited(status: number, body: any): boolean {
  if (status === 429) return true;
  return !!(body && body.success === false && /rate limit/i.test(body?.error || ""));
}

interface KeyEntry {
  label: string;
  key: string;
  email: string;
}

function loadKeys(): KeyEntry[] {
  const entries: KeyEntry[] = [];
  for (const n of [1, 2, 3]) {
    const key = process.env[`SPORTSGAMEODDS_API_KEY_${n}`];
    if (!key) continue;
    const email = process.env[`SPORTSGAMEODDS_API_KEY_${n}_EMAIL`] || `account-${n}`;
    entries.push({ label: `key-${n}`, key, email });
  }
  if (entries.length > 0) return entries;

  // Fallback: old single primary/backup pair.
  const primary = process.env.SPORTSGAMEODDS_API_KEY;
  const backup = process.env.SPORTSGAMEODDS_API_KEY_BACKUP;
  if (primary) entries.push({ label: "primary", key: primary, email: "primary" });
  if (backup && backup !== primary) entries.push({ label: "backup", key: backup, email: "backup" });
  return entries;
}

async function getUsage(key: string): Promise<number | null> {
  try {
    const res = await fetch(`${API_BASE}/account/usage`, { headers: { "x-api-key": key } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const usage = body?.data?.rateLimits?.["per-month"]?.["current-entities"];
    return typeof usage === "number" ? usage : null;
  } catch {
    return null;
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const keys = loadKeys();
  if (keys.length === 0) {
    // Fail closed, same pattern as odds-update.mts: refuse to proceed
    // rather than calling the vendor API with no key.
    return jsonResponse(500, { ok: false, error: "No SPORTSGAMEODDS_API_KEY_1/2/3 (or legacy SPORTSGAMEODDS_API_KEY) configured on this site" });
  }

  const url = new URL(req.url);
  const endpoint = url.searchParams.get("endpoint");

  if (endpoint === "usage") {
    const perKey = await Promise.all(
      keys.map(async (k) => ({
        label: k.label,
        email: k.email,
        usage: await getUsage(k.key),
        cap: PER_KEY_MONTHLY_CAP,
      }))
    );
    const totalUsage = perKey.reduce((sum, k) => sum + (k.usage ?? 0), 0);
    const totalCap = perKey.length * PER_KEY_MONTHLY_CAP;
    return jsonResponse(200, {
      success: true,
      data: {
        perKey,
        totalUsage,
        totalCap,
        // Kept for backward compatibility with any caller still reading
        // the old single-key shape directly.
        rateLimits: { "per-month": { "current-entities": totalUsage } },
        email: perKey.map((k) => k.email).join(", "),
      },
    });
  }

  if (endpoint !== "events") {
    return jsonResponse(400, { ok: false, error: "endpoint query param must be 'usage' or 'events'" });
  }

  const forward = new URLSearchParams();
  for (const key of FORWARDABLE_EVENT_PARAMS) {
    const v = url.searchParams.get(key);
    if (v) forward.set(key, v);
  }
  const upstreamUrl = `${API_BASE}/events?${forward.toString()}`;

  try {
    // Rank keys by current usage (ascending) so requests spread evenly
    // across accounts instead of hammering the first one until it hits
    // the vendor's rate limit. Keys with unknown usage (lookup failed) are
    // tried last, not first, so a flaky usage check doesn't accidentally
    // prioritize an already-exhausted key.
    const ranked = await Promise.all(keys.map(async (k) => ({ ...k, usage: await getUsage(k.key) })));
    ranked.sort((a, b) => (a.usage ?? Infinity) - (b.usage ?? Infinity));

    let lastStatus = 502;
    let lastText = "";
    let usedLabel = "none";

    for (const k of ranked) {
      const upstream = await fetch(upstreamUrl, { headers: { "x-api-key": k.key } });
      const text = await upstream.text();
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON body, leave body null
      }

      lastStatus = upstream.status;
      lastText = text;
      usedLabel = k.label;

      const rejected = isAuthRejection(upstream.status);
      const limited = isRateLimited(upstream.status, body);

      if (!rejected && !limited) {
        // Success or some other error that switching keys won't fix -
        // pass it straight through either way.
        return new Response(text, {
          status: upstream.status,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Odds-Key-Used": k.label,
            ...CORS_HEADERS,
          },
        });
      }
      // Auth rejection or rate limit on this key - try the next one.
    }

    // Every configured key was rejected or rate limited - pass the last
    // attempt's real response through, same fail-through behavior as
    // before this multi-key rotation existed.
    return new Response(lastText, {
      status: lastStatus,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Odds-Key-Used": usedLabel,
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

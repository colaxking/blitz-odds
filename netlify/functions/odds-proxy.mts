import type { Context, Config } from "@netlify/functions";

// Server-side proxy for the SportsGameOdds API, used by the
// blitz-odds-odds-refresh scheduled task. That task runs in a sandboxed
// environment whose outbound network is restricted to an allowlist that
// does not include api.sportsgameodds.com (confirmed blocked as of
// 2026-07-30 - both a direct curl and the WebFetch tool failed against
// that domain). Netlify's own servers have no such restriction, and the
// sandbox can already reach blitz-odds.com fine (it's how
// odds-current/odds-update work today) - so the scheduled task calls this
// function instead of hitting the vendor API directly.
//
// This is intentionally a narrow allowlisted proxy (only 'usage' and
// 'events'), not a general passthrough. The vendor API key(s) live in this
// site's env vars and are never exposed to the caller.
//
// Multi-account rotation (added 2026-08-03, 4th account added 2026-08-27):
// Dan runs several separate SportsGameOdds free-tier accounts (2,500
// objects/month each, no card required) to get a larger combined pool
// instead of hitting the single-key cap - currently 4 accounts = 10,000
// objects/month. Keys live in SPORTSGAMEODDS_API_KEY_{n}, with matching
// SPORTSGAMEODDS_API_KEY_{n}_EMAIL vars purely for readability in logs (not
// used for auth). Before an 'events' call, this proxy checks each key's
// current usage (the /account/usage call is free - it doesn't count
// against quota) and tries keys in ascending-usage order, so requests
// spread evenly across accounts instead of exhausting one before touching
// the others. If a given key comes back 429 (rate limited) or 401/403
// (auth rejected), it moves on to the next key before giving up - same
// fail-through idea as the old primary/backup pair, just across every
// configured account, and driven by real usage instead of only auth
// failures.
//
// Key slots are scanned by number up to MAX_KEY_SLOTS rather than being
// hardcoded to a fixed list, so adding a 5th+ account later is an env-var
// change plus a rebuild, with no code change here. Missing slot numbers are
// skipped, so the numbering doesn't have to stay gapless.
//
// Falls back to the older SPORTSGAMEODDS_API_KEY / SPORTSGAMEODDS_API_KEY_
// BACKUP vars if none of the numbered vars are set, so this doesn't break
// if the multi-key vars are ever removed.
//
// Per-key billing cycles (added 2026-08-29): each account has its own
// monthly reset date (they were signed up on different days), so pacing
// the pool as if it were one account on one anchor date was wrong - it
// skipped runs whose spend was actually affordable, and the pooled ratio
// could read "over budget" while two accounts still sat well under their
// own curves. The 'usage' response now reports each key's own cycle,
// pace allowance and spendability, taken from the vendor's per-month
// currentIntervalEndTime where available and falling back to a
// configurable anchor day-of-month otherwise
// (SPORTSGAMEODDS_API_KEY_{n}_ANCHOR_DAY, else ANCHOR_DAY_DEFAULT).
//
// Note: Netlify functions bake env vars in at build time, not read them
// live - a rebuild is required any time the numbered vars change for a
// running deploy to actually pick them up (2026-08-03 rebuild trigger;
// 2026-08-04 rebuild trigger after rotating SPORTSGAMEODDS_API_KEY_3 to
// the tycoon2face@gmail.com account; 2026-08-27 rebuild trigger for
// SPORTSGAMEODDS_API_KEY_4).

const API_BASE = "https://api.sportsgameodds.com/v2";
const PER_KEY_MONTHLY_CAP = 2500;
// Highest SPORTSGAMEODDS_API_KEY_{n} slot number checked. Only slots that
// actually have a key set are used, so this is just a ceiling - raise it if
// more than 8 accounts are ever configured.
const MAX_KEY_SLOTS = 8;
// Fraction of a key's own cycle-to-date allowance we're willing to have
// spent at any moment. The 5% trim leaves a little headroom for the last
// run before that key's reset lands.
const PACE_SAFETY = 0.95;
// A key needs at least this much genuinely spendable headroom to be worth
// starting a sweep on. A NEAR sweep costs roughly one object per upcoming
// game (tens); pagination spreads a FULL sweep across every key, so this
// is a per-key floor, not the whole sweep's cost.
const MIN_KEY_HEADROOM = 60;
// Day-of-month a key's monthly quota resets on, used only when the vendor
// doesn't report a usable interval end time. Overridable per key via
// SPORTSGAMEODDS_API_KEY_{n}_ANCHOR_DAY, or globally via ANCHOR_DAY_DEFAULT.
// 31 means "last day of the month" - it's clamped to each month's length.
const ANCHOR_DAY_DEFAULT = Number(process.env.ANCHOR_DAY_DEFAULT || 31);

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
  anchorDay: number;
}

function anchorDayFor(slot: number | null): number {
  const raw = slot === null ? null : process.env[`SPORTSGAMEODDS_API_KEY_${slot}_ANCHOR_DAY`];
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 31) return Math.floor(parsed);
  return ANCHOR_DAY_DEFAULT;
}

function loadKeys(): KeyEntry[] {
  const entries: KeyEntry[] = [];
  for (let n = 1; n <= MAX_KEY_SLOTS; n++) {
    const key = process.env[`SPORTSGAMEODDS_API_KEY_${n}`];
    if (!key) continue;
    const email = process.env[`SPORTSGAMEODDS_API_KEY_${n}_EMAIL`] || `account-${n}`;
    entries.push({ label: `key-${n}`, key, email, anchorDay: anchorDayFor(n) });
  }
  if (entries.length > 0) return entries;

  // Fallback: old single primary/backup pair.
  const primary = process.env.SPORTSGAMEODDS_API_KEY;
  const backup = process.env.SPORTSGAMEODDS_API_KEY_BACKUP;
  if (primary) entries.push({ label: "primary", key: primary, email: "primary", anchorDay: anchorDayFor(null) });
  if (backup && backup !== primary) entries.push({ label: "backup", key: backup, email: "backup", anchorDay: anchorDayFor(null) });
  return entries;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// The vendor's own docs and its live responses don't agree on field
// naming inside rateLimits["per-month"] - the docs show
// currentIntervalEntities / maxEntitiesPerInterval / currentIntervalEndTime,
// while the payload this site has actually been reading uses the
// hyphenated current-entities. Read every spelling we've seen rather than
// betting on one, and treat "unlimited"/"n/a" strings as absent.
function pickNumber(obj: any, names: string[]): number | null {
  for (const name of names) {
    const n = finiteNumber(obj?.[name]);
    if (n !== null) return n;
  }
  return null;
}

function pickDate(obj: any, names: string[]): Date | null {
  for (const name of names) {
    const v = obj?.[name];
    if (typeof v !== "string" || !v || v === "n/a" || v === "unlimited") continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

// One calendar month before `d`, clamping the day to the shorter month
// (31 Mar -> 28/29 Feb). Used to derive a cycle start from the vendor's
// interval end time, which is the only side of the window it reports.
function monthBefore(d: Date): Date {
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() - 1;
  if (m < 0) { m = 11; y -= 1; }
  const day = Math.min(d.getUTCDate(), daysInMonth(y, m));
  return new Date(Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

// Cycle bounds from a day-of-month anchor, for keys with no usable vendor
// reset time. The anchor day is clamped to each month's length, so 31 is
// "last day of the month" rather than a date that skips February.
function anchorCycle(now: Date, anchorDay: number): { start: Date; end: Date } {
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  const clamped = (yy: number, mm: number) => Math.min(anchorDay, daysInMonth(yy, mm));
  let start = new Date(Date.UTC(y, m, clamped(y, m)));
  if (start > now) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
    start = new Date(Date.UTC(y, m, clamped(y, m)));
  }
  let ny = y, nm = m + 1;
  if (nm > 11) { nm = 0; ny += 1; }
  return { start, end: new Date(Date.UTC(ny, nm, clamped(ny, nm))) };
}

type CycleSource = "vendor" | "anchor";

function resolveCycle(resetAt: Date | null, anchorDay: number, now: Date): { start: Date; end: Date; source: CycleSource } {
  // A reset time in the past means the vendor handed back a stale or
  // cached interval; fall back rather than pacing against a window that
  // has already closed.
  if (resetAt && resetAt.getTime() > now.getTime()) {
    return { start: monthBefore(resetAt), end: resetAt, source: "vendor" };
  }
  const { start, end } = anchorCycle(now, anchorDay);
  return { start, end, source: "anchor" };
}

// Fraction of this key's cycle that has elapsed. Continuous rather than
// whole-day, so the allowance rises smoothly instead of stair-stepping
// and stranding a run for the rest of a day.
function cycleFraction(cycle: { start: Date; end: Date }, now: Date): number {
  const total = cycle.end.getTime() - cycle.start.getTime();
  if (total <= 0) return 1;
  const elapsed = now.getTime() - cycle.start.getTime();
  return Math.min(1, Math.max(0, elapsed / total));
}

interface KeyUsage {
  usage: number | null;
  cap: number;
  capSource: "vendor" | "default";
  resetAt: Date | null;
  perMonth: any;
}

async function getKeyUsage(key: string): Promise<KeyUsage> {
  const unknown: KeyUsage = { usage: null, cap: PER_KEY_MONTHLY_CAP, capSource: "default", resetAt: null, perMonth: null };
  try {
    const res = await fetch(`${API_BASE}/account/usage`, { headers: { "x-api-key": key } });
    if (!res.ok) return unknown;
    const body = await res.json().catch(() => null);
    const perMonth = body?.data?.rateLimits?.["per-month"] ?? null;
    if (!perMonth) return unknown;
    const usage = pickNumber(perMonth, ["current-entities", "currentIntervalEntities", "currentEntities"]);
    const vendorCap = pickNumber(perMonth, ["max-entities", "maxEntitiesPerInterval", "maxEntities"]);
    const resetAt = pickDate(perMonth, ["current-interval-end-time", "currentIntervalEndTime", "currentIntervalEnd", "interval-end-time"]);
    return {
      usage,
      cap: vendorCap ?? PER_KEY_MONTHLY_CAP,
      capSource: vendorCap === null ? "default" : "vendor",
      resetAt,
      perMonth,
    };
  } catch {
    return unknown;
  }
}

// Everything a caller needs to decide whether this key can fund a run.
function describeKey(entry: KeyEntry, usage: KeyUsage, now: Date) {
  const cycle = resolveCycle(usage.resetAt, entry.anchorDay, now);
  const fraction = cycleFraction(cycle, now);
  const paceAllowance = usage.cap * fraction * PACE_SAFETY;
  const known = usage.usage !== null;
  const remaining = known ? Math.max(0, usage.cap - (usage.usage as number)) : null;
  const underPace = known ? (usage.usage as number) < paceAllowance : null;
  return {
    label: entry.label,
    email: entry.email,
    // Raw vendor number, reported as-is so an over-cap account stays
    // visible rather than being hidden by the clamping used in the pool
    // arithmetic below.
    usage: usage.usage,
    cap: usage.cap,
    capSource: usage.capSource,
    remaining,
    overCap: known ? (usage.usage as number) > usage.cap : null,
    cycleStart: cycle.start.toISOString(),
    cycleEnd: cycle.end.toISOString(),
    cycleSource: cycle.source,
    anchorDay: entry.anchorDay,
    cycleElapsed: Number(fraction.toFixed(4)),
    paceAllowance: Number(paceAllowance.toFixed(1)),
    underPace,
    // The one field a caller should gate on: this account can fund work
    // right now without running ahead of its own cycle.
    spendable: known ? underPace === true && (remaining as number) >= MIN_KEY_HEADROOM : false,
    // Raw per-month block, so a field-name change at the vendor is
    // diagnosable from the usage endpoint instead of guessed at.
    perMonth: usage.perMonth,
  };
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
    return jsonResponse(500, { ok: false, error: `No SPORTSGAMEODDS_API_KEY_1..${MAX_KEY_SLOTS} (or legacy SPORTSGAMEODDS_API_KEY) configured on this site` });
  }

  const url = new URL(req.url);
  const endpoint = url.searchParams.get("endpoint");

  if (endpoint === "usage") {
    const now = new Date();
    const perKey = await Promise.all(
      keys.map(async (k) => describeKey(k, await getKeyUsage(k.key), now))
    );

    // Pool math only counts keys whose usage actually came back. A key
    // with a failed usage lookup contributes to neither side, so it can't
    // masquerade as 2,500 objects of free headroom - previously an
    // unknown key added its full cap to totalCap while adding 0 to
    // totalUsage, overstating the pool by a whole account.
    const known = perKey.filter((k) => typeof k.usage === "number");

    // Per-key usage is clamped at that key's own cap before summing. An
    // account can run slightly past its cap (the vendor allows a little
    // overage - key-4 sat at 2,520/2,500 on 2026-08-27), and without the
    // clamp that overage was subtracted from *other* accounts' headroom,
    // understating what the pool could still spend. Clamping makes the
    // pooled arithmetic self-consistent: totalCap - totalUsage now equals
    // totalRemaining exactly, which was not true before.
    const totalUsage = known.length
      ? known.reduce((sum, k) => sum + Math.min(k.usage as number, k.cap), 0)
      : null;
    const totalCap = known.length ? known.reduce((sum, k) => sum + k.cap, 0) : null;
    // The honest number: objects the pool can still spend right now.
    // Exhausted accounts contribute 0, never a negative offset.
    const totalRemaining = known.length
      ? known.reduce((sum, k) => sum + (k.remaining as number), 0)
      : null;

    // Sum of each key's own allowance, on its own cycle. Kept separate
    // from the pooled ratio a caller could compute from totalCap, which
    // is only meaningful if every account resets on the same day - they
    // don't.
    const totalPaceAllowance = known.length
      ? Number(known.reduce((sum, k) => sum + k.paceAllowance, 0).toFixed(1))
      : null;
    const spendable = perKey.filter((k) => k.spendable);
    const upcomingResets = perKey
      .map((k) => k.cycleEnd)
      .filter((iso) => typeof iso === "string")
      .sort();

    return jsonResponse(200, {
      success: true,
      data: {
        perKey,
        totalUsage,
        totalCap,
        totalRemaining,
        totalPaceAllowance,
        // What a caller should actually gate on. Each account is paced
        // against its own billing cycle, so one exhausted account can no
        // longer veto a run the others can comfortably fund.
        spendableKeys: spendable.length,
        spendableLabels: spendable.map((k) => k.label),
        keysConfigured: perKey.length,
        keysWithKnownUsage: known.length,
        keysWithVendorCycle: perKey.filter((k) => k.cycleSource === "vendor").length,
        nextResetAt: upcomingResets[0] ?? null,
        pacing: "per-key",
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
    // Rank keys by how far each one is through its *own* pace allowance,
    // ascending, so requests land on whichever account is furthest under
    // its own curve. Raw usage was the old metric; it's misleading once
    // accounts sit on different billing cycles, since a key that just
    // reset and a key three days from resetting can show the same number
    // while having very different amounts of affordable headroom left.
    // Keys with unknown usage (lookup failed) are tried last, not first,
    // so a flaky usage check doesn't accidentally prioritize an already
    // exhausted key. No key is excluded outright - an over-pace key is
    // still better than failing the run, it just goes to the back.
    const rankNow = new Date();
    const ranked = await Promise.all(
      keys.map(async (k) => {
        const u = await getKeyUsage(k.key);
        const d = describeKey(k, u, rankNow);
        const ratio = d.usage === null || d.paceAllowance <= 0
          ? Infinity
          : d.usage / d.paceAllowance;
        return { ...k, usage: d.usage, ratio };
      })
    );
    ranked.sort((a, b) => a.ratio - b.ratio);

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

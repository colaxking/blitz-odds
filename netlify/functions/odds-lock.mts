import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Concurrency lock for the blitz-odds-odds-refresh scheduled task. Backed by
// the same `blitz-odds-live` Blobs store used by odds-current/odds-update.
//
// Added after a real incident (2026-07-31): monthly SportsGameOdds usage
// jumped 908 -> 2,520 objects (over the 2,500 free-tier cap) in a couple of
// minutes because two runs of the odds-refresh task overlapped - a run still
// retrying against rate limits was in flight when the next 15-minute fire
// started, and both runs read a stale "under budget" usage number before
// either had published, so both went ahead and re-fetched the full
// remaining-season event set.
//
// Contract: POST { runId } to acquire - 200 { acquired: true } if free, 409
// { acquired: false, holder, ageSeconds } if another run already holds it.
// DELETE { runId } to release - only clears the lock if it's still held by
// that exact runId, and reports whether anything was actually released.
//
// Self-expiring: a held lock older than LOCK_TTL_MS is treated as abandoned
// and can be acquired by the next run. This is what guarantees the lock
// still gets released even if a run never reaches its own cleanup step at
// all - including a run where BOTH the primary and backup SportsGameOdds
// API keys fail and the task exits early/errors before "Finishing each
// run". A stuck lock can only cost one missed 15-minute cycle, never more.

const STORE_NAME = "blitz-odds-live";
const LOCK_KEY = "odds-refresh-lock";
// A run fires every 15 minutes; 12 minutes is long enough to cover normal
// pagination/retries but always clears before the *next* scheduled fire, so
// a genuinely wedged lock never survives more than one missed cycle.
const LOCK_TTL_MS = 12 * 60 * 1000;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-odds-update-secret",
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

type LockDoc = { holder: string; acquiredAt: number };

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST" && req.method !== "DELETE") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const expectedSecret = process.env.ODDS_UPDATE_SECRET;
  if (!expectedSecret) {
    // Fail closed, same pattern as odds-update.mts: refuse to proceed
    // rather than handing out/releasing locks with no auth configured.
    return jsonResponse(500, { ok: false, error: "ODDS_UPDATE_SECRET not configured on this site" });
  }

  const providedSecret = req.headers.get("x-odds-update-secret");
  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-odds-update-secret header" });
  }

  let body: any;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const runId = typeof body.runId === "string" && body.runId.trim() ? body.runId.trim() : null;
  if (!runId) {
    return jsonResponse(400, { ok: false, error: "body.runId is required" });
  }

  const store = getStore(STORE_NAME);

  if (req.method === "DELETE") {
    // Only release if this exact runId still holds the lock - a run must
    // never clear a lock a newer run has since legitimately acquired (e.g.
    // this run's own TTL already expired and someone else took over before
    // this DELETE arrived).
    let current: LockDoc | null = null;
    try {
      current = (await store.get(LOCK_KEY, { type: "json" })) as LockDoc | null;
    } catch (err) {
      return jsonResponse(502, { ok: false, error: err instanceof Error ? err.message : "Failed to read lock" });
    }
    const stillHeldByUs = !!current && current.holder === runId;
    if (stillHeldByUs) {
      await store.delete(LOCK_KEY);
    }
    return jsonResponse(200, { ok: true, released: stillHeldByUs });
  }

  // POST = acquire.
  const now = Date.now();
  let existing: LockDoc | null = null;
  try {
    existing = (await store.get(LOCK_KEY, { type: "json" })) as LockDoc | null;
  } catch (err) {
    return jsonResponse(502, { ok: false, error: err instanceof Error ? err.message : "Failed to read lock" });
  }

  if (existing && existing.holder && typeof existing.acquiredAt === "number") {
    const ageMs = now - existing.acquiredAt;
    if (ageMs < LOCK_TTL_MS) {
      return jsonResponse(409, {
        ok: false,
        acquired: false,
        holder: existing.holder,
        ageSeconds: Math.round(ageMs / 1000),
      });
    }
    // Existing lock is older than the TTL - treat it as abandoned (the run
    // that held it crashed, timed out, or otherwise never reached its own
    // release step, e.g. after both API keys failed) and let this run take
    // over rather than staying wedged.
  }

  await store.setJSON(LOCK_KEY, { holder: runId, acquiredAt: now } satisfies LockDoc);
  return jsonResponse(200, { ok: true, acquired: true });
};

export const config: Config = {
  path: "/.netlify/functions/odds-lock",
};

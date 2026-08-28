import type { Config } from "@netlify/functions";

// ---------------------------------------------------------------------------
// Keeps the analytics-summary cache warm.
// ---------------------------------------------------------------------------
// analytics-summary recomputes every range from a full scan of the session
// store, which takes roughly 20-25s against current data. That's fine as an
// occasional cost but unacceptable on an interactive request, and a short
// cache TTL just moves the pain around: every time it expires, whoever
// refreshes next pays the full scan.
//
// So the TTL is long (see CACHE_TTL_MS there) and this job re-warms each
// traffic-source variant on a schedule. `?fresh=1` forces the rescan and the
// cache write; the response body is discarded. Runs as a background function
// (15 min budget) because three sequential scans comfortably exceed the
// synchronous function timeout.
//
// The sources are warmed one at a time rather than in parallel: they each
// walk the same blob store, and running them concurrently just contends for
// the same reads without finishing any sooner.
const SOURCES = ["live", "live-nodc", "all"];

// Only the ranges worth pre-warming individually - the cache envelope holds
// every range from one scan anyway, so this loop is per source, not per range.
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base) {
    return new Response(JSON.stringify({ ok: false, error: "No site URL in env" }), { status: 500 });
  }

  const results: Record<string, string> = {};
  for (const source of SOURCES) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/.netlify/functions/analytics-summary?range=30d&source=${source}&fresh=1`);
      results[source] = res.ok ? `ok in ${Math.round((Date.now() - started) / 1000)}s` : `HTTP ${res.status}`;
    } catch (err) {
      results[source] = `failed: ${(err as Error).message}`;
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  // Every 5 minutes, comfortably inside the 10-minute fresh window so an
  // interactive request should never find a stale cache in normal operation.
  schedule: "*/5 * * * *",
};

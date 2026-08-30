import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Public read endpoint for the rest of the app's data (teams, players,
// schedule, history, preseason, playoffs) - companion to site-data-update.mts.
// Two modes:
//   GET /.netlify/functions/site-data-current            -> combined snapshot,
//     only including keys that have actually been published at least once.
//     This is what the live site polls (one request instead of six).
//   GET /.netlify/functions/site-data-current?type=teams -> just that one
//     document, or 404 if never published. This is what the weekly task uses
//     to fetch-before-merge the same way the odds task does.

const STORE_NAME = "blitz-site-data";
// "espnInjuries" is the mirror of ESPN's league-wide injury feed. It is
// NEVER the source of truth for a player's status - data/impact-players.json
// ("players") is, and stays so. This is the second, sourced layer the injury
// block renders underneath the curated one, plus what the poller diffs to
// decide an alert is warranted.
const VALID_KEYS = new Set(["teams", "players", "schedule", "history", "preseason", "playoffs", "espnInjuries"]);

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

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const url = new URL(req.url);
  const type = url.searchParams.get("type");

  try {
    if (type) {
      if (!VALID_KEYS.has(type)) {
        return jsonResponse(400, { ok: false, error: `Unknown type. Valid: ${[...VALID_KEYS].join(", ")}` });
      }
      // Strong consistency on the single-doc path only. This is the
      // fetch-before-merge mode the weekly tasks use (history-results-refresh,
      // the injury syncs): they read a doc, mutate it, and write it straight
      // back, so a stale read silently reverts whatever the previous run
      // published. Default eventual consistency was also why a purge could
      // look like it had failed - the read-back right after the write still
      // showed the old doc for a few seconds.
      const store = getStore(STORE_NAME, { consistency: "strong" });
      const doc = await store.get(type, { type: "json" });
      if (!doc) {
        return jsonResponse(404, { ok: false, error: `No ${type} published yet` });
      }
      return jsonResponse(200, doc);
    }

    // Combined snapshot: fetch every key in parallel, omit any that have
    // never been published so the client's existing "did this actually
    // change" validation can leave that piece alone.
    //
    // Deliberately left eventually consistent: this is the hot path every
    // visitor polls on page load, it's read-only, and a few seconds of lag on
    // a stats snapshot costs nothing. Only the mutating callers above pay the
    // strong-read latency.
    const store = getStore(STORE_NAME);
    const keys = [...VALID_KEYS];
    const docs = await Promise.all(keys.map((k) => store.get(k, { type: "json" })));
    const combined: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      if (docs[i]) combined[k] = docs[i];
    });
    return jsonResponse(200, combined);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/site-data-current",
};

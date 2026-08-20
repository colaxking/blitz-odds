import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Public read endpoint for the Hot Picks track record feature - companion
// to hotpicks-update.mts. Same shape as site-data-current.mts:
//   GET /.netlify/functions/hotpicks-current                  -> combined
//     snapshot of everything published so far.
//   GET /.netlify/functions/hotpicks-current?type=snapshots    -> just the
//     frozen weekly picks doc (what hotpicks-snapshot.mjs writes and reads
//     back for its fetch-before-merge).
//   GET /.netlify/functions/hotpicks-current?type=grades       -> per-week
//     graded picks with results.
//   GET /.netlify/functions/hotpicks-current?type=aggregate    -> season
//     totals by market, plus a per-week breakdown. This is what the live
//     site's Track Record panel reads.

const STORE_NAME = "blitz-picks-track-record";
const VALID_KEYS = new Set(["snapshots", "grades", "aggregate"]);

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

// Returned when nothing has been published yet (e.g. before Week 1's first
// snapshot run) so the client's UI can render an honest "no data yet"
// state instead of erroring.
const EMPTY_SNAPSHOTS = { weeks: {} };
const EMPTY_GRADES = { weeks: {} };
const EMPTY_AGGREGATE = {
  season: null,
  updatedAt: null,
  hasData: false,
  confidencePicks: { wins: 0, losses: 0 },
  spreadPicks: { wins: 0, losses: 0, pushes: 0 },
  moneylinePicks: { wins: 0, losses: 0 },
  totalPicks: { wins: 0, losses: 0, pushes: 0 },
  byWeek: [],
};

function emptyFor(key: string) {
  if (key === "snapshots") return EMPTY_SNAPSHOTS;
  if (key === "grades") return EMPTY_GRADES;
  return EMPTY_AGGREGATE;
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
    const store = getStore(STORE_NAME);

    if (type) {
      if (!VALID_KEYS.has(type)) {
        return jsonResponse(400, { ok: false, error: `Unknown type. Valid: ${[...VALID_KEYS].join(", ")}` });
      }
      const doc = await store.get(type, { type: "json" });
      return jsonResponse(200, doc || emptyFor(type));
    }

    const keys = [...VALID_KEYS];
    const docs = await Promise.all(keys.map((k) => store.get(k, { type: "json" })));
    const combined: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      combined[k] = docs[i] || emptyFor(k);
    });
    return jsonResponse(200, combined);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/hotpicks-current",
};

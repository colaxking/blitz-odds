import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Write endpoint for scripts/prediction-snapshot.mjs. Same pattern as
// hotpicks-update.mts / odds-update.mts: writing to Blobs here goes live
// immediately without a git push + Netlify build.
//
// One key per game (`pred:{season}:{week}:{gameId}`) rather than one doc per
// week. Netlify Blobs `set()` is a full-key overwrite with no merge, so a
// per-week document would mean read-modify-write on every freeze, and two
// overlapping runs of a job that fires every few minutes would silently drop
// whichever game the loser of the race had just added. Per-game keys make
// each write independent and the race impossible.
//
// Writes are also append-only by default: a game already frozen is left
// alone unless `force` is set. The whole point of the snapshot is that it
// records what the model said at kickoff, so a later run must never be able
// to quietly restate it.

const STORE_NAME = "blitz-predictions";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-predictions-update-secret",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

interface IncomingPrediction {
  season: number;
  week: number;
  gameId: string;
  away: string;
  home: string;
  predictedWinner: string;
  homeWinProbability: number;
  awayWinProbability: number;
  kickoffUtcMs: number;
  frozenAt: string;
  late?: boolean;
  odds?: unknown;
}

function isValid(p: any): p is IncomingPrediction {
  return (
    p &&
    Number.isFinite(p.season) &&
    Number.isFinite(p.week) &&
    typeof p.gameId === "string" && p.gameId.length > 0 &&
    typeof p.away === "string" && typeof p.home === "string" &&
    typeof p.predictedWinner === "string" &&
    Number.isFinite(p.homeWinProbability) &&
    Number.isFinite(p.awayWinProbability) &&
    Number.isFinite(p.kickoffUtcMs)
  );
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const secret = process.env.PREDICTIONS_UPDATE_SECRET;
  if (!secret) return jsonResponse(500, { ok: false, error: "PREDICTIONS_UPDATE_SECRET is not configured" });
  if (req.headers.get("x-predictions-update-secret") !== secret) {
    return jsonResponse(401, { ok: false, error: "Unauthorized" });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Body must be valid JSON" });
  }

  const predictions: any[] = Array.isArray(body?.predictions) ? body.predictions : [];
  if (!predictions.length) return jsonResponse(400, { ok: false, error: "predictions[] is required" });

  // Preseason is out of scope - a pick'em track record shouldn't be graded
  // on exhibition games where starters play a quarter.
  const invalid = predictions.filter((p) => !isValid(p) || p.week < 1);
  if (invalid.length) {
    return jsonResponse(400, { ok: false, error: `${invalid.length} prediction(s) failed validation or were out of scope (week < 1)` });
  }

  const force = body?.force === true;
  const store = getStore(STORE_NAME, { consistency: "strong" });

  const written: string[] = [];
  const skipped: string[] = [];
  try {
    for (const p of predictions as IncomingPrediction[]) {
      const key = `pred:${p.season}:${p.week}:${p.gameId}`;
      if (!force) {
        const existing = await store.get(key, { type: "json" });
        if (existing) { skipped.push(p.gameId); continue; }
      }
      await store.setJSON(key, p);
      written.push(p.gameId);
    }
    return jsonResponse(200, { ok: true, written, skipped });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/predictions-update",
};

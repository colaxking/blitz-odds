import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Public read endpoint for the kickoff-frozen model predictions written by
// scripts/prediction-snapshot.mjs via predictions-update.mts. Companion to
// odds-current.mts / weather-current.mts, and polled the same way: the live
// site swaps in the frozen record for any game that has already started, so
// a card for a live or final game shows what the model said before kickoff
// instead of recomputing against injuries, weather and lines that have moved
// since. Before kickoff there is nothing frozen and the card keeps computing
// live, which is the correct answer for a game that hasn't happened yet.
//
// Scoped to one week per request (`?week=`). The store is keyed per game
// (`pred:{season}:{week}:{gameId}`) precisely so writes can't race, which
// means a read has to list-then-get; a week is ~16 objects, a season is
// ~272. The site only ever renders one week at a time, so the week scope
// keeps the common request cheap.

const STORE_NAME = "blitz-predictions";
const DEFAULT_SEASON = 2026;

// @ts-ignore - plain JS UMD module, no type declarations
import PredictionEngine from "../../js/predictionEngine.js";

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

/**
 * Bring a stored record up to what the card needs, whatever schema it was
 * written under.
 *
 * schema 1 (everything frozen before this endpoint existed) has two defects,
 * both from the same missing argument: prediction-snapshot.mjs called
 * predictMatchup() without `week`, so the win probability was projected
 * through MARGIN_SD even in weeks 1-4 where the card itself uses the wider
 * EARLY_SEASON_MARGIN_SD - the frozen number reads as *more* confident than
 * the one the reader actually saw. And predictedMargin was never stored at
 * all, so an ats or confidence read can't be rebuilt from it.
 *
 * Both are recoverable without re-fetching anything, because the margin is
 * what the model actually produced and the SD only projects it: invert the
 * probability through the SD that was wrongly used (always MARGIN_SD, since
 * no week was passed), which returns the true margin, then re-project that
 * margin through the SD the week should have had. Weeks 5+ are unaffected by
 * the re-projection - same SD both ways - and get the margin filled in.
 *
 * Deliberately done on read rather than by re-running the snapshot with
 * FORCE_REFREEZE: a re-freeze today would recompute against today's injuries
 * and weather, which is the exact thing this whole mechanism exists to
 * prevent. The stored record stays untouched.
 */
function normalizeRecord(raw: any, week: number) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.schema >= 2 && Number.isFinite(raw.predictedMargin)) {
    return Number.isFinite(raw.confidence)
      ? raw
      : { ...raw, confidence: Math.max(raw.homeWinProbability, raw.awayWinProbability) };
  }

  const storedHomeProb = Number(raw.homeWinProbability);
  if (!Number.isFinite(storedHomeProb)) return null;

  // `null` week -> MARGIN_SD, which is what the schema-1 write used.
  const predictedMargin = PredictionEngine.winProbabilityToMargin(storedHomeProb, null);
  const homeWinProbability = PredictionEngine.marginToWinProbability(predictedMargin, week);
  const awayWinProbability = 1 - homeWinProbability;

  return {
    ...raw,
    schema: 2,
    predictedMargin,
    homeWinProbability,
    awayWinProbability,
    confidence: Math.max(homeWinProbability, awayWinProbability),
    // Flagged rather than silent: this record's probability was rebuilt, not
    // read. predictedWinner is untouched either way - the SD can't move a
    // margin across zero, so the call itself was never in question.
    repaired: true,
  };
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const url = new URL(req.url);
  const week = Number(url.searchParams.get("week"));
  const season = Number(url.searchParams.get("season")) || DEFAULT_SEASON;

  // Preseason is never frozen (see predictions-update), so an out-of-range
  // week is an empty answer rather than an error - the client treats "no
  // frozen record" as "keep computing live" and this is just that, in bulk.
  if (!Number.isFinite(week) || week < 1) {
    return jsonResponse(200, { season, week: Number.isFinite(week) ? week : null, games: {} });
  }

  try {
    const store = getStore(STORE_NAME);
    const prefix = `pred:${season}:${week}:`;
    const { blobs } = await store.list({ prefix });

    const entries = await Promise.all(
      (blobs || []).map(async (b: { key: string }) => {
        try {
          const raw = await store.get(b.key, { type: "json" });
          return normalizeRecord(raw, week);
        } catch {
          // One unreadable key shouldn't cost the whole week its frozen
          // numbers - that game just falls back to a live read on the card.
          return null;
        }
      })
    );

    const games: Record<string, unknown> = {};
    for (const rec of entries) {
      if (!rec) continue;
      // Keyed the way the client looks a game up on a card, not by the
      // storage key: getFrozenPrediction() has `away` and `home` in hand and
      // no reason to rebuild a gameId string to find them.
      games[`${rec.away}-${rec.home}`] = rec;
    }

    return jsonResponse(200, { season, week, games });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/predictions-current",
};

import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Public league discovery for the Leagues landing page's search section.
// No auth required - signed-out visitors can browse/search public leagues
// too (they just get prompted to sign in when they try to actually join,
// same as league-join.mts enforces server-side).
//
// GET /.netlify/functions/leagues-search?q=text&limit=20
//   -> { ok, leagues: [ { id, name, description, format, memberCount,
//        maxMembers, season, createdAt }, ... ], total }
//   Only leagues with visibility "public" are ever returned. inviteCode is
//   deliberately omitted from results - public leagues are joined by id
//   (league-join.mts), not by code, so there's no reason to hand one out.
//
// Scale note: there's no maintained public-league index yet, so this scans
// every "league:*" blob and filters in memory. That's fine at today's
// league count; if it grows into the thousands this should switch to an
// index blob kept in sync by league-create/league-settings-update/
// league-delete instead of listing everything on every search.

const LEAGUE_STORE = "blitz-leagues";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

function toSearchResult(league: any) {
  return {
    id: league.id,
    name: league.name,
    description: league.description || "",
    format: league.format,
    memberCount: league.memberCount,
    maxMembers: league.maxMembers,
    season: league.season,
    createdAt: league.createdAt,
  };
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 20, 1), 50);

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "eventual" });

  try {
    const { blobs } = await leagueStore.list({ prefix: "league:" });
    const fetched = await Promise.all(
      blobs.map((b) => leagueStore.get(b.key, { type: "json" }).catch(() => null))
    );

    let results = fetched.filter((l: any) => l && l.visibility === "public");
    if (q) {
      results = results.filter((l: any) => typeof l.name === "string" && l.name.toLowerCase().includes(q));
    }
    results.sort((a: any, b: any) => (b.memberCount || 0) - (a.memberCount || 0));

    const total = results.length;
    const page = results.slice(0, limit).map(toSearchResult);

    return jsonResponse(200, { ok: true, leagues: page, total });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/leagues-search",
};

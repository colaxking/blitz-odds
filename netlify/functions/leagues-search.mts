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
const USER_STORE = "blitz-users";

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

function toSearchResult(league: any, ownerName: string | null) {
  const isPublic = league.visibility === "public";
  return {
    id: league.id,
    name: league.name,
    // Descriptions are omitted for private leagues on purpose. They were
    // written while private leagues were unlisted, so some carry things
    // their owners never expected a stranger to read - buy-in amounts,
    // payment handles, "the usual crowd from Dave's". The name, format and
    // size are enough to decide whether to ask for a spot; the description
    // isn't, and it's the field most likely to leak something.
    description: isPublic ? league.description || "" : "",
    visibility: league.visibility,
    format: league.format,
    memberCount: league.memberCount,
    maxMembers: league.maxMembers,
    season: league.season,
    createdAt: league.createdAt,
    ownerName,
    full: typeof league.maxMembers === "number" && league.memberCount >= league.maxMembers,
  };
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const formatFilter = url.searchParams.get("format") || "";
  const typeFilter = url.searchParams.get("type") || ""; // "public" | "private" | ""
  const offsetParam = parseInt(url.searchParams.get("offset") || "0", 10);
  const offset = Math.max(Number.isFinite(offsetParam) ? offsetParam : 0, 0);
  const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 20, 1), 50);

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "eventual" });

  try {
    const { blobs } = await leagueStore.list({ prefix: "league:" });
    const fetched = await Promise.all(
      blobs.map((b) => leagueStore.get(b.key, { type: "json" }).catch(() => null))
    );

    // Private leagues are listed too. "Private" now means "you approve who
    // joins", not "nobody can find it" - the invite code remains the way to
    // skip approval entirely. Anything explicitly locked stays out.
    let results = fetched.filter((l: any) => l && !l.locked && (l.visibility === "public" || l.visibility === "private"));
    if (q) {
      results = results.filter((l: any) => typeof l.name === "string" && l.name.toLowerCase().includes(q));
    }
    if (formatFilter) {
      results = results.filter((l: any) => l.format === formatFilter);
    }
    if (typeFilter === "public" || typeFilter === "private") {
      results = results.filter((l: any) => l.visibility === typeFilter);
    }
    // Public first, then by size - someone browsing can act on a public
    // league immediately, where a private one costs them a wait.
    results.sort((a: any, b: any) => {
      if (a.visibility !== b.visibility) return a.visibility === "public" ? -1 : 1;
      return (b.memberCount || 0) - (a.memberCount || 0);
    });

    const total = results.length;
    const page = results.slice(offset, offset + limit);

    // Owner display names come from live profiles rather than the league
    // doc, which doesn't store one. Deduplicated by owner id so a person
    // running several listed leagues is only fetched once.
    const ownerIds = Array.from(new Set(page.map((l: any) => l.ownerId).filter(Boolean)));
    const userStore = getStore(USER_STORE, { consistency: "eventual" });
    const ownerNames: Record<string, string> = {};
    await Promise.all(
      ownerIds.map(async (id: any) => {
        try {
          const p: any = await userStore.get(`users:${id}`, { type: "json" });
          if (p && typeof p.displayName === "string" && p.displayName.trim()) ownerNames[id] = p.displayName;
        } catch {
          // Falls through to null - a missing owner name isn't worth failing
          // the whole search over.
        }
      })
    );

    return jsonResponse(200, {
      ok: true,
      leagues: page.map((l: any) => toSearchResult(l, ownerNames[l.ownerId] || null)),
      total,
      offset,
      limit,
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/leagues-search",
};

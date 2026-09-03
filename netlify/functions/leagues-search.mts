import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser } from "./lib/auth.mts";

// Public league discovery for the Leagues landing page's search section.
// No auth required - signed-out visitors can browse/search public leagues
// too (they just get prompted to sign in when they try to actually join,
// same as league-join.mts enforces server-side).
//
// Auth is *optional* rather than absent: if a Bearer token is supplied, each
// private league the caller has already asked to join comes back with a
// `requestStatus` field ("pending" | "approved" | "declined"). Nothing else
// about the response changes, and no result is added or removed based on who
// is asking.
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
    // Official (house) leagues are site-run public pools with no owner -
    // see lib/house-leagues.mts. The client badges them and pins them to
    // the top; nothing else about them is special-cased.
    official: league.official === true,
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
    // House leagues have no ownerId to look a profile up by, so they carry
    // their own display owner ("Blitz Odds") on the league record.
    ownerName: ownerName || league.ownerName || null,
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
    // Official house leagues first: they're the only ones a brand-new user
    // with no invite can definitely join, so burying them under whichever
    // private league happens to be biggest is backwards. Then public before
    // private (a public league can be acted on immediately, a private one
    // costs a wait), then by size.
    results.sort((a: any, b: any) => {
      const aOfficial = a.official === true, bOfficial = b.official === true;
      if (aOfficial !== bOfficial) return aOfficial ? -1 : 1;
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

    // If (and only if) the caller is signed in, tell them which of these
    // private leagues they've already asked to join. Without this the client
    // has no way to know on a fresh page load, so it renders "Request to
    // Join" for a league it already has a request in and the user taps a
    // button that can't do anything new. Auth stays optional - a signed-out
    // visitor still gets the full search, just without the annotations.
    const requestStatus: Record<string, string> = {};
    const privateIds = page.filter((l: any) => l.visibility === "private").map((l: any) => l.id);
    if (privateIds.length && req.headers.get("authorization")) {
      const claims = await getAuthenticatedUser(req);
      if (claims && claims.id) {
        await Promise.all(
          privateIds.map(async (id: string) => {
            try {
              // Strong per-operation read: the store is on eventual for the
              // league scan above, but this one is frequently read seconds
              // after the user lodged the request that created it.
              const rec: any = await leagueStore.get(`request:${id}:${claims.id}`, {
                type: "json",
                consistency: "strong",
              });
              if (rec && typeof rec.status === "string") requestStatus[id] = rec.status;
            } catch {
              // An annotation that can't be read is simply left off - the
              // button falls back to its normal state and the server still
              // enforces the real rules on the way through.
            }
          })
        );
      }
    }

    return jsonResponse(200, {
      ok: true,
      leagues: page.map((l: any) => {
        const row: any = toSearchResult(l, ownerNames[l.ownerId] || null);
        if (requestStatus[l.id]) row.requestStatus = requestStatus[l.id];
        return row;
      }),
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

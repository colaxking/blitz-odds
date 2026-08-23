import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";

// GET /.netlify/functions/standings-get?leagueId={id}[&week={n}]
//   -> { ok, format, season: [{userId,rank,points,correct,incorrect}],
//        week?: {...} (only if ?week= was passed),
//        survivor?: { [userId]: {alive, usedTeams, eliminatedWeek} } }
//
// Reads only - all the actual scoring happens in results-process.mts.

const LEAGUE_STORE = "blitz-leagues";

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId = claims.id;

  const url = new URL(req.url);
  const leagueId = url.searchParams.get("leagueId") || "";
  const week = url.searchParams.get("week") ? Number(url.searchParams.get("week")) : null;
  if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId query param is required" }, CORS_HEADERS);

  const leagueStore = getStore(LEAGUE_STORE);

  try {
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);

    const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
    const isMember = membersDoc?.members?.some((m: any) => m.userId === userId);
    if (!isMember) return jsonResponse(403, { ok: false, error: "Not a member of this league" }, CORS_HEADERS);

    const standingsDoc: any = (await leagueStore.get(`standings:${leagueId}`, { type: "json" })) || { weeks: {}, season: [] };
    const memberById = new Map((membersDoc?.members || []).map((m: any) => [m.userId, m.displayName]));

    const seasonWithNames = (standingsDoc.season || []).map((row: any) => ({
      ...row,
      displayName: memberById.get(row.userId) || "Player",
    }));

    const responseBody: any = {
      ok: true,
      format: league.format,
      season: seasonWithNames,
    };

    if (week) {
      const weekScores = standingsDoc.weeks?.[week] || {};
      responseBody.week = Object.keys(weekScores).map((userId2) => ({
        userId: userId2,
        displayName: memberById.get(userId2) || "Player",
        ...weekScores[userId2],
      }));
    }

    if (league.format === "survivor") {
      const survivorState: any = (await leagueStore.get(`survivor:${leagueId}`, { type: "json" })) || {};
      responseBody.survivor = Object.fromEntries(
        Object.entries(survivorState).map(([uid, s]: [string, any]) => [
          uid,
          { ...s, displayName: memberById.get(uid) || "Player" },
        ])
      );
    }

    return jsonResponse(200, responseBody, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/standings-get",
};

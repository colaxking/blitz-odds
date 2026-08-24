import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";

// Deletes a league the caller owns. Owner-only.
//
// POST /.netlify/functions/league-delete   Body: { leagueId }
//
// Removes the core league record (league:{id}, members:{id}, invite:{code})
// and drops the league id from every current member's users:{id}.leagues
// array, so it stops showing up in leagues-mine.mts for everyone, not just
// the owner.
//
// Deliberately does NOT walk and delete every picks:{leagueId}:{week}:*,
// results:{leagueId}:*, standings:{leagueId}, or survivor:{leagueId} key -
// there's no bounded way to enumerate "every week x every member" without
// the schedule + full member history handy, and every reader of those keys
// already checks the league still exists first (results-process.mts's
// per-league loop, picks-mine.mts's membership check, etc.), so leftover
// orphaned data is inert rather than something that can leak into another
// league or resurface in the UI.

const LEAGUE_STORE = "blitz-leagues";
const USER_STORE = "blitz-users";

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId = claims.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" }, CORS_HEADERS);
  }

  const leagueId = typeof body.leagueId === "string" ? body.leagueId : "";
  if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId is required" }, CORS_HEADERS);

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const userStore = getStore(USER_STORE, { consistency: "strong" });

  try {
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);
    if (league.ownerId !== userId) {
      return jsonResponse(403, { ok: false, error: "Only the league owner can delete this league" }, CORS_HEADERS);
    }

    const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
    const memberIds: string[] = (membersDoc?.members || []).map((m: any) => m.userId);

    await Promise.all(memberIds.map(async (memberId) => {
      const profile: any = await userStore.get(`users:${memberId}`, { type: "json" });
      if (!profile || !Array.isArray(profile.leagues)) return;
      const leagues = profile.leagues.filter((id: string) => id !== leagueId);
      if (leagues.length !== profile.leagues.length) {
        await userStore.setJSON(`users:${memberId}`, { ...profile, leagues, updatedAt: new Date().toISOString() });
      }
    }));

    await Promise.all([
      leagueStore.delete(`league:${leagueId}`),
      leagueStore.delete(`members:${leagueId}`),
      league.inviteCode ? leagueStore.delete(`invite:${league.inviteCode}`) : Promise.resolve(),
    ]);

    return jsonResponse(200, { ok: true, leagueId }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-delete",
};

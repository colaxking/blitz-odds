import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";

// Removes the caller from a league they're a member of, without deleting
// the league itself. This is the member-facing counterpart to
// league-delete.mts, which is owner-only - owners can't use this endpoint
// to leave; they either transfer ownership (not implemented yet) or
// delete the league outright, same as before.
//
// POST /.netlify/functions/league-leave   Body: { leagueId }
//
// Same read-modify-write shape as league-join.mts on members:{leagueId}
// (strong consistency store), for the same reason: two people leaving/
// joining in the same eventual-consistency window could otherwise clobber
// each other's write.

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

    if (league.ownerId === userId) {
      return jsonResponse(403, { ok: false, error: "Owners can't leave a league - delete it instead" }, CORS_HEADERS);
    }

    const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
    const members = membersDoc?.members || [];
    const wasMember = members.some((m: any) => m.userId === userId);
    if (!wasMember) return jsonResponse(200, { ok: true, leagueId, wasMember: false });

    const now = new Date().toISOString();
    const updatedMembers = members.filter((m: any) => m.userId !== userId);
    league.memberCount = updatedMembers.length;
    league.updatedAt = now;

    await Promise.all([
      leagueStore.setJSON(`members:${leagueId}`, { ...membersDoc, members: updatedMembers }),
      leagueStore.setJSON(`league:${leagueId}`, league),
    ]);

    const profile: any = await userStore.get(`users:${userId}`, { type: "json" });
    if (profile && Array.isArray(profile.leagues)) {
      const leagues = profile.leagues.filter((id: string) => id !== leagueId);
      await userStore.setJSON(`users:${userId}`, { ...profile, leagues, updatedAt: now });
    }

    return jsonResponse(200, { ok: true, leagueId, wasMember: true });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-leave",
};

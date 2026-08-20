import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Read endpoint for the authenticated caller's own leagues.
//
// GET /.netlify/functions/leagues-mine
//   -> { ok, leagues: [ leagueRecord, ... ] } for every league in the
//      caller's users:{id}.leagues array. Leagues that no longer exist
//      (deleted) are silently skipped rather than erroring the whole call.
//
// GET /.netlify/functions/leagues-mine?leagueId={id}
//   -> { ok, league, members } - full detail + member list for one league,
//      but only if the caller is actually a member (403 otherwise). This is
//      what the standings/pick-submission views will use once they exist.

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

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const claims = (context as any).clientContext && (context as any).clientContext.user;
  if (!claims || !claims.sub) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" });

  const userId: string = claims.sub;
  const url = new URL(req.url);
  const singleLeagueId = url.searchParams.get("leagueId");

  const leagueStore = getStore(LEAGUE_STORE);
  const userStore = getStore(USER_STORE);

  try {
    if (singleLeagueId) {
      const membersDoc: any = await leagueStore.get(`members:${singleLeagueId}`, { type: "json" });
      const isMember = membersDoc && membersDoc.members && membersDoc.members.some((m: any) => m.userId === userId);
      if (!isMember) return jsonResponse(403, { ok: false, error: "Not a member of this league" });

      const league = await leagueStore.get(`league:${singleLeagueId}`, { type: "json" });
      if (!league) return jsonResponse(404, { ok: false, error: "League not found" });

      return jsonResponse(200, { ok: true, league, members: membersDoc.members });
    }

    const profile: any = await userStore.get(`users:${userId}`, { type: "json" });
    const leagueIds: string[] = profile && Array.isArray(profile.leagues) ? profile.leagues : [];

    const leagues = (
      await Promise.all(leagueIds.map((id) => leagueStore.get(`league:${id}`, { type: "json" })))
    ).filter(Boolean);

    return jsonResponse(200, { ok: true, leagues });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/leagues-mine",
};

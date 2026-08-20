import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Joins the authenticated caller to a league via invite code. Idempotent -
// joining a league you're already in just returns the current state rather
// than erroring or duplicating your membership row.
//
// POST /.netlify/functions/league-join   Body: { inviteCode: string }

const LEAGUE_STORE = "blitz-leagues";
const USER_STORE = "blitz-users";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

// Auth: verifies the caller's Netlify Identity JWT against the site's own
// hosted Identity (GoTrue) endpoint - context.clientContext.user is a
// v1/Lambda-handler-only mechanism, never populated for modern v2
// "export default" functions like this one.
async function getAuthenticatedUser(req: Request): Promise<any | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) return null;
  try {
    const identityUrl = `${new URL(req.url).origin}/.netlify/identity/user`;
    const res = await fetch(identityUrl, { headers: { Authorization: authHeader } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" });

  const userId: string = claims.id;
  const displayName =
    (claims.user_metadata && claims.user_metadata.full_name) ||
    (claims.email ? claims.email.split("@")[0] : "Player");

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";
  if (!inviteCode) return jsonResponse(400, { ok: false, error: "Invite code is required" });

  const leagueStore = getStore(LEAGUE_STORE);
  const userStore = getStore(USER_STORE);

  try {
    const inviteRecord: any = await leagueStore.get(`invite:${inviteCode}`, { type: "json" });
    if (!inviteRecord || !inviteRecord.leagueId) {
      return jsonResponse(404, { ok: false, error: "Invite code not found" });
    }
    const leagueId = inviteRecord.leagueId;

    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League no longer exists" });

    const membersDoc: any = (await leagueStore.get(`members:${leagueId}`, { type: "json" })) || {
      leagueId,
      members: [],
    };
    const now = new Date().toISOString();
    const already = membersDoc.members.find((m: any) => m.userId === userId);

    if (!already) {
      membersDoc.members.push({ userId, displayName, role: "member", joinedAt: now });
      league.memberCount = membersDoc.members.length;
      league.updatedAt = now;
      await Promise.all([
        leagueStore.setJSON(`members:${leagueId}`, membersDoc),
        leagueStore.setJSON(`league:${leagueId}`, league),
      ]);
    }

    // Merge-update the joiner's profile with the league id.
    const profile: any = (await userStore.get(`users:${userId}`, { type: "json" })) || {
      id: userId,
      email: claims.email || null,
      displayName,
      subscriptionTier: "free",
      leagues: [],
      createdAt: now,
    };
    const leagues = Array.isArray(profile.leagues) ? profile.leagues : [];
    if (!leagues.includes(leagueId)) leagues.push(leagueId);
    await userStore.setJSON(`users:${userId}`, { ...profile, leagues, updatedAt: now });

    return jsonResponse(200, { ok: true, league, alreadyMember: !!already });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-join",
};

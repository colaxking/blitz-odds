import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Joins the authenticated caller to a league, either via invite code (any
// league) or by leagueId directly (public leagues only - this is what the
// Leagues landing page's search results use, via leagues-search.mts).
// Idempotent - joining a league you're already in just returns the current
// state rather than erroring or duplicating your membership row.
//
// POST /.netlify/functions/league-join   Body: { inviteCode: string }
// POST /.netlify/functions/league-join   Body: { leagueId: string }
//   The leagueId form is rejected with 403 unless that league's visibility
//   is "public" - private/invite_only leagues still require the code.
//
// leagueStore uses strong consistency: this does a read-modify-write on
// members:{leagueId} (read -> push new member -> write the whole doc back),
// so two people joining within the same eventual-consistency window could
// otherwise each read a membersDoc missing the other's not-yet-visible
// write and clobber it (same failure mode found and fixed in
// picks-submit.mts for picks).

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
  const leagueIdInput = typeof body.leagueId === "string" ? body.leagueId.trim() : "";
  if (!inviteCode && !leagueIdInput) {
    return jsonResponse(400, { ok: false, error: "Invite code or league is required" });
  }

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  // Strong consistency - a client that joins and immediately reloads
  // leagues-mine.mts (also strong, below) shouldn't have a chance of
  // reading its own eventually-consistent write back as stale/missing.
  const userStore = getStore(USER_STORE, { consistency: "strong" });

  try {
    let leagueId: string;
    if (inviteCode) {
      const inviteRecord: any = await leagueStore.get(`invite:${inviteCode}`, { type: "json" });
      if (!inviteRecord || !inviteRecord.leagueId) {
        return jsonResponse(404, { ok: false, error: "Invite code not found" });
      }
      leagueId = inviteRecord.leagueId;
    } else {
      leagueId = leagueIdInput;
    }

    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League no longer exists" });
    // Joining by leagueId (no code) only works for public leagues - this is
    // the path search results use. Private/invite_only leagues must go
    // through the invite code branch above even if someone learns the id.
    if (!inviteCode && league.visibility !== "public") {
      return jsonResponse(403, { ok: false, error: "This league requires an invite code to join" });
    }
    if (league.locked) return jsonResponse(403, { ok: false, error: "This league is locked and not accepting new members" });

    const membersDoc: any = (await leagueStore.get(`members:${leagueId}`, { type: "json" })) || {
      leagueId,
      members: [],
    };
    const now = new Date().toISOString();
    const already = membersDoc.members.find((m: any) => m.userId === userId);

    if (!already) {
      if (typeof league.maxMembers === "number" && membersDoc.members.length >= league.maxMembers) {
        return jsonResponse(409, { ok: false, error: "This league is full" });
      }
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

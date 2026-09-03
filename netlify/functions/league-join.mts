import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, displayNameFromClaims } from "./lib/auth.mts";

// Joins the authenticated caller to a league, either via invite code (any
// league) or by leagueId directly (public leagues only - this is what the
// Leagues landing page's search results use, via leagues-search.mts).
// Idempotent - joining a league you're already in just returns the current
// state rather than erroring or duplicating your membership row.
//
// POST /.netlify/functions/league-join   Body: { inviteCode: string }
// POST /.netlify/functions/league-join   Body: { leagueId: string }
//   The leagueId form is rejected with 403 unless that league's visibility
//   is "public" - private leagues still require the code.
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
// Auth is the shared lib/auth.mts verifier, which this function used to
// carry its own copy of. The copy is gone deliberately: the shared one also
// refuses a SUSPENDED account, and a local duplicate would quietly opt this
// endpoint out of that.

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" });

  const userId: string = claims.id;
  const claimsDisplayName = displayNameFromClaims(claims);

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
    // the path search results use. Private leagues must go through the
    // invite code branch above even if someone learns the id.
    if (!inviteCode && league.visibility !== "public") {
      return jsonResponse(403, { ok: false, error: "This league requires an invite code to join" });
    }
    if (league.locked) return jsonResponse(403, { ok: false, error: "This league is locked and not accepting new members" });

    const now = new Date().toISOString();

    // Prefer the user's already-saved profile displayName/avatar over the
    // raw Identity claims - same reasoning as league-create.mts.
    const profile: any = (await userStore.get(`users:${userId}`, { type: "json" })) || {
      id: userId,
      email: claims.email || null,
      displayName: claimsDisplayName,
      subscriptionTier: "free",
      leagues: [],
      createdAt: now,
    };
    const displayName = (typeof profile.displayName === "string" && profile.displayName.trim())
      ? profile.displayName
      : claimsDisplayName;
    const avatar = typeof profile.avatar === "string" ? profile.avatar : null;

    const membersDoc: any = (await leagueStore.get(`members:${leagueId}`, { type: "json" })) || {
      leagueId,
      members: [],
    };
    const already = membersDoc.members.find((m: any) => m.userId === userId);

    if (!already) {
      if (typeof league.maxMembers === "number" && membersDoc.members.length >= league.maxMembers) {
        return jsonResponse(409, { ok: false, error: "This league is full" });
      }
      membersDoc.members.push({ userId, displayName, avatar, role: "member", joinedAt: now });
      league.memberCount = membersDoc.members.length;
      league.updatedAt = now;
      await Promise.all([
        leagueStore.setJSON(`members:${leagueId}`, membersDoc),
        leagueStore.setJSON(`league:${leagueId}`, league),
      ]);
    }

    // A decline is final as far as re-requesting goes, but it must not
    // block an invite: an owner who changes their mind, or who declined the
    // wrong row, sends the code and that has to work. It does - this whole
    // function never consults the request store. What's left over is a stale
    // request record that would keep showing "declined" in the owner's queue
    // for someone now sitting in the members list, so settle it here.
    if (inviteCode) {
      try {
        const reqKey = `request:${leagueId}:${userId}`;
        const pastRequest: any = await leagueStore.get(reqKey, { type: "json" });
        if (pastRequest && pastRequest.status !== "approved") {
          await leagueStore.setJSON(reqKey, {
            ...pastRequest,
            status: "approved",
            handledAt: now,
            resolvedBy: "invite",
          });
        }
      } catch {
        // Bookkeeping only - never fail a successful join over it.
      }
    }

    // Merge-update the joiner's profile with the league id.
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

import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";

// POST /.netlify/functions/league-join-request   Body: { leagueId: string }
//   -> { ok, status: "pending" | "member" }
//
// The path into a private league for someone who doesn't have the invite
// code. Private leagues are listed in search (see leagues-search.mts), so
// this is how a stranger asks for a spot; anyone holding the code still
// skips this entirely and joins directly through league-join.mts.
//
// One key per request (`request:{leagueId}:{userId}`) rather than a single
// document per league. Blobs set() is a full overwrite with no merge, so a
// per-league doc would need read-modify-write and two people requesting at
// the same moment would lose one of them. Per-key writes make that race
// impossible, and the owner's queue reads them with a prefix list().
//
// The requester's display name is snapshotted onto the record so the owner's
// queue renders without a profile fetch per row, the same tradeoff
// members:{leagueId} already makes.

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
  const userId: string = claims.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Body must be valid JSON" }, CORS_HEADERS);
  }

  const leagueId = typeof body.leagueId === "string" ? body.leagueId.trim() : "";
  if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId is required" }, CORS_HEADERS);

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const userStore = getStore(USER_STORE, { consistency: "strong" });

  try {
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League no longer exists" }, CORS_HEADERS);
    if (league.locked) return jsonResponse(403, { ok: false, error: "This league is not accepting new members" }, CORS_HEADERS);
    // A public league has nothing to approve - the caller should have gone
    // straight to league-join. Saying so is more useful than silently
    // creating a request nobody will ever look at.
    if (league.visibility !== "private") {
      return jsonResponse(400, { ok: false, error: "This league can be joined directly" }, CORS_HEADERS);
    }

    const membersDoc: any = (await leagueStore.get(`members:${leagueId}`, { type: "json" })) || { members: [] };
    if (membersDoc.members.some((m: any) => m.userId === userId)) {
      return jsonResponse(200, { ok: true, status: "member" }, CORS_HEADERS);
    }
    if (typeof league.maxMembers === "number" && membersDoc.members.length >= league.maxMembers) {
      return jsonResponse(409, { ok: false, error: "This league is full" }, CORS_HEADERS);
    }

    const key = `request:${leagueId}:${userId}`;
    const existing: any = await leagueStore.get(key, { type: "json" });
    if (existing) {
      // Pending is idempotent. A previous decline is deliberately not
      // re-openable: without that, declining someone just invites them to
      // ask again, and the owner has no way to make it stop.
      if (existing.status === "pending") return jsonResponse(200, { ok: true, status: "pending" }, CORS_HEADERS);
      if (existing.status === "declined") {
        return jsonResponse(403, { ok: false, error: "Your previous request for this league was declined" }, CORS_HEADERS);
      }
    }

    const profile: any = await userStore.get(`users:${userId}`, { type: "json" });
    const displayName =
      (profile && typeof profile.displayName === "string" && profile.displayName.trim())
        ? profile.displayName
        : ((claims.user_metadata && claims.user_metadata.full_name) ||
           (claims.email ? claims.email.split("@")[0] : "Player"));

    await leagueStore.setJSON(key, {
      leagueId,
      userId,
      displayName,
      avatar: profile && typeof profile.avatar === "string" ? profile.avatar : null,
      status: "pending",
      requestedAt: new Date().toISOString(),
    });

    return jsonResponse(200, { ok: true, status: "pending" }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-join-request",
};

import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Creates a new pick'em league. Authenticated (Netlify Identity JWT)
// callers only - the creator becomes the owner and first member.
//
// POST /.netlify/functions/league-create   Body: { name: string }
//
// Data model (single "blitz-leagues" store, prefixed keys - same pattern as
// blitz-site-data's teams/players/schedule/etc):
//   league:{leagueId}          -> league record (name, owner, invite code, season, memberCount)
//   members:{leagueId}         -> { members: [{ userId, displayName, role, joinedAt }] }
//   invite:{inviteCode}        -> { leagueId }   (fast lookup for league-join.mts)
//
// The caller's users:{id} blob (in the separate "blitz-users" store) is
// updated to include the new league in its `leagues` array, so
// leagues-mine.mts doesn't need to scan every league in the store.

const LEAGUE_STORE = "blitz-leagues";
const USER_STORE = "blitz-users";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I - avoids ambiguous invite codes
const CURRENT_SEASON = 2026;

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

function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const claims = (context as any).clientContext && (context as any).clientContext.user;
  if (!claims || !claims.sub) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" });

  const userId: string = claims.sub;
  const displayName =
    (claims.user_metadata && claims.user_metadata.full_name) ||
    (claims.email ? claims.email.split("@")[0] : "Player");

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 50) : "";
  if (!name) return jsonResponse(400, { ok: false, error: "League name is required" });

  const leagueStore = getStore(LEAGUE_STORE);
  const userStore = getStore(USER_STORE);

  try {
    // Generate a unique invite code - collisions are astronomically unlikely
    // at this scale (32^6) but check anyway rather than trust the odds.
    let inviteCode = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateInviteCode();
      const existing = await leagueStore.get(`invite:${candidate}`, { type: "json" });
      if (!existing) {
        inviteCode = candidate;
        break;
      }
    }
    if (!inviteCode) return jsonResponse(500, { ok: false, error: "Could not generate a unique invite code, try again" });

    const leagueId = crypto.randomUUID();
    const now = new Date().toISOString();

    const league = {
      id: leagueId,
      name,
      ownerId: userId,
      ownerName: displayName,
      season: CURRENT_SEASON,
      inviteCode,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    };

    const members = {
      leagueId,
      members: [{ userId, displayName, role: "owner", joinedAt: now }],
    };

    await Promise.all([
      leagueStore.setJSON(`league:${leagueId}`, league),
      leagueStore.setJSON(`members:${leagueId}`, members),
      leagueStore.setJSON(`invite:${inviteCode}`, { leagueId }),
    ]);

    // Merge-update the owner's profile with the new league id.
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

    return jsonResponse(201, { ok: true, league });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-create",
};

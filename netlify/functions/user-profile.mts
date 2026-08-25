import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Authenticated read/write for a single user's profile blob. This is the
// unified record backing both the (future) Pro subscription gate and
// pick'em leagues - one identity, one blob, two feature sets reading/writing
// different fields on it.
//
// Auth: requires a Netlify Identity JWT as a Bearer token. We verify it by
// asking the site's own hosted Identity (GoTrue) instance who the token
// belongs to - context.clientContext.user, which older Netlify Functions
// docs describe, turns out to be a v1/Lambda-compatible-handler-only
// mechanism. It is never populated for modern v2 "export default" functions
// (confirmed via a temporary debug endpoint: Authorization header arrived
// with a valid-looking JWT, but context.clientContext was entirely absent).
// Hitting GET {site}/.netlify/identity/user with the same Bearer token is
// the same verification GoTrue's own client libraries use, and works
// identically regardless of function runtime version. We never trust a
// userId passed in the request body/query for anything other than
// admin-style lookups (not exposed here) - the authenticated user can only
// ever read/write their own record, keyed by their Identity user id.
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
//
// GET  /.netlify/functions/user-profile          -> caller's own profile
//        (creates a default record on first login if none exists yet)
// POST /.netlify/functions/user-profile           -> merge-update caller's
//        own profile. Body: { displayName?, leagues?: string[], settings?: {
//        themeMode?, sportsbookId?, tzId?, favorites? } }
//        subscriptionTier is intentionally not settable here - that will be
//        driven by the Stripe webhook once billing exists.
//
// `settings` mirrors the device-local preferences the app already keeps in
// localStorage (theme, sportsbook, timezone, favorite teams). For signed-in
// users this is the source of truth instead - the client fetches it once on
// sign-in and applies it over whatever was on this device, then pushes any
// further changes back here so the same preferences follow the user to
// their next login/device. Signed-out users keep using localStorage only.

const STORE_NAME = "blitz-users";
const LEAGUE_STORE = "blitz-leagues";
const VALID_THEME_MODES = new Set(["light", "dark", "system"]);
// Mirrors the `id` values in PROFILE_AVATARS in index.html - keep these two
// lists in sync if avatar options are ever added/removed.
const VALID_AVATAR_IDS = new Set([
  "blitz-edge", "bolt", "check",
  "football", "trophy", "medal", "target", "fire", "goat", "chart",
  "shield", "cleat", "cap", "clipboard", "party", "muscle", "flag",
  "clock", "stadium", "horn",
]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

function defaultSettings() {
  return {
    themeMode: "system",
    sportsbookId: "draftkings",
    tzId: "auto",
    favorites: [] as string[],
    tutorialSeen: false,
  };
}

function defaultProfile(claims: any) {
  const now = new Date().toISOString();
  return {
    id: claims.id,
    email: claims.email || null,
    displayName:
      (claims.user_metadata && claims.user_metadata.full_name) ||
      (claims.email ? claims.email.split("@")[0] : "Player"),
    subscriptionTier: "free",
    leagues: [],
    settings: defaultSettings(),
    createdAt: now,
    updatedAt: now,
  };
}

// Whitelists and coerces incoming settings fields rather than trusting the
// body wholesale - this blob is small and cheap to write, but it's still
// client-supplied input.
function sanitizeSettings(input: any, existing: any) {
  const base = existing && typeof existing === "object" ? existing : defaultSettings();
  const out = { ...base };

  if (VALID_THEME_MODES.has(input.themeMode)) out.themeMode = input.themeMode;
  if (typeof input.sportsbookId === "string" && input.sportsbookId.trim()) {
    out.sportsbookId = input.sportsbookId.trim().slice(0, 40);
  }
  if (typeof input.tzId === "string" && input.tzId.trim()) {
    out.tzId = input.tzId.trim().slice(0, 60);
  }
  if (Array.isArray(input.favorites)) {
    out.favorites = [...new Set(input.favorites.filter((f: unknown) => typeof f === "string"))].slice(0, 32);
  }
  // One-way flip: once true (tour completed or skipped), never revert to
  // false from a stale client payload that simply omitted the field.
  if (input.tutorialSeen === true) out.tutorialSeen = true;

  return out;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) {
    return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" });
  }

  const userId: string = claims.id;
  const store = getStore(STORE_NAME);
  const key = `users:${userId}`;

  try {
    if (req.method === "GET") {
      let profile: any = await store.get(key, { type: "json" });
      if (!profile) {
        profile = defaultProfile(claims);
        await store.setJSON(key, profile);
      } else if (!profile.settings) {
        // Profile created before `settings` existed - backfill defaults
        // rather than sending the client an undefined settings object.
        profile = { ...profile, settings: defaultSettings() };
      }
      return jsonResponse(200, profile);
    }

    if (req.method === "POST") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
      }

      const existing: any = (await store.get(key, { type: "json" })) || defaultProfile(claims);

      const updated = {
        ...existing,
        ...(typeof body.displayName === "string" && body.displayName.trim()
          ? { displayName: body.displayName.trim().slice(0, 40) }
          : {}),
        ...(typeof body.avatar === "string" && VALID_AVATAR_IDS.has(body.avatar)
          ? { avatar: body.avatar }
          : {}),
        ...(Array.isArray(body.leagues)
          ? { leagues: body.leagues.filter((l: unknown) => typeof l === "string") }
          : {}),
        ...(body.settings && typeof body.settings === "object"
          ? { settings: sanitizeSettings(body.settings, existing.settings) }
          : {}),
        updatedAt: new Date().toISOString(),
      };

      await store.setJSON(key, updated);

      // Fan out a changed name/avatar to every league roster this user
      // belongs to. League membership rows snapshot displayName/avatar at
      // join time (so standings-get.mts doesn't need to look up every
      // member's profile on every read) - without this, a Settings change
      // here would never show up in League/Standings, which only ever read
      // the frozen copy on the members:{leagueId} blob.
      const nameChanged = updated.displayName !== existing.displayName;
      const avatarChanged = updated.avatar !== existing.avatar;
      if ((nameChanged || avatarChanged) && Array.isArray(updated.leagues) && updated.leagues.length) {
        const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
        await Promise.all(
          updated.leagues.map(async (leagueId: string) => {
            try {
              const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
              if (!membersDoc || !Array.isArray(membersDoc.members)) return;
              const member = membersDoc.members.find((m: any) => m.userId === userId);
              if (!member) return;
              member.displayName = updated.displayName;
              member.avatar = updated.avatar ?? null;
              await leagueStore.setJSON(`members:${leagueId}`, membersDoc);

              if (nameChanged) {
                const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
                if (league && league.ownerId === userId && league.ownerName !== updated.displayName) {
                  league.ownerName = updated.displayName;
                  await leagueStore.setJSON(`league:${leagueId}`, league);
                }
              }
            } catch {
              // Best-effort - a failure to update one league's roster
              // shouldn't fail the profile save itself.
            }
          })
        );
      }

      return jsonResponse(200, updated);
    }

    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/user-profile",
};

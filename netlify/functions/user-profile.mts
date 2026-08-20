import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Authenticated read/write for a single user's profile blob. This is the
// unified record backing both the (future) Pro subscription gate and
// pick'em leagues - one identity, one blob, two feature sets reading/writing
// different fields on it.
//
// Auth: requires a Netlify Identity JWT as a Bearer token. Netlify verifies
// the token and populates context.clientContext.user before this function
// runs (v2/modern functions only - see @netlify/identity docs). We never
// trust a userId passed in the request body/query for anything other than
// admin-style lookups (not exposed here) - the authenticated user can only
// ever read/write their own record, keyed by their Identity `sub` claim.
//
// GET  /.netlify/functions/user-profile          -> caller's own profile
//        (creates a default record on first login if none exists yet)
// POST /.netlify/functions/user-profile           -> merge-update caller's
//        own profile. Body: { displayName?, leagues?: string[] }
//        subscriptionTier is intentionally not settable here - that will be
//        driven by the Stripe webhook once billing exists.

const STORE_NAME = "blitz-users";

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

function defaultProfile(claims: any) {
  const now = new Date().toISOString();
  return {
    id: claims.sub,
    email: claims.email || null,
    displayName:
      (claims.user_metadata && claims.user_metadata.full_name) ||
      (claims.email ? claims.email.split("@")[0] : "Player"),
    subscriptionTier: "free",
    leagues: [],
    createdAt: now,
    updatedAt: now,
  };
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const claims = (context as any).clientContext && (context as any).clientContext.user;
  if (!claims || !claims.sub) {
    return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" });
  }

  const userId: string = claims.sub;
  const store = getStore(STORE_NAME);
  const key = `users:${userId}`;

  try {
    if (req.method === "GET") {
      let profile: any = await store.get(key, { type: "json" });
      if (!profile) {
        profile = defaultProfile(claims);
        await store.setJSON(key, profile);
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
        ...(Array.isArray(body.leagues)
          ? { leagues: body.leagues.filter((l: unknown) => typeof l === "string") }
          : {}),
        updatedAt: new Date().toISOString(),
      };

      await store.setJSON(key, updated);
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

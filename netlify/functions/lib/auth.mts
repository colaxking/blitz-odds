// Verifies the caller's Netlify Identity JWT against the site's own hosted
// Identity (GoTrue) endpoint. context.clientContext.user - what older docs
// describe - is a v1/Lambda-handler-only mechanism and is never populated
// for modern v2 "export default" functions. Hitting the Identity endpoint's
// /user route with the same Bearer token is what GoTrue's own client
// libraries do internally, and works regardless of function runtime.
//
// The existing league-create/league-join/leagues-mine.mts each have their
// own copy of this function (predating this shared lib). New pick'em
// functions should import this one instead of copy-pasting again.

export interface AuthClaims {
  id: string;
  email?: string;
  user_metadata?: { full_name?: string };
  [key: string]: unknown;
}

/**
 * Verification is a full network round trip to GoTrue on every single call,
 * and a warm function instance frequently sees the same token twice in a
 * few seconds - a Settings screen that reads then writes, a UI that fires
 * two fetches on open. Caching the successful result for a minute removes
 * that second hop without meaningfully widening the revocation window: a
 * Netlify Identity access token lives an hour, so a token invalidated by
 * logout is at worst honoured 60s longer on one warm instance.
 *
 * Only successes are cached. A failure can be a genuine 401 or a transient
 * Identity blip, and caching the latter would lock a legitimate user out
 * for the rest of the TTL.
 */
const VERIFY_TTL_MS = 60_000;
const VERIFY_CACHE_MAX = 500;
const verifyCache = new Map<string, { claims: AuthClaims; expiresAt: number }>();

export async function getAuthenticatedUser(req: Request): Promise<AuthClaims | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) return null;

  const now = Date.now();
  const hit = verifyCache.get(authHeader);
  if (hit && hit.expiresAt > now) return hit.claims;
  if (hit) verifyCache.delete(authHeader);

  try {
    const identityUrl = `${new URL(req.url).origin}/.netlify/identity/user`;
    const res = await fetch(identityUrl, { headers: { Authorization: authHeader } });
    if (!res.ok) return null;
    const claims = (await res.json()) as AuthClaims;

    // Unbounded growth on a long-lived warm instance is the only real risk
    // here, so evict wholesale rather than tracking an LRU for something
    // that refills in one round trip.
    if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.clear();
    verifyCache.set(authHeader, { claims, expiresAt: now + VERIFY_TTL_MS });
    return claims;
  } catch {
    return null;
  }
}

export function displayNameFromClaims(claims: AuthClaims): string {
  return claims.user_metadata?.full_name || (claims.email ? claims.email.split("@")[0] : "Player");
}

export const CORS_HEADERS_BASE: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS_BASE, ...extraHeaders },
  });
}

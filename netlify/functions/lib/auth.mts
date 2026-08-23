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

export async function getAuthenticatedUser(req: Request): Promise<AuthClaims | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) return null;
  try {
    const identityUrl = `${new URL(req.url).origin}/.netlify/identity/user`;
    const res = await fetch(identityUrl, { headers: { Authorization: authHeader } });
    if (!res.ok) return null;
    return (await res.json()) as AuthClaims;
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

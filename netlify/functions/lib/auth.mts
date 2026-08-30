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
  created_at?: string;
  user_metadata?: {
    full_name?: string;
    /** Set by auth-verify.mts / auth-reset.mts. See isUnverified below. */
    email_verified?: boolean;
    email_verified_at?: string;
    [key: string]: unknown;
  };
  app_metadata?: {
    roles?: string[];
    /** Set by admin-user-update's "set-suspended" action. See below. */
    suspended?: boolean;
    suspendedAt?: string;
    suspendedReason?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/* ------------------------------------------------------------------------ */
/* Suspension                                                                */
/* ------------------------------------------------------------------------ */

/**
 * A suspended account still has a valid login. GoTrue will happily keep
 * issuing it tokens, because suspension is OUR concept, stored on the
 * Identity record's app_metadata rather than in anything GoTrue enforces.
 *
 * WHY NOT JUST DELETE THEM. Deletion is irreversible and takes their picks
 * and league history with it. Most of the reasons to cut someone off - a
 * pool dispute, a suspected shared login, a support case that needs the
 * account frozen while it's sorted out - are reasons to stop them acting,
 * not reasons to destroy a season's worth of data that other members' league
 * tables are built from. Suspension is the reversible half of that pair.
 *
 * WHY THE CHECK LIVES HERE. Twenty-odd functions call getAuthenticatedUser
 * and every one of them is a way to act on the site. Gating each individually
 * means the suspension is only as good as the last person to remember it, and
 * the failure mode is silent: a missed endpoint is a suspended user who can
 * still submit picks, with nothing in any log to say so. Making the shared
 * verifier refuse them closes all of those at once, and closes any endpoint
 * added later by default.
 */
export function isSuspended(claims: AuthClaims | null): boolean {
  return Boolean(claims?.app_metadata?.suspended);
}

export interface SuspensionInfo {
  suspended: boolean;
  reason?: string;
  at?: string;
}

export function suspensionInfo(claims: AuthClaims | null): SuspensionInfo {
  if (!isSuspended(claims)) return { suspended: false };
  const meta = claims!.app_metadata!;
  return {
    suspended: true,
    ...(meta.suspendedReason ? { reason: String(meta.suspendedReason) } : {}),
    ...(meta.suspendedAt ? { at: String(meta.suspendedAt) } : {}),
  };
}

export const SUSPENDED_CODE = "account_suspended";

/**
 * The one response shape a suspended caller should ever see. `code` is what
 * the client keys on - the prose is for a human and will change, the code
 * won't. 403 rather than 401: 401 means "identify yourself", and a client
 * that reads it as such will bounce them into a login they can complete
 * successfully and still get nowhere.
 */
export function suspendedResponse(info: SuspensionInfo = { suspended: true }): Response {
  return jsonResponse(403, {
    ok: false,
    code: SUSPENDED_CODE,
    error: "This account has been suspended.",
    ...(info.reason ? { reason: info.reason } : {}),
    ...(info.at ? { suspendedAt: info.at } : {}),
  });
}

/* ------------------------------------------------------------------------ */
/* Email verification                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Accounts created before server-side signup shipped were confirmed by
 * GoTrue itself and have no email_verified key at all. Treating a missing
 * key as unverified would lock out every existing user at once, so anything
 * created before this cutoff is grandfathered in.
 *
 * This date must not move. It is not a config knob - it is a statement
 * about which accounts predate the flag, and that set is fixed forever.
 * Every account created after it goes through auth-signup.mts and therefore
 * has the key.
 */
export const VERIFY_ENFORCED_FROM = Date.parse("2026-08-30T00:00:00Z");

/**
 * WHY THIS LIVES HERE, next to suspension. Same argument, same file, same
 * twenty-odd callers: an unverified account that can still submit picks
 * because one endpoint forgot to check is a silent failure, and gating in
 * the shared verifier closes every current endpoint and every future one by
 * default.
 *
 * WHY VERIFY AT ALL on a free pick'em site. Leagues are the reason. A league
 * invite goes to an address, standings are shown to other members by name,
 * and the alert system will happily mail whatever address an account claims
 * - an unverified signup is a way to send Blitz Odds mail to someone who
 * never asked for it, with our domain's reputation attached.
 */
export function isUnverified(claims: AuthClaims | null): boolean {
  if (!claims) return false;
  if (claims.user_metadata?.email_verified === true) return false;

  const created = claims.created_at ? Date.parse(claims.created_at) : NaN;
  // Unparseable or absent created_at: fail OPEN. A date GoTrue didn't send
  // is not evidence that someone is unverified, and the cost of guessing
  // wrong in that direction is locking a legitimate user out of an account
  // they have done nothing wrong with.
  if (!Number.isFinite(created)) return false;

  return created >= VERIFY_ENFORCED_FROM;
}

export const UNVERIFIED_CODE = "email_unverified";

/**
 * Like suspendedResponse: 403 with a stable `code` the client keys on. The
 * app turns this into the "confirm your email" screen with a Resend button,
 * so the email address comes back too - the client needs it to call
 * auth-verify-resend and may not have it if the session was restored from
 * a cold start.
 */
export function unverifiedResponse(email?: string): Response {
  return jsonResponse(403, {
    ok: false,
    code: UNVERIFIED_CODE,
    error: "Confirm your email address to finish setting up your account.",
    ...(email ? { email } : {}),
  });
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

/**
 * Verifies the token and returns the claims WITHOUT applying the suspension
 * gate. Only three callers should want this: user-profile (which has to tell
 * the client *why* it's being refused, so the app can show the notice instead
 * of a generic error), account-delete (a suspended person may still delete
 * their own account - see that file), and getAuthenticatedUser below.
 *
 * Everything else should call getAuthenticatedUser.
 */
export async function verifyToken(req: Request): Promise<AuthClaims | null> {
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

/**
 * The verifier every authenticated endpoint should use. Returns null for an
 * absent token, an invalid one, OR a suspended account - the three are
 * deliberately indistinguishable to the caller, so that adding an endpoint
 * can't accidentally leave suspension unenforced.
 *
 * The consequence is that a suspended user hitting, say, picks-submit gets
 * that function's ordinary 401. That's fine: they will already have been
 * shown the suspension notice by then, because user-profile is fetched on
 * sign-in and answers with the real reason (see suspendedResponse).
 *
 * NOTE ON TIMING. verifyToken caches a successful verification for 60s per
 * warm instance, so a suspension can be honoured up to a minute late on an
 * instance that saw the same token just before the flag was set. Sixty
 * seconds of grace on a pick'em site is not worth giving up the cache for.
 */
export async function getAuthenticatedUser(req: Request): Promise<AuthClaims | null> {
  const claims = await verifyToken(req);
  if (!claims || isSuspended(claims) || isUnverified(claims)) return null;
  return claims;
}

/**
 * account-delete's escape hatch, widened. A suspended user may already
 * delete their own account (see that file); an unverified one must be able
 * to as well, or a mistyped address creates an account its owner can never
 * remove. Returns claims for anyone with a genuinely valid token,
 * suspension and verification both ignored.
 *
 * Nothing else should use this.
 */
export async function getAuthenticatedUserIgnoringGates(req: Request): Promise<AuthClaims | null> {
  return verifyToken(req);
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

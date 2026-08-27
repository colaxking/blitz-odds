import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, type AuthClaims } from "./auth.mts";

// Role-based access for the in-app admin console.
//
// Until now every privileged endpoint in this repo was gated by a shared
// secret in a header (site-data-update, results-process, notif-dispatch,
// injury-review). That works for cron jobs and for a static page where Dan
// pastes a secret into a box, but it can't answer "which human did this",
// can't be handed to a second person, and can't be revoked without rotating
// a value that six scheduled jobs also depend on. injury-review.mts's own
// header comment names the gap directly: "there's no admin role in the user
// model to check against". This file is that role.
//
// The secrets are NOT being removed. Every function that had one keeps it,
// because cron-job.org and the .mjs scripts have no Identity session to
// present. Admin auth is added ALONGSIDE, so a request is authorised if it
// carries the right secret OR a JWT with the admin role.

export const ADMIN_ROLE = "admin";
const ADMIN_STORE = "blitz-admin";

export interface AdminClaims extends AuthClaims {
  app_metadata?: { roles?: string[]; [key: string]: unknown };
}

export interface AdminActor {
  id: string;
  email: string;
  name: string;
}

/**
 * WHY A SEED EMAIL. Granting the first admin role is a chicken-and-egg
 * problem: the endpoint that grants roles is itself admin-only. Rather than
 * shipping a one-shot bootstrap endpoint that then sits there forever as an
 * unused privilege-escalation surface, ADMIN_SEED_EMAIL names one account
 * that is treated as admin whether or not the role is on its Identity
 * record. Once that account has granted itself the real role through the UI,
 * the variable can be cleared and nothing changes.
 *
 * Compared case-insensitively; Identity stores emails lowercased but a
 * hand-typed env var may not be.
 */
function isSeedAdmin(claims: AdminClaims): boolean {
  const seed = (process.env.ADMIN_SEED_EMAIL || "").trim().toLowerCase();
  if (!seed) return false;
  return typeof claims.email === "string" && claims.email.trim().toLowerCase() === seed;
}

export function claimsAreAdmin(claims: AdminClaims | null): boolean {
  if (!claims) return false;
  const roles = claims.app_metadata?.roles;
  if (Array.isArray(roles) && roles.includes(ADMIN_ROLE)) return true;
  return isSeedAdmin(claims);
}

/**
 * The gate every admin-* function opens with. Returns the actor on success
 * so the caller can stamp it onto the audit row without re-reading claims.
 *
 * Deliberately returns the same shape for "no token" and "token but not an
 * admin": a non-admin probing for the existence of these endpoints learns
 * nothing from the response that they couldn't guess from the URL.
 */
export async function requireAdmin(req: Request): Promise<AdminActor | null> {
  const claims = (await getAuthenticatedUser(req)) as AdminClaims | null;
  if (!claimsAreAdmin(claims)) return null;
  return {
    id: claims!.id,
    email: claims!.email || "",
    name: claims!.user_metadata?.full_name || (claims!.email || "").split("@")[0] || "Admin",
  };
}

/**
 * Authorised if EITHER the legacy shared secret matches OR the caller is an
 * admin. Used by the two injury endpoints, which the analytics page and the
 * injury-player-sync.mjs script both still call with a secret.
 *
 * Returns the actor when the caller was a human admin, and a synthetic
 * "script" actor when it was the secret - so the audit log can tell the two
 * apart instead of attributing an automated sync to whoever last logged in.
 */
export async function requireAdminOrSecret(
  req: Request,
  secretHeader: string,
  expectedSecret: string | undefined
): Promise<AdminActor | null> {
  const provided = req.headers.get(secretHeader);
  if (expectedSecret && provided && provided === expectedSecret) {
    return { id: "script", email: "", name: "Automated job" };
  }
  return requireAdmin(req);
}

/* ------------------------------------------------------------------ */
/* Identity admin API                                                  */
/* ------------------------------------------------------------------ */

/**
 * GoTrue's admin routes (list users, set app_metadata, delete a user, send
 * a recovery mail) live under /.netlify/identity/admin and need a token with
 * admin rights - not the same thing as a token BELONGING to an admin, on
 * some GoTrue configurations.
 *
 * Three sources are tried in order because which one is populated depends on
 * the function runtime, and this repo's own auth.mts already documents one
 * such surprise (clientContext.user is never set for v2 functions):
 *
 *   1. IDENTITY_ADMIN_TOKEN - an explicit env var. Always works, and is the
 *      escape hatch if the other two turn out not to be populated here.
 *   2. context.clientContext.identity.token - the service token Netlify
 *      injects for Identity-enabled sites.
 *   3. The caller's own bearer token. Netlify Identity honours the "admin"
 *      role on admin routes, so an admin's own token is usually sufficient.
 *
 * Whichever works is remembered for the life of the instance, so the fallback
 * chain costs at most one extra round trip per cold start.
 */
let cachedSource: string | null = null;

function adminTokenCandidates(req: Request, context: any): Array<{ source: string; token: string }> {
  const out: Array<{ source: string; token: string }> = [];
  const envToken = process.env.IDENTITY_ADMIN_TOKEN;
  if (envToken) out.push({ source: "env", token: envToken });

  const ctxToken = context?.clientContext?.identity?.token;
  if (ctxToken) out.push({ source: "clientContext", token: ctxToken });

  const header = req.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    out.push({ source: "caller", token: header.slice(7).trim() });
  }

  if (cachedSource) {
    const idx = out.findIndex((c) => c.source === cachedSource);
    if (idx > 0) out.unshift(out.splice(idx, 1)[0]);
  }
  return out;
}

export interface IdentityUser {
  id: string;
  email: string;
  confirmed_at?: string | null;
  created_at?: string;
  updated_at?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: { roles?: string[]; [key: string]: unknown };
}

export async function identityAdminFetch(
  req: Request,
  context: any,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const origin = new URL(req.url).origin;

  // The v1 proxy first. It is the only caller here that can hold a real
  // Identity SERVICE token (see identity-admin-proxy.js), and it is the only
  // thing that works for the FIRST admin: GoTrue's /admin routes require the
  // admin role, so bootstrapping with the caller's own token is circular -
  // it 401s until the role exists, and the role is what we came to grant.
  const proxySecret = process.env.INTERNAL_PROXY_SECRET;
  if (proxySecret) {
    try {
      const res = await fetch(`${origin}/.netlify/functions/identity-admin-proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-proxy-secret": proxySecret },
        body: JSON.stringify({
          path,
          method: init.method || "GET",
          body: init.body ? JSON.parse(init.body as string) : undefined,
        }),
      });
      if (res.ok) {
        const envelope: any = await res.json();
        if (envelope.ok) {
          cachedSource = "proxy";
          return new Response(envelope.body, {
            status: envelope.status,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      // Proxy unavailable or misconfigured - fall through to the token chain
      // below rather than failing outright, so an operator who has set
      // IDENTITY_ADMIN_TOKEN by hand is unaffected.
    } catch {
      /* fall through */
    }
  }

  const candidates = adminTokenCandidates(req, context);
  if (!candidates.length) throw new Error("No Identity admin token available");

  let last: Response | null = null;
  for (const candidate of candidates) {
    const res = await fetch(`${origin}/.netlify/identity${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${candidate.token}`,
      },
    });
    // 401/403 means "wrong token", which is the only case worth retrying with
    // a different one. A 404 or a 500 is about the request, not the auth, and
    // retrying it three times just triples the latency of a failure.
    if (res.status !== 401 && res.status !== 403) {
      cachedSource = candidate.source;
      return res;
    }
    last = res;
  }
  return last as Response;
}

/** Pages through every Identity user. Netlify caps a page at 100. */
export async function listIdentityUsers(req: Request, context: any): Promise<IdentityUser[]> {
  const all: IdentityUser[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await identityAdminFetch(req, context, `/admin/users?per_page=100&page=${page}`);
    if (!res.ok) {
      if (page === 1) throw new Error(`Identity admin list failed (${res.status})`);
      break;
    }
    const body: any = await res.json();
    const batch: IdentityUser[] = Array.isArray(body) ? body : body?.users || [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  actorEmail: string;
  action: string;
  /** Human-readable, already-composed sentence. Written at the time of the
   *  action because reconstructing it later needs records the action may
   *  have just deleted. */
  summary: string;
  target?: string;
  meta?: Record<string, unknown>;
}

/**
 * Keys sort newest-first by construction: the timestamp is inverted against
 * a fixed epoch so that Blobs' lexicographic list() returns recent entries
 * without reading the whole log. The random suffix breaks ties between two
 * actions in the same millisecond.
 */
const AUDIT_EPOCH = 4_102_444_800_000; // 2100-01-01
function auditKey(at: number): string {
  const inverted = String(AUDIT_EPOCH - at).padStart(14, "0");
  return `audit:${inverted}:${Math.random().toString(36).slice(2, 8)}`;
}

export async function audit(
  actor: AdminActor,
  action: string,
  summary: string,
  extra: { target?: string; meta?: Record<string, unknown> } = {}
): Promise<void> {
  try {
    const at = Date.now();
    const key = auditKey(at);
    const entry: AuditEntry = {
      id: key,
      at: new Date(at).toISOString(),
      actorId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      action,
      summary,
      ...extra,
    };
    await getStore(ADMIN_STORE).setJSON(key, entry);
  } catch {
    // An audit write must never be the reason an admin action fails. The
    // action already happened by the time this runs; throwing here would
    // report failure for something that succeeded, which is worse than a
    // missing log line.
  }
}

export async function readAudit(limit = 100): Promise<AuditEntry[]> {
  const store = getStore(ADMIN_STORE, { consistency: "strong" });
  const { blobs } = await store.list({ prefix: "audit:" });
  const keys = blobs.map((b) => b.key).sort().slice(0, limit);
  const rows = await Promise.all(
    keys.map(async (k) => {
      try {
        return (await store.get(k, { type: "json" })) as AuditEntry;
      } catch {
        return null;
      }
    })
  );
  return rows.filter(Boolean) as AuditEntry[];
}

/* ------------------------------------------------------------------ */

export const ADMIN_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function adminJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...ADMIN_CORS },
  });
}

export function forbidden(): Response {
  return adminJson(403, { ok: false, error: "Admin access required" });
}

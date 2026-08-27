import type { Context, Config } from "@netlify/functions";
import { getAuthenticatedUser } from "./lib/auth.mts";
import { claimsAreAdmin, adminJson, ADMIN_CORS } from "./lib/admin.mts";

// GET /.netlify/functions/admin-whoami -> { ok, isAdmin, viaSeed }
//
// WHY THIS EXISTS. The Admin menu item is rendered when the signed-in user
// holds the admin role, and the role lives on app_metadata.roles, which the
// browser can read straight off the Identity user. That works for everyone
// EXCEPT the first admin.
//
// ADMIN_SEED_EMAIL solves the bootstrap problem server-side: the named
// account is treated as an admin whether or not the role is on its record,
// so it can grant itself the real role through the console. But it's an
// environment variable - the browser has no way to know it exists. So the
// seed admin was authorised by every endpoint and shown the menu item by
// none of them, which made the console unreachable for exactly the one
// person it was supposed to let in.
//
// This endpoint closes that loop: one call, no Blobs, no Identity admin API,
// answering the only question the client can't answer for itself.
//
// It deliberately reports viaSeed so the console can tell that account it's
// running on a fallback and should grant itself the real role - after which
// the client-side check alone is enough and this call is just confirmation.

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ADMIN_CORS });
  if (req.method !== "GET") return adminJson(405, { ok: false, error: "Method not allowed" });

  const claims = await getAuthenticatedUser(req);
  if (!claims) return adminJson(200, { ok: true, isAdmin: false });

  const roles = (claims as any).app_metadata?.roles;
  const hasRole = Array.isArray(roles) && roles.indexOf("admin") !== -1;
  const isAdmin = claimsAreAdmin(claims as any);

  return adminJson(200, { ok: true, isAdmin, viaSeed: isAdmin && !hasRole });
};

export const config: Config = {
  path: "/.netlify/functions/admin-whoami",
};

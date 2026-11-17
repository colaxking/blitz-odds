import type { Context, Config } from "@netlify/functions";
import { getAuthenticatedUser } from "./lib/auth.mts";
import { claimsAreAdmin, requireAdmin, audit, adminJson, ADMIN_CORS, forbidden } from "./lib/admin.mts";
import { readFeatures, writeFeature, resolveFlag, FEATURE_LABELS, type FeatureMode } from "./lib/features.mts";

// GET  /.netlify/functions/features
//   -> { ok, features: { bowls: bool, mobileNav: bool }, isAdmin,
//        admin?: { flags, labels, updatedAt, updatedBy } }
//   Public. The booleans are resolved for the caller: an "admins" flag reads
//   true for an admin and false for everyone else. Raw modes are only
//   returned to admins (the console needs them; nobody else does).
//
// POST /.netlify/functions/features   Body: { name, mode: "off"|"admins"|"everyone" }
//   Admin only. Audited.

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ADMIN_CORS });

  if (req.method === "GET") {
    // A missing or bad token is just a signed-out visitor here, not an error.
    let claims: any = null;
    try { claims = await getAuthenticatedUser(req); } catch { claims = null; }
    const isAdmin = claimsAreAdmin(claims);
    const doc = await readFeatures();
    const features: Record<string, boolean> = {};
    for (const [k, mode] of Object.entries(doc.flags)) features[k] = resolveFlag(mode, isAdmin);
    return adminJson(200, {
      ok: true,
      features,
      isAdmin,
      ...(isAdmin ? { admin: { flags: doc.flags, labels: FEATURE_LABELS, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } } : {}),
    });
  }

  if (req.method === "POST") {
    const actor = await requireAdmin(req);
    if (!actor) return forbidden();
    let body: any;
    try { body = await req.json(); } catch { return adminJson(400, { ok: false, error: "Invalid JSON body" }); }
    const name = typeof body?.name === "string" ? body.name : "";
    const mode = body?.mode as FeatureMode;
    try {
      const before = (await readFeatures()).flags[name];
      const doc = await writeFeature(name, mode, actor.name);
      const label = FEATURE_LABELS[name]?.title || name;
      await audit(actor, "feature.set", `Set ${label} to ${mode === "admins" ? "admins only" : mode} (was ${before === "admins" ? "admins only" : before})`, {
        target: name,
        meta: { from: before, to: mode },
      });
      return adminJson(200, { ok: true, admin: { flags: doc.flags, labels: FEATURE_LABELS, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } });
    } catch (err) {
      return adminJson(400, { ok: false, error: err instanceof Error ? err.message : "Could not update feature" });
    }
  }

  return adminJson(405, { ok: false, error: "Method not allowed" });
};

export const config: Config = {
  path: "/.netlify/functions/features",
};

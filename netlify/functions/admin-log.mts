import type { Context, Config } from "@netlify/functions";
import { requireAdmin, readAudit, adminJson, forbidden, ADMIN_CORS } from "./lib/admin.mts";

// GET /.netlify/functions/admin-log?limit=100 -> { ok, entries }
//
// Read-only by design. There is no delete verb and no edit verb, here or
// anywhere else - a log an admin can quietly prune answers no question worth
// asking. Entries age out only by not being read; nothing sweeps them.

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ADMIN_CORS });
  if (req.method !== "GET") return adminJson(405, { ok: false, error: "Method not allowed" });

  const actor = await requireAdmin(req);
  if (!actor) return forbidden();

  try {
    const raw = Number(new URL(req.url).searchParams.get("limit"));
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 300) : 100;
    const entries = await readAudit(limit);
    return adminJson(200, { ok: true, entries });
  } catch (err) {
    return adminJson(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/admin-log",
};

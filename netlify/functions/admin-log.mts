import type { Context, Config } from "@netlify/functions";
import { requireAdmin, readAudit, adminJson, forbidden, ADMIN_CORS } from "./lib/admin.mts";

// GET /.netlify/functions/admin-log?limit=100[&userId=...] -> { ok, entries }
//
// userId filters to entries where that person was either the admin who acted
// or the account acted upon.
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
    const params = new URL(req.url).searchParams;
    const raw = Number(params.get("limit"));
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 300) : 100;
    const userId = (params.get("userId") || "").trim();

    if (!userId) {
      return adminJson(200, { ok: true, entries: await readAudit(limit) });
    }

    // Filtered by person, and deliberately in BOTH directions.
    //
    // An entry names an actor (the admin who did it) and a target (who or what
    // it was done to). Filtering on actor alone would return nothing for
    // everyone who isn't an admin, which is almost everyone - and "what has
    // been done to this account" is the more useful question anyway when
    // someone reports their picks look wrong.
    //
    // Targets are composite for pick edits ("{leagueId}:{week}:{userId}"), so
    // the id is matched as a segment rather than by equality. Reading wider
    // than the limit before filtering keeps a request for 100 of one person's
    // entries from returning three just because the recent log is busy.
    const pool = await readAudit(300);
    const matches = pool.filter((e) => {
      if (e.actorId === userId) return true;
      if (!e.target) return false;
      return e.target === userId || e.target.split(":").includes(userId);
    });

    return adminJson(200, {
      ok: true,
      entries: matches.slice(0, limit),
      scanned: pool.length,
      // The log only ever records admin actions, so an empty result means
      // nothing has been done to this account - not that they've been idle.
      // The client says so rather than showing a bare "nothing found".
      adminActionsOnly: true,
    });
  } catch (err) {
    return adminJson(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/admin-log",
};

import type { Context, Config } from "@netlify/functions";
import {
  requireAdmin, identityAdminFetch, adminJson, forbidden, audit, ADMIN_CORS,
} from "./lib/admin.mts";
import { purgeUserData } from "./lib/account-purge.mts";

// POST /.netlify/functions/admin-user-delete
//   { userId, confirmEmail }  -> { ok, removed: {...} }
//
// Deletes the login AND everything attached to it. There is no "keep their
// picks" variant: a pick with no account behind it shows as a blank row in
// a league table forever, and the person asking to be forgotten reasonably
// expects the pick to go too.
//
// The sweep itself lives in lib/account-purge.mts, shared with the
// self-service account-delete endpoint. An account removed by its owner has
// to leave exactly as little behind as one removed from here, and one
// implementation is the only way to guarantee that stays true.
//
// ORDER MATTERS. Blob data is purged BEFORE the Identity user is deleted.
// The reverse order has a failure mode with no recovery path: if the blob
// sweep dies halfway, the account is already gone, and the orphaned picks
// are now keyed to a userId that can no longer be looked up or re-deleted
// through this endpoint. Done this way, a mid-sweep failure leaves the
// account intact and the operation is simply repeatable.
//
// confirmEmail must match the target's address. The UI already makes the
// admin type it, but the UI is not the security boundary - a mis-scripted
// POST with the wrong id should not be able to delete a stranger.

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ADMIN_CORS });
  if (req.method !== "POST") return adminJson(405, { ok: false, error: "Method not allowed" });

  const actor = await requireAdmin(req);
  if (!actor) return forbidden();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return adminJson(400, { ok: false, error: "Body must be JSON" });
  }

  const userId = String(body.userId || "").trim();
  const confirmEmail = String(body.confirmEmail || "").trim().toLowerCase();
  if (!userId || !confirmEmail) {
    return adminJson(400, { ok: false, error: "userId and confirmEmail are required" });
  }

  // Deleting your own account through the admin panel logs you out mid-action
  // and, if you were the last admin, locks everyone out. The account can still
  // be removed - just not from here. Settings -> Delete my account is the
  // route, which signs them out cleanly as part of the flow.
  if (userId === actor.id) {
    return adminJson(409, {
      ok: false,
      error: "You can't delete your own account from here. Use Settings \u2192 Delete my account.",
    });
  }

  try {
    const targetRes = await identityAdminFetch(req, context, `/admin/users/${userId}`);
    if (!targetRes.ok) return adminJson(404, { ok: false, error: "No such user" });
    const target: any = await targetRes.json();

    if ((target.email || "").trim().toLowerCase() !== confirmEmail) {
      return adminJson(400, { ok: false, error: "The email you typed doesn't match that account" });
    }

    const removed = await purgeUserData(userId);

    // Only now, with the data provably gone, remove the login itself.
    const delRes = await identityAdminFetch(req, context, `/admin/users/${userId}`, { method: "DELETE" });
    if (!delRes.ok && delRes.status !== 404) {
      return adminJson(delRes.status, {
        ok: false,
        error: `Their data was removed but Identity refused to delete the login (${delRes.status}). Retry to finish.`,
        removed,
      });
    }

    await audit(
      actor,
      "user.delete",
      `deleted ${target.email} and all their data`,
      { target: userId, meta: { removed, leaguesAffected: removed.leaguesAffected } }
    );

    return adminJson(200, { ok: true, removed, leaguesAffected: removed.leaguesAffected });
  } catch (err) {
    return adminJson(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/admin-user-delete",
};

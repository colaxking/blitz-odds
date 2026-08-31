import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  requireAdmin, identityAdminFetch, adminJson, forbidden, audit,
  ADMIN_CORS, ADMIN_ROLE,
} from "./lib/admin.mts";
import { USER_STORE, getPrefs, setPrefs } from "./lib/notif.mts";

// POST /.netlify/functions/admin-user-update
//   { userId, action: "set-admin",     value: true|false }
//   { userId, action: "set-suspended", value: true|false, reason?: string }
//   { userId, action: "set-name",      value: "New Name" }
//   { userId, action: "set-prefs",     value: { ...partial NotifPrefs } }
//   { userId, action: "reset-password" }
//   { userId, action: "reset-tutorial" }
//
// One endpoint, six verbs, because they all mutate one user and all need
// the same audit stamp. Splitting them into six functions would mean six
// copies of the lookup-then-log preamble.

const LEAGUE_STORE = "blitz-leagues";
const PROFILE_STORE = "blitz-users";

/** Fetches one Identity user so the audit line can name them even when the
 *  action is about to change that name. */
async function getIdentityUser(req: Request, context: Context, userId: string): Promise<any | null> {
  const res = await identityAdminFetch(req, context, `/admin/users/${userId}`);
  if (!res.ok) return null;
  return res.json();
}

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
  const action = String(body.action || "").trim();
  if (!userId || !action) return adminJson(400, { ok: false, error: "userId and action are required" });

  try {
    const target = await getIdentityUser(req, context, userId);
    if (!target) return adminJson(404, { ok: false, error: "No such user" });
    const label = target.email || userId;

    /* ---------------- roles ---------------- */
    if (action === "set-admin") {
      const grant = body.value !== false;

      // A site with zero admins is unrecoverable through the UI - the only
      // way back in is the ADMIN_SEED_EMAIL env var, which the person locking
      // themselves out may not have set. Refusing the last revocation is
      // cheaper than that recovery.
      if (!grant) {
        const listRes = await identityAdminFetch(req, context, "/admin/users?per_page=100&page=1");
        if (listRes.ok) {
          const listBody: any = await listRes.json();
          const all: any[] = Array.isArray(listBody) ? listBody : listBody?.users || [];
          const admins = all.filter((u) => (u.app_metadata?.roles || []).includes(ADMIN_ROLE));
          if (admins.length <= 1 && admins.some((u) => u.id === userId)) {
            return adminJson(409, {
              ok: false,
              error: "That's the only admin left. Give someone else the role first.",
            });
          }
        }
      }

      const existing: string[] = target.app_metadata?.roles || [];
      const roles = grant
        ? Array.from(new Set([...existing, ADMIN_ROLE]))
        : existing.filter((r) => r !== ADMIN_ROLE);

      const res = await identityAdminFetch(req, context, `/admin/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ app_metadata: { ...(target.app_metadata || {}), roles } }),
      });
      if (!res.ok) {
        return adminJson(res.status, { ok: false, error: `Identity rejected the role change (${res.status})` });
      }

      await audit(
        actor,
        grant ? "role.grant" : "role.revoke",
        grant ? `made ${label} a site admin` : `removed admin access from ${label}`,
        { target: userId, meta: { roles } }
      );
      return adminJson(200, { ok: true, roles });
    }

    /* ---------------- suspension ---------------- */
    if (action === "set-suspended") {
      const suspend = body.value !== false;
      const reason = String(body.reason || "").trim().slice(0, 200);

      // Suspending yourself locks you out of the console that would let you
      // undo it. If you were the only admin, nobody can undo it.
      if (userId === actor.id) {
        return adminJson(409, { ok: false, error: "You can't suspend your own account" });
      }

      const now = new Date().toISOString();
      const existingMeta = target.app_metadata || {};
      const nextMeta = suspend
        ? { ...existingMeta, suspended: true, suspendedAt: now, suspendedReason: reason || undefined, suspendedBy: actor.email || actor.id }
        : { ...existingMeta, suspended: false, suspendedAt: undefined, suspendedReason: undefined, suspendedBy: undefined };

      const res = await identityAdminFetch(req, context, `/admin/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ app_metadata: nextMeta }),
      });
      if (!res.ok) {
        return adminJson(res.status, { ok: false, error: `Identity rejected the change (${res.status})` });
      }

      // The flag has to land in TWO places, because two different systems
      // ask the question and neither can cheaply reach the other's answer:
      //
      //   Identity app_metadata - read on every request via lib/auth.mts,
      //     which is what actually stops them acting. Source of truth.
      //   The profile blob      - read by the three notification dispatchers,
      //     which walk `users:` in Blobs and have no Identity token and no
      //     business acquiring one to send a kickoff alert.
      //
      // Without the second write a suspended account goes on receiving push
      // and email for a site it can no longer open, which is the worst of
      // both: cut off and still nagged. The blob copy is a cache, and a
      // failed write here is logged rather than fatal - the access gate,
      // the part that matters, has already succeeded.
      try {
        const userStore = getStore(USER_STORE, { consistency: "strong" });
        const profile: any = await userStore.get(`users:${userId}`, { type: "json" });
        if (profile) {
          await userStore.setJSON(`users:${userId}`, {
            ...profile,
            suspended: suspend,
            suspendedAt: suspend ? now : null,
          });
        }
      } catch {
        console.warn("[admin-user-update] suspension flag not mirrored to profile", { userId });
      }

      await audit(
        actor,
        suspend ? "user.suspend" : "user.unsuspend",
        suspend
          ? `suspended ${label}${reason ? ` (${reason})` : ""}`
          : `lifted the suspension on ${label}`,
        { target: userId, meta: { reason: reason || null } }
      );
      return adminJson(200, { ok: true, suspended: suspend, reason: reason || null, suspendedAt: suspend ? now : null });
    }

    /* ---------------- display name ---------------- */
    if (action === "set-name") {
      const name = String(body.value || "").trim();
      if (!name) return adminJson(400, { ok: false, error: "Name can't be empty" });
      if (name.length > 60) return adminJson(400, { ok: false, error: "Name is too long" });

      const res = await identityAdminFetch(req, context, `/admin/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ user_metadata: { ...(target.user_metadata || {}), full_name: name } }),
      });
      if (!res.ok) return adminJson(res.status, { ok: false, error: `Identity rejected the name change (${res.status})` });

      // The display name is denormalised into the profile row and into every
      // members doc the user appears in - those are what league tables render
      // from, so a name changed only in Identity looks unchanged everywhere
      // that matters.
      const userStore = getStore(USER_STORE, { consistency: "strong" });
      try {
        const profile: any = (await userStore.get(`users:${userId}`, { type: "json" })) || {};
        await userStore.setJSON(`users:${userId}`, { ...profile, displayName: name });
      } catch {
        /* no profile row yet - the next write from the app creates one */
      }

      const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
      const { blobs } = await leagueStore.list({ prefix: "members:" });
      let touched = 0;
      for (const b of blobs) {
        try {
          const doc: any = await leagueStore.get(b.key, { type: "json" });
          const member = doc?.members?.find((m: any) => m.userId === userId);
          if (!member) continue;
          member.displayName = name;
          await leagueStore.setJSON(b.key, doc);
          touched++;
        } catch {
          /* skip an unreadable league rather than abandoning the rename */
        }
      }

      await audit(actor, "user.rename", `renamed ${label} to "${name}"`, {
        target: userId,
        meta: { leaguesUpdated: touched },
      });
      return adminJson(200, { ok: true, name, leaguesUpdated: touched });
    }

    /* ---------------- preferences ---------------- */
    if (action === "set-prefs") {
      const patch = body.value;
      if (!patch || typeof patch !== "object") {
        return adminJson(400, { ok: false, error: "value must be a preferences object" });
      }

      // Routed through setPrefs rather than written straight to the blob for
      // two reasons: Blobs set() is a whole-key overwrite, so a partial patch
      // written directly silently drops every field it doesn't mention; and
      // setPrefs is where timezone validation and push sanitising already
      // live, so an admin edit gets the same guards a user edit does.
      const before = await getPrefs(userId);
      const next = await setPrefs(userId, patch);

      const changed = Object.keys(patch)
        .filter((k) => k !== "push")
        .filter((k) => (before as any)[k] !== (next as any)[k]);
      if (patch.push) {
        changed.push(
          ...Object.keys(patch.push).filter(
            (k) => (before.push as any)[k] !== (next.push as any)[k]
          ).map((k) => `push.${k}`)
        );
      }

      await audit(actor, "user.prefs", `updated notification settings for ${label}`, {
        target: userId,
        meta: { changed },
      });
      return adminJson(200, { ok: true, prefs: next });
    }

    /* ---------------- password reset ---------------- */
    if (action === "reset-password") {
      // GoTrue's /recover is the same route the "forgot password" link uses,
      // so the user gets the ordinary email and their existing password keeps
      // working until they follow it. Deliberately not /admin/users PUT with
      // a new password: an admin should never be in a position to know, or be
      // accused of knowing, someone's password.
      const res = await fetch(`${new URL(req.url).origin}/.netlify/identity/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: target.email }),
      });
      if (!res.ok) {
        return adminJson(res.status, { ok: false, error: `Identity couldn't send the reset (${res.status})` });
      }
      await audit(actor, "user.password-reset", `sent a password reset to ${label}`, { target: userId });
      return adminJson(200, { ok: true, sentTo: target.email });
    }

    /* ---------------- first-run tour ---------------- */
    if (action === "reset-tutorial") {
      /* Written straight to the profile blob rather than through
         user-profile.mts, because that endpoint deliberately treats
         tutorialSeen as a one-way flip: a client can set it and never
         unset it, so a stale payload can't wipe out somebody's completed
         run. Clearing it is exactly the thing only an admin should be able
         to do, which is why it lives here instead.

         Read-modify-write rather than a bare set(): Blobs writes are
         whole-key overwrites, so replacing `settings` wholesale would take
         their theme, sportsbook, timezone and favourites with it. */
      const store = getStore(PROFILE_STORE, { consistency: "strong" });
      const key = `users:${userId}`;
      const profile: any = await store.get(key, { type: "json" });
      if (!profile) {
        // No profile blob means they have never signed in far enough to
        // have settings, so there is nothing to reset and the tour will
        // fire on its own the first time they reach the week view.
        return adminJson(200, { ok: true, alreadyUnseen: true });
      }
      const before = profile.settings?.tutorialSeen ? (profile.settings.tutorialOutcome || "seen") : "never seen";
      const next = {
        ...profile,
        settings: {
          ...(profile.settings || {}),
          tutorialSeen: false,
          tutorialOutcome: null,
          tutorialLastStep: null,
          tutorialSeenAt: null,
        },
      };
      await store.setJSON(key, next);
      await audit(actor, "user.tutorial-reset", `reset the first-run tour for ${label}`, {
        target: userId,
        meta: { previous: before },
      });
      /* They see it again the next time they land on the Games week view -
         the app reads this flag from the profile on sign-in, not from the
         device, so it doesn't matter which browser they come back on and
         a session already open picks it up on its next profile load. */
      return adminJson(200, { ok: true, previous: before });
    }

    return adminJson(400, { ok: false, error: `Unknown action "${action}"` });
  } catch (err) {
    return adminJson(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/admin-user-update",
};

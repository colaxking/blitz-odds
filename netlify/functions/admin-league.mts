import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  requireAdmin, identityAdminFetch, adminJson, forbidden, audit, ADMIN_CORS,
} from "./lib/admin.mts";
import { USER_STORE } from "./lib/notif.mts";
import { rescoreLeague, removeUserFromStandings } from "./lib/rescore.mts";

// POST /.netlify/functions/admin-league
//   { leagueId, action: "add-member",    userId }
//   { leagueId, action: "remove-member", userId }
//   { leagueId, action: "rebuild-standings" }
//   { leagueId, action: "delete", confirmName }
//
// The member operations deliberately do NOT go through league-join /
// league-leave. Those enforce rules that exist for the person doing them and
// not for an admin fixing something: an invite code has to be valid, a
// pending request has to be settled, a league can be full, an owner can't
// leave their own league. An admin adding someone to a league is repairing
// state, not participating - so this writes the members doc directly and
// keeps the derived counts in step by hand.

const LEAGUE_STORE = "blitz-leagues";

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

  const leagueId = String(body.leagueId || "").trim();
  const action = String(body.action || "").trim();
  if (!leagueId || !action) return adminJson(400, { ok: false, error: "leagueId and action are required" });

  try {
    const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return adminJson(404, { ok: false, error: "No such league" });
    const leagueName = league.name || leagueId;

    /* ---------------- rebuild standings ---------------- */
    if (action === "rebuild-standings") {
      const weeks = Array.isArray(body.weeks) ? body.weeks.map(Number).filter(Number.isFinite) : undefined;
      const result = await rescoreLeague(leagueStore, leagueId, weeks);
      await audit(
        actor,
        "league.rebuild",
        result.weeksRescored.length
          ? `rebuilt standings for ${leagueName} (week${result.weeksRescored.length === 1 ? "" : "s"} ${result.weeksRescored.join(", ")})`
          : `rebuilt standings for ${leagueName} — no scored weeks to rebuild`,
        { target: leagueId, meta: result }
      );
      return adminJson(200, { ok: true, ...result });
    }

    /* ---------------- delete ---------------- */
    if (action === "delete") {
      // Case and repeated spaces ignored, matching normalizeConfirm() in
      // index.html. The console's field label is uppercased by CSS, so what
      // an admin reads on screen is not byte-identical to the stored name -
      // an exact match here refused the exact thing the UI asked them to
      // type. This box is a "did you mean it" check, not an authorisation
      // one; requireAdmin above is what decides whether the caller may do
      // this at all.
      const norm = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      const confirmName = String(body.confirmName || "").trim();
      if (norm(confirmName) !== norm(leagueName)) {
        return adminJson(400, { ok: false, error: "The name you typed doesn't match this league" });
      }

      // Everything keyed to this league goes: picks, results, standings,
      // members, join requests, survivor state, and the league row itself.
      // Members keep their accounts - only this league's records disappear.
      let keysRemoved = 0;
      for (const prefix of [
        `picks:${leagueId}:`,
        `results:${leagueId}:`,
        `standings:${leagueId}`,
        `members:${leagueId}`,
        `survivor:${leagueId}`,
        `request:${leagueId}:`,
        `league:${leagueId}`,
      ]) {
        const { blobs } = await leagueStore.list({ prefix });
        for (const b of blobs) {
          try {
            await leagueStore.delete(b.key);
            keysRemoved++;
          } catch {
            /* already gone */
          }
        }
      }

      await audit(actor, "league.delete", `deleted the league "${leagueName}"`, {
        target: leagueId,
        meta: { keysRemoved, memberCount: league.memberCount || 0 },
      });
      return adminJson(200, { ok: true, keysRemoved });
    }

    /* ---------------- membership ---------------- */
    const userId = String(body.userId || "").trim();
    if (!userId) return adminJson(400, { ok: false, error: "userId is required for that action" });

    const membersDoc: any = (await leagueStore.get(`members:${leagueId}`, { type: "json" })) || {
      leagueId,
      members: [],
    };
    const now = new Date().toISOString();

    if (action === "add-member") {
      if (membersDoc.members.some((m: any) => m.userId === userId)) {
        return adminJson(409, { ok: false, error: "They're already in this league" });
      }

      const idRes = await identityAdminFetch(req, context, `/admin/users/${userId}`);
      if (!idRes.ok) return adminJson(404, { ok: false, error: "No such user" });
      const target: any = await idRes.json();

      let displayName = (target.user_metadata?.full_name as string) || "";
      let avatar: string | null = null;
      try {
        const profile: any = await getStore(USER_STORE, { consistency: "strong" }).get(`users:${userId}`, { type: "json" });
        displayName = displayName || profile?.displayName || "";
        avatar = profile?.avatar || null;
      } catch {
        /* no profile row yet */
      }
      displayName = displayName || (target.email || "").split("@")[0] || "Player";

      membersDoc.members.push({ userId, displayName, avatar, role: "member", joinedAt: now });
      league.memberCount = membersDoc.members.length;
      league.updatedAt = now;
      await Promise.all([
        leagueStore.setJSON(`members:${leagueId}`, membersDoc),
        leagueStore.setJSON(`league:${leagueId}`, league),
      ]);

      await audit(actor, "league.add-member", `added ${target.email} to ${leagueName}`, {
        target: leagueId,
        meta: { userId },
      });
      return adminJson(200, { ok: true, members: membersDoc.members.length });
    }

    if (action === "remove-member") {
      const member = membersDoc.members.find((m: any) => m.userId === userId);
      if (!member) return adminJson(404, { ok: false, error: "They're not in this league" });

      // Removing the owner would leave a league nobody can administer from
      // the app side - settings, invites and the join queue are all owner-only.
      if (league.ownerId === userId) {
        return adminJson(409, {
          ok: false,
          error: "That's the league owner. Delete the league instead, or transfer it first.",
        });
      }

      membersDoc.members = membersDoc.members.filter((m: any) => m.userId !== userId);
      league.memberCount = membersDoc.members.length;
      league.updatedAt = now;
      await Promise.all([
        leagueStore.setJSON(`members:${leagueId}`, membersDoc),
        leagueStore.setJSON(`league:${leagueId}`, league),
      ]);

      // Their picks are left in place on purpose. Removing someone from a
      // league is reversible - an admin who adds them back the same minute
      // should not find their season wiped. The picks become unreachable
      // (nothing enumerates a non-member) but stay recoverable. Deleting the
      // ACCOUNT is the destructive operation, and that one does clear them.
      const standingsChanged = await removeUserFromStandings(leagueStore, leagueId, userId);

      await audit(
        actor,
        "league.remove-member",
        `removed ${member.displayName || userId} from ${leagueName}`,
        { target: leagueId, meta: { userId, standingsChanged, picksKept: true } }
      );
      return adminJson(200, { ok: true, members: membersDoc.members.length, standingsChanged });
    }

    return adminJson(400, { ok: false, error: `Unknown action "${action}"` });
  } catch (err) {
    return adminJson(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/admin-league",
};

import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { TERMS_VERSION } from "./lib/terms.mts";
import { requireAdmin, listIdentityUsers, adminJson, forbidden, ADMIN_CORS, ADMIN_ROLE } from "./lib/admin.mts";
import { NOTIF_STORE } from "./lib/notif.mts";

// GET /.netlify/functions/admin-users -> { ok, users, leagues }
//
// One call, everything the Users tab needs. Three sources have to be joined
// because no single one of them knows the whole picture:
//
//   Identity        - the login: email, confirmation state, roles, created_at
//   blitz-users     - the profile: display name, notification prefs, push subs
//   blitz-leagues   - membership: which leagues each person is actually in
//
// Doing the join here rather than in the browser is what makes the tab usable
// on a phone: the alternative is the client fetching a member list per league
// and stitching it together over a few dozen round trips.

const USER_STORE = "blitz-users";
const LEAGUE_STORE = "blitz-leagues";

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ADMIN_CORS });
  if (req.method !== "GET") return adminJson(405, { ok: false, error: "Method not allowed" });

  const actor = await requireAdmin(req);
  if (!actor) return forbidden();

  try {
    const userStore = getStore(USER_STORE, { consistency: "strong" });
    const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
    const notifStore = getStore(NOTIF_STORE, { consistency: "strong" });

    const [identityUsers, leagueList] = await Promise.all([
      listIdentityUsers(req, context),
      leagueStore.list({ prefix: "league:" }),
    ]);

    // Membership index: userId -> [{ id, name, role }]. Built from the
    // members docs rather than from each user's profile, because a members
    // doc is the record league-join actually writes - a profile can lag it.
    const leagues: Array<{ id: string; name: string; format: string; memberCount: number; scoredWeeks: number[] }> = [];
    const membershipsByUser = new Map<string, Array<{ id: string; name: string; role: string }>>();

    await Promise.all(
      leagueList.blobs.map(async (b) => {
        const leagueId = b.key.slice("league:".length);
        try {
          const [league, membersDoc, standings] = await Promise.all([
            leagueStore.get(`league:${leagueId}`, { type: "json" }) as Promise<any>,
            leagueStore.get(`members:${leagueId}`, { type: "json" }) as Promise<any>,
            leagueStore.get(`standings:${leagueId}`, { type: "json" }) as Promise<any>,
          ]);
          if (!league) return;
          const members: any[] = membersDoc?.members || [];
          leagues.push({
            id: leagueId,
            name: league.name || leagueId,
            format: league.format || "confidence",
            memberCount: members.length,
            scoredWeeks: standings?.weeks ? Object.keys(standings.weeks).map(Number).sort((a, b2) => a - b2) : [],
          });
          for (const m of members) {
            const list = membershipsByUser.get(m.userId) || [];
            list.push({ id: leagueId, name: league.name || leagueId, role: m.role || "member" });
            membershipsByUser.set(m.userId, list);
          }
        } catch {
          // One unreadable league must not blank the whole admin page.
        }
      })
    );

    const users = await Promise.all(
      identityUsers.map(async (u) => {
        // Profile and prefs live in two different stores (blitz-users holds
        // the account row, blitz-notif holds notification settings) - both are
        // optional, and a user who has never opened Settings has neither.
        let profile: any = null;
        let prefs: any = null;
        try {
          [profile, prefs] = await Promise.all([
            userStore.get(`users:${u.id}`, { type: "json" }),
            notifStore.get(`prefs:${u.id}`, { type: "json" }),
          ]);
        } catch {
          /* absent rows are normal - fall through with nulls */
        }
        const roles = u.app_metadata?.roles || [];
        const meta: any = u.app_metadata || {};
        return {
          id: u.id,
          email: u.email,
          name:
            (u.user_metadata?.full_name as string) ||
            profile?.displayName ||
            (u.email || "").split("@")[0],
          isAdmin: roles.includes(ADMIN_ROLE),
          roles,
          suspended: Boolean(meta.suspended),
          suspendedAt: meta.suspendedAt || null,
          suspendedReason: meta.suspendedReason || null,
          suspendedBy: meta.suspendedBy || null,
          confirmed: Boolean(u.confirmed_at),
          createdAt: u.created_at || null,
          lastSeenAt: profile?.lastSeenAt || u.updated_at || null,
          pushEnabled: Boolean(profile?.subscriptions?.length),
          prefs: prefs || null,
          subscriptionTier: profile?.subscriptionTier || "free",
          /* Terms acceptance, read the same way user-profile.mts reads it and
             in the same order: identity metadata first, then the profile
             blob. auth-signup.mts stamps the version into user_metadata at
             account creation, which happens before any profile blob exists,
             so a brand new account has it in one place and not the other.
             Reading only the blob would show every recent signup as never
             having accepted. */
          termsAcceptedVersion:
            profile?.termsAcceptedVersion ?? u.user_metadata?.terms_accepted_version ?? null,
          termsAcceptedAt:
            profile?.termsAcceptedAt ?? u.user_metadata?.terms_accepted_at ?? null,
          // The full audit trail, oldest first. Only ever written by
          // user-profile.mts, and only appended to.
          termsHistory: Array.isArray(profile?.termsHistory) ? profile.termsHistory : [],
          leagues: membershipsByUser.get(u.id) || [],
        };
      })
    );

    users.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    leagues.sort((a, b) => a.name.localeCompare(b.name));

    /* Sent alongside the rows so the console can mark an account as being on
       an OLD version without hardcoding the current one in the client - the
       version lives in lib/terms.mts and the dashboard should follow it. */
    return adminJson(200, { ok: true, users, leagues, actorId: actor.id, termsCurrentVersion: TERMS_VERSION });
  } catch (err) {
    return adminJson(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/admin-users",
};

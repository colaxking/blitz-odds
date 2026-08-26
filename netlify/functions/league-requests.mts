import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { sendTransactional, emailForUser } from "./lib/send-email.mts";
import { buildRequestApprovedEmail, buildRequestDeclinedEmail } from "./lib/request-emails.mts";

// GET  /.netlify/functions/league-requests?leagueId=...
//        -> { ok, pending: [...], handled: [...] }
// POST /.netlify/functions/league-requests
//        Body: { leagueId, userId, action: "approve" | "decline" }
//        -> { ok, status }
//
// The owner's side of league-join-request.mts. Both verbs live in one
// function because they share the same ownership check and the same key
// layout, and splitting them would mean maintaining that check twice.
//
// Approving performs the membership write inline rather than calling
// league-join, because league-join deliberately refuses a private league
// without an invite code - that refusal is the whole reason this flow
// exists. The write mirrors it exactly: members doc, league.memberCount,
// and the joiner's users:{id}.leagues.

const LEAGUE_STORE = "blitz-leagues";
const USER_STORE = "blitz-users";

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** Owner-or-403. Returns the league so callers don't re-fetch it. */
async function requireOwner(leagueStore: any, leagueId: string, userId: string) {
  const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
  if (!league) return { error: jsonResponse(404, { ok: false, error: "League no longer exists" }, CORS_HEADERS) };
  if (league.ownerId !== userId) {
    return { error: jsonResponse(403, { ok: false, error: "Only the league owner can manage join requests" }, CORS_HEADERS) };
  }
  return { league };
}

/** Best-effort mail to the person who asked. Never throws: the membership
 *  write has already happened by the time this runs, and an email failure
 *  must not report a successful approval back as an error. */
async function notifyRequester(userStore: any, userId: string, mail: { subject: string; html: string }) {
  try {
    const to = await emailForUser(userStore, userId);
    if (to) await sendTransactional({ to, subject: mail.subject, html: mail.html });
  } catch {
    // swallow - see above
  }
}

async function ownerDisplayName(userStore: any, ownerId: string): Promise<string | null> {
  try {
    const p: any = await userStore.get(`users:${ownerId}`, { type: "json" });
    return p && typeof p.displayName === "string" && p.displayName.trim() ? p.displayName : null;
  } catch {
    return null;
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId: string = claims.id;

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const userStore = getStore(USER_STORE, { consistency: "strong" });

  // ---------- list ----------
  if (req.method === "GET") {
    const leagueId = new URL(req.url).searchParams.get("leagueId") || "";
    if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId is required" }, CORS_HEADERS);

    const owned = await requireOwner(leagueStore, leagueId, userId);
    if (owned.error) return owned.error;

    try {
      // Prefix list is safe here: unlike a freshly-written pick, a request
      // the owner is looking at was written by someone else seconds-to-days
      // ago, and the store is on strong consistency anyway.
      const { blobs } = await leagueStore.list({ prefix: `request:${leagueId}:` });
      const records = (
        await Promise.all(blobs.map((b: any) => leagueStore.get(b.key, { type: "json" }).catch(() => null)))
      ).filter(Boolean) as any[];

      records.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
      return jsonResponse(200, {
        ok: true,
        pending: records.filter((r) => r.status === "pending"),
        handled: records.filter((r) => r.status !== "pending").slice(-10),
      }, CORS_HEADERS);
    } catch (err) {
      return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
    }
  }

  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  // ---------- approve / decline ----------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Body must be valid JSON" }, CORS_HEADERS);
  }

  const leagueId = typeof body.leagueId === "string" ? body.leagueId.trim() : "";
  const targetUserId = typeof body.userId === "string" ? body.userId.trim() : "";
  const action = body.action === "approve" || body.action === "decline" ? body.action : null;
  if (!leagueId || !targetUserId || !action) {
    return jsonResponse(400, { ok: false, error: "leagueId, userId and action are required" }, CORS_HEADERS);
  }

  const owned = await requireOwner(leagueStore, leagueId, userId);
  if (owned.error) return owned.error;
  const league: any = owned.league;

  try {
    const key = `request:${leagueId}:${targetUserId}`;
    const request: any = await leagueStore.get(key, { type: "json" });
    if (!request) return jsonResponse(404, { ok: false, error: "That request no longer exists" }, CORS_HEADERS);
    if (request.status !== "pending") {
      // Already handled - most likely a double tap, or the owner has the
      // queue open in two places. Report the settled state rather than
      // erroring or, worse, adding the member twice.
      return jsonResponse(200, { ok: true, status: request.status }, CORS_HEADERS);
    }

    const now = new Date().toISOString();

    if (action === "decline") {
      await leagueStore.setJSON(key, { ...request, status: "declined", handledAt: now });
      await notifyRequester(userStore, targetUserId, buildRequestDeclinedEmail({
        leagueId, leagueName: league.name, format: league.format,
        ownerName: await ownerDisplayName(userStore, league.ownerId),
      }));
      return jsonResponse(200, { ok: true, status: "declined" }, CORS_HEADERS);
    }

    const membersDoc: any = (await leagueStore.get(`members:${leagueId}`, { type: "json" })) || { leagueId, members: [] };
    if (membersDoc.members.some((m: any) => m.userId === targetUserId)) {
      await leagueStore.setJSON(key, { ...request, status: "approved", handledAt: now });
      return jsonResponse(200, { ok: true, status: "approved" }, CORS_HEADERS);
    }
    // Capacity is re-checked at approval, not just at request time - the
    // league can fill up while a request sits in the queue, and approving
    // past the cap would put the league over its own limit.
    if (typeof league.maxMembers === "number" && membersDoc.members.length >= league.maxMembers) {
      return jsonResponse(409, { ok: false, error: "This league is full" }, CORS_HEADERS);
    }

    const profile: any = (await userStore.get(`users:${targetUserId}`, { type: "json" })) || null;
    const displayName =
      (profile && typeof profile.displayName === "string" && profile.displayName.trim())
        ? profile.displayName
        : request.displayName || "Player";
    const avatar = profile && typeof profile.avatar === "string" ? profile.avatar : (request.avatar ?? null);

    membersDoc.members.push({ userId: targetUserId, displayName, avatar, role: "member", joinedAt: now });
    league.memberCount = membersDoc.members.length;
    league.updatedAt = now;

    const leagues = profile && Array.isArray(profile.leagues) ? [...profile.leagues] : [];
    if (!leagues.includes(leagueId)) leagues.push(leagueId);

    await Promise.all([
      leagueStore.setJSON(`members:${leagueId}`, membersDoc),
      leagueStore.setJSON(`league:${leagueId}`, league),
      leagueStore.setJSON(key, { ...request, status: "approved", handledAt: now }),
      profile
        ? userStore.setJSON(`users:${targetUserId}`, { ...profile, leagues, updatedAt: now })
        : Promise.resolve(),
    ]);

    await notifyRequester(userStore, targetUserId, buildRequestApprovedEmail({
      leagueId, leagueName: league.name, format: league.format,
      ownerName: await ownerDisplayName(userStore, league.ownerId),
      memberCount: league.memberCount,
    }));

    return jsonResponse(200, { ok: true, status: "approved", memberCount: league.memberCount }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-requests",
};

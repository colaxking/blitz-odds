import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE, displayNameFromClaims } from "./lib/auth.mts";
import { sendTransactional, emailForUser } from "./lib/send-email.mts";
import { buildJoinRequestEmail } from "./lib/request-emails.mts";

// POST /.netlify/functions/league-join-request   Body: { leagueId: string }
//   -> { ok, status: "pending" | "member" }
//
// The path into a private league for someone who doesn't have the invite
// code. Private leagues are listed in search (see leagues-search.mts), so
// this is how a stranger asks for a spot; anyone holding the code still
// skips this entirely and joins directly through league-join.mts.
//
// One key per request (`request:{leagueId}:{userId}`) rather than a single
// document per league. Blobs set() is a full overwrite with no merge, so a
// per-league doc would need read-modify-write and two people requesting at
// the same moment would lose one of them. Per-key writes make that race
// impossible, and the owner's queue reads them with a prefix list().
//
// The requester's display name is snapshotted onto the record so the owner's
// queue renders without a profile fetch per row, the same tradeoff
// members:{leagueId} already makes.
//
// Re-requesting while already pending is a no-op on the record but still
// runs the owner-notification path, subject to a per-league cooldown - see
// the notify block near the bottom for why.

const LEAGUE_STORE = "blitz-leagues";
const USER_STORE = "blitz-users";

/** How long after mailing a league owner about join requests before another
 *  request against the same league is allowed to mail them again. */
const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId: string = claims.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Body must be valid JSON" }, CORS_HEADERS);
  }

  const leagueId = typeof body.leagueId === "string" ? body.leagueId.trim() : "";
  if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId is required" }, CORS_HEADERS);

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const userStore = getStore(USER_STORE, { consistency: "strong" });

  try {
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League no longer exists" }, CORS_HEADERS);
    if (league.locked) return jsonResponse(403, { ok: false, error: "This league is not accepting new members" }, CORS_HEADERS);
    // A public league has nothing to approve - the caller should have gone
    // straight to league-join. Saying so is more useful than silently
    // creating a request nobody will ever look at.
    if (league.visibility !== "private") {
      return jsonResponse(400, { ok: false, error: "This league can be joined directly" }, CORS_HEADERS);
    }

    const membersDoc: any = (await leagueStore.get(`members:${leagueId}`, { type: "json" })) || { members: [] };
    if (membersDoc.members.some((m: any) => m.userId === userId)) {
      return jsonResponse(200, { ok: true, status: "member" }, CORS_HEADERS);
    }
    if (typeof league.maxMembers === "number" && membersDoc.members.length >= league.maxMembers) {
      return jsonResponse(409, { ok: false, error: "This league is full" }, CORS_HEADERS);
    }

    const key = `request:${leagueId}:${userId}`;
    const existing: any = await leagueStore.get(key, { type: "json" });
    // A previous decline is deliberately not re-openable: without that,
    // declining someone just invites them to ask again, and the owner has no
    // way to make it stop.
    if (existing && existing.status === "declined") {
      return jsonResponse(403, { ok: false, error: "Your previous request for this league was declined" }, CORS_HEADERS);
    }
    // An existing pending request is idempotent as far as the *record* goes -
    // it isn't rewritten, so requestedAt stays honest. It deliberately does
    // NOT return early any more: it used to short-circuit above the notify
    // block, which meant that once someone had a request in flight, no
    // attempt they ever made could produce an email. The owner-side cooldown
    // below is what stops a retry turning into a mailbox full of duplicates.
    const alreadyPending = !!(existing && existing.status === "pending");

    const profile: any = await userStore.get(`users:${userId}`, { type: "json" });
    const displayName =
      (profile && typeof profile.displayName === "string" && profile.displayName.trim())
        ? profile.displayName
        : displayNameFromClaims(claims);

    if (!alreadyPending) {
      await leagueStore.setJSON(key, {
        leagueId,
        userId,
        displayName,
        avatar: profile && typeof profile.avatar === "string" ? profile.avatar : null,
        status: "pending",
        requestedAt: new Date().toISOString(),
      });
    }

    // Tell the owner, rate-limited by time rather than by queue depth.
    //
    // This used to fire only when the new request was the *only* pending one.
    // That read as "don't send ten emails for ten requests", but what it
    // actually did was go permanently silent: one request left unhandled in
    // the queue meant no further request against that league could ever mail
    // the owner again. A time window gets the same anti-spam result without
    // the trapdoor - a busy league is still capped at one mail an hour, and
    // the mail names the total waiting, so nothing is lost by batching.
    //
    // The stamp lives on its own key rather than on the request record,
    // because the thing being limited is "mail to this owner about this
    // league", not "mail about this one requester". Note the key does not
    // start with `request:`, so it can't turn up in the queue listings that
    // league-requests.mts and home-summary.mts do.
    try {
      const { blobs } = await leagueStore.list({ prefix: `request:${leagueId}:` });
      const all = await Promise.all(
        blobs.map((b) => leagueStore.get(b.key, { type: "json" }).catch(() => null))
      );
      const pendingCount = all.filter((r: any) => r && r.status === "pending").length;

      const stampKey = `notify:league:${leagueId}`;
      const stamp: any = await leagueStore.get(stampKey, { type: "json" });
      const lastAt = stamp && typeof stamp.lastNotifiedAt === "string" ? Date.parse(stamp.lastNotifiedAt) : NaN;
      const withinCooldown = Number.isFinite(lastAt) && Date.now() - lastAt < NOTIFY_COOLDOWN_MS;

      if (withinCooldown) {
        console.info("[join-request] owner mail suppressed by cooldown", { leagueId, pendingCount });
      } else {
        const ownerEmail = await emailForUser(userStore, league.ownerId);
        if (ownerEmail) {
          const mail = buildJoinRequestEmail({
            leagueId,
            leagueName: league.name,
            format: league.format,
            requesterName: displayName,
            memberCount: membersDoc.members.length,
            maxMembers: typeof league.maxMembers === "number" ? league.maxMembers : null,
            pendingCount,
          });
          const sent = await sendTransactional({ to: ownerEmail, subject: mail.subject, html: mail.html });
          // Only stamp on a successful send. Stamping regardless would let a
          // single Resend blip start an hour of silence on top of the failure.
          if (sent) {
            await leagueStore.setJSON(stampKey, { leagueId, lastNotifiedAt: new Date().toISOString() });
            console.info("[join-request] owner notified", { leagueId, pendingCount });
          }
        } else {
          console.warn("[join-request] owner has no email address", { leagueId, ownerId: league.ownerId });
        }
      }
    } catch (err) {
      // The request is already stored. An email that doesn't go out must
      // never turn a lodged request into an error for the person who made it.
      console.warn("[join-request] notify step failed", {
        leagueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(200, { ok: true, status: "pending" }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-join-request",
};

import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE, displayNameFromClaims } from "./lib/auth.mts";
import {
  SITE_URL, APP_URL, FORMAT_LABELS, FORMAT_BADGE_URLS, escapeHtml,
  emailShell, emailButton, emailFormatBadge, EMAIL_COLORS as C, EMAIL_MONO,
} from "./lib/email-shell.mts";

// Emails league invitations via Resend (https://resend.com). Any current
// member can send invites - not owner-only, since pick'em pools are
// usually grown by everyone bringing in their own friends, not just
// whoever happened to create the league.
//
// POST /.netlify/functions/league-invite
// Body: { leagueId: string, emails: string[] }
//   -> { ok, sent: string[], failed: [{ email, error }] }
//
// Every email includes the league name, description (if set), and who
// sent the invite. Private leagues also get the invite code, since that's
// the only way to join one; public leagues get pointed at Search Leagues
// instead (see league-join.mts - joining a public league by id needs no
// code, and codes aren't handed out for it in leagues-search.mts either).
//
// Requires a RESEND_API_KEY env var (Netlify site settings -> Environment
// variables) and a sending domain verified in the Resend dashboard that
// matches FROM_EMAIL below. Until both of those are set up this endpoint
// returns a clear 500 rather than silently failing.

const LEAGUE_STORE = "blitz-leagues";
const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_EMAIL = "Blitz Odds <invites@blitz-odds.com>";
// Explicit even though it matches FROM_EMAIL by default - domain now has
// receiving enabled in Resend, so replies to this address actually land
// somewhere instead of bouncing, and an explicit reply-to (vs. relying on
// the from address) is itself a small deliverability signal.
const REPLY_TO = "invites@blitz-odds.com";
const MAX_RECIPIENTS = 25;
// Deliberately simple - this only gates what we'll try to send an email
// to, not full RFC 5322 validation. Resend's own API is the real check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};




function buildInviteEmail(league: any, inviterName: string) {
  const isPrivate = league.visibility !== "public";
  const formatLabel = FORMAT_LABELS[league.format] || league.format;
    const subject = `${inviterName} invited you to join "${league.name}" on Blitz Odds`;

  // Deep link straight into the join flow: the frontend reads this query
  // param at load, forces the League tab open, and - once the recipient is
  // signed in (prompting sign-in first if they aren't) - calls
  // league-join.mts automatically. Query string, not a URL hash: Netlify
  // Identity's own confirm/invite/recovery email flows use hash tokens, and
  // some email click-trackers strip fragments entirely when rewriting
  // links, but query params survive both (see getInitialLeagueJoin in
  // index.html).
  // Path form rather than the old `/?joinCode=...#league`. The hash never
  // reached the server, so it was invisible to anything but the browser,
  // and a path is the only shape a native app's Universal Links can match
  // later. `getInitialLeagueJoin` still reads both query params, and always
  // will - invites already sitting in inboxes don't expire on our schedule.
  const joinUrl = isPrivate
    ? `${APP_URL}/join/${encodeURIComponent(league.inviteCode)}`
    : `${APP_URL}/join/league/${encodeURIComponent(league.id)}`;

  const descriptionHtml = league.description
    ? `<p style="margin:0 0 18px;color:${C.body};font-size:14px;line-height:1.5;">${escapeHtml(league.description)}</p>`
    : "";

  const joinButtonHtml = emailButton("Join League", joinUrl);

  const joinHtml = isPrivate
    ? `
      ${joinButtonHtml}
      <div style="margin:0 0 20px;padding:16px;border:1px solid ${C.panelBorder};border-radius:8px;background:${C.panelBg};text-align:center;">
        <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:${C.muted};">Invite Code</p>
        <p style="margin:0;font-size:24px;font-weight:800;letter-spacing:.1em;font-family:${EMAIL_MONO};color:${C.heading};">${escapeHtml(league.inviteCode)}</p>
        <p style="margin:8px 0 0;font-size:12px;color:${C.muted};">The button above uses this automatically - keep it handy only if you'd rather enter it by hand.</p>
      </div>`
    : `${joinButtonHtml}
      <p style="margin:0 0 20px;color:${C.body};font-size:14px;">
        The button signs you in (if needed) and joins <strong>${escapeHtml(league.name)}</strong> automatically - no code needed for public leagues.
      </p>`;

  // Badge image if we have one for this format, else fall back to the
  // plain-text pill this email used before badges existed - keeps this
  // forward-compatible with a future format value that hasn't gotten
  // artwork yet instead of rendering a broken image icon.
  const formatBadgeHtml = emailFormatBadge(
    league.format,
    `${formatLabel} pick'em`,
    `${league.season} season`
  );

  // No unsubscribe link: an invite is solicited by a person, not a
  // subscription, so there's nothing to unsubscribe from. emailShell omits
  // the whole line when unsubType is absent.
  const html = emailShell(
    `
        <p style="margin:0 0 6px;font-size:13px;color:${C.muted};">${escapeHtml(inviterName)} invited you to a pick'em league</p>
        <h1 style="margin:0 0 10px;font-size:22px;line-height:1.25;color:${C.heading};">${escapeHtml(league.name)}</h1>
        ${formatBadgeHtml}
        ${descriptionHtml}
        ${joinHtml}`,
    {
      reason: `You're receiving this because ${inviterName} invited you to a league on Blitz Odds. Questions? Just reply to this email.`,
    },
    `${inviterName} invited you to ${league.name} - ${formatLabel} pick'em.`
  );

  const text = [
    `${inviterName} invited you to join "${league.name}" on Blitz Odds`,
    "",
    `${formatLabel} pick'em - ${league.season} season`,
    league.description || null,
    "",
    `Join: ${joinUrl}`,
    isPrivate ? `(Signs you in if needed and fills in the invite code, ${league.inviteCode}, automatically.)` : `(Signs you in if needed and joins automatically - no code needed.)`,
    "",
    `You're receiving this because ${inviterName} invited you to a league on Blitz Odds. Questions? Just reply to this email.`,
  ].filter((line) => line !== null).join("\n");

  return { subject, html, text };
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId = claims.id;
  // Falls back to the derived first name rather than the email local-part.
  // Overridden below by the inviter's own name on their membership row for
  // this league, which is the one they chose and the one the recipient
  // will see in standings.
  let inviterName = displayNameFromClaims(claims) || "A Blitz Odds player";

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" }, CORS_HEADERS);
  }

  const leagueId = typeof body.leagueId === "string" ? body.leagueId : "";
  if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId is required" }, CORS_HEADERS);

  const rawEmails = Array.isArray(body.emails) ? body.emails : [];
  const seen = new Set<string>();
  const emails: string[] = [];
  const preInvalid: { email: string; error: string }[] = [];
  for (const raw of rawEmails) {
    if (typeof raw !== "string") continue;
    const email = raw.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (EMAIL_RE.test(email)) {
      emails.push(email);
    } else {
      preInvalid.push({ email, error: "Invalid email address" });
    }
  }

  if (!emails.length && !preInvalid.length) {
    return jsonResponse(400, { ok: false, error: "No email addresses provided" }, CORS_HEADERS);
  }
  if (emails.length + preInvalid.length > MAX_RECIPIENTS) {
    return jsonResponse(400, { ok: false, error: `Send ${MAX_RECIPIENTS} or fewer addresses at a time` }, CORS_HEADERS);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      500,
      { ok: false, error: "Email invites aren't configured yet - RESEND_API_KEY is missing" },
      CORS_HEADERS
    );
  }

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "eventual" });

  try {
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);

    const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
    const me = membersDoc?.members?.find((m: any) => m.userId === userId);
    if (!me) return jsonResponse(403, { ok: false, error: "Only league members can send invites" }, CORS_HEADERS);

    // The name this inviter shows under in this very league is the name the
    // recipient will recognise, and it's the one the inviter chose. The
    // claims-derived fallback above only applies if the membership row has
    // no name on it. user-profile.mts keeps these rows in step on rename.
    if (typeof me.displayName === "string" && me.displayName.trim()) inviterName = me.displayName;

    const { subject, html, text } = buildInviteEmail(league, inviterName);

    const settled = await Promise.allSettled(
      emails.map(async (toEmail) => {
        const res = await fetch(RESEND_API_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM_EMAIL, to: [toEmail], reply_to: REPLY_TO, subject, html, text }),
        });
        if (!res.ok) {
          let detail = "";
          try {
            const errBody: any = await res.json();
            detail = errBody?.message || "";
          } catch {
            // ignore - fall through to generic message below
          }
          throw new Error(detail || `Resend returned ${res.status}`);
        }
        return toEmail;
      })
    );

    const sent: string[] = [];
    const failed: { email: string; error: string }[] = [...preInvalid];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        sent.push(result.value);
      } else {
        failed.push({
          email: emails[i],
          error: result.reason instanceof Error ? result.reason.message : "Failed to send",
        });
      }
    });

    return jsonResponse(200, { ok: true, sent, failed }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-invite",
};

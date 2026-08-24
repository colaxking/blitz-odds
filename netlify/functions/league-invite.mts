import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";

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
const SITE_URL = "https://blitz-odds.com";
// Cropped/downscaled copy of the site's dark-background wordmark
// (branding/blitz-odds-wordmark-dark.svg), sized for an email header
// instead of the full 900px source - see branding/README.txt for the
// original artwork. Raster PNG, not SVG, since Outlook desktop doesn't
// render SVG in HTML email at all.
const WORDMARK_URL = "https://blitz-odds.com/branding/blitz-odds-wordmark-dark-email.png";
const MAX_RECIPIENTS = 25;
// Deliberately simple - this only gates what we'll try to send an email
// to, not full RFC 5322 validation. Resend's own API is the real check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FORMAT_LABELS: Record<string, string> = {
  straight_up: "Straight-Up",
  confidence: "Confidence",
  survivor: "Survivor",
  ats: "ATS",
};

function escapeHtml(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function buildInviteEmail(league: any, inviterName: string) {
  const isPrivate = league.visibility !== "public";
  const formatLabel = FORMAT_LABELS[league.format] || league.format;
  const subject = `${inviterName} invited you to join "${league.name}" on Blitz Odds`;

  const descriptionHtml = league.description
    ? `<p style="margin:0 0 18px;color:#333;font-size:14px;line-height:1.5;">${escapeHtml(league.description)}</p>`
    : "";

  const joinHtml = isPrivate
    ? `
      <div style="margin:20px 0;padding:16px;border:1px solid #d8dee4;border-radius:8px;background:#f6f8fa;text-align:center;">
        <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#57606a;">Invite Code</p>
        <p style="margin:0;font-size:24px;font-weight:800;letter-spacing:.1em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;">${escapeHtml(league.inviteCode)}</p>
      </div>
      <p style="margin:0 0 20px;color:#333;font-size:14px;">
        Open <a href="${SITE_URL}" style="color:#02a4a4;">blitz-odds.com</a>, sign in, go to the Leagues tab, and enter
        this code under "Have an invite code instead?" to join.
      </p>`
    : `
      <p style="margin:0 0 20px;color:#333;font-size:14px;">
        Open <a href="${SITE_URL}" style="color:#02a4a4;">blitz-odds.com</a>, sign in, go to the Leagues tab, and search
        for <strong>${escapeHtml(league.name)}</strong> under Search Leagues to join - no code needed.
      </p>`;

  const header = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:24px;background:#0a1420;border-radius:12px 12px 0 0;">
          <img src="${WORDMARK_URL}" width="200" alt="Blitz Odds" style="display:block;max-width:200px;height:auto;">
        </td>
      </tr>
    </table>`;

  const html = `
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e9ef;border-radius:12px;overflow:hidden;">
      ${header}
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:28px 24px;">
        <p style="margin:0 0 6px;font-size:13px;color:#57606a;">${escapeHtml(inviterName)} invited you to a pick'em league</p>
        <h1 style="margin:0 0 10px;font-size:22px;line-height:1.25;color:#111;">${escapeHtml(league.name)}</h1>
        <p style="margin:0 0 16px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#02a4a4;">
          ${escapeHtml(formatLabel)} pick'em &middot; ${escapeHtml(league.season)} season
        </p>
        ${descriptionHtml}
        ${joinHtml}
        <p style="margin:24px 0 0;font-size:12px;color:#8b949e;">
          Blitz Odds - free NFL pick'em confidence tool and odds analyzer.
        </p>
        <p style="margin:6px 0 0;font-size:11px;color:#b1bac4;">
          You're receiving this because ${escapeHtml(inviterName)} invited you to a league on Blitz Odds.
          Questions? Just reply to this email.
        </p>
      </div>
    </div>`;

  const text = [
    `${inviterName} invited you to join "${league.name}" on Blitz Odds`,
    "",
    `${formatLabel} pick'em - ${league.season} season`,
    league.description || null,
    "",
    isPrivate
      ? `Invite code: ${league.inviteCode}\nSign in at ${SITE_URL}, open the Leagues tab, and enter this code to join.`
      : `Sign in at ${SITE_URL}, open the Leagues tab, and search for "${league.name}" under Search Leagues to join.`,
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
  const inviterName =
    claims.user_metadata?.full_name || (claims.email ? claims.email.split("@")[0] : "A Blitz Odds player");

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
    const isMember = !!membersDoc?.members?.some((m: any) => m.userId === userId);
    if (!isMember) return jsonResponse(403, { ok: false, error: "Only league members can send invites" }, CORS_HEADERS);

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

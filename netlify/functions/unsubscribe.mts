import type { Context, Config } from "@netlify/functions";
import { getPrefs, setPrefs, verifyUnsubToken, type NotifType } from "./lib/notif.mts";
import { EMAIL_COLORS as C, EMAIL_FONT, SITE_URL, WORDMARK_URL, escapeHtml } from "./lib/email-shell.mts";

// Unsubscribe, reachable without being signed in.
//
// GET  ?u={userId}&t={reminders|weekly|all}&s={hmac}
//        -> applies the change, renders a branded confirmation page with a
//           one-tap resubscribe.
// POST same query string
//        -> applies the change, returns 204. This is the RFC 8058 one-click
//           target named by the List-Unsubscribe-Post header. Gmail and
//           Yahoo POST here directly from their own UI without ever loading
//           the page, and both increasingly require that path to exist for
//           bulk mail to reach the inbox at all.
//
// GET must be safe to call twice: mail clients and security scanners
// prefetch links in messages. Unsubscribing is idempotent (setting an
// already-false flag to false changes nothing) so a prefetch is harmless -
// but it does mean a scanner can unsubscribe someone who never clicked.
// That risk is why the confirmation page leads with resubscribe rather than
// burying it.

const TYPES = new Set(["reminders", "weekly", "all"]);

function page(title: string, message: string, actionHtml: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - Blitz Odds</title>
<meta name="robots" content="noindex">
</head>
<body style="margin:0;background:#dbe2ec;font-family:${EMAIL_FONT};">
  <div style="max-width:480px;margin:40px auto;padding:0 12px;">
    <div style="background:${C.shellBg};border:1px solid ${C.shellBorder};border-radius:12px;overflow:hidden;">
      <div style="padding:24px;background:${C.headerBg};text-align:center;">
        <img src="${WORDMARK_URL}" width="200" alt="Blitz Odds" style="display:block;margin:0 auto;max-width:200px;height:auto;">
      </div>
      <div style="padding:28px 24px;">
        <h1 style="margin:0 0 10px;font-size:20px;line-height:1.3;color:${C.heading};">${escapeHtml(title)}</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:${C.body};">${message}</p>
        ${actionHtml}
        <p style="margin:20px 0 0;padding-top:16px;border-top:1px solid ${C.panelBorder};font-size:12px;color:${C.foot};">
          Your leagues and picks are unchanged.
          <a href="${SITE_URL}/?settings=notifications" style="color:${C.teal};text-decoration:underline;">Manage all notifications</a>
        </p>
      </div>
    </div>
  </div>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="border-radius:8px;background:${C.teal};">
      <a href="${href}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr></table>`;
}

const LABELS: Record<string, string> = {
  reminders: "pick reminders",
  weekly: "the weekly recap",
  all: "all notification emails",
};

/** Turning something off, or (resubscribe=1) back on. */
async function apply(userId: string, type: NotifType, on: boolean) {
  if (type === "all") {
    await setPrefs(userId, { emailPickReminders: on, emailWeeklyRecap: on });
  } else if (type === "reminders") {
    await setPrefs(userId, { emailPickReminders: on });
  } else {
    await setPrefs(userId, { emailWeeklyRecap: on });
  }
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const userId = url.searchParams.get("u") || "";
  const type = (url.searchParams.get("t") || "") as NotifType;
  const sig = url.searchParams.get("s") || "";
  const resubscribe = url.searchParams.get("resubscribe") === "1";

  const valid = userId && TYPES.has(type) && verifyUnsubToken(userId, type, sig);

  if (!valid) {
    // A bad or expired link shouldn't dead-end someone who genuinely wants
    // out - point them at the signed-in settings instead.
    if (req.method === "POST") return new Response(null, { status: 400 });
    return page(
      "This link didn't work",
      "It may have been altered in transit, or the address it was issued for no longer exists.",
      button("Open notification settings", `${SITE_URL}/?settings=notifications`)
    );
  }

  try {
    await apply(userId, type, resubscribe);
  } catch (err) {
    if (req.method === "POST") return new Response(null, { status: 500 });
    return page(
      "Something went wrong",
      "We couldn't update your preferences just now. Try again from your account settings.",
      button("Open notification settings", `${SITE_URL}/?settings=notifications`)
    );
  }

  // One-click: no body, no page - the mail client is not a browser here.
  if (req.method === "POST") return new Response(null, { status: 204 });

  const label = LABELS[type] || "these emails";

  if (resubscribe) {
    const offUrl = `${SITE_URL}/.netlify/functions/unsubscribe?u=${encodeURIComponent(userId)}&t=${type}&s=${encodeURIComponent(sig)}`;
    return page(
      "You're back on",
      `You'll start receiving ${escapeHtml(label)} again.`,
      button("Actually, unsubscribe", offUrl)
    );
  }

  const backUrl = `${SITE_URL}/.netlify/functions/unsubscribe?u=${encodeURIComponent(userId)}&t=${type}&s=${encodeURIComponent(sig)}&resubscribe=1`;
  return page(
    "Unsubscribed",
    `You won't receive ${escapeHtml(label)} anymore. Changed your mind?`,
    button("Resubscribe", backUrl)
  );
};

export const config: Config = {
  path: "/.netlify/functions/unsubscribe",
};

import {
  emailShell,
  emailButton,
  emailEyebrow,
  emailPanel,
  escapeHtml,
  EMAIL_COLORS as C,
  EMAIL_MONO,
  SITE_URL,
  APP_URL,
} from "./email-shell.mts";

// The account emails: verify-your-address and reset-your-password. Same
// shell as the league invite and the weekly recap, so auth mail doesn't
// become the one corner of the product with its own look.
//
// These would ordinarily be Netlify Identity's job. They aren't, because
// Identity's custom-template and custom-sender settings are Pro-plan
// features and this site is on Personal - see lib/auth-tokens.mts for the
// full reasoning. The practical consequence for this file: the links point
// at OUR functions carrying OUR tokens, not at GoTrue's
// #confirmation_token= fragment, so there is no client-side token handling
// to get right.

/**
 * support@ rather than a fresh no-reply@: it is already a real inbound
 * address (MX configured, forwarded by inbound-forward.mts), so a reply to
 * "I didn't ask for this password reset" reaches a human instead of
 * bouncing. That is the single most important reply any of this mail can
 * receive and it should not go into a void.
 */
export const AUTH_FROM = "Blitz Odds <support@blitz-odds.com>";

const RESEND_API_URL = "https://api.resend.com/emails";

export interface TransactionalArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Deliberately NOT notif.mts's sendEmail. That function stamps every
 * message with List-Unsubscribe and List-Unsubscribe-Post, which is correct
 * for the reminder and the recap and wrong here twice over: these are
 * transactional (no subscription exists to leave), and an unsubscribe
 * header on a password reset invites a client to offer "unsubscribe from
 * these" on the one email a person must be able to receive to get back into
 * their account. It also requires a userId to build the token from, which
 * the forgot-password path does not have when the address is unknown.
 */
export async function sendTransactionalEmail(args: TransactionalArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is missing");

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: AUTH_FROM,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const errBody: any = await res.json();
      detail = errBody?.message || "";
    } catch {
      // fall through to the status-code message
    }
    throw new Error(detail || `Resend returned ${res.status}`);
  }
}

/* ------------------------------------------------------------------------ */
/* Shared body pieces                                                        */
/* ------------------------------------------------------------------------ */

const h1 = (text: string) =>
  `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:800;color:${C.heading};">${escapeHtml(text)}</h1>`;

const p = (text: string, extra = "") =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${C.body};${extra}">${text}</p>`;

/**
 * Every one of these emails is a single-link email. A button that a client
 * mangles is a person locked out of their account, so the raw URL always
 * ships underneath it.
 */
const fallback = (url: string) => `
  <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${C.muted};">
    Button not working? Paste this into your browser:
  </p>
  <p style="margin:0 0 20px;font-size:12px;line-height:1.5;word-break:break-all;font-family:${EMAIL_MONO};color:${C.teal};">
    ${escapeHtml(url)}
  </p>`;

const addressedTo = (email: string) =>
  emailPanel(
    `<p style="margin:0;font-size:13px;line-height:1.5;color:${C.muted};">
       This was sent to <span style="color:${C.body};font-weight:600;">${escapeHtml(email)}</span>.
     </p>`
  );

const expiryLine = (hours: number) =>
  p(
    `The link works once and expires in ${hours === 1 ? "an hour" : `${hours} hours`}.`,
    `font-size:13px;color:${C.muted};`
  );

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

/* ------------------------------------------------------------------------ */
/* Verify email address                                                      */
/* ------------------------------------------------------------------------ */

export function verifyUrl(token: string): string {
  return `${APP_URL}/.netlify/functions/auth-verify?t=${encodeURIComponent(token)}`;
}

export function buildVerifyEmail(args: { email: string; token: string }): BuiltEmail {
  const url = verifyUrl(args.token);

  const html = emailShell(
    `
      ${emailEyebrow("Confirm your email", C.teal)}
      ${h1("You're one tap from being in.")}
      ${p("Confirm this address and your Blitz Odds account is live &mdash; picks, leagues and alerts all unlock straight away.")}
      ${emailButton("Confirm my email", url)}
      ${fallback(url)}
      ${expiryLine(24)}
      ${addressedTo(args.email)}
      ${p(
        "Didn't sign up? Ignore this email and nothing happens &mdash; the account stays unconfirmed and no one can use it.",
        `font-size:13px;color:${C.muted};margin-bottom:0;`
      )}
    `,
    { reason: "You're getting this because someone signed up for Blitz Odds with this address." },
    "One tap and your account is live."
  );

  const text = [
    "Confirm your email",
    "",
    "Confirm this address and your Blitz Odds account is live - picks, leagues and alerts all unlock straight away.",
    "",
    url,
    "",
    "The link works once and expires in 24 hours.",
    "",
    `This was sent to ${args.email}.`,
    "Didn't sign up? Ignore this email and nothing happens.",
    "",
    "Blitz Odds - free NFL pick'em confidence tool and odds analyzer.",
    SITE_URL,
  ].join("\n");

  return { subject: "Confirm your Blitz Odds email", html, text };
}

/* ------------------------------------------------------------------------ */
/* Password reset                                                            */
/* ------------------------------------------------------------------------ */

export function resetUrl(token: string): string {
  return `${APP_URL}/?reset=${encodeURIComponent(token)}`;
}

export function buildResetEmail(args: { email: string; token: string }): BuiltEmail {
  const url = resetUrl(args.token);

  const html = emailShell(
    `
      ${emailEyebrow("Password reset", C.warn)}
      ${h1("Set a new password.")}
      ${p("Use the link below to choose a new password for your Blitz Odds account.")}
      ${emailButton("Choose a new password", url)}
      ${fallback(url)}
      ${expiryLine(1)}
      ${addressedTo(args.email)}
      ${p(
        "Didn't ask for this? Ignore it &mdash; your current password keeps working and nothing changes. If you keep getting these, reply to this email and we'll look into it.",
        `font-size:13px;color:${C.muted};margin-bottom:0;`
      )}
    `,
    { reason: "You're getting this because a password reset was requested for this address." },
    "Choose a new password for your account."
  );

  const text = [
    "Reset your password",
    "",
    "Use the link below to choose a new password for your Blitz Odds account.",
    "",
    url,
    "",
    "The link works once and expires in an hour.",
    "",
    `This was sent to ${args.email}.`,
    "Didn't ask for this? Ignore it - your current password keeps working.",
    "",
    "Blitz Odds - free NFL pick'em confidence tool and odds analyzer.",
    SITE_URL,
  ].join("\n");

  return { subject: "Reset your Blitz Odds password", html, text };
}

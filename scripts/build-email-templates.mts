#!/usr/bin/env node
/**
 * build-email-templates.mts
 *
 * Renders the four Netlify Identity email templates (confirmation, invite,
 * recovery, email change) into /email-templates/*.html, built from the same
 * lib/email-shell.mts every Resend email uses. Identity's custom-template
 * feature (Pro plan) reads these files from the PUBLISHED deploy, so they
 * ship as static assets and are pointed at from
 *   Project configuration > Identity > Emails > {Confirmation,Invitation,
 *   Password recovery,Email change} > Path to template
 * as /email-templates/confirmation.html etc.
 *
 * Why generate rather than hand-write: the shell is the single place the
 * transactional look lives. A hand-written copy would drift the moment the
 * shell changed. The output is committed, so this only needs to run when
 * the shell or the copy below changes:
 *
 *   node scripts/build-email-templates.mts
 *
 * (Node 22.18+ strips the types natively - no build step, same as the
 * functions themselves under Netlify.)
 *
 * What these templates are actually for. auth-signup / auth-forgot own
 * sign-up confirmation and password reset end to end via Resend, so in
 * practice GoTrue only sends the INVITE (a dashboard invite from Identity >
 * Users) and the EMAIL CHANGE confirmation. Confirmation and recovery are
 * still rendered so that if either GoTrue path ever fires - an account
 * created from the dashboard, a recovery triggered through the widget - it
 * arrives looking like ours instead of Netlify's grey default.
 *
 * Template variables are Go text/template syntax and are the only dynamic
 * data GoTrue offers: {{ .ConfirmationURL }}, {{ .Email }}, {{ .SiteURL }},
 * {{ .Token }}. They are written raw, never through escapeHtml, and the
 * link always uses ConfirmationURL (never SiteURL + Token by hand) because
 * that's the one GoTrue signs and the widget knows how to consume.
 *
 * Every link points at the production origin via ConfirmationURL - GoTrue
 * builds it from the site's Identity settings, not from a deploy preview,
 * so unlike lib/auth-emails.mts there is no APP_URL concern here.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  emailShell,
  emailButton,
  emailEyebrow,
  emailPanel,
  EMAIL_COLORS as C,
  EMAIL_MONO,
} from "../netlify/functions/lib/email-shell.mts";

const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "email-templates"
);

// GoTrue's template variables. Raw on purpose - see header.
const URL = "{{ .ConfirmationURL }}";
const EMAIL = "{{ .Email }}";

/* Same small helpers as lib/auth-emails.mts. Duplicated rather than
   exported from there because that module is a Netlify Function library
   (imports Resend config, expects RESEND_API_KEY at runtime) and this is a
   build script; five one-liners are cheaper than coupling the two. */

const h1 = (text: string) =>
  `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${C.heading};">${text}</h1>`;

const p = (html: string, extra = "") =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${C.body};${extra}">${html}</p>`;

const fallback = (url: string) => `
  <p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${C.muted};">
    If the button doesn't work, paste this link into your browser:
  </p>
  <p style="margin:0 0 20px;font-size:12px;line-height:1.5;word-break:break-all;font-family:${EMAIL_MONO};color:${C.teal};">
    ${url}
  </p>`;

const addressedTo = (email: string) =>
  emailPanel(
    `<p style="margin:0;font-size:13px;line-height:1.5;color:${C.muted};">
       This was sent to <span style="color:${C.body};font-weight:600;">${email}</span>.
     </p>`
  );

const quiet = (html: string) =>
  p(html, `font-size:13px;color:${C.muted};margin-bottom:0;`);

/* ------------------------------------------------------------------------ */

interface Template {
  file: string;
  body: string;
  reason: string;
  preheader: string;
}

const TEMPLATES: Template[] = [
  {
    file: "confirmation.html",
    preheader: "One tap and your account is live.",
    reason: "You're getting this because someone signed up for Blitz Odds with this address.",
    body: `
      ${emailEyebrow("Confirm your email", C.teal)}
      ${h1("You're one tap from being in.")}
      ${p("Confirm this address and your Blitz Odds account is live &mdash; picks, leagues and alerts all unlock straight away.")}
      ${emailButton("Confirm my email", URL)}
      ${fallback(URL)}
      ${addressedTo(EMAIL)}
      ${quiet("Didn't sign up? Ignore this email and nothing happens &mdash; the account stays unconfirmed and no one can use it.")}
    `,
  },
  {
    file: "invite.html",
    preheader: "Set a password and you're in.",
    reason: "You're getting this because a Blitz Odds admin created an account for this address.",
    body: `
      ${emailEyebrow("You're invited", C.teal)}
      ${h1("Your Blitz Odds account is waiting.")}
      ${p("Someone at Blitz Odds set up an account for you. Tap below to choose a password and you're in &mdash; free NFL pick'em confidence rankings, leagues and game alerts.")}
      ${emailButton("Accept invite", URL)}
      ${fallback(URL)}
      ${addressedTo(EMAIL)}
      ${quiet("Not expecting this? Ignore it and the account is never activated. If you have questions, reply to this email and a human will answer.")}
    `,
  },
  {
    file: "recovery.html",
    preheader: "Choose a new password for your account.",
    reason: "You're getting this because a password reset was requested for this address.",
    body: `
      ${emailEyebrow("Password reset", C.warn)}
      ${h1("Set a new password.")}
      ${p("Use the link below to choose a new password for your Blitz Odds account.")}
      ${emailButton("Choose a new password", URL)}
      ${fallback(URL)}
      ${addressedTo(EMAIL)}
      ${quiet("Didn't ask for this? Ignore it &mdash; your current password keeps working and nothing changes. If you keep getting these, reply to this email and we'll look into it.")}
    `,
  },
  {
    file: "email-change.html",
    preheader: "Confirm your new email address.",
    reason: "You're getting this because an email address change was requested on a Blitz Odds account.",
    body: `
      ${emailEyebrow("Confirm your new email", C.teal)}
      ${h1("Make this your new address.")}
      ${p("You asked to move your Blitz Odds account to this email address. Confirm below and sign-in, league invites and alerts will all use it from now on.")}
      ${emailButton("Confirm new email", URL)}
      ${fallback(URL)}
      ${addressedTo(EMAIL)}
      ${quiet("Didn't request this? Ignore it and your account keeps its current address. If you think someone else has access to your account, reply to this email.")}
    `,
  },
];

/* Identity templates are full documents, not fragments (the Resend path
   sends bare shell HTML and lets the client wrap it, but here GoTrue mails
   the file as-is). Minimal wrapper: no <style>, since Gmail strips <head>
   and the shell is fully inline anyway. */
function document(inner: string, preheader: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformat">
<title>Blitz Odds</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f0f2f5;">
${inner}
</body>
</html>
`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const t of TEMPLATES) {
    const html = document(emailShell(t.body, { reason: t.reason }, t.preheader), t.preheader);
    // GoTrue must see the variables verbatim. A regression here (someone
    // routes URL through escapeHtml, say) would mail a dead button.
    for (const v of ["{{ .ConfirmationURL }}", "{{ .Email }}"]) {
      if (!html.includes(v)) throw new Error(`${t.file}: template variable ${v} missing`);
    }
    await writeFile(path.join(OUT_DIR, t.file), html, "utf8");
    console.log(`wrote email-templates/${t.file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

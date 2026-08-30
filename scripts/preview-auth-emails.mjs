// Renders the account emails from the real builders with sample data, so
// they can be eyeballed without sending. Same shape as
// preview-notif-emails.mjs. Run: node scripts/preview-auth-emails.mjs [outFile]

import { writeFileSync, readFileSync } from "node:fs";
import { buildVerifyEmail, buildResetEmail, AUTH_FROM } from "../netlify/functions/lib/auth-emails.mts";
import { EMAIL_FONT, WORDMARK_URL } from "../netlify/functions/lib/email-shell.mts";

const outFile = process.argv[2] || "/tmp/auth-email-preview.html";

// PREVIEW ONLY. The sent mail keeps the absolute https:// URL - Gmail and
// Outlook both strip data: URIs, so an inlined image would render here and
// nowhere else. Inlined purely so the preview survives a sandboxed viewer.
const WORDMARK_DATA_URI = `data:image/png;base64,${readFileSync(
  "branding/blitz-odds-wordmark-dark-email.png"
).toString("base64")}`;

const SAMPLE_EMAIL = "dan@blitz-odds.com";
const SAMPLE_TOKEN = "hZ9k2QvT4mXbN7pLsR1wYcJ3fD8gK5aE2nP6tU0bV4s";

const built = [
  { file: "auth-verify (signup)", mail: buildVerifyEmail({ email: SAMPLE_EMAIL, token: SAMPLE_TOKEN }) },
  { file: "auth-forgot (password reset)", mail: buildResetEmail({ email: SAMPLE_EMAIL, token: SAMPLE_TOKEN }) },
];

const cards = built
  .map(({ file, mail }) => `
    <section class="slot">
      <header class="slot-head">
        <span class="file">${file}</span>
        <span class="meta"><b>From:</b> ${AUTH_FROM.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>
        <span class="meta"><b>Subject:</b> ${mail.subject}</span>
      </header>
      <div class="frame">${mail.html.split(WORDMARK_URL).join(WORDMARK_DATA_URI)}</div>
    </section>`)
  .join("\n");

writeFileSync(outFile, `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blitz Odds - account emails</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:20px 12px 60px; background:#eef1f5; font-family:${EMAIL_FONT}; }
  .page-head { max-width:560px; margin:0 auto 24px; }
  .page-head h1 { margin:0 0 6px; font-size:19px; color:#0a1420; }
  .page-head p { margin:0; font-size:13px; line-height:1.55; color:#57606a; }
  .slot { max-width:560px; margin:0 auto 34px; }
  .slot-head { display:flex; flex-direction:column; gap:2px; margin:0 0 10px; padding:0 4px; }
  .file { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:#02a4a4; }
  .meta { font-size:13px; color:#333; }
</style>
</head>
<body>
  <div class="page-head">
    <h1>Account emails</h1>
    <p>Built by <code>lib/auth-emails.mts</code> from the same <code>email-shell.mts</code> as the league invite and weekly recap. Sent through Resend, not Netlify Identity.</p>
  </div>
  ${cards}
</body>
</html>
`);
console.log(`Wrote ${outFile}`);

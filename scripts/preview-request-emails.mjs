// Renders the three join-request emails from the real builders with sample
// data, so they can be eyeballed without sending. Mirrors
// preview-notif-emails.mjs.
// Run: node scripts/preview-request-emails.mjs [outDir]

import { writeFileSync, mkdirSync } from "node:fs";
import {
  buildJoinRequestEmail,
  buildRequestApprovedEmail,
  buildRequestDeclinedEmail,
} from "../netlify/functions/lib/request-emails.mts";

const outDir = process.argv[2] || "/tmp/request-preview";
mkdirSync(outDir, { recursive: true });

const files = {
  "owner-new-request.html": buildJoinRequestEmail({
    leagueId: "lg_4thfloor", leagueName: "4th Floor Pick'em", format: "confidence",
    requesterName: "Marcus T.", memberCount: 11, maxMembers: 16, pendingCount: 3,
  }),
  "owner-new-request-single.html": buildJoinRequestEmail({
    leagueId: "lg_miller", leagueName: "The Miller Family Pool", format: "straight_up",
    requesterName: "Jess R.", memberCount: 9, maxMembers: 20, pendingCount: 1,
  }),
  "requester-approved.html": buildRequestApprovedEmail({
    leagueId: "lg_4thfloor", leagueName: "4th Floor Pick'em", format: "confidence",
    ownerName: "Austin J.", memberCount: 12,
  }),
  "requester-declined.html": buildRequestDeclinedEmail({
    leagueId: "lg_miller", leagueName: "The Miller Family Pool", format: "straight_up",
    ownerName: "Dana M.",
  }),
};

for (const [name, mail] of Object.entries(files)) {
  writeFileSync(
    `${outDir}/${name}`,
    `<!doctype html><meta charset="utf-8"><title>${mail.subject}</title>` +
    `<body style="margin:0;padding:24px;background:#eef1f5;">` +
    `<p style="font:600 13px -apple-system,sans-serif;color:#57606a;margin:0 0 12px;">Subject: ${mail.subject}</p>` +
    mail.html + `</body>`,
    "utf8"
  );
  console.log(`${name}  —  ${mail.subject}`);
}
console.log(`\nWrote ${Object.keys(files).length} files to ${outDir}`);

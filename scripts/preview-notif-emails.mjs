// Renders both scheduled emails from the real builders with sample data, so
// they can be eyeballed (and pasted into a client tester) without sending.
// Run: node scripts/preview-notif-emails.mjs [outDir]

import { writeFileSync, mkdirSync } from "node:fs";
import { buildReminderEmail, buildRecapEmail } from "../netlify/functions/lib/notif-emails.mts";

const outDir = process.argv[2] || "/tmp/notif-preview";
mkdirSync(outDir, { recursive: true });

const UNSUB = "https://blitz-odds.com/.netlify/functions/unsubscribe?u=SAMPLE&t=reminders&s=SAMPLE";

const reminder = buildReminderEmail({
  season: 2026, week: 12,
  kickLabel: "Wednesday 8:00 PM ET",
  leagues: [
    { format: "confidence", name: "Office Pool 2025", missing: 16, total: 16 },
    { format: "survivor", name: "Sunday Crew", missing: 1, total: 1 },
    { format: "ats", name: "Degens Anonymous", missing: 16, total: 16 },
  ],
  firstGame: {
    away: "GB", home: "LAR", awayName: "Green Bay Packers", homeName: "Los Angeles Rams",
    line: "LAR -3.5 - O/U 47.5",
  },
  unsubUrl: UNSUB,
});

const recapAlive = buildRecapEmail({
  season: 2026, week: 11,
  intro: "You went 28-20 across 3 leagues and moved up in 2.",
  leagues: [
    {
      format: "confidence", name: "Office Pool 2025", seasonLabel: "2026 season",
      headline: "11-5 - 84 pts", headlineTone: "neutral", rank: 3, total: 14, delta: 2,
      standings: [
        { rank: 2, name: "J. Kim", value: "1,027" },
        { rank: 3, name: "You", value: "1,022", isMe: true },
        { rank: 4, name: "T. Boone", value: "1,008" },
      ],
      foot: "19 pts back of 1st",
    },
    {
      format: "survivor", name: "Sunday Crew", seasonLabel: "2026 season",
      headline: "Survived", headlineTone: "win", rank: "6", total: 22, delta: 0,
      pick: { teamAbbr: "BAL", teamName: "Baltimore Ravens", result: "W 24-17", tone: "alive" },
      stripLabel: "Your pick",
      foot: "16 knocked out in Week 11",
    },
    {
      format: "ats", name: "Degens Anonymous", seasonLabel: "2026 season",
      headline: "6-10 ATS", headlineTone: "loss", rank: 9, total: 12, delta: -1,
      standings: [
        { rank: 8, name: "R. Patel", value: "84-76" },
        { rank: 9, name: "You", value: "79-81", isMe: true },
        { rank: 10, name: "C. Duffy", value: "77-83" },
      ],
      foot: "5 pts back of 1st",
    },
  ],
  highlights: [
    { label: "Best call", tone: "win", headline: "Denver Broncos - banked 13 pts", detail: "Your highest-ranked pick that came in." },
    { label: "Costliest miss", tone: "loss", headline: "Kansas City Chiefs - lost 16 pts", detail: "Your 16-point pick didn't land." },
  ],
  unsubUrl: UNSUB,
});

const recapOut = buildRecapEmail({
  season: 2026, week: 11,
  intro: "You went 28-20 across 3 leagues.",
  leagues: [
    {
      format: "survivor", name: "Sunday Crew", seasonLabel: "2026 season",
      headline: "Eliminated in Week 11", headlineTone: "loss", rank: "Out", total: null, delta: 0,
      pick: { teamAbbr: "PIT", teamName: "Pittsburgh Steelers", result: "L 17-24", tone: "out" },
      stripLabel: "Your pick",
      foot: "6 of 22 still alive. You lasted 11 weeks.",
    },
  ],
  highlights: [],
  unsubUrl: UNSUB,
});

const page = (title, email) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${title}</title></head>
<body style="margin:0;background:#eef1f5;padding:24px 12px;">
<p style="max-width:480px;margin:0 auto 12px;font:600 13px -apple-system,sans-serif;color:#57606a;">
  Subject: ${email.subject}</p>
${email.html}
<p style="max-width:480px;margin:24px auto 0;font:12px ui-monospace,monospace;color:#8b949e;white-space:pre-wrap;border-top:1px solid #d8dee4;padding-top:12px;">${email.text.replace(/</g, "&lt;")}</p>
</body></html>`;

writeFileSync(`${outDir}/reminder.html`, page("Pick reminder", reminder));
writeFileSync(`${outDir}/recap-alive.html`, page("Weekly recap", recapAlive));
writeFileSync(`${outDir}/recap-eliminated.html`, page("Weekly recap (eliminated)", recapOut));

for (const [name, e] of [["reminder", reminder], ["recap-alive", recapAlive], ["recap-eliminated", recapOut]]) {
  console.log(`${name.padEnd(18)} subject: ${e.subject}`);
  console.log(`${"".padEnd(18)} html: ${(e.html.length / 1024).toFixed(1)}kb  text: ${e.text.length}b`);
}
console.log(`\nWritten to ${outDir}/`);

// Exercises the reminder send-time computation against real 2026 schedule
// weeks and a spread of reader timezones. Run: node scripts/test-notif-timing.mjs
//
// This is the piece most likely to be quietly wrong - it crosses a timezone
// boundary, a DST boundary, and a calendar-day boundary all at once - and
// the failure mode (an email at 3am, or after kickoff) is invisible until a
// real user complains.

import { readFileSync } from "node:fs";
import { parseKickoffUTC } from "../netlify/functions/lib/kickoff.mts";
import { firstKickoffOf, kickoffLabel, reminderSendInstant } from "../netlify/functions/notif-dispatch-background.mts";

const SEASON = 2026;
const schedule = JSON.parse(readFileSync(new URL("../data/schedule-full-2026.json", import.meta.url)));

const ZONES = ["America/New_York", "America/Los_Angeles", "America/Denver", "Pacific/Honolulu", "Europe/London", "Asia/Tokyo"];
const CUTOFF_MS = 3 * 60 * 60 * 1000;

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log("  FAIL: " + msg); } };

const fmt = (d, tz) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d);

console.log("Reminder send times, by week shape and reader timezone\n");

// A representative slice: week 1 (Wednesday opener), an ordinary Thursday
// week, Thanksgiving, and the Saturday-heavy end of the season.
const sample = [1, 5, 12, 13, 17, 18];

for (const wk of sample) {
  const entry = schedule.weeks.find((w) => w.week === wk);
  if (!entry) continue;
  const kickoff = firstKickoffOf(SEASON, entry.games);
  if (!kickoff) { console.log(`Week ${wk}: no parseable kickoff (TBD week) - skipped\n`); continue; }

  const opener = entry.games.find((g) => {
    const k = parseKickoffUTC(SEASON, g.date, g.time);
    return k && k.getTime() === kickoff.getTime();
  });

  console.log(`Week ${wk} - opens ${opener.away} @ ${opener.home}, ${kickoffLabel(kickoff)}`);

  for (const tz of ZONES) {
    const sendAt = reminderSendInstant(kickoff, tz);
    const leadH = (kickoff.getTime() - sendAt.getTime()) / 3600000;
    console.log(`    ${tz.padEnd(21)} send ${fmt(sendAt, tz).padEnd(26)} (${leadH.toFixed(1)}h lead)`);

    // The send must land at 7pm local - that's the entire promise.
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(sendAt)
    ) % 24;
    check(localHour === 19, `week ${wk} ${tz}: expected 19:00 local, got ${localHour}:00`);

    // It must be before kickoff, and outside the 3h dead zone.
    check(sendAt.getTime() < kickoff.getTime(), `week ${wk} ${tz}: send is after kickoff`);
    check(kickoff.getTime() - sendAt.getTime() > CUTOFF_MS, `week ${wk} ${tz}: only ${leadH.toFixed(1)}h lead - inside the cutoff`);

    // And it must be the local day before kickoff's local day.
    const dayOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const expectedPrev = dayOf(new Date(kickoff.getTime() - 86400000 * 0));
    const sendDay = dayOf(sendAt);
    check(sendDay < expectedPrev, `week ${wk} ${tz}: send day ${sendDay} is not before kickoff day ${expectedPrev}`);
  }
  console.log();
}

// DST boundary: US clocks fall back on Nov 1, 2026. A week straddling it
// must still land at 7pm wall-clock, not 6pm or 8pm.
console.log("DST fall-back check (US clocks change Sun Nov 1, 2026)");
const nov = schedule.weeks.find((w) =>
  (w.games || []).some((g) => /Nov\s+[1-5]\b/.test(g.date))
);
if (nov) {
  const k = firstKickoffOf(SEASON, nov.games);
  for (const tz of ["America/New_York", "America/Los_Angeles"]) {
    const s = reminderSendInstant(k, tz);
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(s)) % 24;
    console.log(`    week ${nov.week} ${tz}: ${fmt(s, tz)} (hour ${h})`);
    check(h === 19, `DST week ${tz}: expected 19:00, got ${h}:00`);
  }
} else {
  console.log("    (no early-November week found in this schedule)");
}

console.log(failures === 0 ? "\nAll timing assertions passed." : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

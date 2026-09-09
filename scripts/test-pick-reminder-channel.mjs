// Exercises the pick reminder's channel choice - push when a device can be
// reached, email when it can't - against a stubbed Blobs store, a stubbed
// web-push, and a stubbed Resend.
//
// Run: node scripts/test-pick-reminder-channel.mjs
//
// This is the piece worth testing because its failure modes are both silent
// and both bad: sending on BOTH channels (one nudge arriving twice, which is
// what gets a sender muted) and sending on NEITHER (a push that couldn't be
// delivered and no email behind it). Neither shows up as an error anywhere.
//
// The dispatcher is bundled through esbuild rather than imported directly so
// that @netlify/blobs, web-push and the schedule JSON can all be swapped for
// fixtures at the module boundary.

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SEASON = 2026;
const WEEK = 6;

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
};

// --- Fixtures --------------------------------------------------------------

// A single Thursday game, so "first kickoff" is unambiguous. The reminder
// fires at 7pm local the evening before, which for America/New_York is
// 2026-10-14T23:00Z.
const KICKOFF_ISO = "2026-10-15T20:15:00-04:00";
const GAMES = [{ away: "MIN", home: "DEN", date: "Thu, Oct 15", time: "8:15 PM ET" }];
const NOW = new Date("2026-10-14T23:30:00Z");   // just past the send instant

const GAME_ID = `${SEASON}-w${WEEK}-MIN-DEN`;

function makeStores(users) {
  const data = new Map();

  data.set("blitz-site-data\u0000schedule-full-2026", {
    weeks: [{ week: WEEK, games: GAMES }],
  });
  data.set("blitz-site-data\u0000teams", { teams: [{ id: "MIN", name: "Vikings" }, { id: "DEN", name: "Broncos" }] });

  data.set("blitz-leagues\u0000league:L1", { season: SEASON, format: "confidence", name: "Sunday Funday", locked: false });

  for (const u of users) {
    data.set(`blitz-users\u0000users:${u.id}`, { email: `${u.id}@example.com`, leagues: ["L1"], settings: { favorites: [] } });
    data.set("blitz-leagues\u0000members:L1", {
      members: users.map((x) => ({ userId: x.id, displayName: x.id })),
    });
    data.set(`blitz-notif\u0000prefs:${u.id}`, {
      emailPickReminders: u.email,
      emailWeeklyRecap: false,
      timezone: "America/New_York",
      push: { kickoff: false, scoring: "off", final: false, scope: "fav", injuries: "off", inGameInjury: false, pickReminder: u.push, lastCall: false, quietFrom: null, quietTo: null },
    });
    if (u.device) {
      data.set(`blitz-notif\u0000push:${u.id}:d1`, {
        platform: "web", createdAt: "2026-09-01T00:00:00Z",
        web: { endpoint: "https://push.example.com/x", keys: { p256dh: "p", auth: "a" } },
      });
    }
  }
  return data;
}

function blobsStub(data) {
  return `
    export function getStore(name, _opts) {
      const prefix = (typeof name === "string" ? name : name.name) + "\\u0000";
      return {
        async get(key) { const v = globalThis.__BLOBS.get(prefix + key); return v === undefined ? null : v; },
        async setJSON(key, value) { globalThis.__BLOBS.set(prefix + key, value); },
        async delete(key) { globalThis.__BLOBS.delete(prefix + key); },
        async *list({ prefix: p = "", paginate }) {
          const blobs = [...globalThis.__BLOBS.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((k) => k.slice(prefix.length))
            .filter((k) => k.startsWith(p))
            .map((key) => ({ key }));
          yield { blobs };
        },
      };
    }
  `;
}

const WEBPUSH_STUB = `
  export default {
    setVapidDetails() {},
    async sendNotification(sub, payload) {
      globalThis.__PUSHES.push(JSON.parse(payload));
      if (globalThis.__PUSH_FAILS) { const e = new Error("gone"); e.statusCode = 410; throw e; }
      return { statusCode: 201 };
    },
  };
`;

// --- Build -----------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "pickrem-"));
writeFileSync(join(dir, "blobs.mjs"), blobsStub());
writeFileSync(join(dir, "webpush.mjs"), WEBPUSH_STUB);

const out = join(dir, "dispatch.mjs");
execFileSync("npx", ["esbuild", "netlify/functions/notif-dispatch-background.mts",
  "--bundle", "--format=esm", "--platform=node",
  `--alias:@netlify/blobs=${join(dir, "blobs.mjs")}`,
  `--alias:web-push=${join(dir, "webpush.mjs")}`,
  "--external:@netlify/functions",
  `--outfile=${out}`], { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"] });

const { default: dispatch } = await import(pathToFileURL(out).href);

// --- Harness ---------------------------------------------------------------

process.env.NOTIF_DISPATCH_SECRET = "s";
process.env.NOTIF_UNSUB_SECRET = "u";
process.env.RESEND_API_KEY = "rk";
process.env.VAPID_PUBLIC_KEY = "pub";
process.env.VAPID_PRIVATE_KEY = "priv";
process.env.VAPID_SUBJECT = "mailto:support@blitz-odds.com";

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("resend.com")) {
    globalThis.__EMAILS.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  }
  return realFetch(url, init);
};

async function run(users, { pushFails = false, keepStore = null } = {}) {
  globalThis.__BLOBS = keepStore || makeStores(users);
  globalThis.__EMAILS = [];
  globalThis.__PUSHES = [];
  globalThis.__PUSH_FAILS = pushFails;

  const req = new Request("https://x/", {
    method: "POST",
    headers: { "x-notif-dispatch-secret": "s", "Content-Type": "application/json" },
    body: JSON.stringify({ now: NOW.toISOString(), only: "reminder" }),
  });
  const res = await dispatch(req, {});
  const body = await res.json();
  return { body, emails: globalThis.__EMAILS, pushes: globalThis.__PUSHES, store: globalThis.__BLOBS };
}

// --- Cases -----------------------------------------------------------------

console.log("\nPick reminder channel selection\n");

{
  console.log("Push on, device registered -> push only");
  const r = await run([{ id: "u1", email: true, push: true, device: true }]);
  check(r.pushes.length === 1, "one push sent");
  check(r.emails.length === 0, "no email sent alongside it");
  check(/still open/.test(r.pushes[0]?.title || ""), `title reads sensibly: "${r.pushes[0]?.title}"`);
  check(r.pushes[0]?.url === "/leagues", "tap target is /leagues");
  check(r.body.reminder.sent[0]?.channel === "push", "report records channel=push");
}

{
  console.log("\nPush on, NO device registered -> email fallback");
  const r = await run([{ id: "u2", email: true, push: true, device: false }]);
  check(r.pushes.length === 0, "no push attempted to a device that isn't there");
  check(r.emails.length === 1, "email sent as the fallback");
  check(r.body.reminder.sent[0]?.channel === "email", "report records channel=email");
  check(r.body.pickReminderPush.outcomes["no-devices"] === 1, "push outcome logged as no-devices");
}

{
  console.log("\nPush on, device registered, delivery FAILS -> email fallback");
  const r = await run([{ id: "u3", email: true, push: true, device: true }], { pushFails: true });
  check(r.pushes.length === 1, "push was attempted");
  check(r.emails.length === 1, "email sent behind the failed push");
}

{
  console.log("\nPush off, email on -> email only");
  const r = await run([{ id: "u4", email: true, push: false, device: true }]);
  check(r.pushes.length === 0, "no push");
  check(r.emails.length === 1, "email sent");
}

{
  console.log("\nPush on, email off, no device -> nothing, and no crash");
  const r = await run([{ id: "u5", email: false, push: true, device: false }]);
  check(r.pushes.length === 0 && r.emails.length === 0, "silent, as configured");
  check((r.body.errors || []).length === 0, "no errors raised");
}

{
  console.log("\nBoth off -> nothing");
  const r = await run([{ id: "u6", email: false, push: false, device: true }]);
  check(r.pushes.length === 0 && r.emails.length === 0, "nothing sent");
}

{
  console.log("\nSecond tick after a push -> silent (shared ledger holds)");
  const first = await run([{ id: "u7", email: true, push: true, device: true }]);
  check(first.pushes.length === 1, "first tick pushed");
  const second = await run([{ id: "u7", email: true, push: true, device: true }], { keepStore: first.store });
  check(second.pushes.length === 0 && second.emails.length === 0, "second tick sent nothing");
}

{
  console.log("\nPush delivered, then push turned OFF -> no email on the next tick");
  const first = await run([{ id: "u8", email: true, push: true, device: true }]);
  check(first.pushes.length === 1, "first tick pushed");
  const store = first.store;
  const prefs = store.get("blitz-notif\u0000prefs:u8");
  store.set("blitz-notif\u0000prefs:u8", { ...prefs, push: { ...prefs.push, pickReminder: false } });
  const second = await run([], { keepStore: store });
  check(second.emails.length === 0, "no duplicate nudge via email");
}

console.log("\n" + (failures === 0 ? "All checks passed." : failures + " check(s) FAILED."));
process.exit(failures ? 1 : 0);

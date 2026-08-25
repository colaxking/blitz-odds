import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SITE_URL } from "./email-shell.mts";

// Notification preferences, unsubscribe tokens, and the Resend send path.
// Everything that decides *whether* and *where* to send lives here; the
// individual email builders only decide what the message says.
//
// Storage (blitz-notif store):
//   prefs:{userId}          -> NotifPrefs
//   sent:{type}:{season}:{week}:{userId} -> { sentAt }   idempotency ledger
//
// The ledger is what makes a double-fired cron harmless. cron-job.org does
// occasionally deliver a trigger twice, and a duplicate "you haven't picked
// yet" email is a real trust hit - worse than a missed one. Every send
// writes its ledger key BEFORE calling Resend and re-checks it first, so
// the second run finds the key and skips. A crash between the ledger write
// and the Resend call loses that one email; that's the deliberate trade
// (better to drop one than send two).

export const NOTIF_STORE = "blitz-notif";
export const USER_STORE = "blitz-users";

export type NotifType = "reminders" | "weekly" | "all";

/** Which games the game-time alerts apply to. */
export type PushScope = "fav" | "picks" | "both";

export interface PushPrefs {
  /** ~10 minutes before a followed game starts. */
  kickoff: boolean;
  /** "all" is every score; "lead" only the ones that change who's ahead. */
  scoring: "all" | "lead" | "off";
  final: boolean;
  scope: PushScope;
  /** "key" limits it to tracked impact players. */
  injuries: "key" | "all" | "off";
  /** Someone going down mid-game, before any official designation exists. */
  inGameInjury: boolean;
  /** Final nudge before kickoff if picks are still open. */
  lastCall: boolean;
  /** Local hours. Null disables quiet hours entirely. */
  quietFrom: number | null;
  quietTo: number | null;
}

export interface NotifPrefs {
  emailPickReminders: boolean;
  emailWeeklyRecap: boolean;
  /** Favourite-team headlines inside the Tuesday recap. Off by default -
   *  it's an addition to an email people already agreed to receive, so it
   *  should be asked for rather than assumed. */
  emailRecapTeamNews: boolean;
  /** IANA zone captured from the browser, e.g. "America/New_York". */
  timezone: string;
  push: PushPrefs;
  updatedAt?: string;
}

/* Push defaults are chosen to be survivable rather than exciting. Favourites
 * only, lead changes rather than every score, key players only: about 20 a
 * week for someone with three starred teams. Scope "both" with every score
 * is closer to 190, which is the rate at which people turn notifications off
 * permanently and never come back. Anyone who wants more can opt up; nobody
 * gets buried by a default they didn't choose. */
export const DEFAULT_PUSH_PREFS: PushPrefs = {
  kickoff: true,
  scoring: "lead",
  final: true,
  scope: "fav",
  injuries: "key",
  inGameInjury: true,
  lastCall: true,
  quietFrom: 23,
  quietTo: 7,
};

export const DEFAULT_PREFS: NotifPrefs = {
  emailPickReminders: true,
  emailWeeklyRecap: true,
  emailRecapTeamNews: false,
  timezone: "America/New_York",
  push: { ...DEFAULT_PUSH_PREFS },
};

/**
 * Strong consistency is required, not optional: someone who toggles an
 * email off and then receives one 30 seconds later because the dispatcher
 * read a stale edge replica will report it as spam, and rightly so.
 */
export function notifStore() {
  return getStore(NOTIF_STORE, { consistency: "strong" });
}

export async function getPrefs(userId: string): Promise<NotifPrefs> {
  try {
    const stored = (await notifStore().get(`prefs:${userId}`, { type: "json" })) as Partial<NotifPrefs> | null;
    if (!stored) return { ...DEFAULT_PREFS };
    // The spread has to be nested, not just top-level: a record written
    // before `push` existed has no push block at all, and one written
    // before a later field was added has a partial one. A shallow merge
    // would hand the dispatcher `undefined` for a field it reads.
    return {
      ...DEFAULT_PREFS,
      ...stored,
      push: { ...DEFAULT_PUSH_PREFS, ...(stored.push || {}) },
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const SCORING_VALUES = new Set(["all", "lead", "off"]);
const SCOPE_VALUES = new Set(["fav", "picks", "both"]);
const INJURY_VALUES = new Set(["key", "all", "off"]);

/** Whitelists an incoming push block. This is client-supplied input, and an
 *  unrecognised enum value reaching the dispatcher would fall through every
 *  comparison there and silently mean "send nothing". */
function sanitizePush(input: any, existing: PushPrefs): PushPrefs {
  const out: PushPrefs = { ...existing };
  if (!input || typeof input !== "object") return out;
  for (const key of ["kickoff", "final", "inGameInjury", "lastCall"] as const) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  if (SCORING_VALUES.has(input.scoring)) out.scoring = input.scoring;
  if (SCOPE_VALUES.has(input.scope)) out.scope = input.scope;
  if (INJURY_VALUES.has(input.injuries)) out.injuries = input.injuries;
  for (const key of ["quietFrom", "quietTo"] as const) {
    if (input[key] === null) out[key] = null;
    else if (Number.isInteger(input[key]) && input[key] >= 0 && input[key] <= 23) out[key] = input[key];
  }
  return out;
}

/** True when `at`, seen in `tz`, falls inside the user's quiet hours.
 *  Handles the overnight case (23 -> 7) as well as a same-day window. */
export function inQuietHours(at: Date, prefs: NotifPrefs): boolean {
  const { quietFrom, quietTo } = prefs.push;
  if (quietFrom === null || quietTo === null || quietFrom === quietTo) return false;
  const hour = localParts(at, prefs.timezone).hour;
  return quietFrom < quietTo
    ? hour >= quietFrom && hour < quietTo
    : hour >= quietFrom || hour < quietTo;   // wraps past midnight
}

export async function setPrefs(userId: string, patch: Partial<NotifPrefs>): Promise<NotifPrefs> {
  const existing = await getPrefs(userId);
  const next: NotifPrefs = {
    ...existing,
    ...(typeof patch.emailPickReminders === "boolean" ? { emailPickReminders: patch.emailPickReminders } : {}),
    ...(typeof patch.emailWeeklyRecap === "boolean" ? { emailWeeklyRecap: patch.emailWeeklyRecap } : {}),
    ...(typeof patch.emailRecapTeamNews === "boolean" ? { emailRecapTeamNews: patch.emailRecapTeamNews } : {}),
    ...(typeof patch.timezone === "string" && isValidTimezone(patch.timezone) ? { timezone: patch.timezone } : {}),
    push: sanitizePush(patch.push, existing.push),
    updatedAt: new Date().toISOString(),
  };
  await notifStore().setJSON(`prefs:${userId}`, next);
  return next;
}

/**
 * Rejects anything Intl can't resolve. Without this an arbitrary client
 * string reaches `timeZone:` in the dispatcher and throws there instead,
 * where it would take down a whole batch rather than one user's pref write.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unsubscribe tokens
// ---------------------------------------------------------------------------

/**
 * The unsubscribe link has to work from an email client, where the reader
 * is not signed in and may not even be on a device that's ever been signed
 * in - so it can't require auth. An HMAC over (userId, type) makes the link
 * unguessable and untamperable without storing per-link state.
 *
 * Scoped by type on purpose: unsubscribing from the weekly recap should not
 * silently kill pick reminders too. A token minted for "weekly" only turns
 * off the recap.
 */
export function unsubToken(userId: string, type: NotifType): string {
  const secret = process.env.NOTIF_UNSUB_SECRET;
  if (!secret) throw new Error("NOTIF_UNSUB_SECRET is not configured on this site");
  return createHmac("sha256", secret).update(`${userId}:${type}`).digest("hex").slice(0, 32);
}

export function verifyUnsubToken(userId: string, type: NotifType, token: string): boolean {
  if (!userId || !type || !token) return false;
  let expected: string;
  try {
    expected = unsubToken(userId, type);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function unsubUrl(userId: string, type: NotifType): string {
  const t = unsubToken(userId, type);
  return `${SITE_URL}/.netlify/functions/unsubscribe?u=${encodeURIComponent(userId)}&t=${type}&s=${t}`;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const RESEND_API_URL = "https://api.resend.com/emails";

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Drives the From address and the one-click unsubscribe header. */
  type: Exclude<NotifType, "all">;
  userId: string;
}

const FROM_BY_TYPE: Record<string, string> = {
  reminders: "Blitz Odds <alerts@blitz-odds.com>",
  weekly: "Blitz Odds <recap@blitz-odds.com>",
};

/**
 * List-Unsubscribe + List-Unsubscribe-Post are not optional for this kind
 * of mail: Gmail and Yahoo both require a working one-click unsubscribe
 * from bulk senders, and its absence measurably pushes mail to spam. The
 * POST target is the same endpoint as the footer link.
 */
export async function sendEmail(args: SendArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is missing");

  const oneClick = unsubUrl(args.userId, args.type);

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_BY_TYPE[args.type] || "Blitz Odds <alerts@blitz-odds.com>",
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
      headers: {
        "List-Unsubscribe": `<${oneClick}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
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

// ---------------------------------------------------------------------------
// Idempotency ledger
// ---------------------------------------------------------------------------

export function ledgerKey(type: string, season: number, week: number, userId: string): string {
  return `sent:${type}:${season}:${week}:${userId}`;
}

/**
 * Ledger key for a per-event alert, as opposed to the once-a-week emails
 * above. `event` identifies the specific thing that happened - a scoring
 * play, an injury designation - so a poll that sees the same event twice
 * finds the key and stays quiet, while a genuine escalation makes a new key
 * and correctly sends.
 *
 * The {season}:{week} segment is here even though the event id is already
 * unique. It's what makes the store sweepable: Netlify Blobs has no TTL, so
 * without a prefix that groups by week, this namespace grows for the life of
 * the site and nothing can ever be deleted in bulk. One scoring alert per
 * play per user across a full slate is tens of thousands of keys a season.
 */
export function eventLedgerKey(type: string, season: number, week: number, event: string, userId: string): string {
  return `evt:${season}:${week}:${type}:${event}:${userId}`;
}

/** Prefix covering every event ledger key for one week, across all types -
 *  the unit a sweep deletes. This is why season and week lead the key
 *  rather than following the type the way the weekly `sent:` keys do: a
 *  sweep wants "everything from week 6", not "every scoring alert ever". */
export function eventLedgerWeekPrefix(season: number, week: number): string {
  return `evt:${season}:${week}:`;
}

/** Deletes a whole week of event ledger keys. Nothing calls this yet - the
 *  first alert type that writes event keys should also schedule it, a few
 *  weeks behind the current one, so the namespace has a ceiling from the
 *  day it starts filling rather than being someone's cleanup job later. */
export async function sweepEventLedger(season: number, week: number): Promise<number> {
  const store = notifStore();
  let deleted = 0;
  for await (const page of store.list({ prefix: eventLedgerWeekPrefix(season, week), paginate: true })) {
    for (const blob of page.blobs) {
      try { await store.delete(blob.key); deleted++; } catch { /* best effort */ }
    }
  }
  return deleted;
}

export async function alreadySentEvent(type: string, season: number, week: number, event: string, userId: string): Promise<boolean> {
  try {
    const doc = await notifStore().get(eventLedgerKey(type, season, week, event, userId), { type: "json" });
    return !!doc;
  } catch {
    return false;
  }
}

export async function markSentEvent(type: string, season: number, week: number, event: string, userId: string): Promise<void> {
  await notifStore().setJSON(eventLedgerKey(type, season, week, event, userId), { sentAt: new Date().toISOString() });
}

export async function alreadySent(type: string, season: number, week: number, userId: string): Promise<boolean> {
  try {
    const doc = await notifStore().get(ledgerKey(type, season, week, userId), { type: "json" });
    return !!doc;
  } catch {
    return false;
  }
}

export async function markSent(type: string, season: number, week: number, userId: string): Promise<void> {
  await notifStore().setJSON(ledgerKey(type, season, week, userId), { sentAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Local-time helpers
// ---------------------------------------------------------------------------

/**
 * The wall-clock parts a given UTC instant maps to in `tz`. Used to answer
 * "is it 7pm on the right day for this user" without pulling in a tz
 * library - Intl already ships the tz database.
 */
export function localParts(at: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: string } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const parts = dtf.formatToParts(at).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl gives "24" for midnight with hour12:false in some ICU versions.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

/** YYYY-MM-DD of a UTC instant as seen in `tz`. */
export function localDateKey(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

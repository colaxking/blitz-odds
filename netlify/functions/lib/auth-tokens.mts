import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { notifStore } from "./notif.mts";

// One-time tokens for the two auth flows this site now owns end to end:
// email verification and password reset.
//
// WHY WE OWN THEM AT ALL. GoTrue issues perfectly good confirmation and
// recovery tokens of its own, and on a Netlify Pro plan we would just use
// them and restyle the mail. On the Personal plan the Identity email
// settings - custom template, custom sender - are both unavailable, so the
// only mail GoTrue can send is its unbranded default from
// no-reply@netlify.com. The way out is to stop GoTrue sending anything
// (admin-create with confirm:true; never call /recover) and drive both
// flows from tokens we mint here and mail through Resend, like every other
// email the site sends.
//
// Storage (blitz-notif store, reusing it rather than adding a second):
//   authtok:{purpose}:{hash} -> { userId, email, purpose, createdAt, expiresAt }
//
// THE STORED VALUE IS A HASH, NOT THE TOKEN. The token itself only ever
// exists in the link in someone's inbox. A read of the blob store - a
// leaked deploy log, a mis-scoped admin endpoint, anything - therefore
// yields nothing that can be redeemed, the same reason passwords aren't
// stored in the clear. SHA-256 with no salt is right here and bcrypt would
// be wrong: the input is 32 bytes of CSPRNG output, so there is no
// dictionary to attack and nothing for a work factor to buy.
//
// Blobs has no TTL, so expiry is enforced on read (below) and the dead keys
// are swept separately - see sweepAuthTokens. Expiry is correctness and
// happens on every consume; sweeping is only housekeeping.

export type TokenPurpose = "verify" | "reset";

export interface AuthTokenDoc {
  userId: string;
  email: string;
  purpose: TokenPurpose;
  createdAt: string;
  expiresAt: string;
}

/**
 * Verification gets a day because people sign up on a phone and open the
 * mail on a laptop that evening. Reset gets an hour because a password
 * reset link is a live key to the account and the person asking for one is,
 * by definition, sitting there waiting for it.
 */
export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenKey(purpose: TokenPurpose, token: string): string {
  return `authtok:${purpose}:${hashToken(token)}`;
}

/**
 * 32 bytes of CSPRNG, base64url so it survives a URL untouched. Returned in
 * the clear exactly once, to the caller that is about to put it in an email.
 */
export async function mintToken(
  purpose: TokenPurpose,
  userId: string,
  email: string
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + TOKEN_TTL_MS[purpose]).toISOString();

  const doc: AuthTokenDoc = {
    userId,
    email,
    purpose,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  };

  await notifStore().setJSON(tokenKey(purpose, token), doc);
  return { token, expiresAt };
}

export type ConsumeResult =
  | { ok: true; doc: AuthTokenDoc }
  | { ok: false; reason: "missing" | "expired" | "wrong_purpose" };

/**
 * Reads, validates and DELETES in one go - a token is spent whether or not
 * the caller goes on to succeed. The alternative (delete only on success)
 * leaves a live token in the store any time the admin call after it fails,
 * which is the one moment you would least like a replayable credential
 * lying around.
 *
 * The store is opened with consistency:"strong" (see notifStore), which
 * matters more here than anywhere else on the site: the gap between minting
 * a token and someone clicking the link can be under a second on a fast
 * mail path, and an eventually-consistent read would tell that person their
 * brand new link is invalid.
 */
export async function consumeToken(purpose: TokenPurpose, token: string): Promise<ConsumeResult> {
  if (!token || typeof token !== "string") return { ok: false, reason: "missing" };

  const store = notifStore();
  const key = tokenKey(purpose, token);

  let doc: AuthTokenDoc | null = null;
  try {
    doc = (await store.get(key, { type: "json" })) as AuthTokenDoc | null;
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!doc) return { ok: false, reason: "missing" };

  await store.delete(key);

  if (doc.purpose !== purpose) return { ok: false, reason: "wrong_purpose" };
  if (Date.parse(doc.expiresAt) <= Date.now()) return { ok: false, reason: "expired" };

  return { ok: true, doc };
}

/**
 * Deletes every token a user holds for a purpose. Called when a fresh one
 * is issued, so "resend the email" doesn't leave a trail of simultaneously
 * live links, and after a password reset lands.
 *
 * This is a prefix scan rather than a lookup because the key is keyed by
 * the token hash, not the user - which is the whole point (you cannot go
 * from a user to their live token) and the price is that revoking costs a
 * list. The namespace is small: unredeemed auth tokens, not history.
 */
export async function revokeTokensFor(purpose: TokenPurpose, userId: string): Promise<number> {
  const store = notifStore();
  let removed = 0;
  try {
    const { blobs } = await store.list({ prefix: `authtok:${purpose}:` });
    for (const b of blobs) {
      const doc = (await store.get(b.key, { type: "json" })) as AuthTokenDoc | null;
      if (doc && doc.userId === userId) {
        await store.delete(b.key);
        removed++;
      }
    }
  } catch {
    // Revocation is defence in depth, not correctness - the old token still
    // expires on its own. Never fail the flow that called us over it.
  }
  return removed;
}

/** Longest rate-limit window in use below. Anything older than this can
 *  never be counted against anyone again. */
const MAX_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Housekeeping: drop expired tokens AND stale rate-limit counters. Safe to
 * run any time; nothing reads an expired token or a lapsed counter even if
 * this never runs at all.
 *
 * BOTH namespaces, not just the tokens. A rate-limit key is written for
 * every address that touches signup, resend or forgot - including addresses
 * with no account, since the endpoints deliberately don't check first - and
 * unlike a token it is never consumed. Sweeping only `authtok:` would leave
 * `authrate:` growing one key per address forever, which is precisely the
 * failure sweepEventLedger in notif.mts already has. It is wired to a
 * schedule from day one here - see auth-token-sweep-background.mts.
 */
export async function sweepAuthTokens(): Promise<{
  scanned: number;
  deleted: number;
  rateScanned: number;
  rateDeleted: number;
}> {
  const store = notifStore();
  const now = Date.now();
  let scanned = 0;
  let deleted = 0;

  for (const purpose of ["verify", "reset"] as TokenPurpose[]) {
    const { blobs } = await store.list({ prefix: `authtok:${purpose}:` });
    for (const b of blobs) {
      scanned++;
      const doc = (await store.get(b.key, { type: "json" })) as AuthTokenDoc | null;
      if (!doc || Date.parse(doc.expiresAt) <= now) {
        await store.delete(b.key);
        deleted++;
      }
    }
  }

  let rateScanned = 0;
  let rateDeleted = 0;
  const { blobs: rateBlobs } = await store.list({ prefix: "authrate:" });
  for (const b of rateBlobs) {
    rateScanned++;
    const doc = (await store.get(b.key, { type: "json" })) as { hits?: number[] } | null;
    const hits = Array.isArray(doc?.hits) ? doc!.hits : [];
    // Every recorded hit has aged out of even the longest window, so the
    // record can no longer affect any decision. rateLimitOk rebuilds it from
    // nothing on the next request.
    if (!hits.length || hits.every((t) => now - t >= MAX_RATE_WINDOW_MS)) {
      await store.delete(b.key);
      rateDeleted++;
    }
  }

  return { scanned, deleted, rateScanned, rateDeleted };
}

/**
 * Crude per-address throttle for the two endpoints anyone can hit unauthenticated
 * (resend verification, forgot password). Without it either one is a free
 * mail cannon pointed at any address the caller likes.
 *
 * Stored per address hash so the store never holds a plaintext email for an
 * address that may not even have an account.
 */
export async function rateLimitOk(scope: string, email: string, windowMs: number, max: number): Promise<boolean> {
  const store = notifStore();
  const key = `authrate:${scope}:${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32)}`;
  const now = Date.now();

  try {
    const doc = (await store.get(key, { type: "json" })) as { hits: number[] } | null;
    const hits = (doc?.hits || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) return false;
    hits.push(now);
    await store.setJSON(key, { hits });
    return true;
  } catch {
    // Fail open. A blob hiccup should not stop a legitimate person
    // recovering their account.
    return true;
  }
}

/** Constant-time compare, for anywhere a token is checked outside consumeToken. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

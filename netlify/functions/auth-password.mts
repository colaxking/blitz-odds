import { verifyToken, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { identityAdminFetch } from "./lib/admin.mts";
import { rateLimitOk, revokeTokensFor } from "./lib/auth-tokens.mts";
import { buildPasswordChangedEmail, sendTransactionalEmail } from "./lib/auth-emails.mts";

// POST /.netlify/functions/auth-password
//   { currentPassword, newPassword } -> { ok }
//
// Changing your own password from the profile panel, as distinct from
// auth-forgot/auth-reset which recover an account you can't get into. Both
// exist because they answer different questions: the reset flow proves you
// control the ADDRESS, this one proves you know the PASSWORD.
//
// WHY NOT window.netlifyIdentity.currentUser().update({ password }). GoTrue
// accepts that on the access token alone - no current password. Which means
// a session someone else has (a shared laptop, a phone left unlocked, a
// token lifted from storage) can set a new password and lock the real owner
// out of their own account, and the owner's only route back is the reset
// email they may no longer receive if the address was changed in the same
// sitting. Re-authenticating first costs one extra field and removes that.
//
// The exception is an account with no password to know: a Google signup has
// never set one, so there is nothing to re-authenticate against and the
// current-password check is skipped (the UI calls this "Set a password").
// That case is exactly as strong as the session, which is also true of
// every other thing a signed-in Google user can do, and adding a password
// to an OAuth account is strictly an increase in the ways in.

const CORS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIN_PASSWORD = 8;

/* Deliberately tighter than auth-forgot's 4/hour. That endpoint is rate
   limited to stop mail flooding; this one is a live password oracle - a
   wrong currentPassword answers "no" - so the limit is the control that
   stops it being used to guess. Keyed on the account's own email, so it
   cannot be exhausted for someone else. */
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 5;

export default async (req: Request, context: any) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  // verifyToken rather than getAuthenticatedUser, matching account-delete:
  // an unverified or suspended account still owns its password. Locking
  // someone out of changing a password they may believe is compromised is
  // the wrong side to err on, and neither gate is about the credential.
  const claims = await verifyToken(req);
  if (!claims) return jsonResponse(401, { ok: false, error: "Sign in first." });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const currentPassword = String(body?.currentPassword || "");
  const newPassword = String(body?.newPassword || "");
  const email = String(claims.email || "").trim().toLowerCase();
  const userId = String(claims.sub || "");

  if (!email || !userId) {
    return jsonResponse(400, { ok: false, error: "That account is missing an email address." });
  }

  if (newPassword.length < MIN_PASSWORD) {
    return jsonResponse(400, {
      ok: false,
      code: "weak_password",
      error: `Password must be at least ${MIN_PASSWORD} characters.`,
    });
  }

  // An OAuth account has no password on file; anything else is a password
  // account and must prove it. Read from the token's app_metadata, the same
  // field isUnverified() branches on.
  const provider = (claims as any).app_metadata?.provider;
  const hasPassword = !provider || provider === "email";

  if (hasPassword) {
    if (!currentPassword) {
      return jsonResponse(400, {
        ok: false,
        code: "current_required",
        error: "Enter your current password.",
      });
    }

    if (newPassword === currentPassword) {
      return jsonResponse(400, {
        ok: false,
        code: "same_password",
        error: "That's already your password. Pick a different one.",
      });
    }

    if (!(await rateLimitOk("password", email, RATE_WINDOW_MS, RATE_MAX))) {
      return jsonResponse(429, {
        ok: false,
        code: "rate_limited",
        error: "Too many attempts. Wait fifteen minutes and try again.",
      });
    }

    // Re-authenticate by asking GoTrue for a fresh token with the password
    // as submitted. Its answer IS the check - we never see or compare a
    // hash ourselves. The token that comes back is thrown away; only the
    // status code matters.
    const origin = new URL(req.url).origin;
    let ok = false;
    try {
      const res = await fetch(`${origin}/.netlify/identity/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          username: email,
          password: currentPassword,
        }).toString(),
      });
      ok = res.ok;
      if (!ok && res.status >= 500) {
        console.error("[auth-password] reauth upstream error", res.status);
        return jsonResponse(502, { ok: false, error: "Couldn't verify your password. Try again." });
      }
    } catch (err) {
      console.error("[auth-password] reauth failed", err);
      return jsonResponse(502, { ok: false, error: "Couldn't verify your password. Try again." });
    }

    if (!ok) {
      return jsonResponse(400, {
        ok: false,
        code: "wrong_password",
        error: "That's not your current password.",
      });
    }
  }

  try {
    const res = await identityAdminFetch(req, context, `/admin/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ password: newPassword }),
    });
    if (!res.ok) {
      console.error("[auth-password] identity update failed", res.status);
      return jsonResponse(502, { ok: false, error: "Couldn't update the password. Try again." });
    }
  } catch (err) {
    console.error("[auth-password] identity update threw", err);
    return jsonResponse(502, { ok: false, error: "Couldn't update the password. Try again." });
  }

  // Any outstanding reset link is now a way back into an account whose owner
  // just demonstrated they don't need one. Spend them.
  try {
    await revokeTokensFor("reset", userId);
  } catch (err) {
    console.error("[auth-password] token revoke failed", err);
  }

  // Sent after the fact and never gated on - the change has already
  // happened and a Resend outage must not report it as a failure. Its job
  // is the case where the owner DIDN'T do this: a notification is how they
  // find out, and it names the reset link as the way back.
  try {
    const mail = buildPasswordChangedEmail({ email });
    await sendTransactionalEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  } catch (err) {
    console.error("[auth-password] notification email failed", err);
  }

  return jsonResponse(200, { ok: true, hadPassword: hasPassword });
};

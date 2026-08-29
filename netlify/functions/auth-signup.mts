import { identityAdminFetch, listIdentityUsers } from "./lib/admin.mts";
import { jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { mintToken, rateLimitOk } from "./lib/auth-tokens.mts";
import { buildVerifyEmail, sendTransactionalEmail } from "./lib/auth-emails.mts";
import { TERMS_VERSION } from "./lib/terms.mts";

// Signup, done server-side so that WE send the confirmation email instead
// of Netlify.
//
// The widget's own signup posts straight from the browser to GoTrue
// /signup, which immediately mails its default template from
// no-reply@netlify.com. There is no hook to intercept that and no setting
// on the Personal plan to restyle it, so the only way to own the email is
// to not let GoTrue send one: create the account through the admin API with
// confirm:true, which marks the address confirmed as far as GoTrue is
// concerned and suppresses the mail.
//
// Verification then becomes OUR flag - user_metadata.email_verified - which
// lib/auth.mts enforces on every authenticated endpoint, exactly where
// suspension is enforced and for the same reason.
//
// The account is created BEFORE the address is verified, and can sign in
// while unverified. It just can't do anything: every authenticated endpoint
// refuses it, so the app shows the "check your email" state instead of the
// dashboard. Creating the user up front is what lets someone close the tab,
// click the link two hours later on a different device, and simply be in.

const MIN_PASSWORD = 8;

/**
 * One address, three signup attempts an hour. Enough for a genuine
 * fat-fingered retry, not enough to enumerate or to use this endpoint to
 * mail somebody repeatedly.
 */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 3;

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export default async (req: Request, context: any) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS_BASE });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const fullName = String(body?.fullName || "").trim().slice(0, 80);
  const acceptTerms = body?.acceptTerms === true;

  if (!isPlausibleEmail(email)) {
    return jsonResponse(400, { ok: false, code: "bad_email", error: "Enter a valid email address." });
  }
  if (password.length < MIN_PASSWORD) {
    return jsonResponse(400, {
      ok: false,
      code: "weak_password",
      error: `Password must be at least ${MIN_PASSWORD} characters.`,
    });
  }

  // The form disables its own submit button without this, so reaching here
  // means the request did not come from our form. Refuse rather than create
  // the account and rely on the post-sign-in gate to catch it: an account
  // that exists without recorded consent is exactly what this endpoint is
  // supposed to make impossible.
  if (!acceptTerms) {
    return jsonResponse(400, {
      ok: false,
      code: "terms_required",
      error: "You need to accept the Terms of Service and Privacy Policy to create an account.",
    });
  }

  if (!(await rateLimitOk("signup", email, RATE_WINDOW_MS, RATE_MAX))) {
    return jsonResponse(429, {
      ok: false,
      code: "rate_limited",
      error: "Too many signup attempts for this address. Try again in an hour.",
    });
  }

  // Existing-address check. This DOES leak whether an address has an account
  // - and that is the deliberate choice here, not an oversight. A signup form
  // that silently pretends to succeed on a taken address strands the one
  // person it was meant to protect: someone who genuinely forgot they have an
  // account, waiting for mail that will never arrive. The address is already
  // enumerable through any real signup form for the same reason. The reset
  // and resend endpoints, where there is no such tradeoff, stay silent.
  let existing: { id: string; email: string } | undefined;
  try {
    const users = await listIdentityUsers(req, context);
    existing = users.find((u) => String(u.email || "").toLowerCase() === email);
  } catch (err) {
    console.error("[auth-signup] identity list failed", err);
    return jsonResponse(502, { ok: false, error: "Could not reach the accounts service. Try again shortly." });
  }

  if (existing) {
    return jsonResponse(409, {
      ok: false,
      code: "email_taken",
      error: "There's already an account with that email. Try signing in, or reset your password.",
    });
  }

  // confirm:true is the whole trick - see the header comment. email_verified
  // is ours and starts false.
  let created: any;
  try {
    const res = await identityAdminFetch(req, context, "/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        confirm: true,
        user_metadata: {
          ...(fullName ? { full_name: fullName } : {}),
          email_verified: false,
          signup_source: "site",
          /* Stamped here, in the create call, rather than written to the
             profile blob afterwards. A second write could fail and leave a
             live account with no record of what it agreed to; this way the
             acceptance and the account are the same operation. The profile
             blob picks it up on first read - see user-profile.mts. */
          terms_accepted_version: TERMS_VERSION,
          terms_accepted_at: new Date().toISOString(),
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error("[auth-signup] identity create failed", res.status, detail);
      return jsonResponse(502, { ok: false, error: "Could not create the account. Try again shortly." });
    }
    created = await res.json();
  } catch (err) {
    console.error("[auth-signup] identity create threw", err);
    return jsonResponse(502, { ok: false, error: "Could not create the account. Try again shortly." });
  }

  const userId = String(created?.id || "");
  if (!userId) {
    console.error("[auth-signup] identity create returned no id", created);
    return jsonResponse(502, { ok: false, error: "Could not create the account. Try again shortly." });
  }

  // A send failure is NOT a signup failure. The account exists and the
  // password works; the person can sign in, land on the unverified screen
  // and press Resend. Rolling the account back here would be worse - it
  // would delete a working account because a third-party API had a bad
  // second.
  let emailSent = true;
  try {
    const { token } = await mintToken("verify", userId, email);
    const mail = buildVerifyEmail({ email, token });
    await sendTransactionalEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  } catch (err) {
    emailSent = false;
    console.error("[auth-signup] verification email failed", err);
  }

  return jsonResponse(201, { ok: true, userId, email, emailSent });
};

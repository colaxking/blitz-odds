import { listIdentityUsers } from "./lib/admin.mts";
import { jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { mintToken, revokeTokensFor, rateLimitOk } from "./lib/auth-tokens.mts";
import { buildVerifyEmail, sendTransactionalEmail } from "./lib/auth-emails.mts";

// "Send it again" for the verification email.
//
// Unauthenticated on purpose. The person who needs this is very often not
// signed in - they closed the tab after signing up, or the first mail went
// to spam - and requiring a session to ask for the mail that unlocks the
// session is a loop with no exit.
//
// Being unauthenticated makes it an address oracle unless it answers
// identically no matter what is on the other end, which is what it does:
// unknown address, already-verified address and freshly-mailed address all
// get the same 202. Unlike auth-signup (where the tradeoff genuinely runs
// the other way - see that file), there is nothing a truthful answer here
// would buy the legitimate user.

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 4;

const ACCEPTED = {
  ok: true,
  message: "If that address needs confirming, a new link is on its way.",
};

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
  if (!email) return jsonResponse(400, { ok: false, error: "Email is required." });

  // The rate limit answers 202 as well. A 429 here would tell a caller that
  // they had found a real address by the mere fact of being throttled.
  if (!(await rateLimitOk("verify-resend", email, RATE_WINDOW_MS, RATE_MAX))) {
    return jsonResponse(202, ACCEPTED);
  }

  try {
    const users = await listIdentityUsers(req, context);
    const user = users.find((u) => String(u.email || "").toLowerCase() === email);

    if (user && (user.user_metadata as any)?.email_verified !== true) {
      // Old links die when a new one is issued. Otherwise pressing Resend
      // three times leaves three live keys to the same account lying in an
      // inbox, and the person will click whichever one their client shows
      // first.
      await revokeTokensFor("verify", user.id);

      const { token } = await mintToken("verify", user.id, email);
      const mail = buildVerifyEmail({ email, token });
      await sendTransactionalEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
    }
  } catch (err) {
    // Logged, but still a 202. An error shape that differs from the success
    // shape is the leak this endpoint spent its whole design avoiding.
    console.error("[auth-verify-resend] failed", err);
  }

  return jsonResponse(202, ACCEPTED);
};

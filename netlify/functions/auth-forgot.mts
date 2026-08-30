import { listIdentityUsers } from "./lib/admin.mts";
import { jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { mintToken, revokeTokensFor, rateLimitOk } from "./lib/auth-tokens.mts";
import { buildResetEmail, sendTransactionalEmail } from "./lib/auth-emails.mts";

// Start a password reset.
//
// GoTrue has /recover, which does all of this already. We can't use it: it
// sends Netlify's default recovery mail from no-reply@netlify.com, and the
// Personal plan has no way to restyle or re-address that. So the reset runs
// on our own token, same as verification.
//
// Always answers 202 with the same body regardless of whether the address
// exists. Unlike the signup form (which has to say "that's taken" or it
// strands people), there is no legitimate user here who benefits from
// knowing the address is unknown - they either typed it wrong, in which
// case "check your inbox" sends them to look, or they don't have an
// account, in which case signup is the answer either way.

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 4;

const ACCEPTED = {
  ok: true,
  message: "If there's an account with that address, a reset link is on its way.",
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

  if (!(await rateLimitOk("forgot", email, RATE_WINDOW_MS, RATE_MAX))) {
    return jsonResponse(202, ACCEPTED);
  }

  try {
    const users = await listIdentityUsers(req, context);
    const user = users.find((u) => String(u.email || "").toLowerCase() === email);

    if (user) {
      // A suspended account still gets its reset link. Suspension stops you
      // acting on the site, it isn't meant to seize the account - and
      // refusing here would tell an outsider which addresses are suspended.
      await revokeTokensFor("reset", user.id);
      const { token } = await mintToken("reset", user.id, email);
      const mail = buildResetEmail({ email, token });
      await sendTransactionalEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
    }
  } catch (err) {
    console.error("[auth-forgot] failed", err);
  }

  return jsonResponse(202, ACCEPTED);
};

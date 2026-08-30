import { identityAdminFetch } from "./lib/admin.mts";
import { jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { consumeToken, revokeTokensFor } from "./lib/auth-tokens.mts";

// Finish a password reset: spend the token, set the new password.
//
// POST rather than a link target, because unlike auth-verify this one takes
// a password the person types. The token arrives from the ?reset= query
// string the email link put on the site URL, and index.html hands it back
// here with the new password.

const MIN_PASSWORD = 8;

export default async (req: Request, context: any) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS_BASE });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const token = String(body?.token || "");
  const password = String(body?.password || "");

  if (password.length < MIN_PASSWORD) {
    return jsonResponse(400, {
      ok: false,
      code: "weak_password",
      error: `Password must be at least ${MIN_PASSWORD} characters.`,
    });
  }

  const result = await consumeToken("reset", token);
  if (!result.ok) {
    return jsonResponse(400, {
      ok: false,
      code: result.reason === "expired" ? "token_expired" : "token_invalid",
      error:
        result.reason === "expired"
          ? "That reset link has expired. Request a new one."
          : "That reset link isn't valid. It may already have been used.",
    });
  }

  const { userId, email } = result.doc;

  try {
    const currentRes = await identityAdminFetch(req, context, `/admin/users/${userId}`);
    if (!currentRes.ok) {
      if (currentRes.status === 404) {
        return jsonResponse(400, { ok: false, code: "token_invalid", error: "That account no longer exists." });
      }
      throw new Error(`Identity read failed (${currentRes.status})`);
    }
    const current: any = await currentRes.json();

    // Completing a reset also confirms the address: the link only reached
    // them because the mailbox is theirs, which is the same proof the
    // verification email asks for. Someone who never clicked the original
    // confirm link but did complete a reset should not then be told to go
    // and confirm their email.
    const res = await identityAdminFetch(req, context, `/admin/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({
        password,
        user_metadata: {
          ...(current?.user_metadata || {}),
          email_verified: true,
          ...(current?.user_metadata?.email_verified_at
            ? {}
            : { email_verified_at: new Date().toISOString() }),
          password_reset_at: new Date().toISOString(),
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error("[auth-reset] identity update failed", res.status, detail);
      return jsonResponse(502, { ok: false, error: "Could not set the new password. Try again shortly." });
    }
  } catch (err) {
    console.error("[auth-reset] failed", err);
    return jsonResponse(502, { ok: false, error: "Could not set the new password. Try again shortly." });
  }

  // Any other live reset link for this account dies now. If the request was
  // an attacker's and the real owner also asked for one, the owner's link
  // should not still work after the password changed underneath them - and
  // vice versa.
  await revokeTokensFor("reset", userId);
  // A verification link is moot now that the address is confirmed.
  await revokeTokensFor("verify", userId);

  return jsonResponse(200, { ok: true, email });
};

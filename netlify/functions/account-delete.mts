import type { Context, Config } from "@netlify/functions";
import { verifyToken, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { deleteIdentityUser } from "./lib/admin.mts";
import { purgeUserData } from "./lib/account-purge.mts";
import { sendTransactional } from "./lib/send-email.mts";
import { emailShell, emailEyebrow, emailPanel, escapeHtml, EMAIL_COLORS, SITE_URL } from "./lib/email-shell.mts";

// POST /.netlify/functions/account-delete
//   { confirmEmail } -> { ok, removed }
//
// The user deleting their own account. Until now the only way out was
// emailing support and waiting for an admin to do it by hand, which the
// privacy policy had to promise and nobody could audit.
//
// WHY THIS ISN'T JUST admin-user-delete WITH A DIFFERENT GATE. It nearly is,
// and the purge itself IS shared (lib/account-purge.mts) precisely so the
// two can't drift. What differs is only the authorisation question:
//
//   admin-user-delete  - "is the caller an admin, and did they name someone?"
//   account-delete     - "is the caller this account?" - which the JWT
//                        already answers, so there is no userId in the body
//                        at all. Nothing here reads an id from the request;
//                        it comes from the verified token and nowhere else,
//                        so a crafted body cannot aim this at a stranger.
//
// confirmEmail must still match, for the same reason a "type the name to
// confirm" box exists on the league delete: it's not a security control,
// it's the difference between meaning it and mis-tapping.

const CORS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const C = EMAIL_COLORS;

/** Confirms the deletion to the address that owned the account.
 *
 *  Sent AFTER the fact and never gated on: the account is already gone by
 *  the time this runs, and a Resend outage must not turn a completed
 *  deletion into an error. Its real job is the case where the owner didn't
 *  do it - a session left open on a shared machine - where a silent deletion
 *  is the difference between a support ticket and a mystery. */
async function sendFarewell(to: string, displayName: string): Promise<void> {
  if (!to) return;
  const body = `
    ${emailEyebrow("Account deleted", C.muted)}
    <h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:${C.heading};">
      Your Blitz Odds account is gone
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${C.body};">
      ${escapeHtml(displayName)}, your account and everything attached to it has been permanently
      deleted: your profile, your picks, your league memberships and standings entries, and every
      notification setting and subscription.
    </p>
    ${emailPanel(
      `<p style="margin:0;font-size:14px;line-height:1.6;color:${C.body};">
         If this wasn't you, reply to this email straight away. We can't restore the account - the
         data is already gone - but we do need to know.
       </p>`,
      C.teal
    )}
    <p style="margin:0;font-size:14px;line-height:1.6;color:${C.body};">
      You're welcome back any time at <a href="${SITE_URL}" style="color:${C.teal};">blitz-odds.com</a>.
      A new account starts fresh.
    </p>`;

  try {
    await sendTransactional({
      to,
      subject: "Your Blitz Odds account has been deleted",
      html: emailShell(body, { reason: "Sent because a Blitz Odds account registered to this address was deleted." }, "Your account and all its data have been removed."),
    });
  } catch {
    /* sendTransactional already swallows its own failures; this is belt and braces */
  }
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS);

  // verifyToken, not getAuthenticatedUser: a SUSPENDED user may still delete
  // their own account. Suspension is a restriction on acting inside the app,
  // not a way to hold someone's data hostage - refusing here would mean the
  // one irreversible thing a person is always entitled to do could be taken
  // away by an admin, which is not a position worth defending to them or to
  // a regulator. Every other endpoint stays closed to them.
  const claims = await verifyToken(req);
  if (!claims || !claims.id) {
    return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Body must be JSON" }, CORS);
  }

  const userId: string = claims.id;
  const email = (claims.email || "").trim().toLowerCase();
  const confirmEmail = String(body?.confirmEmail || "").trim().toLowerCase();

  if (!confirmEmail) {
    return jsonResponse(400, { ok: false, error: "confirmEmail is required" }, CORS);
  }
  if (confirmEmail !== email) {
    return jsonResponse(400, { ok: false, error: "That doesn't match the email on this account" }, CORS);
  }

  const displayName =
    (claims.user_metadata?.full_name as string) || (email ? email.split("@")[0] : "there");

  try {
    // ORDER MATTERS, same as the admin path. Blob data goes BEFORE the
    // Identity login. The reverse has a failure mode with no recovery: if
    // the sweep dies halfway the account is already gone, and the orphaned
    // picks are keyed to a userId nobody can look up or re-delete. Done this
    // way a mid-sweep failure leaves the account intact and the whole
    // operation is simply repeatable by the user.
    const removed = await purgeUserData(userId);

    // Deleting the login needs GoTrue's admin API - there is no self-serve
    // DELETE /user on Netlify Identity. identityAdminFetch's privileged
    // sources (the internal proxy, or IDENTITY_ADMIN_TOKEN) are what make
    // this work; the caller's own token would be refused, correctly, since
    // they aren't an admin.
    //
    // That is a real privilege boundary being crossed on behalf of a
    // non-admin, so it is worth being explicit about why it's safe: the id
    // being deleted came from a verified JWT and cannot be influenced by the
    // request body, and the only operation performed is a delete of that one
    // id. There is no path here that touches another account.
    //
    // Shared with the admin path so the two can't drift, and it reads the
    // account back afterwards rather than trusting the status code: someone
    // told their account is deleted and then able to sign back in is a much
    // worse outcome than an honest "try again".
    const del = await deleteIdentityUser(req, context, userId);
    if (!del.ok) {
      return jsonResponse(
        502,
        {
          ok: false,
          error: "Your data was removed, but the login itself couldn't be deleted. Try again in a minute, or email support@blitz-odds.com.",
          removed,
        },
        CORS
      );
    }

    await sendFarewell(email, displayName);

    return jsonResponse(200, { ok: true, removed }, CORS);
  } catch (err) {
    return jsonResponse(
      500,
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      CORS
    );
  }
};

export const config: Config = {
  path: "/.netlify/functions/account-delete",
};

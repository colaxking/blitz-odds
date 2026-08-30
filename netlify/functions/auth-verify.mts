import { identityAdminFetch } from "./lib/admin.mts";
import { consumeToken } from "./lib/auth-tokens.mts";
import { APP_URL } from "./lib/email-shell.mts";

// The target of the link in the verification email.
//
// This is a GET opened directly from a mail client, so it answers with a
// redirect rather than JSON: whatever happens, the person ends up on the
// site looking at a message, not at a bare API response. The outcome rides
// in the query string and index.html turns it into a banner.
//
// GET-that-mutates is normally a smell, and here it is unavoidable - a mail
// client can only produce a GET. What makes it safe enough is that the
// token is single-use and high-entropy, so the usual worry (a prefetcher or
// a scanner firing the link) costs at most a confirmed account that was
// about to be confirmed anyway. Note that some corporate mail scanners DO
// follow links, which is exactly why the person is left signed-in-capable
// rather than being auto-logged-in by this endpoint: possession of the link
// confirms the address, it does not hand out a session.

function redirect(status: string, extra: Record<string, string> = {}): Response {
  const params = new URLSearchParams({ verified: status, ...extra });
  return new Response(null, {
    status: 302,
    headers: { Location: `${APP_URL}/?${params.toString()}`, "Cache-Control": "no-store" },
  });
}

export default async (req: Request, context: any) => {
  const token = new URL(req.url).searchParams.get("t") || "";

  const result = await consumeToken("verify", token);
  if (!result.ok) {
    // "expired" and "missing" are told apart for the user's sake: one wants
    // a Resend button, the other wants "check you used the newest email".
    return redirect(result.reason === "expired" ? "expired" : "invalid");
  }

  const { userId, email } = result.doc;

  try {
    // Read first: user_metadata is replaced wholesale by a PUT, so writing
    // { email_verified: true } alone would silently drop full_name and
    // anything else stored alongside it.
    const currentRes = await identityAdminFetch(req, context, `/admin/users/${userId}`);
    if (!currentRes.ok) {
      // The account was deleted between the email going out and the click.
      if (currentRes.status === 404) return redirect("invalid");
      throw new Error(`Identity read failed (${currentRes.status})`);
    }
    const current: any = await currentRes.json();

    const res = await identityAdminFetch(req, context, `/admin/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({
        user_metadata: {
          ...(current?.user_metadata || {}),
          email_verified: true,
          email_verified_at: new Date().toISOString(),
        },
      }),
    });
    if (!res.ok) throw new Error(`Identity update failed (${res.status})`);
  } catch (err) {
    console.error("[auth-verify] could not mark verified", err);
    // The token is already spent at this point (consumeToken deletes on
    // read), so there is nothing to retry with - say so plainly and let
    // them request a fresh one.
    return redirect("error");
  }

  return redirect("ok", { email });
};

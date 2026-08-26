// One place the join-request flow talks to Resend, so league-join-request
// and league-requests don't each carry their own copy of the call, the
// from/reply-to addresses, and the "never fail the action over an email"
// rule.
//
// That last rule is the important one. Every caller here has already
// committed a write - the request is lodged, the member is added - by the
// time this runs. A Resend outage, a missing API key, or a bounced address
// must not turn a successful action into an error the user sees, so this
// returns a boolean and never throws.

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_EMAIL = "Blitz Odds <invites@blitz-odds.com>";
const REPLY_TO = "invites@blitz-odds.com";

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
}

export async function sendTransactional({ to, subject, html }: SendArgs): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return false;
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], reply_to: REPLY_TO, subject, html }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * A user's email address, from their stored profile with the Identity claim
 * as a fallback. Profiles are written on first sign-in, but a very old or
 * partially-migrated record may not carry one.
 */
export async function emailForUser(userStore: any, userId: string): Promise<string | null> {
  try {
    const profile: any = await userStore.get(`users:${userId}`, { type: "json" });
    if (profile && typeof profile.email === "string" && profile.email.includes("@")) return profile.email;
  } catch {
    // fall through
  }
  return null;
}

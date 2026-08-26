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
  if (!apiKey) {
    console.warn("[send-email] RESEND_API_KEY is not set - no mail will be sent");
    return false;
  }
  if (!to) {
    console.warn("[send-email] no recipient address; skipping", { subject });
    return false;
  }
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], reply_to: REPLY_TO, subject, html }),
    });
    if (!res.ok) {
      // Resend puts the actual reason (unverified domain, suppressed
      // address, rate limit) in the body, and without it a failure here is
      // indistinguishable from every other one.
      const detail = await res.text().catch(() => "");
      console.warn("[send-email] Resend rejected the send", {
        status: res.status,
        subject,
        detail: detail.slice(0, 500),
      });
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[send-email] Resend request threw", {
      subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * A user's email address, read from their stored profile.
 *
 * There is deliberately no Identity-claim fallback: every caller needs the
 * address of somebody *other* than the person holding the request (the
 * league owner, or the requester being approved), so the caller's own
 * claims are never the right answer. `users:{id}` has carried `email` since
 * profiles were introduced, so a null here means the profile blob is
 * genuinely missing - which is worth a log line rather than silence.
 */
export async function emailForUser(userStore: any, userId: string): Promise<string | null> {
  try {
    const profile: any = await userStore.get(`users:${userId}`, { type: "json" });
    if (profile && typeof profile.email === "string" && profile.email.includes("@")) return profile.email;
    console.warn("[send-email] no email on profile", { userId, hasProfile: !!profile });
  } catch (err) {
    console.warn("[send-email] profile lookup failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

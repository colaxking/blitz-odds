import type { Config } from "@netlify/functions";
import { sweepAuthTokens } from "./lib/auth-tokens.mts";

// Deletes expired verification and reset tokens, and stale rate-limit
// counters.
//
// Blobs has no TTL, so every namespace the site writes has to be swept by
// something or it grows for the life of the site. There is already one
// namespace here with a sweeper that was written and never wired to
// anything (sweepEventLedger in notif.mts), which is exactly how it happens:
// the sweep gets built, the scheduling gets left for later, and later never
// arrives. Wiring it on the day it ships is the cheapest it will ever be.
//
// SCHEDULED BY NETLIFY, not by cron-job.org. The rest of this site's
// automation goes through cron-job.org because GitHub Actions' `schedule:`
// trigger is unreliable on a repo with this traffic profile - but that is a
// fact about GitHub, not about scheduling in general. Netlify's own
// scheduled functions run fine here (analytics-reindex-background has been
// on this mechanism for weeks), and using them means no external service, no
// PAT, and no shared secret to rotate.
//
// That is also why there is no auth check: Netlify invokes scheduled
// functions internally and blocks direct HTTP invocation of them, so there
// is no caller to authenticate. Same as analytics-reindex-background.
//
// Background rather than a plain function for the timeout: the sweep is a
// prefix list plus a read per key, which is comfortably inside 10s today but
// scales with the namespace, and a sweep that starts timing out is a sweep
// that silently stops working.
//
// Correctness does not depend on any of this running. An expired token is
// refused by consumeToken whether or not it has ever been swept.

export default async () => {
  try {
    const result = await sweepAuthTokens();
    console.log("[auth-token-sweep]", result);
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[auth-token-sweep] failed", err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  schedule: "0 9 * * *", // daily at 9am UTC - same low-traffic window as the analytics reindex
};

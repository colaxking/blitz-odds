import { jsonResponse } from "./lib/auth.mts";
import { sweepAuthTokens } from "./lib/auth-tokens.mts";

// Deletes expired verification and reset tokens.
//
// Blobs has no TTL, so every namespace the site writes has to be swept by
// something or it grows for the life of the site. This one is small - only
// unredeemed tokens live in it, and consumeToken deletes on read - but
// "small and growing forever" is still growing forever, and there is
// already one namespace on this site (sweepEventLedger in notif.mts) with a
// sweeper that was written and never wired to anything. Wiring this one on
// the day it ships is the cheapest it will ever be.
//
// Correctness does not depend on it running. An expired token is refused by
// consumeToken whether or not this has ever swept.
//
// Scheduling: cron-job.org POSTs to the GitHub REST API to fire a
// workflow_dispatch, same as every other scheduled job here - GitHub's own
// schedule: trigger is unreliable on a repo with this traffic profile.
// Daily is plenty; the longest TTL is 24h.

export default async (req: Request) => {
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const expectedSecret = process.env.AUTH_SWEEP_SECRET;
  if (!expectedSecret) {
    return jsonResponse(500, { ok: false, error: "AUTH_SWEEP_SECRET not configured on this site" });
  }
  const provided = req.headers.get("x-auth-sweep-secret");
  if (!provided || provided !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-auth-sweep-secret header" });
  }

  try {
    const result = await sweepAuthTokens();
    console.log("[auth-token-sweep]", result);
    return jsonResponse(200, { ok: true, ...result });
  } catch (err) {
    console.error("[auth-token-sweep] failed", err);
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

import type { Context, Config } from "@netlify/functions";

// Synchronous front door for notif-live-dispatch-background, for the same
// reason notif-dispatch.mts exists: Netlify answers a background function
// with 202 the instant the request arrives, before the handler runs. A
// caller gets 202 whether the secret was right, wrong, or absent, so a
// misconfigured cron would silently do nothing forever while its own logs
// said "accepted."
//
// That matters more here than on the 15-minute tick. This one fires every
// 90 seconds during games and its whole value is timeliness - a silent
// misconfiguration would mean a season of missed scoring alerts that looks
// exactly like "nobody had alerts on."
//
// POST /.netlify/functions/notif-live-dispatch
// Header: x-notif-dispatch-secret        (shared with the 15-minute tick)
// Body (all optional): { dryRun?, userId?, force? }
//   200 -> handed off; the outcome lands in the background function's log
//   401 -> secret missing or wrong
//   500 -> a required env var isn't set on this site

const REQUIRED_ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const expectedSecret = process.env.NOTIF_DISPATCH_SECRET;
  if (!expectedSecret) {
    return jsonResponse(500, { ok: false, error: "NOTIF_DISPATCH_SECRET is not set on this site" });
  }
  const provided = req.headers.get("x-notif-dispatch-secret");
  if (!provided || provided !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-notif-dispatch-secret header" });
  }

  // This tick sends push and nothing else, so VAPID - not Resend - is what
  // it can't run without.
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    return jsonResponse(500, {
      ok: false,
      error: `Required env var(s) not set on this site: ${missing.join(", ")}`,
    });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is the normal cron case */ }

  const origin = new URL(req.url).origin;
  try {
    const res = await fetch(`${origin}/.netlify/functions/notif-live-dispatch-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-notif-dispatch-secret": expectedSecret },
      body: JSON.stringify(body),
    });
    if (res.status !== 202 && !res.ok) {
      return jsonResponse(502, { ok: false, error: `Background function returned ${res.status}` });
    }
  } catch (err) {
    return jsonResponse(502, { ok: false, error: err instanceof Error ? err.message : "Handoff failed" });
  }

  return jsonResponse(200, {
    ok: true,
    triggered: true,
    dryRun: body.dryRun === true,
    note: "Configuration checks passed. Per-game results are in the notif-live-dispatch-background function log.",
  });
};

export const config: Config = {
  path: "/.netlify/functions/notif-live-dispatch",
};

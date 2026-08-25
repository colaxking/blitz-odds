import type { Context, Config } from "@netlify/functions";

// Synchronous front door for notif-dispatch-background.
//
// WHY THIS EXISTS. Netlify answers a background function with 202 the
// instant the request arrives - before the handler runs at all. That means
// a caller gets 202 whether the secret was right, wrong, or absent, and a
// misconfigured cron would silently do nothing forever while its own logs
// said "accepted." Confirmed by hitting the deployed background function
// with a deliberately wrong secret and with no secret header: both 202.
//
// So configuration is checked here, where a real status code can still be
// returned, and only then is the background function invoked to do the
// slow work. The background function re-checks the secret itself - this is
// a usable error surface, not the security boundary.
//
// POST /.netlify/functions/notif-dispatch
// Header: x-notif-dispatch-secret
// Body (all optional): { dryRun?, only?, userId? }
//   200 -> handed off; the outcome lands in the background function's log
//   401 -> secret missing or wrong
//   500 -> a required env var isn't set on this site

const REQUIRED_ENV = ["NOTIF_UNSUB_SECRET", "RESEND_API_KEY"] as const;

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

  // Checked before handing off rather than inside the background function,
  // where a failure would only ever surface in a log nobody is watching.
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
    const res = await fetch(`${origin}/.netlify/functions/notif-dispatch-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-notif-dispatch-secret": expectedSecret },
      body: JSON.stringify(body),
    });
    // 202 is the expected answer here and means "queued", not "sent".
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
    note: "Configuration checks passed. Per-user results are in the notif-dispatch-background function log.",
  });
};

export const config: Config = {
  path: "/.netlify/functions/notif-dispatch",
};

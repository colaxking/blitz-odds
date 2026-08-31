import type { Context, Config } from "@netlify/functions";

// Synchronous front door for indexnow-submit-background.
//
// WHY THIS EXISTS. Same reason as notif-dispatch.mts: Netlify answers a
// background function with 202 the instant the request arrives, before the
// handler runs at all. A caller gets 202 whether the secret was right,
// wrong, or absent - so a misconfigured cron-job.org entry would report
// success forever while submitting nothing. Configuration is checked here,
// where a real status code can still come back.
//
// POST /.netlify/functions/indexnow-submit
// Header: x-indexnow-secret
// Body (all optional): { dryRun?, force? }
//   200 -> handed off; the outcome is in the background function's log
//   401 -> secret missing or wrong
//   500 -> a required env var isn't set on this site

const REQUIRED_ENV = ["INDEXNOW_KEY"] as const;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const expectedSecret = process.env.INDEXNOW_SECRET;
  if (!expectedSecret) {
    return jsonResponse(500, { ok: false, error: "INDEXNOW_SECRET is not set on this site" });
  }
  const provided = req.headers.get("x-indexnow-secret");
  if (!provided || provided !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-indexnow-secret header" });
  }

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
    const res = await fetch(`${origin}/.netlify/functions/indexnow-submit-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-indexnow-secret": expectedSecret },
      body: JSON.stringify(body),
    });
    // 202 is the expected answer and means "queued", not "submitted".
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
    note: "Configuration checks passed. Submission results are in the indexnow-submit-background function log.",
  });
};

export const config: Config = {
  path: "/.netlify/functions/indexnow-submit",
};

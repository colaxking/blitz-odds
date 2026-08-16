import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Standing admin utility, same pattern as site-data-update.mts: a
// secret-protected POST endpoint rather than a one-off script, so it's
// available again later (test data cleanup, a fresh season, etc.) without
// needing another deploy. Requires both the secret header AND an explicit
// {"confirm":"DELETE_ALL_ANALYTICS_DATA"} body - two separate things that
// both have to be right, since this is irreversible and wipes every
// visitor session and drill-down index in one call.

const STORE_NAME = "blitz-analytics";
const CONFIRM_PHRASE = "DELETE_ALL_ANALYTICS_DATA";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-analytics-clear-secret",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const expectedSecret = process.env.ANALYTICS_CLEAR_SECRET;
  if (!expectedSecret) {
    return jsonResponse(500, { ok: false, error: "ANALYTICS_CLEAR_SECRET not configured on this site" });
  }

  const providedSecret = req.headers.get("x-analytics-clear-secret");
  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-analytics-clear-secret header" });
  }

  let body: any;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  if (body?.confirm !== CONFIRM_PHRASE) {
    return jsonResponse(400, {
      ok: false,
      error: `Missing or incorrect confirmation. POST body must include {"confirm":"${CONFIRM_PHRASE}"}`,
    });
  }

  try {
    const store = getStore(STORE_NAME);
    let deleted = 0;
    const deletions: Promise<unknown>[] = [];

    // Deletes everything in the store - both session:{visitorId} blobs and
    // every idx:{dimension}:... secondary-index blob - not just one prefix,
    // since a partial wipe would leave orphaned index entries pointing at
    // sessions that no longer exist.
    for await (const page of store.list({ paginate: true })) {
      for (const b of page.blobs) {
        deletions.push(store.delete(b.key));
        deleted += 1;
      }
    }
    await Promise.all(deletions);

    return jsonResponse(200, { ok: true, deleted });
  } catch (err: any) {
    return jsonResponse(500, { ok: false, error: err?.message || "Unknown error during clear" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/analytics-clear",
};

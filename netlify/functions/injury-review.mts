import type { Context, Config } from "@netlify/functions";
import { notifStore } from "./lib/notif.mts";

// The review queue behind the injury dispatcher: what ESPN saw move that
// Dan hasn't reflected in data/impact-players.json yet.
//
// GET  /.netlify/functions/injury-review            -> { ok, items }
//   ?all=1 includes items already marked done.
// POST /.netlify/functions/injury-review
//   { id, resolved: true|false }                    -> { ok, item }
// Both require: x-injury-review-secret
//
// WHY A SECRET AND NOT IDENTITY AUTH. analytics.html is a plain static page
// with no Identity widget on it, and there's no admin role in the user
// model to check against - inventing one for this would be a bigger change
// than the feature. A shared secret matches how every other write endpoint
// in this repo is gated (site-data-update, results-process, notif-dispatch).
//
// The GET is gated too. The contents aren't secret - it's public injury news
// - but an open endpoint listing exactly which players the site's own data
// is currently wrong about is not something to leave lying around.
//
// This queue is the half of the injury system that's for Dan rather than
// for readers. The curated file isn't slow because the research is slow;
// it's slow because nothing tells him when to look.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-injury-review-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** Items older than this are swept on read. Blobs has no TTL, and a queue
 *  that only grows stops being a queue and becomes an archive nobody opens. */
const MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const expected = process.env.INJURY_REVIEW_SECRET;
  if (!expected) return jsonResponse(500, { ok: false, error: "INJURY_REVIEW_SECRET is not set on this site" });
  const provided = req.headers.get("x-injury-review-secret");
  if (!provided || provided !== expected) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-injury-review-secret header" });
  }

  const store = notifStore();

  try {
    if (req.method === "GET") {
      const includeDone = new URL(req.url).searchParams.get("all") === "1";
      const items: any[] = [];
      let swept = 0;

      for await (const page of store.list({ prefix: "review:", paginate: true })) {
        for (const blob of page.blobs) {
          try {
            const item: any = await store.get(blob.key, { type: "json" });
            if (!item) continue;
            const age = Date.now() - Date.parse(item.seenAt || "");
            if (Number.isFinite(age) && age > MAX_AGE_MS) {
              await store.delete(blob.key);
              swept++;
              continue;
            }
            if (item.resolved && !includeDone) continue;
            items.push(item);
          } catch {
            // One unreadable row shouldn't empty the whole queue.
          }
        }
      }

      // Newest first, and anything already handled last.
      items.sort((a, b) => {
        if (!!a.resolved !== !!b.resolved) return a.resolved ? 1 : -1;
        return String(b.seenAt || "").localeCompare(String(a.seenAt || ""));
      });

      return jsonResponse(200, {
        ok: true,
        items,
        swept,
        openCount: items.filter((i) => !i.resolved).length,
      });
    }

    if (req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return jsonResponse(400, { ok: false, error: "Invalid JSON body" }); }
      if (!body.id) return jsonResponse(400, { ok: false, error: "id is required" });

      const key = `review:${body.id}`;
      const item: any = await store.get(key, { type: "json" });
      if (!item) return jsonResponse(404, { ok: false, error: "No such review item" });

      // Marked rather than deleted, so the same change re-appearing is
      // recognisable as a repeat rather than looking brand new.
      item.resolved = body.resolved !== false;
      item.resolvedAt = item.resolved ? new Date().toISOString() : null;
      await store.setJSON(key, item);
      return jsonResponse(200, { ok: true, item });
    }

    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/injury-review",
};

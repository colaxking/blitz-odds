import type { Context, Config } from "@netlify/functions";
import { notifStore } from "./lib/notif.mts";
import { requireAdminOrSecret, audit } from "./lib/admin.mts";

// The review queue behind the injury dispatcher: what ESPN saw move that
// Dan hasn't reflected in data/impact-players.json yet.
//
// GET  /.netlify/functions/injury-review            -> { ok, items }
//   ?all=1 includes items already marked done, and skips the collapse below.
// POST /.netlify/functions/injury-review
//   { id, resolved: true|false }                    -> { ok, item }
// Auth: an admin Identity session, OR x-injury-review-secret (scripts).
//
// WHY BOTH A SECRET AND IDENTITY AUTH. This started secret-only: analytics.html
// is a plain static page with no Identity widget, and at the time there was no
// admin role in the user model to check against. There is one now (lib/admin.mts),
// and the in-app Injuries tab uses it. The secret was not removed - the sync
// script and the static page still need it, and so does every other write
// endpoint in this repo (site-data-update, results-process, notif-dispatch).
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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-injury-review-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** Items older than this are swept on read. Blobs has no TTL, and a queue
 *  that only grows stops being a queue and becomes an archive nobody opens. */
const MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * One player, several reports.
 *
 * The dispatcher keys every row as `review:{espnId}:{injuryId}` - one row per
 * ESPN REPORT, not per player. So someone who went active -> questionable on
 * Wednesday and questionable -> out on Friday leaves two open rows, and rows
 * live for three weeks. That's not just two clicks instead of one: the older
 * row still carries its own `to`, so applying it after the newer one writes a
 * stale status back over the correct one.
 *
 * Only the newest row per player is actionable. Its `from` already accounts
 * for the earlier move, and its `ours` is read against the same curated file,
 * so acting on it alone lands the player in the right place. The older rows
 * are folded into it.
 *
 * Grouping is by espnId. A row with no espnId groups by its own id - it
 * collapses with nothing rather than with every other id-less row.
 */
function collapseRepeats(items: any[]): { kept: any[]; superseded: any[] } {
  const newestFor = new Map<string, any>();
  const kept: any[] = [];
  const superseded: any[] = [];

  // Callers pass items already sorted newest-first, so the first row seen for
  // a player is the one to keep.
  for (const item of items) {
    const groupKey = item.espnId ? `id:${item.espnId}` : `row:${item.id}`;
    const newest = newestFor.get(groupKey);
    if (!newest) {
      newestFor.set(groupKey, item);
      kept.push(item);
      continue;
    }
    superseded.push({ item, by: newest });
  }

  return { kept, superseded };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Two ways in, deliberately. The shared secret stays because
  // injury-player-sync.mjs and analytics.html have no Identity session to
  // present; the admin role is added alongside so the in-app Injuries tab
  // works off a normal login. Whichever matched is carried forward as the
  // actor, so an automated sync and a human approval are distinguishable in
  // the audit log rather than both showing up as "the secret holder".
  const actor = await requireAdminOrSecret(req, "x-injury-review-secret", process.env.INJURY_REVIEW_SECRET);
  if (!actor) {
    return jsonResponse(401, { ok: false, error: "Sign in as an admin, or send a valid x-injury-review-secret header" });
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

      // Fold repeat reports into the newest row per player. Done on read
      // rather than only at write time so the rows already sitting in the
      // queue collapse too, instead of waiting for each player to move again.
      // ?all=1 is the audit view and sees the queue untouched.
      let out = items;
      let folded = 0;
      if (!includeDone) {
        const { kept, superseded } = collapseRepeats(items);
        out = kept;
        for (const { item, by } of superseded) {
          item.resolved = true;
          item.resolvedAt = new Date().toISOString();
          item.supersededBy = by.id;
          by.supersedes = (by.supersedes || 0) + 1;
          await store.setJSON(`review:${item.id}`, item);
          folded++;
        }
        // The kept rows only need writing back when they actually absorbed
        // something, and one audit line covers the batch - a row per fold
        // would bury the human decisions this log exists to record.
        for (const item of kept) {
          if (item.supersedes) await store.setJSON(`review:${item.id}`, item);
        }
        if (folded) {
          await audit(
            actor,
            "injury.supersede",
            `folded ${folded} repeat injury report${folded === 1 ? "" : "s"} into the newer row for the same player`,
            { meta: { folded } }
          );
        }
      }

      return jsonResponse(200, {
        ok: true,
        items: out,
        swept,
        folded,
        openCount: out.filter((i) => !i.resolved).length,
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
      await audit(
        actor,
        item.resolved ? "injury.resolve" : "injury.reopen",
        item.resolved
          ? `cleared ${item.name || item.espnId} (${item.team}) from the injury queue`
          : `reopened ${item.name || item.espnId} (${item.team}) in the injury queue`,
        { target: item.id, meta: { espnId: item.espnId, from: item.from, to: item.to } }
      );
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

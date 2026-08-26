import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { notifStore } from "./lib/notif.mts";

// The write half of the injury review queue: turn an "untracked-candidate"
// row in analytics.html into a real entry in the curated player list.
//
// GET  /.netlify/functions/injury-player-add       -> { ok, pending }
// POST /.netlify/functions/injury-player-add
//   { reviewId, position, status, impactScore, injuryType, since, note, pinned }
//                                                  -> { ok, player, pending }
//   { ack: [espnId, ...] }                         -> { ok, cleared, pending }
// All require: x-injury-review-secret
//
// WHY A STAGING KEY AND NOT JUST THE LIVE BLOB. data/impact-players.json in
// git is the source of truth; the "players" blob is the live copy the site
// actually reads. Writing only the blob looks like it works and then loses
// the player: mergePlayersPayload in site-data-update.mts iterates the
// INCOMING team array, so anyone present in the blob but missing from the
// repo copy is dropped the next time injury-player-sync.mjs publishes.
//
// So every add is written twice - into the live "players" blob so the site
// reflects it within seconds, and onto "pending-adds" so the next sync run
// folds it into the repo copy and the two agree again. The sync script GETs
// this endpoint, merges, then POSTs { ack } to clear what it absorbed.
// Nothing leaves the staging list until it's provably in git.
//
// Gated by INJURY_REVIEW_SECRET rather than a new secret of its own: it's
// the same operator, on the same panel, acting on the same queue.

const SITE_DATA_STORE = "blitz-site-data";
const PENDING_KEY = "pending-adds";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-injury-review-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const VALID_STATUS = new Set(["active", "questionable", "doubtful", "out", "ir"]);

interface PendingAdd {
  team: string;
  player: Record<string, unknown>;
  stagedAt: string;
  reviewId: string | null;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

/** Strong consistency on both reads: an add is immediately followed by a
 *  re-read (the panel refreshes), and an edge replica a few seconds behind
 *  would show the operator their own write missing and invite a duplicate. */
function siteStore() {
  return getStore(SITE_DATA_STORE, { consistency: "strong" });
}

async function readPending(store: ReturnType<typeof getStore>): Promise<PendingAdd[]> {
  try {
    const list = await store.get(PENDING_KEY, { type: "json" });
    return Array.isArray(list) ? (list as PendingAdd[]) : [];
  } catch {
    return [];
  }
}

/** A trimmed date - "2026-08-26" or "2026-08" - is what formatInjurySince in
 *  index.html parses. Anything else is dropped rather than rendered as junk. */
function cleanSince(raw: unknown): string | null {
  const s = String(raw || "").trim();
  return /^\d{4}-\d{2}(-\d{2})?$/.test(s) ? s : null;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const expected = process.env.INJURY_REVIEW_SECRET;
  if (!expected) return jsonResponse(500, { ok: false, error: "INJURY_REVIEW_SECRET is not set on this site" });
  const provided = req.headers.get("x-injury-review-secret");
  if (!provided || provided !== expected) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-injury-review-secret header" });
  }

  const store = siteStore();

  try {
    if (req.method === "GET") {
      const pending = await readPending(store);
      return jsonResponse(200, { ok: true, pending, count: pending.length });
    }

    if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

    let body: any;
    try { body = await req.json(); } catch { return jsonResponse(400, { ok: false, error: "Invalid JSON body" }); }

    // ---- ack: the sync script has these in git now ------------------------
    if (Array.isArray(body.ack)) {
      const done = new Set(body.ack.map((id: unknown) => String(id)));
      const pending = await readPending(store);
      const keep = pending.filter((p) => !done.has(String((p.player as any)?.espnId)));
      await store.setJSON(PENDING_KEY, keep);
      return jsonResponse(200, { ok: true, cleared: pending.length - keep.length, pending: keep });
    }

    // ---- add --------------------------------------------------------------
    if (!body.reviewId) return jsonResponse(400, { ok: false, error: "reviewId is required" });

    const notif = notifStore();
    const reviewKey = `review:${body.reviewId}`;
    const item: any = await notif.get(reviewKey, { type: "json" });
    if (!item) return jsonResponse(404, { ok: false, error: "No such review item" });
    if (!item.team) return jsonResponse(422, { ok: false, error: "Review item has no team" });

    const status = String(body.status || item.to || "").toLowerCase();
    if (!VALID_STATUS.has(status)) {
      return jsonResponse(400, { ok: false, error: `status must be one of: ${[...VALID_STATUS].join(", ")}` });
    }

    const impactScore = Number(body.impactScore);
    if (!Number.isInteger(impactScore) || impactScore < 1 || impactScore > 10) {
      return jsonResponse(400, { ok: false, error: "impactScore must be a whole number from 1 to 10" });
    }

    const doc: any = await store.get("players", { type: "json" });
    if (!doc || !doc.players || typeof doc.players !== "object") {
      return jsonResponse(503, { ok: false, error: "The players document hasn't been published yet" });
    }

    const team = String(item.team);
    if (!Array.isArray(doc.players[team])) {
      return jsonResponse(422, { ok: false, error: `The players document carries no team "${team}"` });
    }

    // Both guards matter. espnId is the join key the sync script and the
    // dispatcher both use, and a duplicate there throws on the next sync
    // run ("Duplicate espnId(s)"). The name check catches the same player
    // added before his ID was ever resolved.
    const flat: any[] = Object.values(doc.players).flat() as any[];
    const dupe = flat.find((p) =>
      (item.espnId && p.espnId && String(p.espnId) === String(item.espnId)) ||
      (p.name && item.name && String(p.name).toLowerCase() === String(item.name).toLowerCase()));
    if (dupe) {
      return jsonResponse(409, { ok: false, error: `${dupe.name} is already tracked`, player: dupe });
    }

    const now = new Date().toISOString();
    const since = cleanSince(body.since) || (item.reportedAt ? String(item.reportedAt).slice(0, 10) : null);
    const note = String(body.note || "").trim() || null;
    const injuryType = String(body.injuryType || item.detail || "").trim() || "Undisclosed";

    const player: Record<string, unknown> = {
      name: item.name,
      position: String(body.position || item.position || "").toUpperCase() || null,
      espnId: item.espnId ? String(item.espnId) : null,
      impactScore,
      status,
      // A healthy player carries no injury block - the narrative would
      // describe a situation that's over. Same rule the sync script uses
      // when it moves someone back to active.
      injury: status === "active" ? null : { type: injuryType, since, note },
      // Stamped now and marked curated so the sync script treats this as a
      // human decision: only an ESPN report filed AFTER this moment can move
      // it, which means the report that put him in the queue can't
      // immediately overwrite the call just made about it.
      statusUpdatedAt: now,
      source: "curated",
    };
    if (body.pinned === true) player.pinned = true;

    doc.players[team].push(player);
    doc.updatedAt = now;
    await store.setJSON("players", doc);

    const pending = await readPending(store);
    pending.push({ team, player, stagedAt: now, reviewId: String(body.reviewId) });
    await store.setJSON(PENDING_KEY, pending);

    // One decision, one click: adding a player IS handling the queue item.
    try {
      item.resolved = true;
      item.resolvedAt = now;
      await notif.setJSON(reviewKey, item);
    } catch {
      // The add is the part that matters. A queue row that stays open is a
      // cosmetic problem the operator can clear by hand.
    }

    return jsonResponse(200, { ok: true, team, player, pendingCount: pending.length });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/injury-player-add",
};

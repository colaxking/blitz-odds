import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { notifStore } from "./lib/notif.mts";
import { requireAdminOrSecret, audit } from "./lib/admin.mts";

// The write half of the injury review queue: turn an "untracked-candidate"
// row in analytics.html into a real entry in the curated player list.
//
// GET  /.netlify/functions/injury-player-add       -> { ok, pending }
// POST /.netlify/functions/injury-player-add
//   { reviewId, position, status, impactScore, injuryType, since, note, pinned }
//                                                  -> { ok, player, pending }
//   { ack: [espnId, ...] }                         -> { ok, cleared, pending }
// Auth: an admin Identity session, OR x-injury-review-secret (scripts).
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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-injury-review-secret",
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

    // Validated per-branch below: a NEW player must be given a score, but an
    // update to someone already tracked inherits the one they have, so an
    // admin flipping a status isn't forced to re-assert an unrelated number.
    const scoreProvided = body.impactScore !== undefined && body.impactScore !== null && body.impactScore !== "";
    const impactScore = Number(body.impactScore);
    if (scoreProvided && (!Number.isInteger(impactScore) || impactScore < 1 || impactScore > 10)) {
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
    const now0 = new Date().toISOString();

    // WAS A 409. This endpoint originally only ever created players, so a name
    // already in the curated file was an error. That left the common case with
    // no home at all: most queue items are "tracked-change" rows about players
    // who ARE in the file, and the whole point of reviewing one is to move the
    // status the file records. Refusing that made the queue read-only for
    // everything except brand new names.
    //
    // So an existing player is now an update rather than a conflict. It writes
    // the same two places a create does - the live "players" blob so the site
    // reflects it within seconds, and "pending-adds" so the next sync run
    // folds it into the repo copy (see the header note on why one without the
    // other silently loses the change).
    if (dupe) {
      const dupeTeam = Object.keys(doc.players).find((t: string) =>
        (doc.players[t] || []).some((p: any) => p === dupe)) || team;

      const nextScore = scoreProvided ? impactScore : Number(dupe.impactScore);
      if (!Number.isInteger(nextScore) || nextScore < 1 || nextScore > 10) {
        return jsonResponse(400, {
          ok: false,
          error: `${dupe.name} has no impact score on file - provide one from 1 to 10`,
        });
      }

      const upIntoInjury = String(body.injuryType || dupe.injury?.type || item.detail || "").trim() || "Undisclosed";
      const upSince = cleanSince(body.since)
        || dupe.injury?.since
        || (item.reportedAt ? String(item.reportedAt).slice(0, 10) : null);
      const upNote = String(body.note || "").trim() || dupe.injury?.note || null;

      dupe.status = status;
      dupe.impactScore = nextScore;
      dupe.injury = status === "active" ? null : { type: upIntoInjury, since: upSince, note: upNote };
      // Same reasoning as a create: stamped now and marked curated so the sync
      // script treats this as a human decision and only an ESPN report filed
      // AFTER this moment can move it.
      dupe.statusUpdatedAt = now0;
      dupe.source = "curated";
      if (body.pinned === true) dupe.pinned = true;

      doc.updatedAt = now0;
      await store.setJSON("players", doc);

      const pendingUp = await readPending(store);
      pendingUp.push({ team: dupeTeam, player: dupe, stagedAt: now0, reviewId: String(body.reviewId) });
      await store.setJSON(PENDING_KEY, pendingUp);

      try {
        item.resolved = true;
        item.resolvedAt = now0;
        await notif.setJSON(reviewKey, item);
      } catch {
        /* the status change is what matters; a stuck queue row is cosmetic */
      }

      await audit(
        actor,
        "injury.status",
        `set ${dupe.name} (${dupeTeam}) to ${status}`,
        { target: String(dupe.espnId || dupe.name || ""), meta: { team: dupeTeam, status, updated: true } }
      );

      return jsonResponse(200, { ok: true, team: dupeTeam, player: dupe, updated: true, pendingCount: pendingUp.length });
    }

    if (!scoreProvided) {
      return jsonResponse(400, { ok: false, error: "impactScore is required when adding a new player" });
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

    await audit(
      actor,
      "injury.status",
      `set ${(player as any).name || "a player"} (${team}) to ${(player as any).status}`,
      { target: String((player as any).espnId || (player as any).name || ""), meta: { team, status: (player as any).status } }
    );

    return jsonResponse(200, { ok: true, team, player, pendingCount: pending.length });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/injury-player-add",
};

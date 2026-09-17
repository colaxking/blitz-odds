import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Write endpoint for the nfl-matchup-analyzer-weekly-update scheduled task.
// Same idea as odds-update.mts, applied to the rest of the app's data: team
// stats/ranks, injury statuses, the weekly history archive, and the playoff
// bracket. Publishing here makes the change live immediately, without
// waiting on a git push + Netlify build - the task still writes files to
// disk and commits/pushes afterward for a durable, versioned record, but a
// slow or failed git push no longer means stale data on the live site.
//
// Uses a separate secret (SITE_DATA_UPDATE_SECRET) from odds-update.mts's
// ODDS_UPDATE_SECRET, so this function can be added/changed without any risk
// to the already-running odds pipeline.

const STORE_NAME = "blitz-site-data";
// "espnInjuries" is the mirror of ESPN's league-wide injury feed. It is
// NEVER the source of truth for a player's status - data/impact-players.json
// ("players") is, and stays so. This is the second, sourced layer the injury
// block renders underneath the curated one, plus what the poller diffs to
// decide an alert is warranted.
const VALID_KEYS = new Set(["teams", "players", "schedule", "history", "preseason", "playoffs", "espnInjuries"]);

// Defensive safety net for the "players" key. The weekly-update task is
// supposed to fetch-before-merge itself (see site-data-current.mts), but
// when it doesn't - or when it's regenerating the injury list fresh each
// run - any field it doesn't know about (e.g. activatedDate, added after
// the task was last touched) gets silently dropped on the next overwrite.
// This merges each incoming player record over the previously-stored one
// (matched by team + name), so fields present in the old record but absent
// from the new one survive instead of disappearing. Fields the new record
// *does* specify always win.
async function mergePlayersPayload(store: ReturnType<typeof getStore>, incoming: any): Promise<any> {
  if (!incoming || typeof incoming !== "object" || !incoming.players || typeof incoming.players !== "object") {
    return incoming;
  }
  let existing: any = null;
  try {
    existing = await store.get("players", { type: "json" });
  } catch {
    existing = null;
  }
  const oldTeams = existing && typeof existing === "object" ? existing.players : null;
  if (!oldTeams || typeof oldTeams !== "object") {
    return incoming;
  }

  const mergedTeams: Record<string, any> = {};
  for (const team of Object.keys(incoming.players)) {
    const newList = Array.isArray(incoming.players[team]) ? incoming.players[team] : [];
    const oldList = Array.isArray(oldTeams[team]) ? oldTeams[team] : [];
    const oldByName = new Map(oldList.map((p: any) => [p && p.name, p]));
    mergedTeams[team] = newList.map((p: any) => {
      const old = p && oldByName.get(p.name);
      return old && typeof old === "object" ? { ...old, ...p } : p;
    });
  }

  return { ...incoming, players: mergedTeams };
}

// Hard guard for the "history" key. Week 1 of 2026 originally shipped as an
// illustrative sample snapshot (isDemo: true) to demonstrate the
// predicted-vs-actual view before the season started. It was deleted from git
// five separate times (Jul 30, Aug 8, Aug 18, Aug 24, plus a blob-only purge
// Aug 25) and came back every time, because the weekly archive step copies the
// whole history document forward and only needs ONE surviving stale copy - the
// blob, data/history.json, the embedded HISTORY_DATA block, or a static page -
// to re-propagate it everywhere.
//
// Rather than keep chasing copies, this rejects the data at the only choke
// point every publisher goes through. No demo week can enter the blob store,
// so no archive can pick one back up. The app no longer renders isDemo at all;
// this exists purely so a stale payload can't reintroduce it.
function stripDemoWeeks(incoming: any): { value: any; dropped: number[] } {
  if (!incoming || typeof incoming !== "object" || !Array.isArray(incoming.weeks)) {
    return { value: incoming, dropped: [] };
  }
  const dropped: number[] = [];
  const weeks = incoming.weeks.filter((w: any) => {
    if (w && typeof w === "object" && w.isDemo === true) {
      dropped.push(typeof w.week === "number" ? w.week : -0);
      return false;
    }
    return true;
  });
  if (!dropped.length) return { value: incoming, dropped };
  return { value: { ...incoming, weeks }, dropped };
}

// The fields of a weekly history entry that describe what the model was
// running on when that week's games kicked off. Once a week has been seeded
// at kickoff (see seedWeekSnapshots() in scripts/history-results-refresh.mjs,
// which stamps `inputsFrozenAt`), these are a record of the past and must
// not be restated by a later publish - the whole reason the entry exists is
// so a finished card can show the ranks and injury report its call was made
// on, not the ones that absorbed that week's results.
//
// Week 1 of 2026 is the cautionary tale: the Tuesday archive wrote the
// season-to-date stats *through* Week 1 (DEN's offense at #32 was literally
// that game's stat line) and Monday-night injury statuses (Darnold out,
// Garrett to IR - hurt *in* Week 1), so every Week 1 card recomputed
// against hindsight and DEN@KC read "KC 86%, called it" when the model had
// DEN 57% at kickoff. The weekly-update task refreshes teams.json to
// through-week-N and archives week N in the same breath, which is exactly
// how the wrong numbers land in the archive. This guard keeps them out at
// the choke point, the same way stripDemoWeeks keeps the sample week out.
const FROZEN_INPUT_FIELDS = ["teamStats", "impactPlayers", "inputsFrozenAt", "teamStatsThroughWeek", "inputsNote", "note"] as const;

/** For every incoming week entry that the stored history doc already holds
 *  with `inputsFrozenAt` set, carry the stored kickoff inputs forward and
 *  take only the rest (results, above all) from the incoming entry. Weeks
 *  the store has never seen, and stored weeks that were never seeded, pass
 *  through untouched. `force` (body.forceHistoryInputs === true) is the
 *  deliberate escape hatch for correcting a seeded week by hand. */
async function preserveFrozenHistoryInputs(
  store: ReturnType<typeof getStore>,
  incoming: any,
  force: boolean
): Promise<{ value: any; preserved: number[] }> {
  if (force || !incoming || typeof incoming !== "object" || !Array.isArray(incoming.weeks)) {
    return { value: incoming, preserved: [] };
  }
  let existing: any = null;
  try {
    existing = await store.get("history", { type: "json" });
  } catch {
    existing = null;
  }
  const storedWeeks: any[] = existing && Array.isArray(existing.weeks) ? existing.weeks : [];
  if (!storedWeeks.length) return { value: incoming, preserved: [] };
  const storedByWeek = new Map<number, any>(
    storedWeeks.filter((w) => w && typeof w === "object" && typeof w.week === "number").map((w) => [w.week, w])
  );

  const preserved: number[] = [];
  const weeks = incoming.weeks.map((w: any) => {
    if (!w || typeof w !== "object" || typeof w.week !== "number") return w;
    const stored = storedByWeek.get(w.week);
    if (!stored || !stored.inputsFrozenAt) return w;
    let changed = false;
    const out: any = { ...w };
    for (const field of FROZEN_INPUT_FIELDS) {
      if (JSON.stringify(out[field]) !== JSON.stringify(stored[field])) changed = true;
      if (stored[field] === undefined) delete out[field];
      else out[field] = stored[field];
    }
    if (changed) preserved.push(w.week);
    return out;
  });
  return { value: { ...incoming, weeks }, preserved };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-site-data-update-secret",
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

  const expectedSecret = process.env.SITE_DATA_UPDATE_SECRET;
  if (!expectedSecret) {
    return jsonResponse(500, { ok: false, error: "SITE_DATA_UPDATE_SECRET not configured on this site" });
  }

  const providedSecret = req.headers.get("x-site-data-update-secret");
  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-site-data-update-secret header" });
  }

  let body: any;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  if (!body || typeof body !== "object") {
    return jsonResponse(400, { ok: false, error: "Body must be a JSON object" });
  }

  // Control flags ride alongside the data keys and aren't published.
  const CONTROL_KEYS = new Set(["forceHistoryInputs"]);
  const providedKeys = Object.keys(body).filter((k) => body[k] !== undefined && !CONTROL_KEYS.has(k));
  const unknownKeys = providedKeys.filter((k) => !VALID_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return jsonResponse(400, { ok: false, error: `Unknown key(s): ${unknownKeys.join(", ")}. Valid keys: ${[...VALID_KEYS].join(", ")}` });
  }

  const relevantKeys = providedKeys.filter((k) => VALID_KEYS.has(k));
  if (relevantKeys.length === 0) {
    return jsonResponse(400, { ok: false, error: `Provide at least one of: ${[...VALID_KEYS].join(", ")}` });
  }

  // Strong consistency: mergePlayersPayload below reads the stored doc and
  // writes a merged version straight back. A stale read there would drop
  // fields the previous run had just added.
  const store = getStore(STORE_NAME, { consistency: "strong" });
  const updated: string[] = [];

  for (const key of relevantKeys) {
    let value = body[key];
    if (!value || typeof value !== "object") {
      return jsonResponse(400, { ok: false, error: `body.${key} must be an object` });
    }
    if (key === "players") {
      value = await mergePlayersPayload(store, value);
    }
    if (key === "history") {
      const { value: cleaned, dropped } = stripDemoWeeks(value);
      if (dropped.length) {
        console.warn(
          `site-data-update: dropped ${dropped.length} demo week(s) from history payload: ${dropped.join(", ")}`
        );
      }
      const { value: kept, preserved } = await preserveFrozenHistoryInputs(store, cleaned, body.forceHistoryInputs === true);
      if (preserved.length) {
        console.warn(
          `site-data-update: kept the kickoff-frozen team stats / injury lists for week(s) ${preserved.join(", ")}; the incoming copies were ignored (send forceHistoryInputs: true to override)`
        );
      }
      value = kept;
    }
    await store.setJSON(key, value);
    updated.push(key);
  }

  return jsonResponse(200, { ok: true, updated });
};

export const config: Config = {
  path: "/.netlify/functions/site-data-update",
};

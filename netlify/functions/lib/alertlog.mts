import { notifStore } from "./notif.mts";

// A durable record of what every push dispatch pass decided, per user, per
// alert.
//
// WHY THIS EXISTS. Until now the only account of a dispatch pass was the
// `report` object the background function returned - and a background
// function's response body is never seen by anyone, because Netlify answers
// the caller 202 before the handler runs. The per-user detail existed for
// the length of one invocation and then went to the function log, where it
// is neither queryable nor filterable by user.
//
// That made the most common support question unanswerable: "why didn't I get
// an alert for that game?" The outcomes that answer it - `no-devices`,
// `not-followed`, `off`, `quiet-hours`, `duplicate` - are each a different
// bug with a different fix, and none of them is distinguishable from the
// outside. Diagnosing one of these took bundling the dispatcher against
// stubbed Blobs and replaying the tick locally. This turns that into a read.
//
// WHAT IS AND ISN'T RECORDED. One row per (user, alert) actually considered
// for a candidate event - so the volume is bounded by how many games were in
// a window, not by roster size times slate size. A tick that finds no
// candidate game writes nothing at all, which is almost every tick: the
// 15-minute dispatcher writes on the order of a dozen entries a week, and
// the 90-second live dispatcher only while a followed game is actually
// scoring.
//
// NOT AN AUDIT LOG. lib/admin.mts's audit records human decisions and is
// deliberately append-only forever. This records machine behaviour for
// debugging and is pruned. Keeping them in separate stores and separate
// prefixes means a retention rule here can never reach the other one.

const KEY_PREFIX = "alertlog:";
/** Beyond this, the oldest entries are dropped on the next flush. */
const MAX_ENTRIES = 500;
/** Nothing older than this survives a flush, even under the cap. */
const MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;

export type AlertSource = "dispatch" | "live" | "injury";

export interface AlertLogRow {
  userId: string;
  /** Alert family: "kick" | "final" | "lastcall" | "score" | "inj". */
  type: string;
  /** The specific occurrence - usually a game id. */
  event: string;
  week: number;
  /** deliverAlert's AlertOutcome, or a dispatcher-side skip reason. */
  outcome: string;
  /** Anything that makes the row readable without cross-referencing, e.g.
   *  "MIN@DEN". */
  label?: string;
}

export interface AlertLogEntry {
  id: string;
  at: string;
  source: AlertSource;
  dryRun: boolean;
  /** Rolled-up counts, so the admin list can be rendered without opening
   *  every row. */
  outcomes: Record<string, number>;
  rows: AlertLogRow[];
  meta?: Record<string, unknown>;
}

/**
 * Newest-first by construction, same trick as the audit log: the timestamp
 * is inverted against a fixed epoch so a lexicographic list() returns recent
 * entries first and the reader never has to sort the whole log. The random
 * suffix breaks ties inside one millisecond.
 */
const LOG_EPOCH = 4_102_444_800_000; // 2100-01-01
function logKey(at: number): string {
  const inverted = String(LOG_EPOCH - at).padStart(14, "0");
  return `${KEY_PREFIX}${inverted}:${Math.random().toString(36).slice(2, 8)}`;
}

export interface AlertLog {
  add(row: AlertLogRow): void;
  /** Number of rows collected so far. */
  size(): number;
  flush(meta?: Record<string, unknown>): Promise<void>;
}

/**
 * Collects rows in memory for the length of one dispatch pass and writes
 * them as a single blob at the end.
 *
 * One write per pass rather than one per row, for two reasons: a row-per-
 * write would multiply the pass's Blobs cost by its user count, and the
 * three dispatchers can overlap - a per-pass key with a random suffix can't
 * collide, whereas any read-modify-write on a shared document would lose
 * whichever pass finished second.
 */
export function createAlertLog(source: AlertSource, now: Date, dryRun = false): AlertLog {
  const rows: AlertLogRow[] = [];

  return {
    add(row: AlertLogRow) {
      rows.push(row);
    },
    size() {
      return rows.length;
    },
    async flush(meta?: Record<string, unknown>) {
      // Nothing considered means nothing worth a key. This is what keeps a
      // 15-minute tick that found no candidate game from writing 96 empty
      // entries a day.
      if (!rows.length) return;
      try {
        const at = now.getTime();
        const outcomes: Record<string, number> = {};
        for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;

        const entry: AlertLogEntry = {
          id: logKey(at),
          at: new Date(at).toISOString(),
          source,
          dryRun,
          outcomes,
          rows,
          ...(meta ? { meta } : {}),
        };
        await notifStore().setJSON(entry.id, entry);
        await prune(at);
      } catch {
        // A logging failure must never take down a dispatch pass. The
        // alerts themselves have already been sent by the time this runs;
        // throwing here would turn a missing log line into a 500 for work
        // that succeeded.
      }
    },
  };
}

/** Trims the log to the retention rule. Best-effort and only ever called
 *  from a flush that actually wrote something, so the list() cost lands on
 *  the handful of passes that had alerts rather than on every tick. */
async function prune(nowMs: number): Promise<void> {
  try {
    const store = notifStore();
    const { blobs } = await store.list({ prefix: KEY_PREFIX });
    // Keys sort newest-first, so anything past the cap is the tail.
    const keys = blobs.map((b) => b.key).sort();
    const doomed = new Set(keys.slice(MAX_ENTRIES));
    for (const key of keys.slice(0, MAX_ENTRIES)) {
      const at = timestampFromKey(key);
      if (at !== null && nowMs - at > MAX_AGE_MS) doomed.add(key);
    }
    await Promise.all([...doomed].map((key) => store.delete(key).catch(() => {})));
  } catch {
    /* best effort - a log that grows is better than a dispatch that fails */
  }
}

/** Recovers the entry's timestamp from its key, so age-based pruning doesn't
 *  need to read every blob it's considering. */
function timestampFromKey(key: string): number | null {
  const part = key.slice(KEY_PREFIX.length).split(":")[0];
  const inverted = Number(part);
  if (!Number.isFinite(inverted)) return null;
  return LOG_EPOCH - inverted;
}

export interface ReadAlertLogOptions {
  limit?: number;
  /** Only entries containing a row for this user, with the other users'
   *  rows stripped out. */
  userId?: string;
  /** "dispatch" | "live" | "injury". */
  source?: string;
  /** Alert family, e.g. "kick". */
  type?: string;
}

/**
 * Newest entries first. Filtering happens after the read because the log is
 * small and capped - a per-user index would be a second write on every pass
 * to save a scan of at most MAX_ENTRIES keys.
 */
export async function readAlertLog(options: ReadAlertLogOptions = {}): Promise<AlertLogEntry[]> {
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  const store = notifStore();
  const { blobs } = await store.list({ prefix: KEY_PREFIX });
  const keys = blobs.map((b) => b.key).sort();

  // A filtered request has to read wider than the limit, or asking for 50 of
  // one user's rows would return three just because the recent log is busy
  // with someone else's.
  const scanDepth = options.userId || options.source || options.type
    ? Math.min(keys.length, MAX_ENTRIES)
    : limit;

  const entries = await Promise.all(
    keys.slice(0, scanDepth).map(async (key) => {
      try {
        return (await store.get(key, { type: "json" })) as AlertLogEntry | null;
      } catch {
        return null;
      }
    })
  );

  const out: AlertLogEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (options.source && entry.source !== options.source) continue;

    let rows = entry.rows || [];
    if (options.userId) rows = rows.filter((r) => r.userId === options.userId);
    if (options.type) rows = rows.filter((r) => r.type === options.type);
    if (!rows.length) continue;

    // Recount against the rows actually being returned - a filtered entry
    // showing the whole pass's outcome counts would read as if those
    // outcomes belonged to the one user asked about.
    const outcomes: Record<string, number> = {};
    for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;

    out.push({ ...entry, rows, outcomes });
    if (out.length >= limit) break;
  }
  return out;
}

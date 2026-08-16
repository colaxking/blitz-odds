import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Every dimension a dashboard tile can be clicked on. Must match the
// `addIndex(...)` calls in track.mts.
const VALID_DIMENSIONS = new Set([
  "device",
  "city",
  "country",
  "teamClick",
  "favTeam",
  "rosterTeam",
  "rosterSide",
  "player",
  "pvHour",
  "pvDay",
  "pvMonth",
  "theme",
  "sportsbook",
  "tzPref",
  "newsSource",
]);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
type Range = "24h" | "7d" | "30d" | "3m" | "6m" | "1y" | "all";
const VALID_RANGES = new Set<Range>(["24h", "7d", "30d", "3m", "6m", "1y", "all"]);

// Mirrors resolveRange's cutoff logic in analytics-summary.mts, so a
// drill-down list stays in sync with whatever window the dashboard tile it
// was opened from is currently showing.
function monthsAgoStart(now: number, n: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1);
}
function resolveCutoff(range: Range, now: number): number | null {
  switch (range) {
    case "24h": return now - 24 * HOUR_MS;
    case "7d": return now - 7 * DAY_MS;
    case "30d": return now - 30 * DAY_MS;
    case "3m": return monthsAgoStart(now, 2);
    case "6m": return monthsAgoStart(now, 5);
    case "1y": return monthsAgoStart(now, 11);
    case "all": return null;
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
// Bounds worst-case work per request regardless of how large an index has
// grown - a request is always "list up to this many index keys, hydrate the
// unique visitors among them", never "scan everything". See the storage-model
// comment in track.mts for why index keys can contain visitor duplicates.
const MAX_INDEX_KEYS_SCANNED = 800;
const MAX_SESSION_EVENTS_RETURNED = 300;

type SessionRecord = {
  visitorId: string;
  firstSeen: number;
  lastSeen: number;
  device?: string;
  location?: Record<string, unknown>;
  pageviews: number;
  favoriteTeams?: Record<string, true>;
  theme?: string;
  sportsbookPref?: string;
  tzPref?: string;
  events: Record<string, unknown>[];
};

function shortId(visitorId: string): string {
  // Never expose the full UUID to the dashboard UI - a per-browser random id
  // is not personal data, but there's no reason to show more of it than
  // needed to tell rows apart at a glance.
  return visitorId.slice(0, 8);
}

function summarize(session: SessionRecord, requestedDimension?: string, requestedValue?: string) {
  const loc = session.location || {};
  const cityLabel = [loc.city, loc.region, loc.country].filter(Boolean).join(", ") || null;
  const favTeams = session.favoriteTeams ? Object.keys(session.favoriteTeams) : [];
  return {
    id: session.visitorId, // full anonymous id, for follow-up ?visitorId= detail lookups
    visitorId: shortId(session.visitorId), // display-only, truncated
    firstSeen: session.firstSeen,
    lastSeen: session.lastSeen,
    device: session.device || null,
    theme: session.theme || null,
    sportsbook: session.sportsbookPref || null,
    tzPref: session.tzPref || null,
    city: cityLabel,
    country: (loc.country as string) || null,
    pageviews: session.pageviews || 0,
    eventCount: Array.isArray(session.events) ? session.events.length : 0,
    favoriteTeams: favTeams,
    // If this list was scoped to a favTeam filter, flag whether that team is
    // still currently favorited - the index can lag an unfavorite by up to a
    // day (see analytics-reindex-background.mts), so surface the live state
    // here rather than let a stale-looking row pass as current.
    activeForFilter:
      requestedDimension === "favTeam" && requestedValue ? favTeams.indexOf(requestedValue) !== -1 : undefined,
  };
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const url = new URL(req.url);
  const store = getStore("blitz-analytics");

  const visitorIdParam = url.searchParams.get("visitorId");

  // --- Single-session detail: full event timeline for one visitor ---
  if (visitorIdParam) {
    try {
      const session = (await store.get(`session:${visitorIdParam}`, { type: "json" })) as SessionRecord | null;
      if (!session) return jsonResponse(404, { ok: false, error: "Session not found" });

      const events = Array.isArray(session.events) ? session.events.slice(-MAX_SESSION_EVENTS_RETURNED) : [];
      return jsonResponse(200, {
        ok: true,
        session: { ...summarize(session), events: events.slice().sort((a: any, b: any) => (b.ts || 0) - (a.ts || 0)) },
      });
    } catch {
      return jsonResponse(404, { ok: false, error: "Session not found" });
    }
  }

  // --- Filtered list: all visitors matching a dashboard tile's dimension/value ---
  const dimension = url.searchParams.get("dimension") || "all";
  const value = url.searchParams.get("value") || "";
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get("limit") || "", 10) || DEFAULT_LIMIT));
  const rangeParam = url.searchParams.get("range") || "30d";
  const range: Range = VALID_RANGES.has(rangeParam as Range) ? (rangeParam as Range) : "30d";
  const now = Date.now();
  const cutoff = resolveCutoff(range, now);

  if (dimension !== "all" && !VALID_DIMENSIONS.has(dimension)) {
    return jsonResponse(400, { ok: false, error: "Invalid dimension" });
  }
  if (dimension !== "all" && !value) {
    return jsonResponse(400, { ok: false, error: "Missing value" });
  }

  try {
    const prefix = dimension === "all" ? "session:" : `idx:${dimension}:${encodeURIComponent(value)}:`;

    const uniqueIds: string[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let truncated = false;

    outer: for await (const page of store.list({ prefix, paginate: true })) {
      for (const b of page.blobs) {
        scanned += 1;
        if (scanned > MAX_INDEX_KEYS_SCANNED) {
          truncated = true;
          break outer;
        }
        // Key shapes:
        //   session:{visitorId}
        //   idx:{dim}:{value}:{invertedTs}:{visitorId}
        const parts = b.key.split(":");
        const id = parts[parts.length - 1];
        if (!id) continue;

        // idx: keys sort most-recent-first (inverted timestamp), so as soon
        // as we hit an entry older than the selected range's cutoff, every
        // remaining entry under this prefix is even older - stop scanning
        // rather than filtering the rest out one at a time.
        if (dimension !== "all" && cutoff !== null) {
          const invTs = parts[parts.length - 2];
          const entryTs = 9999999999999 - parseInt(invTs, 10);
          if (!Number.isFinite(entryTs) || entryTs < cutoff) break outer;
        }

        if (seen.has(id)) continue;
        seen.add(id);
        uniqueIds.push(id);
        if (uniqueIds.length >= limit) break outer;
      }
    }

    let sessions = (
      await Promise.all(
        uniqueIds.map(async (id) => {
          try {
            return (await store.get(`session:${id}`, { type: "json" })) as SessionRecord | null;
          } catch {
            return null;
          }
        })
      )
    ).filter((s): s is SessionRecord => !!s);

    // "all" isn't index-ordered by recency the way a dimension prefix is
    // (session keys sort by visitorId, not by activity) and has no
    // per-entry timestamp to filter on the way idx: keys do, so scope it by
    // last activity instead, then sort explicitly.
    if (dimension === "all") {
      if (cutoff !== null) sessions = sessions.filter((s) => (s.lastSeen || 0) >= cutoff);
      sessions.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    }

    return jsonResponse(200, {
      ok: true,
      dimension,
      value: dimension === "all" ? null : value,
      range,
      sessions: sessions.map((s) => summarize(s, dimension, value)),
      truncated, // true if MAX_INDEX_KEYS_SCANNED was hit before `limit` unique visitors were found
    });
  } catch (err) {
    return jsonResponse(200, { ok: true, dimension, value: dimension === "all" ? null : value, range, sessions: [], truncated: false });
  }
};

export const config: Config = {
  path: "/.netlify/functions/analytics-sessions",
};

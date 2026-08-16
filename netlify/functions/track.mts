import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(extraHeaders || {}),
    },
  });
}

const VALID_TYPES = new Set([
  "pageview",
  "team_click",
  "favorite",
  "team_tab",
  "roster_side",
  "player_view",
  "news_click",
  "boxscore_click",
]);

// Coarse buckets sent by js/analytics.js's UA-based detectDeviceType().
// Anything else (missing, malformed, or a detection failure on the client,
// which sends "unknown") is simply omitted from the record rather than
// stored - same convention as location below.
const VALID_DEVICES = new Set(["mobile", "tablet", "desktop"]);

// Best-effort extraction of Netlify's built-in geolocation (derived from the
// edge node that served the request, via the `x-nf-geo` header). This is
// approximate (city-level at best) and never involves storing a raw IP.
function extractLocation(context: Context): Record<string, unknown> | null {
  try {
    const geo = context && (context as any).geo;
    if (!geo) return null;

    const location: Record<string, unknown> = {};
    if (geo.city) location.city = String(geo.city).slice(0, 128);
    if (geo.country && geo.country.name) location.country = String(geo.country.name).slice(0, 128);
    if (geo.country && geo.country.code) location.countryCode = String(geo.country.code).slice(0, 8);
    if (geo.subdivision && geo.subdivision.name) location.region = String(geo.subdivision.name).slice(0, 128);
    if (geo.subdivision && geo.subdivision.code) location.regionCode = String(geo.subdivision.code).slice(0, 16);
    if (geo.timezone) location.timezone = String(geo.timezone).slice(0, 64);
    if (typeof geo.latitude === "number" && Number.isFinite(geo.latitude)) location.lat = geo.latitude;
    if (typeof geo.longitude === "number" && Number.isFinite(geo.longitude)) location.lon = geo.longitude;

    return Object.keys(location).length > 0 ? location : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage model
// ---------------------------------------------------------------------------
// Every visitor gets exactly ONE blob - `session:{visitorId}` - holding their
// running event log (capped) plus a small denormalized summary. This is a
// deliberate change from the old one-blob-per-event model: blob COUNT for
// sessions stays bounded by unique visitors (not total events), so reading
// "everything this visitor did" is a single key lookup, and a full-store scan
// (analytics-summary.mts) has far fewer blobs to fetch as traffic grows.
//
// For "click a tile, see matching visitors" drill-down, we also write tiny
// secondary-index blobs shaped:
//   idx:{dimension}:{encodedValue}:{invertedTimestamp}:{visitorId}
// The inverted timestamp makes lexicographic key order == most-recent-first,
// so a drill-down list is just `store.list({ prefix })` capped at N results -
// no read-modify-write, no sorting, no race conditions on shared state. The
// tradeoff: a returning visitor writes a fresh index entry each time they
// touch the same dimension/value (e.g. every pageview from the same device),
// so historical duplicates accumulate under a given prefix over time. Reads
// dedupe by visitorId and stop once they have enough unique matches, so this
// never slows a request down - it's purely a storage-growth concern, which
// analytics-reindex-background.mts sweeps up periodically.
const MAX_EVENTS_PER_SESSION = 300;

type SessionRecord = {
  visitorId: string;
  firstSeen: number;
  lastSeen: number;
  device?: string;
  location?: Record<string, unknown>;
  pageviews: number;
  favoriteTeams: Record<string, true>;
  theme?: string;
  sportsbookPref?: string;
  tzPref?: string;
  events: Record<string, unknown>[];
};

function invertedTimestamp(ts: number): string {
  // 13 digits covers ms-epoch through the year 2286, zero-padded so string
  // comparison sorts numerically. Inverting means "most recent" sorts first.
  return String(9999999999999 - Math.floor(ts)).padStart(13, "0");
}

function indexKey(dimension: string, value: string, ts: number, visitorId: string): string {
  return `idx:${dimension}:${encodeURIComponent(value)}:${invertedTimestamp(ts)}:${visitorId}`;
}

// Mirrors hourBucketLabel/dayBucketLabel/monthBucketLabel in
// analytics-summary.mts exactly, so a bucket string produced here for
// indexing matches the bucket string the chart hands back on click.
function hourBucketLabel(ts: number): string {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
function dayBucketLabel(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
function monthBucketLabel(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const raw = await req.text();
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
    }

    const { type, visitorId, ts, team, teamName, adding, week, tab, side, player, source, device, theme, sportsbook, timezone, headline, origin, placement, away, home } = body || {};

    if (!VALID_TYPES.has(type)) {
      return jsonResponse(400, { ok: false, error: "Invalid or missing type" });
    }

    if (!visitorId || typeof visitorId !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing visitorId" });
    }

    const cleanVisitorId = String(visitorId).slice(0, 128);
    const timestamp = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();

    const record: Record<string, unknown> = {
      type,
      ts: timestamp,
    };

    if (
      type === "team_click" ||
      type === "favorite" ||
      type === "team_tab" ||
      type === "roster_side" ||
      type === "player_view"
    ) {
      record.team = team ? String(team).slice(0, 64) : "unknown";
      if (teamName) record.teamName = String(teamName).slice(0, 128);
    }

    if (type === "team_click" && (origin === "game_card" || origin === "favorites_bar")) {
      record.origin = origin;
    }

    if (type === "favorite") {
      record.adding = adding === true;
    }

    if (type === "team_tab" && tab) {
      record.tab = String(tab).slice(0, 64);
    }

    if (type === "roster_side" && side) {
      record.side = String(side).slice(0, 64);
    }

    if (type === "player_view") {
      if (player) record.player = String(player).slice(0, 128);
      if (source) record.source = String(source).slice(0, 32);
    }

    if (type === "news_click") {
      record.newsSource = source ? String(source).slice(0, 128) : "unknown";
      if (headline) record.headline = String(headline).slice(0, 200);
      if (placement === "ticker" || placement === "team_news") record.placement = placement;
    }

    if (type === "boxscore_click") {
      if (away) record.away = String(away).slice(0, 64);
      if (home) record.home = String(home).slice(0, 64);
    }

    if (week !== undefined && week !== null && week !== "") {
      record.week = String(week).slice(0, 32);
    }

    if (typeof device === "string" && VALID_DEVICES.has(device)) {
      record.device = device;
    }

    // Local-only display preferences (theme / sportsbook / time zone), sent
    // as a snapshot on every pageview - see readPreference() in
    // js/analytics.js. Capped to a small allowlist-shaped length rather than
    // a fixed enum since SPORTSBOOKS/TIMEZONES are data-driven lists in
    // index.html that can grow without a matching deploy of this function.
    if (type === "pageview") {
      if (typeof theme === "string" && theme) record.theme = theme.slice(0, 32);
      if (typeof sportsbook === "string" && sportsbook) record.sportsbook = sportsbook.slice(0, 64);
      if (typeof timezone === "string" && timezone) record.tzPref = timezone.slice(0, 64);
    }

    const location = extractLocation(context);
    if (location) {
      record.location = location;
    }

    const store = getStore("blitz-analytics");
    const sessionKey = `session:${cleanVisitorId}`;

    let session: SessionRecord | null = null;
    try {
      session = (await store.get(sessionKey, { type: "json" })) as SessionRecord | null;
    } catch {
      session = null;
    }
    if (!session || typeof session !== "object") {
      session = {
        visitorId: cleanVisitorId,
        firstSeen: timestamp,
        lastSeen: timestamp,
        pageviews: 0,
        favoriteTeams: {},
        events: [],
      };
    }

    session.lastSeen = Math.max(session.lastSeen || 0, timestamp);
    session.firstSeen = session.firstSeen ? Math.min(session.firstSeen, timestamp) : timestamp;
    if (record.device) session.device = record.device as string;
    if (record.location) session.location = record.location as Record<string, unknown>;
    if (record.theme) session.theme = record.theme as string;
    if (record.sportsbook) session.sportsbookPref = record.sportsbook as string;
    if (record.tzPref) session.tzPref = record.tzPref as string;
    if (type === "pageview") session.pageviews = (session.pageviews || 0) + 1;
    if (!session.favoriteTeams) session.favoriteTeams = {};
    if (type === "favorite") {
      const favTeam = record.team as string;
      if (favTeam && favTeam !== "unknown") {
        if (record.adding) session.favoriteTeams[favTeam] = true;
        else delete session.favoriteTeams[favTeam];
      }
    }
    if (!Array.isArray(session.events)) session.events = [];
    session.events.push(record);
    if (session.events.length > MAX_EVENTS_PER_SESSION) {
      session.events = session.events.slice(session.events.length - MAX_EVENTS_PER_SESSION);
    }

    const writes: Promise<unknown>[] = [store.setJSON(sessionKey, session)];

    // Secondary indexes - one tiny blob write per dimension this event is
    // relevant to. Skipped for "unknown" values since drilling into "unknown"
    // isn't a useful filter. See storage-model comment above for the key shape.
    function addIndex(dimension: string, value: string | undefined) {
      if (!value || value === "unknown") return;
      writes.push(store.set(indexKey(dimension, value, timestamp, cleanVisitorId), "1"));
    }

    if (type === "pageview") {
      addIndex("device", record.device as string | undefined);
      const loc = record.location as Record<string, unknown> | undefined;
      if (loc && loc.city) {
        const cityLabel = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
        addIndex("city", cityLabel);
      }
      if (loc && loc.country) addIndex("country", loc.country as string);
      // One entry per granularity - the chart can be showing hour/day/month
      // buckets depending on the selected range, and each is its own cheap
      // O(1) write, so there's no need to guess which one will get clicked.
      addIndex("pvHour", hourBucketLabel(timestamp));
      addIndex("pvDay", dayBucketLabel(timestamp));
      addIndex("pvMonth", monthBucketLabel(timestamp));
      addIndex("theme", record.theme as string | undefined);
      addIndex("sportsbook", record.sportsbook as string | undefined);
      addIndex("tzPref", record.tzPref as string | undefined);
    }
    if (type === "team_click") {
      addIndex("teamClick", record.team as string | undefined);
      addIndex("teamClickOrigin", record.origin as string | undefined);
    }
    if (type === "favorite" && record.adding) addIndex("favTeam", record.team as string | undefined);
    if (type === "team_tab" && record.tab === "Roster & Depth Chart") {
      addIndex("rosterTeam", record.team as string | undefined);
    }
    if (type === "roster_side") addIndex("rosterSide", record.side as string | undefined);
    if (type === "player_view") addIndex("player", record.player as string | undefined);
    if (type === "news_click") {
      addIndex("newsSource", record.newsSource as string | undefined);
      addIndex("newsPlacement", record.placement as string | undefined);
    }
    if (type === "boxscore_click") {
      // Indexed under both teams in the matchup, so "who's clicking into
      // DEN box scores" works regardless of whether DEN was home or away.
      addIndex("boxscoreTeam", record.away as string | undefined);
      addIndex("boxscoreTeam", record.home as string | undefined);
    }

    await Promise.all(writes);

    return jsonResponse(200, { ok: true });
  } catch (err) {
    // Never let a malformed/unexpected request take the endpoint down hard;
    // respond with a soft failure the client already treats as fire-and-forget.
    return jsonResponse(200, { ok: false });
  }
};

export const config: Config = {
  path: "/.netlify/functions/track",
};

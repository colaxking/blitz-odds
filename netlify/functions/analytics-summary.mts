import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// How long a precomputed summary stays servable before a request rescans.
//
// The recompute is ~23s against the current store, so this must NOT be tuned
// to "just longer than the dashboard's refresh interval" - that would make
// roughly every other auto-refresh pay the full scan. Instead the TTL is long
// and analytics-cache-warm-background.mts re-warms every source every 5
// minutes, so an interactive request essentially always hits a warm cache.
// STALE_TTL_MS is the backstop: past the fresh window we still serve what we
// have (flagged stale) rather than making someone wait 23s, and only a truly
// ancient or missing cache blocks on a live scan.
const CACHE_TTL_MS = 10 * 60 * 1000;
const STALE_TTL_MS = 60 * 60 * 1000;

type CacheEnvelope = { computedAt: number; ranges: Record<string, unknown>; excludedSessions?: number };

type Range = "24h" | "7d" | "30d" | "3m" | "6m" | "1y" | "all";
const VALID_RANGES = new Set<Range>(["24h", "7d", "30d", "3m", "6m", "1y", "all"]);

// Start of the UTC month that is `n` months before `now`'s month (n=0 -> this
// month's start). Used so "3m"/"6m"/"1y" line up on calendar-month
// boundaries the same way pageviewsByMonth buckets do, rather than a rough
// 90/180/365-day approximation that would straddle a month.
function monthsAgoStart(now: number, n: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1);
}

// Resolves a range key to { cutoff, granularity, bucketCount }. cutoff is
// null for "all" (no lower bound). granularity picks which bucketing
// function/step the series uses; bucketCount is how many buckets to
// zero-fill so empty periods still render instead of being omitted.
function resolveRange(range: Range, now: number, monthsAvailable: number) {
  switch (range) {
    case "24h":
      return { cutoff: now - 24 * HOUR_MS, granularity: "hour" as const, bucketCount: 24 };
    case "7d":
      return { cutoff: now - 7 * DAY_MS, granularity: "day" as const, bucketCount: 7 };
    case "30d":
      return { cutoff: now - 30 * DAY_MS, granularity: "day" as const, bucketCount: 30 };
    case "3m":
      return { cutoff: monthsAgoStart(now, 2), granularity: "month" as const, bucketCount: 3 };
    case "6m":
      return { cutoff: monthsAgoStart(now, 5), granularity: "month" as const, bucketCount: 6 };
    case "1y":
      return { cutoff: monthsAgoStart(now, 11), granularity: "month" as const, bucketCount: 12 };
    case "all":
      return { cutoff: null, granularity: "month" as const, bucketCount: Math.max(monthsAvailable, 1) };
  }
}

type LocationInfo = {
  city?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  regionCode?: string;
  timezone?: string;
  lat?: number;
  lon?: number;
};

type EventRecord = {
  type?: string;
  visitorId?: string;
  ts?: number;
  team?: string;
  teamName?: string;
  adding?: boolean;
  week?: string;
  tab?: string;
  side?: string;
  player?: string;
  source?: string;
  newsSource?: string;
  headline?: string;
  placement?: string;
  origin?: string;
  away?: string;
  home?: string;
  page?: string;
  pathname?: string;
  referrerHost?: string;
  nav?: string;
  filter?: string;
  value?: string;
  location?: LocationInfo;
  device?: string;
  host?: string;
};

type SessionRecord = {
  visitorId?: string;
  theme?: string;
  sportsbookPref?: string;
  tzPref?: string;
  host?: string;
  firstSeen?: number;
  lastSeen?: number;
  pageviews?: number;
  location?: Record<string, unknown>;
  events?: EventRecord[];
};


// ---------------------------------------------------------------------------
// Traffic-source filtering
// ---------------------------------------------------------------------------
// Two independent filters, both applied at read time so nothing is lost at
// ingest and the raw store stays inspectable.
//
// 1. HOST. `record.host` (added in track.mts) says which host actually served
//    a pageview. Anything that isn't a production host is Dan browsing a
//    deploy preview or localhost, not a real visit. Events written before the
//    host field shipped have none; those are treated as production, because
//    discarding all pre-existing history would be far more wrong than keeping
//    a handful of old preview pageviews.
//
// 2. DATACENTER. Some cloud-region cities show an unmistakable crawler
//    signature: every session is exactly one pageview, one event, and never
//    returns. Verified against live data - Ashburn VA, The Dalles OR and
//    Council Bluffs IA are 100% single-hit sessions.
//
//    Crucially this is NOT a plain city denylist. A real person can browse
//    from a city that also hosts a cloud region, and at least one genuinely
//    engaged visitor (60 pageviews, favorites, box scores, roster views, over
//    six days) does exist in a city that looked suspicious on aggregates
//    alone. So a session is only excluded when it is in a datacenter city
//    AND shows the single-hit signature. Anyone who actually used the site is
//    kept regardless of where they appear to be.
const PRODUCTION_HOSTS = new Set(["blitz-odds.com"]);

const DATACENTER_CITIES = new Set([
  "Ashburn",         // AWS us-east-1
  "The Dalles",      // Google us-west1
  "Council Bluffs",  // Google us-central1
  "Boardman",        // AWS us-west-2
  "Columbus",        // AWS us-east-2
  "Des Moines",      // Google
  "Boydton",         // Azure East US 2
  "Quincy",          // Azure West US 2
  "Cheyenne",        // Microsoft/Google
  "Papillion",       // Google
  "Moncks Corner",   // Google us-east1
]);

export type SourceMode = "live" | "live-nodc" | "all";
const VALID_SOURCES = new Set<SourceMode>(["live", "live-nodc", "all"]);

function isProductionSession(s: SessionRecord): boolean {
  // Session-level host is the last host this visitor was seen on. Absent =
  // pre-dates the field = assume production.
  if (!s.host) return true;
  return PRODUCTION_HOSTS.has(s.host);
}

// Single-hit signature: one pageview, one event total, and first/last seen
// within a couple of seconds - i.e. hit one page and never came back.
function isSingleHit(s: SessionRecord): boolean {
  const events = Array.isArray(s.events) ? s.events.length : 0;
  const pv = s.pageviews || 0;
  const span = (s.lastSeen || 0) - (s.firstSeen || 0);
  return events <= 1 && pv <= 1 && span < 5000;
}

function sessionCity(s: SessionRecord): string | null {
  const loc = (s.location || {}) as Record<string, unknown>;
  return typeof loc.city === "string" ? loc.city : null;
}

function isDatacenterNoise(s: SessionRecord): boolean {
  const city = sessionCity(s);
  if (!city || !DATACENTER_CITIES.has(city)) return false;
  return isSingleHit(s);
}

function sessionPassesSource(s: SessionRecord, mode: SourceMode): boolean {
  if (mode === "all") return true;
  if (!isProductionSession(s)) return false;
  if (mode === "live-nodc" && isDatacenterNoise(s)) return false;
  return true;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function hourBucketLabel(ts: number): string {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function dayBucketLabel(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthBucketLabel(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7); // YYYY-MM
}

function buildZeroFilledSeries(
  now: number,
  count: number,
  stepMs: number,
  labelFn: (ts: number) => string
): { bucket: string; count: number }[] {
  const series: { bucket: string; count: number }[] = [];
  // Anchor the most recent bucket to the current period start.
  const currentPeriodStart = Math.floor(now / stepMs) * stepMs;
  for (let i = count - 1; i >= 0; i--) {
    const bucketStart = currentPeriodStart - i * stepMs;
    series.push({ bucket: labelFn(bucketStart), count: 0 });
  }
  return series;
}

function buildZeroFilledMonthSeries(now: number, count: number): { bucket: string; count: number }[] {
  const series: { bucket: string; count: number }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    series.push({ bucket: monthBucketLabel(monthsAgoStart(now, i)), count: 0 });
  }
  return series;
}

// Tallies `keyFn(record)` across `records`, sorted descending, as a plain
// {label: count} object - the shape every bar-list widget on the dashboard
// consumes. Records with no usable key are skipped rather than lumped into
// "unknown", since an absent tab/side/player name means the click handler
// couldn't find a value, not that the value legitimately was "unknown".
// The dashboard renders the top 8 of any bar list, but pageviewsByPath alone
// was shipping 3,750 entries - 312 KB of a 327 KB payload, 95% of it never
// rendered. Everything is capped to a small head; TOP_N is above 8 so a
// client-side filter or a future "show more" still has room.
const TOP_N = 15;

function capTop(obj: Record<string, number>, n = TOP_N): Record<string, number> {
  const out: Record<string, number> = {};
  let i = 0;
  for (const k of Object.keys(obj)) {
    if (i++ >= n) break;
    out[k] = obj[k];
  }
  return out;
}

function sortedCounts(records: EventRecord[], keyFn: (r: EventRecord) => string | undefined): Record<string, number> {
  const map = new Map<string, number>();
  for (const r of records) {
    const key = keyFn(r);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  const sorted = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  const out: Record<string, number> = {};
  for (const [k, v] of sorted) out[k] = v;
  return out;
}

type LocationBucket = {
  label: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  lat?: number;
  lon?: number;
  pageviews: number;
  uniqueVisitors: number;
};

type DeviceBucket = {
  label: string;
  pageviews: number;
  uniqueVisitors: number;
};

function emptySummary(now: number, range: Range) {
  const { granularity, bucketCount } = resolveRange(range, now, 1);
  const points =
    granularity === "hour"
      ? buildZeroFilledSeries(now, bucketCount, HOUR_MS, hourBucketLabel)
      : granularity === "day"
      ? buildZeroFilledSeries(now, bucketCount, DAY_MS, dayBucketLabel)
      : buildZeroFilledMonthSeries(now, bucketCount);
  return {
    range,
    totalPageviews: 0,
    uniqueVisitors: 0,
    series: { granularity, points },
    teamClicksByTeam: {} as Record<string, number>,
    favoritesByTeam: {} as Record<string, number>,
    topFavoriteTeam: null as string | null,
    rosterViewsByTeam: {} as Record<string, number>,
    depthChartSideViews: {} as Record<string, number>,
    injuryPanelOpens: 0,
    injuryPanelOpenRate: null as number | null,
    injuryOpensByTeam: {} as Record<string, number>,
    scheduleGameClicksByTeam: {} as Record<string, number>,
    topViewedPlayers: {} as Record<string, number>,
    newsSourceClicks: {} as Record<string, number>,
    newsClicksByPlacement: {} as Record<string, number>,
    teamClicksByOrigin: {} as Record<string, number>,
    boxscoreClicksByTeam: {} as Record<string, number>,
    boxscoreClicksBySource: {} as Record<string, number>,
    playbookSubtabViews: {} as Record<string, number>,
    playbookFormatViews: {} as Record<string, number>,
    gateCtaClicks: {} as Record<string, number>,
    gateCtaBySurface: {} as Record<string, number>,
    bookCompareOpens: 0,
    historyPageviews: 0,
    historyGameClicksByTeam: {} as Record<string, number>,
    historyClicksByType: {} as Record<string, number>,
    referrerBreakdown: {} as Record<string, number>,
    pageviewsByPath: {} as Record<string, number>,
    teamPageViews: 0,
    gamePageViews: 0,
    themeDistribution: {} as Record<string, number>,
    sportsbookDistribution: {} as Record<string, number>,
    tzPrefDistribution: {} as Record<string, number>,
    viewsByCountry: [] as LocationBucket[],
    viewsByCity: [] as LocationBucket[],
    topLocation: null as string | null,
    viewsByDevice: [] as DeviceBucket[],
    lastUpdated: new Date(now).toISOString(),
  };
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const now = Date.now();

  const url = new URL(req.url);
  const rangeParam = url.searchParams.get("range") || "30d";
  const range: Range = VALID_RANGES.has(rangeParam as Range) ? (rangeParam as Range) : "30d";
  const sourceParam = url.searchParams.get("source") || "live";
  const source: SourceMode = VALID_SOURCES.has(sourceParam as SourceMode) ? (sourceParam as SourceMode) : "live";
  const noCache = url.searchParams.get("fresh") === "1";

  try {
    const store = getStore("blitz-analytics");

    // ---- Cache read -----------------------------------------------------
    // The full-store scan below costs 8-13s, and the dashboard fires it on
    // load, on a 60s timer, on tab focus, and on every range switch. Serve a
    // precomputed blob when one is fresh enough, and only fall through to a
    // rescan when it isn't. `fresh=1` forces a rescan (the Refresh button).
    const cacheKey = `summary:${source}`;
    if (!noCache) {
      try {
        const cached = (await store.get(cacheKey, { type: "json" })) as CacheEnvelope | null;
        if (cached && typeof cached.computedAt === "number" && cached.ranges && cached.ranges[range]) {
          const age = now - cached.computedAt;
          if (age < STALE_TTL_MS) {
            return jsonResponse(200, {
              ...(cached.ranges[range] as Record<string, unknown>),
              cached: true,
              stale: age >= CACHE_TTL_MS,
              computedAt: cached.computedAt,
              ageMs: age,
              excludedSessions: cached.excludedSessions,
              source,
            });
          }
        }
      } catch {
        /* cache miss or malformed envelope - fall through to a live scan */
      }
    }

    // Sessions are now the source of truth (see track.mts): one blob per
    // visitor instead of one per event, so this scan reads roughly
    // events-per-visitor times fewer blobs than the old model, and that
    // ratio only improves as traffic grows. Paginated with a hard cap so a
    // very large visitor base can't run this past the function's time
    // budget - see the note above emptySummary if you hit MAX_SESSION_PAGES
    // in practice; at that point these dashboard-wide aggregates should move
    // to precomputed rolling counters instead of a full scan.
    const MAX_SESSION_PAGES = 40; // ~40 x up-to-1000 = up to ~40k sessions
    const sessionRecords: SessionRecord[] = [];
    let pages = 0;
    for await (const page of store.list({ prefix: "session:", paginate: true })) {
      const pageSessions = await Promise.all(
        page.blobs.map(async (b) => {
          try {
            return await store.get(b.key, { type: "json" });
          } catch {
            return null;
          }
        })
      );
      sessionRecords.push(...pageSessions);
      pages += 1;
      if (pages >= MAX_SESSION_PAGES) break;
    }

    if (sessionRecords.length === 0) {
      return jsonResponse(200, emptySummary(now, range));
    }

    // Drop whole sessions that don't match the requested traffic source
    // before any aggregation runs, so a filtered-out visitor can't leak into
    // unique-visitor counts, location tiles, or preference distributions.
    const sourcedSessions = sessionRecords.filter(
      (s): s is SessionRecord => !!s && typeof s === "object" && sessionPassesSource(s, source)
    );
    const excludedSessions = sessionRecords.length - sourcedSessions.length;

    // Flatten each session's capped event log back into a flat event stream,
    // decorated with the session's visitorId - everything below this point
    // is unchanged from the old per-event-blob model, since it only ever
    // operated on a flat EventRecord[] anyway.
    const allValidRecords: EventRecord[] = [];
    for (const s of sourcedSessions) {
      if (!s || typeof s !== "object" || !Array.isArray(s.events)) continue;
      for (const ev of s.events) {
        if (ev && typeof ev === "object" && typeof ev.ts === "number") {
          allValidRecords.push({ ...ev, visitorId: s.visitorId });
        }
      }
    }

    if (allValidRecords.length === 0) {
      return jsonResponse(200, emptySummary(now, range));
    }

    // How many distinct months of data exist at all - used so "all" zero-fills
    // exactly as many months as there's history for, no more, no less.
    const monthsAvailable = new Set(allValidRecords.map((r) => monthBucketLabel(r.ts!))).size;

    // ---- Compute every range from this one scan -------------------------
    // Reading and flattening the session blobs is the expensive part (8-13s);
    // bucketing the already-in-memory events into a second, third or seventh
    // window costs almost nothing by comparison. Computing all of them here
    // means a range switch on the dashboard is a cache hit rather than
    // another full scan.
    function computeForRange(range: Range) {
      const { cutoff, granularity, bucketCount } = resolveRange(range, now, monthsAvailable);

    // Every widget on the dashboard - KPIs, team clicks, favorites, cities,
    // and the chart - is scoped to this same window, so switching ranges
    // moves the whole page together instead of just the chart.
    const validRecords = cutoff === null ? allValidRecords : allValidRecords.filter((r) => r.ts! >= cutoff);

    const pageviews = validRecords.filter((r) => r.type === "pageview");
    const teamClicks = validRecords.filter((r) => r.type === "team_click");
    // "Favorited" = a star-btn click that was turning a favorite ON. Clicks
    // that removed a favorite are tracked (for completeness) but excluded
    // from the "most favorited team" ranking, since that answers "which
    // team do people add as a favorite most", not net current state.
    const favoriteAdds = validRecords.filter((r) => r.type === "favorite" && r.adding === true);

    const totalPageviews = pageviews.length;

    const uniqueVisitorSet = new Set<string>();
    for (const r of validRecords) {
      if (r.visitorId) uniqueVisitorSet.add(r.visitorId);
    }
    const uniqueVisitors = uniqueVisitorSet.size;

    // --- series: bucketed pageviews at whatever granularity this range
    // calls for (hour/day/month), zero-filled so gaps still render ---
    let seriesPoints: { bucket: string; count: number }[];
    if (granularity === "hour") {
      seriesPoints = buildZeroFilledSeries(now, bucketCount, HOUR_MS, hourBucketLabel);
    } else if (granularity === "day") {
      seriesPoints = buildZeroFilledSeries(now, bucketCount, DAY_MS, dayBucketLabel);
    } else {
      seriesPoints = buildZeroFilledMonthSeries(now, bucketCount);
    }
    const seriesIndex = new Map(seriesPoints.map((entry, idx) => [entry.bucket, idx]));
    const labelFn = granularity === "hour" ? hourBucketLabel : granularity === "day" ? dayBucketLabel : monthBucketLabel;
    for (const pv of pageviews) {
      const label = labelFn(pv.ts!);
      const idx = seriesIndex.get(label);
      if (idx !== undefined) seriesPoints[idx].count += 1;
    }

    // --- teamClicksByTeam: sorted desc ---
    const teamMap = new Map<string, number>();
    for (const tc of teamClicks) {
      const teamKey = tc.team || "unknown";
      teamMap.set(teamKey, (teamMap.get(teamKey) || 0) + 1);
    }
    const sortedTeamEntries = Array.from(teamMap.entries()).sort((a, b) => b[1] - a[1]);
    const teamClicksByTeam: Record<string, number> = {};
    for (const [team, count] of sortedTeamEntries) {
      teamClicksByTeam[team] = count;
    }

    // --- favoritesByTeam: sorted desc, this is "who's the favorite" ---
    const favMap = new Map<string, number>();
    for (const f of favoriteAdds) {
      const teamKey = f.team || "unknown";
      favMap.set(teamKey, (favMap.get(teamKey) || 0) + 1);
    }
    const sortedFavEntries = Array.from(favMap.entries()).sort((a, b) => b[1] - a[1]);
    const favoritesByTeam: Record<string, number> = {};
    for (const [team, count] of sortedFavEntries) {
      favoritesByTeam[team] = count;
    }
    const topFavoriteTeam = sortedFavEntries.length > 0 ? sortedFavEntries[0][0] : null;

    // --- rosterViewsByTeam: how many times each team's "Roster & Depth
    // Chart" tab was opened - which team pages people actually dig into,
    // not just click through to ---
    const rosterTabOpens = validRecords.filter(
      (r) => r.type === "team_tab" && r.tab === "Roster & Depth Chart"
    );
    const rosterViewsByTeam = sortedCounts(rosterTabOpens, (r) => r.team);

    // --- depthChartSideViews: Offense/Defense/Special Teams toggle clicks,
    // aggregated across all teams - which side of the ball people look at ---
    const rosterSideClicks = validRecords.filter((r) => r.type === "roster_side");
    const depthChartSideViews = sortedCounts(rosterSideClicks, (r) => r.side);

    // --- injuryPanelOpens / injuryPanelOpenRate: the team page's injury
    // report is collapsed by default on mobile. Opens is the raw count;
    // the rate is opens as a share of all toggles, which is the number that
    // says whether collapsing it hid something people wanted. A team page
    // with no toggles at all yields null rather than 0, so "nobody opened
    // it" and "nobody was there" don't read the same ---
    const injuryToggles = validRecords.filter((r) => r.type === "team_injury_toggle");
    const injuryPanelOpens = injuryToggles.filter((r) => r.open === true).length;
    const injuryPanelOpenRate =
      injuryToggles.length > 0 ? Math.round((injuryPanelOpens / injuryToggles.length) * 100) : null;
    const injuryOpensByTeam = sortedCounts(
      injuryToggles.filter((r) => r.open === true),
      (r) => r.team
    );

    // --- scheduleGameClicksByTeam: taps on a row of the mobile team
    // schedule, which now links to that matchup's own page. Those pages
    // existed and were in the sitemap but nothing on a team page linked to
    // them, so this is the measure of a new internal path ---
    const scheduleGameClicksByTeam = sortedCounts(
      validRecords.filter((r) => r.type === "team_schedule_game"),
      (r) => r.team
    );

    // --- topViewedPlayers: player-name clicks from either the depth chart
    // or the full roster table, aggregated by player across all teams ---
    const playerViews = validRecords.filter((r) => r.type === "player_view");
    const topViewedPlayers = sortedCounts(playerViews, (r) => r.player);

    // --- newsSourceClicks: which outlet's headlines get clicked, from the
    // scrolling news ticker - an action count, same shape as team clicks ---
    const newsClicks = validRecords.filter((r) => r.type === "news_click");
    const newsSourceClicks = sortedCounts(newsClicks, (r) => r.newsSource);

    // --- newsClicksByPlacement: ticker (week view) vs. Team News panel
    // (per-team page) - two separate surfaces, same event type ---
    const newsClicksByPlacement = sortedCounts(newsClicks, (r) => r.placement);

    // --- Playbook: which of the four sub-screens people open. The redesign
    // split one tab into four and this is the only measure of whether that
    // was worth doing ---
    const playbookSubtabViews = sortedCounts(
      validRecords.filter((r) => r.type === "playbook_subtab"),
      (r) => r.subtab
    );

    // --- playbookFormatViews: which pool format visitors pick on the
    // signed-out preview. The only signal about a visitor's format before
    // they have an account and a league to read it from ---
    const playbookFormatViews = sortedCounts(
      validRecords.filter((r) => r.type === "playbook_format"),
      (r) => r.format
    );

    // --- gateCtaClicks / gateCtaBySurface: the conversion event for the
    // gated surfaces. Split by surface because the sign-in wall on the
    // preview and the Pro gate on What Changed / Betting Angles are asking
    // for different things and will not convert at the same rate ---
    const gateCtas = validRecords.filter((r) => r.type === "gate_cta");
    const gateCtaClicks = sortedCounts(gateCtas, (r) => r.action);
    const gateCtaBySurface = sortedCounts(gateCtas, (r) => r.surface);

    // --- bookCompareOpens: how often anyone opens the per-book price
    // comparison. Worth knowing before any affiliate work is wired to it ---
    const bookCompareOpens = validRecords.filter((r) => r.type === "book_compare").length;

    // --- teamClicksByOrigin: game-card click vs. the favorites-bar
    // quick-nav chip - how much the favorites shortcut actually gets used ---
    const teamClicksByOrigin = sortedCounts(teamClicks, (r) => r.origin);

    // --- boxscoreClicksByTeam: which teams' box scores get opened most -
    // each click carries both teams in the matchup, so both get credited ---
    const boxscoreClicks = validRecords.filter((r) => r.type === "boxscore_click");
    const boxTeamMap = new Map<string, number>();
    for (const r of boxscoreClicks) {
      for (const t of [r.away, r.home]) {
        if (!t) continue;
        boxTeamMap.set(t, (boxTeamMap.get(t) || 0) + 1);
      }
    }
    const boxscoreClicksByTeam: Record<string, number> = {};
    for (const [team, count] of Array.from(boxTeamMap.entries()).sort((a, b) => b[1] - a[1])) {
      boxscoreClicksByTeam[team] = count;
    }

    // --- boxscoreClicksBySource: which entry point opened the box score.
    // "full_details" is the "View Full Box Score" button inside a game
    // card's Full Details panel - the only path from a game card since the
    // redesign. "score_tap" is the older tappable score, which now only
    // exists on the picks/results and team schedule views. Events recorded
    // before track.mts started persisting `source` have none and fall into
    // "unknown", so a lingering "unknown" bar is historical data, not a
    // bug - but note that's every event up to that fix, not just the ones
    // predating the client-side tracking fix. ---
    const boxscoreClicksBySource = sortedCounts(boxscoreClicks, (r) => r.source);

    // --- historical archive: pageviews on /historical/ pages, click
    // breakdown by which archive interaction fired, and which teams'
    // historical games actually get clicked into. `page` for these pages
    // is set by getCurrentPageLabel()'s `.archive-badge` branch (see
    // js/analytics.js), always prefixed "Historical archive: ", so that
    // prefix alone is enough to separate archive pageviews from live-app
    // ones without a separate flag on every pageview event. ---
    const historyPageviews = pageviews.filter(
      (r) => typeof r.page === "string" && r.page.indexOf("Historical archive:") === 0
    ).length;
    const historyGameClicks = validRecords.filter(
      (r) => r.type === "history_game_click" || r.type === "history_team_game_click"
    );
    const historyTeamMap = new Map<string, number>();
    for (const r of historyGameClicks) {
      for (const t of [r.away, r.home]) {
        if (!t) continue;
        historyTeamMap.set(t, (historyTeamMap.get(t) || 0) + 1);
      }
    }
    const historyGameClicksByTeam: Record<string, number> = {};
    for (const [team, count] of Array.from(historyTeamMap.entries()).sort((a, b) => b[1] - a[1])) {
      historyGameClicksByTeam[team] = count;
    }
    const historyClicksByType = sortedCounts(
      validRecords.filter(
        (r) =>
          r.type === "history_nav_click" ||
          r.type === "history_week_select" ||
          r.type === "history_game_click" ||
          r.type === "history_team_game_click"
      ),
      (r) => r.type
    );

    // --- referrerBreakdown: where pageviews came from, by hostname only
    // (never a raw URL/query string - see js/analytics.js's
    // getReferrerHost()). "(direct)" covers no-referrer visits (typed URL,
    // bookmark, most apps); "(internal)" covers in-app navigation that
    // still fires a hard pageview (a static team/game page's <a> links to
    // another team/game page, or back to "/"). ---
    const referrerBreakdown = sortedCounts(pageviews, (r) => r.referrerHost);

    // --- pageviewsByPath / teamPageViews / gamePageViews: now that Phase 3
    // gives team and game pages real URLs, `pathname` on the pageview event
    // is the reliable way to see which specific pages are getting found and
    // visited (via search, a shared link, or in-app navigation) - not just
    // that "a team page" was viewed, but which one. Capped like every other
    // bar-list dimension (dashboard shows top 8), so 353+ distinct URLs
    // doesn't mean an unusably long list, just that the most-viewed pages
    // naturally sort to the top. ---
    const pageviewsByPath = sortedCounts(pageviews, (r) => r.pathname);
    const teamPageViews = pageviews.filter(
      (r) => typeof r.pathname === "string" && r.pathname.indexOf("/teams/") === 0
    ).length;
    const gamePageViews = pageviews.filter(
      (r) => typeof r.pathname === "string" && r.pathname.indexOf("/games/") === 0
    ).length;

    // --- themeDistribution / sportsbookDistribution / tzPrefDistribution:
    // unlike the click-count tiles above, these answer "what are people
    // currently set to", not "how many times did they change it" - so
    // they're built from each session's latest known preference (sent as a
    // snapshot on every pageview, see js/analytics.js's readPreference, so a
    // visitor who never opens Settings still reports their effective
    // default instead of being absent). Only sessions that have visited
    // since this tracking shipped will have a value here; older sessions
    // are skipped rather than assumed to be on any particular default.
    const sessionsInRange = sourcedSessions.filter((s) => {
      if (!Array.isArray(s.events)) return false;
      return s.events.some((ev) => typeof ev.ts === "number" && (cutoff === null || ev.ts >= cutoff));
    });
    function sessionPrefCounts(pick: (s: SessionRecord) => string | undefined): Record<string, number> {
      const map = new Map<string, number>();
      for (const s of sessionsInRange) {
        const key = pick(s);
        if (!key) continue;
        map.set(key, (map.get(key) || 0) + 1);
      }
      const out: Record<string, number> = {};
      for (const [k, v] of Array.from(map.entries()).sort((a, b) => b[1] - a[1])) out[k] = v;
      return out;
    }
    const themeDistribution = sessionPrefCounts((s) => s.theme);
    const sportsbookDistribution = sessionPrefCounts((s) => s.sportsbookPref);
    const tzPrefDistribution = sessionPrefCounts((s) => s.tzPref);

    // --- viewsByCountry / viewsByCity: where unique views are coming from ---
    // Grouped from pageview events that carried a `location` (Netlify's
    // built-in edge geolocation - see track.mts). "Unique" here means
    // distinct visitorIds seen at that location, not raw pageview count.
    type Agg = {
      country?: string;
      countryCode?: string;
      region?: string;
      city?: string;
      lat?: number;
      lon?: number;
      pageviews: number;
      visitors: Set<string>;
    };

    const countryAgg = new Map<string, Agg>();
    const cityAgg = new Map<string, Agg>();

    for (const pv of pageviews) {
      const loc = pv.location;
      if (!loc) continue;

      if (loc.country) {
        const key = loc.country;
        const entry =
          countryAgg.get(key) ||
          ({ country: loc.country, countryCode: loc.countryCode, pageviews: 0, visitors: new Set<string>() } as Agg);
        entry.pageviews += 1;
        if (pv.visitorId) entry.visitors.add(pv.visitorId);
        countryAgg.set(key, entry);
      }

      if (loc.city) {
        const key = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
        const entry =
          cityAgg.get(key) ||
          ({
            country: loc.country,
            countryCode: loc.countryCode,
            region: loc.region,
            city: loc.city,
            lat: loc.lat,
            lon: loc.lon,
            pageviews: 0,
            visitors: new Set<string>(),
          } as Agg);
        entry.pageviews += 1;
        if (pv.visitorId) entry.visitors.add(pv.visitorId);
        cityAgg.set(key, entry);
      }
    }

    function toSortedBuckets(agg: Map<string, Agg>): LocationBucket[] {
      return Array.from(agg.entries())
        .map(([label, v]) => ({
          label,
          country: v.country,
          countryCode: v.countryCode,
          region: v.region,
          city: v.city,
          lat: v.lat,
          lon: v.lon,
          pageviews: v.pageviews,
          uniqueVisitors: v.visitors.size,
        }))
        .sort((a, b) => b.uniqueVisitors - a.uniqueVisitors || b.pageviews - a.pageviews);
    }

    const viewsByCountry = toSortedBuckets(countryAgg);
    const viewsByCity = toSortedBuckets(cityAgg);
    const topLocation = viewsByCity.length > 0 ? viewsByCity[0].label : null;

    // --- viewsByDevice: mobile/tablet/desktop split, from pageview events
    // that carried a `device` (client-side UA sniff - see js/analytics.js).
    // Same "unique = distinct visitorIds" convention as country/city above,
    // scoped to pageviews so it reflects sessions, not every click event.
    const deviceAgg = new Map<string, { pageviews: number; visitors: Set<string> }>();
    for (const pv of pageviews) {
      const key = pv.device || "unknown";
      const entry = deviceAgg.get(key) || { pageviews: 0, visitors: new Set<string>() };
      entry.pageviews += 1;
      if (pv.visitorId) entry.visitors.add(pv.visitorId);
      deviceAgg.set(key, entry);
    }
    const viewsByDevice: DeviceBucket[] = Array.from(deviceAgg.entries())
      .map(([label, v]) => ({ label, pageviews: v.pageviews, uniqueVisitors: v.visitors.size }))
      .sort((a, b) => b.uniqueVisitors - a.uniqueVisitors || b.pageviews - a.pageviews);

      return {
        range,
        totalPageviews,
        uniqueVisitors,
        series: { granularity, points: seriesPoints },
        teamClicksByTeam: capTop(teamClicksByTeam),
        favoritesByTeam,
        topFavoriteTeam,
        rosterViewsByTeam,
        depthChartSideViews,
        injuryPanelOpens,
        injuryPanelOpenRate,
        injuryOpensByTeam: capTop(injuryOpensByTeam),
        scheduleGameClicksByTeam: capTop(scheduleGameClicksByTeam),
        topViewedPlayers: capTop(topViewedPlayers),
        newsSourceClicks,
        newsClicksByPlacement,
        teamClicksByOrigin,
        boxscoreClicksByTeam: capTop(boxscoreClicksByTeam),
        boxscoreClicksBySource,
        playbookSubtabViews,
        playbookFormatViews,
        gateCtaClicks,
        gateCtaBySurface,
        bookCompareOpens,
        historyPageviews,
        historyGameClicksByTeam,
        historyClicksByType,
        referrerBreakdown: capTop(referrerBreakdown),
        pageviewsByPath: capTop(pageviewsByPath),
        teamPageViews,
        gamePageViews,
        themeDistribution,
        sportsbookDistribution,
        tzPrefDistribution,
        viewsByCountry: viewsByCountry.slice(0, TOP_N),
        viewsByCity: viewsByCity.slice(0, TOP_N),
        topLocation,
        viewsByDevice,
        lastUpdated: new Date(now).toISOString(),
      };
    }

    const ranges: Record<string, unknown> = {};
    for (const r of VALID_RANGES) ranges[r] = computeForRange(r);

    // Best-effort cache write - a failure here must not fail the request.
    try {
      await store.setJSON(cacheKey, { computedAt: now, ranges, excludedSessions } as CacheEnvelope);
    } catch {
      /* cache is an optimisation, not a requirement */
    }

    return jsonResponse(200, {
      ...(ranges[range] as Record<string, unknown>),
      cached: false,
      computedAt: now,
      ageMs: 0,
      excludedSessions,
      source,
    });
  } catch (err) {
    // On any unexpected failure, still return a well-formed zeroed structure
    // rather than an error, per spec.
    return jsonResponse(200, emptySummary(now, range));
  }
};

export const config: Config = {
  path: "/.netlify/functions/analytics-summary",
};

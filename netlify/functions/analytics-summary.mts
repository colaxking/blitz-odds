import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
  location?: LocationInfo;
  device?: string;
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
    topViewedPlayers: {} as Record<string, number>,
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

  try {
    const store = getStore("blitz-analytics");
    const { blobs } = await store.list();

    if (!blobs || blobs.length === 0) {
      return jsonResponse(200, emptySummary(now, range));
    }

    const records = await Promise.all(
      blobs.map(async (b) => {
        try {
          const data = await store.get(b.key, { type: "json" });
          return data as EventRecord | null;
        } catch {
          return null;
        }
      })
    );

    const allValidRecords = records.filter(
      (r): r is EventRecord => !!r && typeof r === "object" && typeof r.ts === "number"
    );

    // How many distinct months of data exist at all - used so "all" zero-fills
    // exactly as many months as there's history for, no more, no less.
    const monthsAvailable = new Set(allValidRecords.map((r) => monthBucketLabel(r.ts!))).size;
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

    // --- topViewedPlayers: player-name clicks from either the depth chart
    // or the full roster table, aggregated by player across all teams ---
    const playerViews = validRecords.filter((r) => r.type === "player_view");
    const topViewedPlayers = sortedCounts(playerViews, (r) => r.player);

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

    return jsonResponse(200, {
      range,
      totalPageviews,
      uniqueVisitors,
      series: { granularity, points: seriesPoints },
      teamClicksByTeam,
      favoritesByTeam,
      topFavoriteTeam,
      rosterViewsByTeam,
      depthChartSideViews,
      topViewedPlayers,
      viewsByCountry,
      viewsByCity,
      topLocation,
      viewsByDevice,
      lastUpdated: new Date(now).toISOString(),
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

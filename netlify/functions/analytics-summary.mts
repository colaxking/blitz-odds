import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type EventRecord = {
  type?: string;
  visitorId?: string;
  ts?: number;
  team?: string;
  teamName?: string;
  adding?: boolean;
  week?: string;
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

function emptySummary(now: number) {
  return {
    totalPageviews: 0,
    uniqueVisitors: 0,
    pageviewsByHour: buildZeroFilledSeries(now, 48, HOUR_MS, hourBucketLabel),
    pageviewsByDay: buildZeroFilledSeries(now, 30, DAY_MS, dayBucketLabel),
    pageviewsByMonth: [] as { bucket: string; count: number }[],
    teamClicksByTeam: {} as Record<string, number>,
    favoritesByTeam: {} as Record<string, number>,
    topFavoriteTeam: null as string | null,
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

  try {
    const store = getStore("blitz-analytics");
    const { blobs } = await store.list();

    if (!blobs || blobs.length === 0) {
      return jsonResponse(200, emptySummary(now));
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

    const validRecords = records.filter(
      (r): r is EventRecord => !!r && typeof r === "object" && typeof r.ts === "number"
    );

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

    // --- pageviewsByHour: last 48 hours, zero-filled ---
    const hourSeries = buildZeroFilledSeries(now, 48, HOUR_MS, hourBucketLabel);
    const hourIndex = new Map(hourSeries.map((entry, idx) => [entry.bucket, idx]));
    const hourCutoff = now - 48 * HOUR_MS;
    for (const pv of pageviews) {
      if (pv.ts! >= hourCutoff) {
        const label = hourBucketLabel(pv.ts!);
        const idx = hourIndex.get(label);
        if (idx !== undefined) hourSeries[idx].count += 1;
      }
    }

    // --- pageviewsByDay: last 30 days, zero-filled ---
    const daySeries = buildZeroFilledSeries(now, 30, DAY_MS, dayBucketLabel);
    const dayIndex = new Map(daySeries.map((entry, idx) => [entry.bucket, idx]));
    const dayCutoff = now - 30 * DAY_MS;
    for (const pv of pageviews) {
      if (pv.ts! >= dayCutoff) {
        const label = dayBucketLabel(pv.ts!);
        const idx = dayIndex.get(label);
        if (idx !== undefined) daySeries[idx].count += 1;
      }
    }

    // --- pageviewsByMonth: all time ---
    const monthMap = new Map<string, number>();
    for (const pv of pageviews) {
      const label = monthBucketLabel(pv.ts!);
      monthMap.set(label, (monthMap.get(label) || 0) + 1);
    }
    const monthSeries = Array.from(monthMap.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([bucket, count]) => ({ bucket, count }));

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

    return jsonResponse(200, {
      totalPageviews,
      uniqueVisitors,
      pageviewsByHour: hourSeries,
      pageviewsByDay: daySeries,
      pageviewsByMonth: monthSeries,
      teamClicksByTeam,
      favoritesByTeam,
      topFavoriteTeam,
      lastUpdated: new Date(now).toISOString(),
    });
  } catch (err) {
    // On any unexpected failure, still return a well-formed zeroed structure
    // rather than an error, per spec.
    return jsonResponse(200, emptySummary(now));
  }
};

export const config: Config = {
  path: "/.netlify/functions/analytics-summary",
};

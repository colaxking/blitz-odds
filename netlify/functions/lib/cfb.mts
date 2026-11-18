import { getStore } from "@netlify/blobs";
import { notifStore } from "./notif.mts";

// College football (FBS) on the Games tab - the server-side half.
//
// WHAT LIVES WHERE. The browser reads ESPN's college scoreboard directly, the
// same way the NFL week view already reads the NFL one (it's CORS-open and
// costs us nothing). The server only does the parts a browser can't or
// shouldn't:
//   - team stat ranks: ESPN's by-team endpoint is ~1.3 MB for all 138 FBS
//     teams, so it is ranked once here and cached, not shipped to phones
//   - weather: geocoding ~70 venues and asking Open-Meteo once per week
//   - follows + live alerts: a notification has to fire with no tab open
//
// IDENTITY. College abbreviations are not unique and ESPN's own spellings
// vary between its endpoints ("RUT" on the scoreboard, "RUTG" on team
// schedules), so everything is keyed by ESPN's numeric team and event ids.
//
// ODDS. ESPN's scoreboard carries a DraftKings line on most FBS games, so the
// college slate uses none of the SportsGameOdds quota. Win % shown on cards is
// the market's (vig-removed moneyline, else spread) - there is no college
// Blitz Edge model yet. Copy says "market", never "edge".

export const CFB_SEASON = 2026;
export const CFB_STORE = "blitz-cfb";

const ESPN_HEADERS: Record<string, string> = { "User-Agent": "curl/8.4.0", Accept: "application/json" };

export function scoreboardUrl(opts: { week?: number | null; seasontype?: number | null } = {}): string {
  const p = new URLSearchParams({ groups: "80", limit: "300", dates: String(CFB_SEASON) });
  if (opts.week) p.set("week", String(opts.week));
  if (opts.seasontype) p.set("seasontype", String(opts.seasontype));
  // No week at all = ESPN's idea of the current week, which is what the live
  // alert pass wants. With a week, `dates` pins the season.
  if (!opts.week) p.delete("dates");
  return `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?${p.toString()}`;
}

export async function fetchScoreboard(opts: { week?: number | null; seasontype?: number | null } = {}): Promise<any> {
  const res = await fetch(scoreboardUrl(opts), { headers: ESPN_HEADERS });
  if (!res.ok) throw new Error(`ESPN college scoreboard ${res.status}`);
  return res.json();
}

function num(v: any): number | null {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------------ */
/* Team stat ranks                                                           */
/* ------------------------------------------------------------------------ */

export interface CfbTeamStats {
  id: string;
  /** Who the team is, for lists that need to draw it (Settings' college
   *  favourites). Colours come from ESPN's team list, merged in loadStats. */
  abbr: string;
  name: string;
  short: string;
  color: string | null;
  altColor: string | null;
  gamesPlayed: number;
  offense: { rushYdsPerGame: number | null; passYdsPerGame: number | null; totalYdsPerGame: number | null; pointsPerGame: number | null; rankRush: number; rankPass: number; rankTotal: number; rankPoints: number };
  defense: { rushYdsAllowedPerGame: number | null; passYdsAllowedPerGame: number | null; totalYdsAllowedPerGame: number | null; pointsAllowedPerGame: number | null; rankRush: number; rankPass: number; rankTotal: number; rankPoints: number };
}

export interface CfbStatsDoc {
  season: number;
  fetchedAt: string;
  teamCount: number;
  teams: Record<string, CfbTeamStats>;
}

const STATS_FRESH_MS = 6 * 60 * 60 * 1000;

/** Reads one named value out of ESPN's by-team category block. Each category
 *  carries parallel `names` (from the top-level category list) and `values`
 *  arrays, so the index comes from the shared definition. */
function valueOf(defs: Map<string, string[]>, cats: any[], catName: string, split: "own" | "opp", stat: string, occurrence = 0): number | null {
  const names = defs.get(catName);
  if (!names) return null;
  const block = cats.find((c: any) => c.name === catName && (split === "own" ? String(c.splitId) === "0" : String(c.splitId) === "900"));
  if (!block || !Array.isArray(block.values)) return null;
  let seen = -1;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === stat) {
      seen++;
      if (seen === occurrence) return num(block.values[i]);
    }
  }
  return null;
}

/** 1 = best. Ties share a rank (competition ranking: 1, 2, 2, 4). Teams with
 *  no value rank last. */
function rankBy(ids: string[], value: (id: string) => number | null, higherIsBetter: boolean): Map<string, number> {
  const rows = ids.map((id) => ({ id, v: value(id) }));
  rows.sort((a, b) => {
    if (a.v === null && b.v === null) return 0;
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    return higherIsBetter ? b.v - a.v : a.v - b.v;
  });
  const out = new Map<string, number>();
  let lastV: number | null | undefined;
  let lastRank = 0;
  rows.forEach((r, i) => {
    const rank = r.v !== null && r.v === lastV ? lastRank : i + 1;
    out.set(r.id, rank);
    lastV = r.v;
    lastRank = rank;
  });
  return out;
}

export function buildStatsDoc(json: any): CfbStatsDoc {
  const defs = new Map<string, string[]>();
  for (const c of json?.categories || []) defs.set(c.name, c.names || []);
  const raw = new Map<string, any>();
  for (const row of json?.teams || []) {
    const id = row?.team?.id ? String(row.team.id) : null;
    if (!id) continue;
    const cats = row.categories || [];
    const gp = valueOf(defs, cats, "general", "own", "gamesPlayed") || 0;
    raw.set(id, {
      abbr: String(row.team.abbreviation || ""),
      name: String(row.team.displayName || ""),
      short: String(row.team.shortDisplayName || row.team.nickname || row.team.displayName || ""),
      gp,
      // "yardsPerGame" lives in the passing block on ESPN's by-team feed and
      // is total offense (pass + rush) per game.
      oRush: valueOf(defs, cats, "rushing", "own", "rushingYardsPerGame"),
      oPass: valueOf(defs, cats, "passing", "own", "passingYardsPerGame"),
      oTotal: valueOf(defs, cats, "passing", "own", "yardsPerGame"),
      oPts: valueOf(defs, cats, "passing", "own", "totalPointsPerGame"),
      dRush: valueOf(defs, cats, "rushing", "opp", "rushingYardsPerGame"),
      dPass: valueOf(defs, cats, "passing", "opp", "passingYardsPerGame"),
      dTotal: valueOf(defs, cats, "passing", "opp", "yardsPerGame"),
      dPts: valueOf(defs, cats, "passing", "opp", "totalPointsPerGame"),
    });
  }
  const ids = [...raw.keys()];
  const get = (k: string) => (id: string) => raw.get(id)[k] as number | null;
  const r = {
    oRush: rankBy(ids, get("oRush"), true), oPass: rankBy(ids, get("oPass"), true),
    oTotal: rankBy(ids, get("oTotal"), true), oPts: rankBy(ids, get("oPts"), true),
    dRush: rankBy(ids, get("dRush"), false), dPass: rankBy(ids, get("dPass"), false),
    dTotal: rankBy(ids, get("dTotal"), false), dPts: rankBy(ids, get("dPts"), false),
  };
  const teams: Record<string, CfbTeamStats> = {};
  for (const id of ids) {
    const v = raw.get(id);
    teams[id] = {
      id,
      abbr: v.abbr, name: v.name, short: v.short, color: null, altColor: null,
      gamesPlayed: v.gp,
      offense: {
        rushYdsPerGame: v.oRush, passYdsPerGame: v.oPass, totalYdsPerGame: v.oTotal, pointsPerGame: v.oPts,
        rankRush: r.oRush.get(id)!, rankPass: r.oPass.get(id)!, rankTotal: r.oTotal.get(id)!, rankPoints: r.oPts.get(id)!,
      },
      defense: {
        rushYdsAllowedPerGame: v.dRush, passYdsAllowedPerGame: v.dPass, totalYdsAllowedPerGame: v.dTotal, pointsAllowedPerGame: v.dPts,
        rankRush: r.dRush.get(id)!, rankPass: r.dPass.get(id)!, rankTotal: r.dTotal.get(id)!, rankPoints: r.dPts.get(id)!,
      },
    };
  }
  return { season: CFB_SEASON, fetchedAt: new Date().toISOString(), teamCount: ids.length, teams };
}

export async function loadStats(opts: { force?: boolean } = {}): Promise<CfbStatsDoc> {
  const store = getStore(CFB_STORE, { consistency: "strong" });
  // v2: the doc also carries team names and colours now.
  const key = `stats-v2:${CFB_SEASON}`;
  let cached: CfbStatsDoc | null = null;
  try { cached = (await store.get(key, { type: "json" })) as CfbStatsDoc | null; } catch { cached = null; }
  if (cached && !opts.force && Date.now() - Date.parse(cached.fetchedAt) < STATS_FRESH_MS) return cached;
  try {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/statistics/byteam?region=us&lang=en&contentorigin=espn&limit=200&group=80&season=${CFB_SEASON}&seasontype=2`;
    const res = await fetch(url, { headers: ESPN_HEADERS });
    if (!res.ok) throw new Error(`ESPN by-team stats ${res.status}`);
    const doc = buildStatsDoc(await res.json());
    // Team colours, from ESPN's team list (every division; FBS ids pick out
    // ours). Decoration only - a failure leaves the colours null.
    try {
      const tr = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=1000", { headers: ESPN_HEADERS });
      if (tr.ok) {
        const tj: any = await tr.json();
        for (const w of tj?.sports?.[0]?.leagues?.[0]?.teams || []) {
          const t = w?.team;
          const hit = t?.id ? doc.teams[String(t.id)] : null;
          if (!hit) continue;
          hit.color = t.color ? `#${t.color}` : null;
          hit.altColor = t.alternateColor ? `#${t.alternateColor}` : null;
        }
      }
    } catch { /* colours are optional */ }
    if (doc.teamCount > 0) {
      await store.setJSON(key, doc);
      return doc;
    }
    if (cached) return cached;
    return doc;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

/* ------------------------------------------------------------------------ */
/* Weather                                                                   */
/* ------------------------------------------------------------------------ */

export interface CfbWeather {
  tempF: number | null;
  condition: string | null;
  windMph: number | null;
  precipChance: number | null;
  isDome: boolean;
  source: "forecast" | "dome";
  capturedAt: string;
}

const WEATHER_CODE_MAP: Record<number, string> = {
  0: "clear", 1: "mostly-clear", 2: "partly-cloudy", 3: "overcast",
  45: "fog", 48: "fog", 51: "light-rain", 53: "rain", 55: "heavy-rain",
  61: "light-rain", 63: "rain", 65: "heavy-rain", 71: "light-snow",
  73: "snow", 75: "heavy-snow", 80: "showers", 81: "showers", 82: "heavy-showers",
  95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm",
};

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const WEATHER_FRESH_MS = 60 * 60 * 1000;
/** Open-Meteo's free forecast runs 16 days; a week out is plenty. */
const WEATHER_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

/** Venue -> coordinates, cached forever per ESPN venue id (stadiums don't
 *  move). Open-Meteo's geocoder matches on city name; the state narrows the
 *  several Amhersts and Columbias to the right one. */
async function geocodeVenue(store: any, venueId: string, city: string, state: string): Promise<{ lat: number; lon: number } | null> {
  const key = `geo:${venueId}`;
  try {
    const hit: any = await store.get(key, { type: "json" });
    if (hit && typeof hit.lat === "number") return hit;
    if (hit && hit.miss) return null;
  } catch { /* fall through to a lookup */ }
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=20&country=US&language=en`);
    if (!res.ok) return null;
    const body: any = await res.json();
    const want = STATE_NAMES[String(state).toUpperCase()] || state;
    const results: any[] = body?.results || [];
    const match = results.find((r) => r.admin1 === want) || null;
    if (!match) {
      await store.setJSON(key, { miss: true, city, state });
      return null;
    }
    const out = { lat: match.latitude, lon: match.longitude };
    await store.setJSON(key, out);
    return out;
  } catch {
    return null;
  }
}

export async function loadWeather(week: number, seasontype: number, opts: { force?: boolean } = {}): Promise<{ fetchedAt: string; games: Record<string, CfbWeather> }> {
  const store = getStore(CFB_STORE, { consistency: "strong" });
  const key = `weather:${CFB_SEASON}:${seasontype}:${week}`;
  let cached: any = null;
  try { cached = await store.get(key, { type: "json" }); } catch { cached = null; }
  if (cached && !opts.force && Date.now() - Date.parse(cached.fetchedAt) < WEATHER_FRESH_MS) return cached;

  const sb = await fetchScoreboard({ week, seasontype });
  const now = Date.now();
  const games: Record<string, CfbWeather> = { ...(cached?.games || {}) };
  const targets: { id: string; kick: Date; lat: number; lon: number }[] = [];
  for (const e of sb?.events || []) {
    const comp = e?.competitions?.[0];
    if (!comp) continue;
    const id = String(e.id);
    const st = comp.status?.type?.state;
    // Started or finished: keep whatever we last had (a forecast at kickoff),
    // never overwrite it with today's conditions.
    if (st && st !== "pre") continue;
    const kick = new Date(comp.date || e.date);
    if (!Number.isFinite(kick.getTime()) || kick.getTime() - now > WEATHER_HORIZON_MS) continue;
    const venue = comp.venue || {};
    if (venue.indoor) {
      games[id] = { tempF: null, condition: null, windMph: null, precipChance: null, isDome: true, source: "dome", capturedAt: new Date().toISOString() };
      continue;
    }
    const city = venue.address?.city, state = venue.address?.state;
    if (!venue.id || !city || !state) continue;
    const geo = await geocodeVenue(store, String(venue.id), city, state);
    if (geo) targets.push({ id, kick, lat: geo.lat, lon: geo.lon });
  }

  // One Open-Meteo request per batch: it takes comma-separated coordinates
  // and answers with an array in the same order.
  for (let i = 0; i < targets.length; i += 40) {
    const batch = targets.slice(i, i + 40);
    const params = new URLSearchParams({
      latitude: batch.map((t) => t.lat.toFixed(4)).join(","),
      longitude: batch.map((t) => t.lon.toFixed(4)).join(","),
      hourly: "temperature_2m,precipitation_probability,windspeed_10m,weathercode",
      temperature_unit: "fahrenheit",
      windspeed_unit: "mph",
      timezone: "UTC",
      forecast_days: "10",
    });
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
      if (!res.ok) continue;
      let body: any = await res.json();
      if (!Array.isArray(body)) body = [body];
      batch.forEach((t, j) => {
        const h = body[j]?.hourly;
        if (!h || !Array.isArray(h.time)) return;
        const target = t.kick.toISOString().slice(0, 13);
        let idx = h.time.findIndex((x: string) => x.startsWith(target));
        if (idx === -1) {
          let best = -1, bestDiff = Infinity;
          h.time.forEach((x: string, k: number) => {
            const d = Math.abs(Date.parse(x + ":00Z") - t.kick.getTime());
            if (d < bestDiff) { bestDiff = d; best = k; }
          });
          if (bestDiff > 3 * 3600 * 1000) best = -1;
          idx = best;
        }
        if (idx === -1) return;
        games[t.id] = {
          tempF: Math.round(h.temperature_2m[idx]),
          condition: WEATHER_CODE_MAP[h.weathercode[idx]] || "unknown",
          windMph: Math.round(h.windspeed_10m[idx]),
          precipChance: h.precipitation_probability[idx],
          isDome: false,
          source: "forecast",
          capturedAt: new Date().toISOString(),
        };
      });
    } catch { /* weather is decoration; a failed batch just goes without */ }
  }

  const doc = { fetchedAt: new Date().toISOString(), games };
  try { await store.setJSON(key, doc); } catch { /* serve it anyway */ }
  return doc;
}

/* ------------------------------------------------------------------------ */
/* Follows                                                                   */
/* ------------------------------------------------------------------------ */
//
// Same shape as the NFL follows in lib/follows.mts, in their own key space so
// neither side can ever read the other's ids:
//   cfbfollow:{season}:{week}:{userId} -> { games: string[] (ESPN event ids), updatedAt }

export const CFB_MAX_FOLLOWS_PER_WEEK = 30;

export function cfbFollowKey(week: number, userId: string): string {
  return `cfbfollow:${CFB_SEASON}:${week}:${userId}`;
}
export function cfbFollowWeekPrefix(week: number): string {
  return `cfbfollow:${CFB_SEASON}:${week}:`;
}

export async function getCfbFollows(week: number, userId: string): Promise<string[]> {
  try {
    const doc: any = await notifStore().get(cfbFollowKey(week, userId), { type: "json" });
    return Array.isArray(doc?.games) ? doc.games : [];
  } catch {
    return [];
  }
}

export async function toggleCfbFollow(week: number, userId: string, eventId: string, follow: boolean): Promise<string[]> {
  const current = await getCfbFollows(week, userId);
  const set = new Set(current);
  if (follow) set.add(eventId); else set.delete(eventId);
  const games = [...set].slice(0, CFB_MAX_FOLLOWS_PER_WEEK);
  const store = notifStore();
  if (games.length) await store.setJSON(cfbFollowKey(week, userId), { games, updatedAt: new Date().toISOString() });
  else await store.delete(cfbFollowKey(week, userId));
  return games;
}

export async function loadWeekCfbFollows(week: number): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const store = notifStore();
  const prefix = cfbFollowWeekPrefix(week);
  try {
    for await (const page of store.list({ prefix, paginate: true })) {
      for (const blob of page.blobs) {
        const userId = blob.key.slice(prefix.length);
        if (!userId) continue;
        try {
          const doc: any = await store.get(blob.key, { type: "json" });
          if (Array.isArray(doc?.games) && doc.games.length) out.set(userId, new Set(doc.games));
        } catch { /* one bad record shouldn't cost the others */ }
      }
    }
  } catch { /* nothing followed */ }
  return out;
}

/** Keeps the cheap "is anyone interested" marker the live pass reads first.
 *  Only ever flips on - an occasional wasted ESPN read on a Saturday after
 *  everyone un-stars is cheaper than a full user scan to prove it. */
export async function markCfbAlertInterest(): Promise<void> {
  try {
    const store = getStore(CFB_STORE, { consistency: "strong" });
    const cur: any = await store.get("alerts-interest", { type: "json" });
    if (cur?.any) return;
    await store.setJSON("alerts-interest", { any: true, since: new Date().toISOString() });
  } catch { /* best effort */ }
}

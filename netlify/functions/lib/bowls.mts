import { getStore } from "@netlify/blobs";

// College bowl season: the slate, live scores, results and market lines, all
// from ESPN's public college-football scoreboard.
//
// WHY ESPN AND NOT SPORTSGAMEODDS. ESPN's postseason feed already carries a
// DraftKings line (spread, total, moneylines) on every scheduled game, so the
// bowl slate costs none of the SportsGameOdds quota the NFL odds refresh
// depends on. It's the same unlicensed endpoint the NFL live scores use, with
// the same User-Agent requirement from server IPs.
//
// IDENTITY. College abbreviations are not unique (and ESPN reuses "TBD" for
// every undecided slot), so games are keyed by ESPN's numeric event id and
// teams by ESPN's numeric team id - never by abbreviation. ESPN creates every
// bowl and Playoff event months ahead with TBD teams, so a game's id is stable
// from the day the slate is published through the final whistle, including
// Playoff rounds whose teams aren't known yet.
//
// CACHING. There's no cron. The slate is fetched on demand and cached in
// Blobs; whoever asks after the cache goes stale pays for one ESPN call. The
// cache is short while games are live or about to kick off, long otherwise.
//
// LINES AFTER KICKOFF. ESPN drops a game's odds once it starts. The last
// pre-kickoff line we saw is carried forward so finished games still show
// what the market said. (ATS grading doesn't depend on this - each ATS pick
// snapshots its own line when it's saved, same as the NFL ATS leagues.)

export const BOWL_SEASON = 2026; // the fall season the bowls belong to; ESPN's `dates=` value
export const BOWL_STORE = "blitz-bowls";

const ESPN_URL = (season: number) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?seasontype=3&week=1&groups=80&limit=300&dates=${season}`;

const FRESH_MS_IDLE = 10 * 60 * 1000;   // nothing live or imminent
const FRESH_MS_HOT = 75 * 1000;         // a game is live or kicks off within 20 min
const HOT_WINDOW_MS = 20 * 60 * 1000;

export interface BowlTeam {
  id: string;
  abbr: string;
  name: string;      // "Washington Huskies"
  short: string;     // "Washington"
  color: string | null;
  altColor: string | null;
  record: string | null;
  rank: number | null; // CFP/AP rank, null when unranked
}

export interface BowlOdds {
  favoriteId: string | null; // null for a pick'em line
  spread: number;            // points the favorite gives, >= 0
  details: string | null;    // "WASH -6.5"
  total: number | null;
  homeML: number | null;
  awayML: number | null;
  provider: string | null;
  homeWinProb: number | null; // 0..1, vig-removed moneyline, else from the spread
  asOf: string;
}

export interface BowlGame {
  id: string;
  date: string;              // ISO kickoff
  timeTbd: boolean;
  bowl: string;              // ESPN's note headline, e.g. "Valero Alamo Bowl"
  venue: string | null;
  city: string | null;
  cfp: boolean;
  round: "first" | "quarter" | "semi" | "final" | null;
  state: "pre" | "in" | "post";
  completed: boolean;
  detail: string | null;     // "Final", "Q3 4:12", "12/18 - 8:00 PM EST"
  broadcast: string | null;
  away: BowlTeam | null;     // null = TBD
  home: BowlTeam | null;
  awayScore: number | null;
  homeScore: number | null;
  winnerId: string | null;
  odds: BowlOdds | null;
}

export interface BowlSlate {
  season: number;
  fetchedAt: string;
  games: BowlGame[];
}

function num(v: any): number | null {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function mlToProb(ml: number | null): number | null {
  if (ml === null || ml === 0) return null;
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}

// Standard normal CDF (Abramowitz-Stegun 7.1.26), for the spread fallback.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// College margins are wider than the NFL's; ~15.5 points is the usual
// standard deviation of final margin around the closing spread.
const CFB_MARGIN_SD = 15.5;

export function homeWinProbFrom(odds: { favoriteId: string | null; spread: number; homeML: number | null; awayML: number | null }, homeId: string | null): number | null {
  const ph = mlToProb(odds.homeML), pa = mlToProb(odds.awayML);
  if (ph !== null && pa !== null && ph + pa > 0) return ph / (ph + pa);
  if (!homeId) return null;
  if (!odds.favoriteId || odds.spread === 0) return 0.5;
  const favP = normCdf(odds.spread / CFB_MARGIN_SD);
  return odds.favoriteId === homeId ? favP : 1 - favP;
}

function roundOf(headline: string): BowlGame["round"] {
  const h = headline.toLowerCase();
  if (!h.includes("playoff")) return null;
  if (h.includes("national championship")) return "final";
  if (h.includes("semifinal")) return "semi";
  if (h.includes("quarterfinal")) return "quarter";
  if (h.includes("first round")) return "first";
  return null;
}

function teamOf(c: any): BowlTeam | null {
  const t = c?.team;
  if (!t || !t.id || t.id === "-1" || t.abbreviation === "TBD") return null;
  const rank = num(c?.curatedRank?.current);
  const rec = Array.isArray(c?.records) ? (c.records.find((r: any) => r.type === "total") || c.records[0]) : null;
  return {
    id: String(t.id),
    abbr: String(t.abbreviation || "").slice(0, 6),
    name: t.displayName || t.name || t.abbreviation,
    short: t.shortDisplayName || t.location || t.abbreviation,
    color: t.color ? `#${t.color}` : null,
    altColor: t.alternateColor ? `#${t.alternateColor}` : null,
    record: rec?.summary || null,
    rank: rank !== null && rank >= 1 && rank <= 25 ? rank : null,
  };
}

function oddsOf(comp: any, home: BowlTeam | null, away: BowlTeam | null): BowlOdds | null {
  const o = Array.isArray(comp?.odds) ? comp.odds[0] : null;
  if (!o || (o.spread === undefined && !o.details)) return null;
  const spreadRaw = num(o.spread);
  if (spreadRaw === null) return null;
  let favoriteId: string | null = null;
  if (o.homeTeamOdds?.favorite && home) favoriteId = home.id;
  else if (o.awayTeamOdds?.favorite && away) favoriteId = away.id;
  else if (spreadRaw !== 0 && home && away) favoriteId = spreadRaw < 0 ? home.id : away.id;
  const homeML = num(o.moneyline?.home?.close?.odds ?? o.homeTeamOdds?.moneyLine);
  const awayML = num(o.moneyline?.away?.close?.odds ?? o.awayTeamOdds?.moneyLine);
  const base = {
    favoriteId,
    spread: Math.abs(spreadRaw),
    homeML,
    awayML,
  };
  return {
    ...base,
    details: o.details || null,
    total: num(o.overUnder),
    provider: o.provider?.name || null,
    homeWinProb: homeWinProbFrom(base, home ? home.id : null),
    asOf: new Date().toISOString(),
  };
}

export function normalizeEspn(json: any, season: number, previous: BowlSlate | null): BowlSlate {
  const prevById = new Map<string, BowlGame>((previous?.games || []).map((g) => [g.id, g]));
  const games: BowlGame[] = [];
  for (const e of json?.events || []) {
    const comp = e?.competitions?.[0];
    if (!comp) continue;
    const headline: string = (comp.notes || []).map((n: any) => n?.headline).find(Boolean) || e.name || "Bowl game";
    const hc = (comp.competitors || []).find((c: any) => c.homeAway === "home");
    const ac = (comp.competitors || []).find((c: any) => c.homeAway === "away");
    const home = teamOf(hc), away = teamOf(ac);
    const st = comp.status?.type || e.status?.type || {};
    const state: BowlGame["state"] = st.state === "in" ? "in" : st.state === "post" ? "post" : "pre";
    const started = state !== "pre";
    const prev = prevById.get(String(e.id)) || null;
    let odds = oddsOf(comp, home, away);
    // Carry the last pre-kickoff line forward once ESPN stops sending one -
    // but only while the matchup is the same teams it was quoted for.
    if (!odds && prev?.odds && prev.home?.id === home?.id && prev.away?.id === away?.id) odds = prev.odds;
    if (started && prev?.odds && prev.home?.id === home?.id && prev.away?.id === away?.id) odds = prev.odds;
    const winner = (comp.competitors || []).find((c: any) => c.winner === true);
    const venue = comp.venue || null;
    const round = roundOf(headline);
    games.push({
      id: String(e.id),
      date: comp.date || e.date,
      timeTbd: comp.timeValid === false,
      bowl: headline,
      venue: venue?.fullName || null,
      city: venue?.address ? [venue.address.city, venue.address.state].filter(Boolean).join(", ") || null : null,
      cfp: round !== null,
      round,
      state,
      completed: !!st.completed,
      detail: st.shortDetail || st.detail || null,
      broadcast: comp.broadcast || null,
      away,
      home,
      awayScore: started ? num(ac?.score) : null,
      homeScore: started ? num(hc?.score) : null,
      winnerId: st.completed && winner?.team?.id ? String(winner.team.id) : null,
      odds,
    });
  }
  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
  return { season, fetchedAt: new Date().toISOString(), games };
}

function isHot(slate: BowlSlate, now: number): boolean {
  return slate.games.some((g) => {
    if (g.state === "in") return true;
    if (g.state === "post") return false;
    const t = Date.parse(g.date);
    return Number.isFinite(t) && t - now < HOT_WINDOW_MS && now - t < 6 * 3600 * 1000;
  });
}

/** True once a game can no longer take picks: it has started per ESPN, or its
 *  scheduled kickoff has passed (whichever comes first - ESPN's state can lag
 *  a minute or two behind the actual kickoff). A TBD kickoff time doesn't
 *  lock early: ESPN parks those at 05:00Z on the right day. */
export function isLocked(g: BowlGame, now: number = Date.now()): boolean {
  if (g.state !== "pre") return true;
  if (g.timeTbd) return false;
  const t = Date.parse(g.date);
  return Number.isFinite(t) && now >= t;
}

export async function fetchEspnSlate(season: number): Promise<any> {
  const res = await fetch(ESPN_URL(season), {
    headers: { "User-Agent": "curl/8.4.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}

/** The current slate, from cache when fresh enough, otherwise refetched. On
 *  an ESPN failure the stale cache is served rather than nothing. */
export async function loadSlate(season: number = BOWL_SEASON, opts: { force?: boolean } = {}): Promise<BowlSlate> {
  const store = getStore(BOWL_STORE, { consistency: "strong" });
  const key = `slate:${season}`;
  let cached: BowlSlate | null = null;
  try { cached = (await store.get(key, { type: "json" })) as BowlSlate | null; } catch { cached = null; }
  const now = Date.now();
  if (cached && !opts.force) {
    const age = now - Date.parse(cached.fetchedAt);
    const fresh = isHot(cached, now) ? FRESH_MS_HOT : FRESH_MS_IDLE;
    if (age < fresh) return cached;
  }
  try {
    const json = await fetchEspnSlate(season);
    const slate = normalizeEspn(json, season, cached);
    if (slate.games.length) {
      await store.setJSON(key, slate);
      return slate;
    }
    if (cached) return cached;
    return slate;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

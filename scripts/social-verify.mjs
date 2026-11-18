#!/usr/bin/env node
/**
 * Blitz Odds - social post verification + scheduling (no Claude in the loop).
 *
 * Reads social/queue.json, which holds @RealBlitzOdds posts as *templates*
 * ({{spread:MIA-SF}}, {{biggest:4}}, ...) plus assertions about the lines
 * they depend on. Every run:
 *
 *   1. Pulls the current odds from the live site's own endpoint
 *      (/.netlify/functions/odds-current) - the same numbers the site is
 *      showing - and the kickoff schedule from data/schedule-full-2026.json.
 *   2. For every post due inside the look-ahead window, renders the template
 *      with today's numbers and evaluates its assertions.
 *        - pass                      -> schedule it in Buffer at its dueAt
 *        - fail, fallback passes     -> schedule the fallback copy instead
 *        - fail, no fallback passes  -> leave it unscheduled, notify Dan
 *   3. Re-checks posts it already scheduled but that haven't gone out yet:
 *      re-rendered text is pushed with editPost; a post whose assertions now
 *      fail is deleted from Buffer and Dan is notified. So the Sunday 8 AM
 *      run can pull a post the Saturday 10 PM run scheduled.
 *   4. Warns (by email, once a week) when the Buffer API token is inside
 *      its final 30 days.
 *   5. Writes social/verify-log.json (the workflow commits it).
 *
 * Images (Nov 2026): every templated post that names games gets a matchup
 * card (scripts/social-card.mjs) with both team badges, the line and total,
 * for exactly the games its text names. New or changed cards are committed
 * to social/img/ in one push and attached in Buffer by their
 * raw.githubusercontent.com URL pinned to that commit (Buffer re-fetches at
 * send time, so the URL must never move - a Netlify URL would need a manual
 * publish first). A card that can't be rendered, pushed or accepted by
 * Buffer never blocks the post: it goes out text only and Dan is emailed.
 *
 * College (Nov 2026): weekly slots with "league": "cfb" render against
 * ESPN's FBS scoreboard for their own Eastern day rather than the NFL odds,
 * and talk about the Top 25 slate. See queue.json's weekly._readme.
 *
 * Notifications go through Resend when RESEND_API_KEY is present. When it
 * isn't, any run that has something to report exits non-zero so GitHub's own
 * "workflow failed" email carries the alert instead.
 *
 * Required env vars:
 *   BUFFER_TOKEN        - Buffer API key (Settings > API in Buffer)
 * Optional env vars:
 *   RESEND_API_KEY      - enables email alerts
 *   SITE_BASE           - defaults to https://blitz-odds.com
 *   REPO_ROOT           - defaults to CWD
 *   LOOKAHEAD_HOURS     - schedule posts due within this window (default 26)
 *   NOW                 - ISO timestamp override for testing
 *   DRY_RUN=1           - render + evaluate, print the plan, touch nothing
 */

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { renderCardPng, cardAltText, CARD_VERSION } from "./social-card.mjs";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.com";
const BUFFER_API = "https://api.buffer.com";
const RESEND_API = "https://api.resend.com/emails";
const LOOKAHEAD_HOURS = Number(process.env.LOOKAHEAD_HOURS || 26);
const DRY_RUN = process.env.DRY_RUN === "1";
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();

const QUEUE_PATH = path.join(REPO_ROOT, "social", "queue.json");
const LOG_PATH = path.join(REPO_ROOT, "social", "verify-log.json");
const SCHEDULE_PATH = path.join(REPO_ROOT, "data", "schedule-full-2026.json");

const IMG_DIR_REL = "social/img";
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || "colaxking/blitz-odds";
const ESPN_CFB = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const ESPN_HEADERS = { "User-Agent": "curl/8.4.0", Accept: "application/json" };
const MAX_CARD_GAMES = 6;

const TOKEN_WARN_DAYS = 30;
const TOKEN_WARN_EVERY_DAYS = 7;
const TWEET_MAX = 280;
const TCO_LENGTH = 23; // X counts every URL as 23 chars regardless of length

function log(...args) {
  console.log(NOW.toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (err) {
    if (fallback !== undefined && err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function fetchLiveOdds() {
  const res = await fetch(`${SITE_BASE}/.netlify/functions/odds-current`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`odds-current returned ${res.status}`);
  const doc = await res.json();
  if (!doc || typeof doc.weeks !== "object") throw new Error("odds-current: unexpected shape");
  return doc;
}

function buildWeekContext(week, odds, schedule) {
  const sched = (schedule.weeks || []).find((w) => Number(w.week) === Number(week));
  if (!sched) throw new Error(`No schedule entry for week ${week}`);
  const oddsWeek = (odds?.weeks || {})[String(week)] || { games: {} };
  const games = sched.games.map((g) => {
    const key = `${g.away}-${g.home}`;
    const o = oddsWeek.games?.[key] || null;
    const spread = o && typeof o.spread === "number" ? o.spread : null;
    const kickoff = kickoffOf(g, schedule.season);
    return {
      key,
      away: g.away,
      home: g.home,
      date: g.date || "",
      day: (g.date || "").split(",")[0],
      kickoff,
      started: kickoff !== null && kickoff <= NOW,
      time: g.time || "",
      network: g.network || "",
      favorite: o?.favorite || null,
      spread,
      absSpread: spread === null ? null : Math.abs(spread),
      overUnder: o && typeof o.overUnder === "number" ? o.overUnder : null,
      asOf: o?.asOf || null,
      hasOdds: !!o,
      // For the image card.
      awayT: { league: "nfl", id: g.away, abbr: g.away, name: TEAM_NAMES[g.away] || g.away },
      homeT: { league: "nfl", id: g.home, abbr: g.home, name: TEAM_NAMES[g.home] || g.home },
    };
  });
  const byKey = Object.fromEntries(games.map((g) => [g.key, g]));
  // Week-relative aliases, so a weekly template can say {{line:@MNF}} instead
  // of naming a matchup. The last game on a day is the night game.
  const chrono = [...games].sort((a, b) => (a.kickoff ?? 0) - (b.kickoff ?? 0));
  const lastOn = (day) => chrono.filter((g) => g.day === day).pop();
  const aliases = { "@OPENER": chrono[0], "@TNF": lastOn("Thu"), "@SNF": lastOn("Sun"), "@MNF": lastOn("Mon") };
  for (const [k, g] of Object.entries(aliases)) if (g) byKey[k] = g;
  return { league: "nfl", week, games, byKey };
}

// ---------------------------------------------------------------------------
// College context (ESPN college scoreboard, FBS only)
// ---------------------------------------------------------------------------

// "YYYYMMDD" for the Eastern calendar day of an instant, plus N days.
function nyYmd(ms, plusDays = 0) {
  const off = nyOffsetMinutes(ms);
  const d = new Date(ms + off * 60000 + plusDays * 86400e3);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function nyClock(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}

function nyDow3(ms) {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
}

async function fetchCfbScoreboard(dates) {
  const url = `${ESPN_CFB}/scoreboard?groups=80&limit=400&dates=${dates}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: ESPN_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw new Error(`ESPN college scoreboard (${dates}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const cfbRank = (c) => {
  const r = c?.curatedRank?.current;
  return Number.isInteger(r) && r >= 1 && r <= 25 ? r : null;
};

function cfbTeam(c) {
  const t = c.team || {};
  return {
    league: "cfb",
    id: String(t.id),
    abbr: t.abbreviation || "",
    name: t.shortDisplayName || t.location || t.displayName || t.abbreviation,
    rank: cfbRank(c),
    record: c.records?.[0]?.summary || "",
    color: t.color,
    altColor: t.alternateColor,
  };
}

const cfbLabel = (t) => `${t.rank ? `#${t.rank} ` : ""}${t.name}`;

// One normalised game. away/home/favorite are display strings so the shared
// NFL formatters (fmtLine, fmtOdds, {{matchup}}) read naturally for college.
function cfbGame(e) {
  const comp = e.competitions?.[0] || {};
  const cs = comp.competitors || [];
  const ac = cs.find((c) => c.homeAway === "away") || cs[0];
  const hc = cs.find((c) => c.homeAway === "home") || cs[1];
  const awayT = cfbTeam(ac), homeT = cfbTeam(hc);
  const o = (comp.odds || [])[0] || null;
  let favorite = null, absSpread = null;
  if (o && o.details) {
    if (/^even|pk|pick/i.test(o.details)) { absSpread = 0; }
    else {
      const n = Math.abs(Number(o.spread ?? /-?\d+(\.\d+)?$/.exec(o.details)?.[0]));
      if (Number.isFinite(n)) absSpread = n;
      const favT = o.awayTeamOdds?.favorite ? awayT : o.homeTeamOdds?.favorite ? homeT
        : [awayT, homeT].find((t) => o.details.startsWith(t.abbr + " ")) || null;
      favorite = favT ? favT.name : null;
      if (!favorite) absSpread = null;
    }
  }
  const hasOdds = absSpread !== null;
  const kickoff = new Date(e.date).getTime();
  const ranks = [awayT.rank, homeT.rank].filter(Boolean);
  return {
    key: String(e.id),
    league: "cfb",
    away: cfbLabel(awayT),
    home: cfbLabel(homeT),
    awayT, homeT,
    day: nyDow3(kickoff),
    date: "",
    kickoff,
    started: (e.status?.type?.state || "pre") !== "pre" || kickoff <= NOW.getTime(),
    time: nyClock(kickoff),
    network: comp.broadcasts?.[0]?.names?.[0] || "",
    favorite,
    spread: hasOdds ? -absSpread : null,
    absSpread,
    overUnder: o && typeof o.overUnder === "number" ? o.overUnder : null,
    asOf: hasOdds ? NOW.toISOString() : null, // ESPN serves the current line; there is no older copy
    hasOdds,
    rankedCount: ranks.length,
    rankSum: ranks.length ? ranks.reduce((a, b) => a + b, 0) + (2 - ranks.length) * 30 : 999,
    bestRank: ranks.length ? Math.min(...ranks) : 99,
  };
}

// Games in [dueAt day, dueAt day + windowDays]. ctx.games is the Top 25
// slate (either team ranked) - what the posts talk about - and ctx.allGames
// is every FBS game in the window.
async function buildCfbContext(post) {
  const dueMs = new Date(post.dueAt).getTime();
  const span = Number(post.cfbWindowDays ?? 0);
  const dates = span > 0 ? `${nyYmd(dueMs)}-${nyYmd(dueMs, span)}` : nyYmd(dueMs);
  const doc = await fetchCfbScoreboard(dates);
  const events = doc.events || [];
  const allGames = events.map(cfbGame);
  const games = allGames.filter((g) => g.rankedCount > 0).sort((a, b) => a.kickoff - b.kickoff || a.rankSum - b.rankSum);
  const byKey = Object.fromEntries(allGames.map((g) => [g.key, g]));
  const rankedVsRanked = games.filter((g) => g.rankedCount === 2).sort((a, b) => a.rankSum - b.rankSum);
  const top = rankedVsRanked[0] || [...games].sort((a, b) => a.bestRank - b.bestRank)[0];
  if (top) byKey["@TOP"] = top;
  const postseason = events.some((e) => Number(e.season?.type) === 3);
  return {
    league: "cfb",
    week: Number(doc.week?.number) || null,
    postseason,
    dates,
    games,
    allGames,
    rankedVsRanked,
    byKey,
  };
}

// Ranked teams in danger: a ranked underdog, or a ranked favourite laying
// `maxSpread` or less, against an unranked or lower-ranked opponent.
function upsetWatch(ctx, maxSpread = 3.5) {
  return withOdds(ctx).filter((g) => {
    const fav = g.favorite === g.awayT.name ? g.awayT : g.favorite === g.homeT.name ? g.homeT : null;
    const dog = fav === g.awayT ? g.homeT : fav === g.homeT ? g.awayT : null;
    if (!fav || !dog) return false;
    if (dog.rank && (!fav.rank || dog.rank < fav.rank)) return true;
    return !!fav.rank && (!dog.rank || fav.rank < dog.rank) && g.absSpread <= maxSpread;
  }).sort((a, b) => a.bestRank - b.bestRank);
}

// ---------------------------------------------------------------------------
// Eastern-time helpers
// ---------------------------------------------------------------------------

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// Minutes America/New_York is ahead of UTC at a given instant (-240 EDT, -300 EST).
function nyOffsetMinutes(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

// Wall-clock Eastern time -> epoch ms.
function nyToMs(y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ms = guess - nyOffsetMinutes(guess) * 60000;
  ms = guess - nyOffsetMinutes(ms) * 60000; // settle across a DST edge
  return ms;
}

// Epoch ms -> "2026-10-04T09:07:00-04:00", the dueAt form the queue uses.
function nyIso(ms) {
  const off = nyOffsetMinutes(ms);
  const local = new Date(ms + off * 60000).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

// "Sun, Oct 4" in the 2026 season -> {y, m, d}. January and February belong to the next calendar year.
function seasonDate(dateStr, season) {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(dateStr || "");
  if (!m || !MONTHS[m[1]]) return null;
  const month = MONTHS[m[1]];
  return { y: Number(season) + (month <= 2 ? 1 : 0), m: month, d: Number(m[2]) };
}

// Kickoff in epoch ms. A TBD time counts as 1 PM ET that day, which is when a
// flexed late-season game is earliest likely to start.
function kickoffOf(g, season) {
  const d = seasonDate(g.date, season);
  if (!d) return null;
  const t = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(g.time || "");
  let hh = 13, mm = 0;
  if (t) { hh = (Number(t[1]) % 12) + (/pm/i.test(t[3]) ? 12 : 0); mm = Number(t[2]); }
  return nyToMs(d.y, d.m, d.d, hh, mm);
}

// ---------------------------------------------------------------------------
// Weekly templates -> concrete posts
// ---------------------------------------------------------------------------

// queue.weekly.slots are rendered once per NFL week, so the account keeps
// posting without anyone writing a new batch. Each slot is placed relative
// to that week's Sunday (dayOffset -5 = Tuesday ... +1 = Monday) and rotates
// through its variants by week number so the copy doesn't repeat every week.
// A hand-written entry in queue.posts with the same week and slot wins.
function expandWeekly(queue, schedule, logDoc) {
  const cfg = queue.weekly;
  if (!cfg?.slots?.length) return [];
  const taken = new Set(queue.posts.filter((p) => p.slot).map((p) => `${p.week}:${p.slot}`));
  const out = [];
  for (const w of schedule.weeks || []) {
    const week = Number(w.week);
    if (week < (cfg.startWeek ?? 1) || week > (cfg.endWeek ?? 99)) continue;
    const sunday = w.games.find((g) => (g.date || "").startsWith("Sun"));
    const base = sunday && seasonDate(sunday.date, schedule.season);
    if (!base) continue;
    for (const slot of cfg.slots) {
      if (taken.has(`${week}:${slot.slot}`)) continue;
      if (week < (slot.startWeek ?? 1) || week > (slot.endWeek ?? 99)) continue;
      if (slot.whenDay && !w.games.some((g) => (g.date || "").startsWith(slot.whenDay))) continue;
      const [hh, mm] = slot.time.split(":").map(Number);
      const day = new Date(Date.UTC(base.y, base.m - 1, base.d + slot.dayOffset));
      const dueMs = nyToMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
      const id = `${schedule.season}-w${week}-${slot.slot}`;
      // Only posts that are still ahead, or that an earlier run already touched
      // (so it can be closed out as sent/expired). Keeps past weeks out of the log.
      if (dueMs <= NOW.getTime() && !logDoc.posts[id]) continue;
      const pick = slot.variants[week % slot.variants.length];
      const v = typeof pick === "string" ? { text: pick } : pick;
      out.push({
        id,
        week,
        slot: slot.slot,
        generated: true,
        dueAt: nyIso(dueMs),
        requires: v.requires ?? slot.requires ?? [],
        text: v.text,
        fallback: v.fallback ?? slot.fallback,
        league: slot.league,
        optional: slot.optional,
        cfbWindowDays: slot.cfbWindowDays,
        image: v.image ?? slot.image,
        imageTitle: v.imageTitle ?? slot.imageTitle,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];
const numWord = (n) => NUMBER_WORDS[n] ?? String(n);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function fmtSpread(n) {
  if (n === null || n === undefined) return "?";
  const v = Math.abs(n);
  return `-${Number.isInteger(v) ? v : v}`;
}

function fmtLine(g) {
  if (!g.hasOdds) return `${g.away} at ${g.home} — line not posted`;
  if (g.absSpread === 0) return `${g.away} at ${g.home} — pick'em`;
  return `${g.away} at ${g.home} — ${g.favorite} ${fmtSpread(g.spread)}`;
}

function joinList(items, conj = "and") {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`;
}

// Games still ahead that have a line. A game that has kicked off keeps its
// last pre-game line forever, so it must never count as a stale line (that is
// what blocked the Week 2 Sunday and Monday posts) and must never show up in a
// "biggest spreads" or "closest games" list after it's been played.
function withOdds(ctx) {
  return ctx.games.filter((g) => g.hasOdds && !g.started);
}

// Every game with a line, played or not - for counting how complete a week's board is.
function withOddsAll(ctx) {
  return ctx.games.filter((g) => g.hasOdds);
}

const TEAM_NAMES = {
  ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears",
  CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers",
  HOU: "Texans", IND: "Colts", JAX: "Jaguars", KC: "Chiefs", LAC: "Chargers", LAR: "Rams",
  LV: "Raiders", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants",
  NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SEA: "Seahawks", SF: "49ers", TB: "Buccaneers",
  TEN: "Titans", WAS: "Commanders",
};
const DAY_NAMES = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

function fmtOdds(g) {
  if (g.absSpread === 0) return "pick'em";
  return `${g.favorite} ${fmtSpread(g.spread)}`;
}

function onDay(games, day) {
  return day ? games.filter((g) => g.day.toLowerCase() === day.toLowerCase()) : games;
}

function byBiggest(games) {
  return [...games].sort((a, b) => b.absSpread - a.absSpread || a.key.localeCompare(b.key));
}

function byClosest(games) {
  return [...games].sort((a, b) => a.absSpread - b.absSpread || a.key.localeCompare(b.key));
}

function dowOf(dueAt) {
  return new Date(dueAt).toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

function renderTemplate(text, ctx, post) {
  const missing = [];
  // Every game the text names, in the order it names them - these become
  // the rows of the attached image, so picture and words always agree.
  const used = [];
  const use = (g) => { if (g && !used.includes(g)) used.push(g); return g; };
  const useAll = (gs) => { gs.forEach(use); return gs; };
  const need = (key) => {
    const g = ctx.byKey[key];
    if (!g) throw new Error(`Unknown game ${key} in week ${ctx.week}`);
    if (!g.hasOdds) missing.push(key);
    return use(g);
  };
  const peek = (key) => use(ctx.byKey[key]);

  const out = text.replace(/\{\{([^}]+)\}\}/g, (_, raw) => {
    const [name, ...args] = raw.trim().split(":").map((s) => s.trim());
    switch (name) {
      case "fav": return need(args[0]).favorite ?? "?";
      case "spread": return fmtSpread(need(args[0]).spread);
      case "ou": { const g = need(args[0]); return g.overUnder === null ? "?" : String(g.overUnder); }
      case "away": return peek(args[0])?.away ?? "?";
      case "home": return peek(args[0])?.home ?? "?";
      case "time": return (peek(args[0])?.time ?? "?").replace(/\s*ET$/, " ET");
      case "network": return peek(args[0])?.network ?? "?";
      case "line": return fmtLine(need(args[0]));
      case "biggest": {
        const n = Number(args[0] || 4);
        return useAll(byBiggest(onDay(withOdds(ctx), args[1])).slice(0, n)).map(fmtLine).join("\n");
      }
      case "closest": {
        const n = Number(args[0] || 3);
        return useAll(byClosest(onDay(withOdds(ctx), args[1])).slice(0, n)).map(fmtLine).join("\n");
      }
      case "countGte": {
        const v = Number(args[0]);
        return numWord(withOdds(ctx).filter((g) => g.absSpread >= v).length);
      }
      case "topFavs": {
        const n = Number(args[0] || 2);
        return joinList(useAll(byBiggest(withOdds(ctx)).slice(0, n)).map((g) => g.favorite), args[1] || "or");
      }
      case "maxTotal": {
        const games = onDay(withOdds(ctx), args[0]).filter((g) => g.overUnder !== null);
        if (!games.length) return "?";
        const top = use([...games].sort((a, b) => b.overUnder - a.overUnder)[0]);
        return `${top.away} at ${top.home}, ${top.overUnder}`;
      }
      // College-only placeholders (league "cfb" posts).
      case "ranked": {
        if (ctx.league !== "cfb") throw new Error(`{{ranked}} is college-only (post ${post.id})`);
        const n = Number(args[0] || 3);
        const gs = useAll(ctx.rankedVsRanked.filter((g) => !g.started).slice(0, n));
        gs.filter((g) => !g.hasOdds).forEach((g) => missing.push(g.key));
        return gs.map(fmtLine).join("\n");
      }
      case "rankedCount": {
        if (ctx.league !== "cfb") throw new Error(`{{rankedCount}} is college-only (post ${post.id})`);
        return numWord(ctx.rankedVsRanked.filter((g) => !g.started).length);
      }
      case "upsets": {
        if (ctx.league !== "cfb") throw new Error(`{{upsets}} is college-only (post ${post.id})`);
        const n = Number(args[0] || 3);
        return useAll(upsetWatch(ctx, Number(args[1] || 3.5)).slice(0, n)).map(fmtLine).join("\n");
      }
      case "cfbWeek":
        if (ctx.league !== "cfb") throw new Error(`{{cfbWeek}} is college-only (post ${post.id})`);
        return ctx.postseason ? "Bowl season" : `Week ${ctx.week}`;
      case "slot": {
        // {{slot:4:05 PM ET}} -> "JAX-DEN and LV-LAC" (args re-joined because the time contains ':')
        const t = args.join(":");
        return joinList(onDay(ctx.games, "Sun").filter((g) => g.time === t).map((g) => g.key));
      }
      case "slotCount": {
        const t = args.join(":");
        return cap(numWord(onDay(ctx.games, "Sun").filter((g) => g.time === t).length));
      }
      case "dow": return dowOf(post.dueAt);
      case "week": return String(ctx.week);
      case "weekPlus": return String(ctx.week + Number(args[0] || 1));
      case "matchup": {
        const g = peek(args[0]);
        if (!g) throw new Error(`Unknown game ${args[0]} in week ${ctx.week}`);
        return `${TEAM_NAMES[g.away] || g.away} at ${TEAM_NAMES[g.home] || g.home}`;
      }
      case "odds": return fmtOdds(need(args[0]));
      case "day": {
        const g = ctx.byKey[args[0]];
        if (!g) throw new Error(`Unknown game ${args[0]} in week ${ctx.week}`);
        return DAY_NAMES[g.day] || g.day;
      }
      case "count": return numWord(onDay(ctx.games, args[0]).length);
      case "firstTime": {
        const first = onDay(ctx.games, args[0]).filter((g) => g.kickoff !== null).sort((a, b) => a.kickoff - b.kickoff)[0];
        return first ? first.time.replace(/\s*ET$/, " ET") : "?";
      }
      default: throw new Error(`Unknown placeholder {{${raw}}} in post ${post.id}`);
    }
  });
  return { text: out, missing, games: used };
}

// ---------------------------------------------------------------------------
// Image card
// ---------------------------------------------------------------------------

// Card spec for a rendered post, or null when it names no games (tips,
// feature promos) or opts out with "image": false.
function imageSpecFor(post, ctx, rendered, title) {
  if (post.image === false || !ctx || !rendered.games?.length) return null;
  const games = rendered.games.slice(0, MAX_CARD_GAMES).map((g) => ({
    away: g.awayT,
    home: g.homeT,
    hasLine: g.hasOdds,
    lineText: !g.hasOdds ? "Line not posted" : g.absSpread === 0 ? "Pick'em" : `${g.league === "cfb" ? abbrOfFav(g) : g.favorite} ${fmtSpread(g.spread)}`,
    ouText: g.overUnder !== null && g.hasOdds ? `O/U ${g.overUnder}` : "",
    meta: [g.day, g.time && g.time.replace(/\s*ET$/, " ET"), g.network].filter(Boolean).join(" · "),
  }));
  const dueMs = new Date(post.dueAt).getTime();
  const asOfDay = new Date(dueMs).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
  const cfb = ctx.league === "cfb";
  return {
    kicker: cfb ? `COLLEGE FOOTBALL · ${ctx.postseason ? "BOWL SEASON" : `WEEK ${ctx.week}`}` : `NFL · WEEK ${ctx.week}`,
    title: title || (cfb ? "Top 25 slate" : `Week ${ctx.week} lines`),
    games,
    footer: cfb ? `Lines via ESPN (DraftKings) as of ${asOfDay} · Top 25 ranks via ESPN` : `Consensus lines as of ${asOfDay}`,
  };
}

function abbrOfFav(g) {
  return g.favorite === g.awayT.name ? g.awayT.abbr : g.favorite === g.homeT.name ? g.homeT.abbr : g.favorite;
}

const hashOf = (obj) => createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 10);

function git(...args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

// raw.githubusercontent.com pinned to a commit SHA: public, permanent, and
// live the moment the push lands - no Netlify deploy/publish in the way.
// Buffer fetches the file again when the post goes out, so it must not move.
function rawUrl(sha, rel) {
  return `https://raw.githubusercontent.com/${GITHUB_REPO}/${sha}/${rel}`;
}

async function waitForUrl(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

async function evaluate(requires, ctx, rendered) {
  const failures = [];
  const fail = (msg) => failures.push(msg);

  for (const r of requires || []) {
    const g = r.game ? ctx.byKey[r.game] : null;
    if (r.game && !g) { fail(`${r.kind}: unknown game ${r.game}`); continue; }
    if (r.game && !g.hasOdds && r.kind !== "kickoff") { fail(`${r.kind}: no line posted for ${r.game}`); continue; }

    switch (r.kind) {
      case "fresh": {
        const maxMs = (r.maxAgeHours ?? 48) * 3600e3;
        const stale = withOdds(ctx).filter((x) => !x.asOf || NOW - new Date(x.asOf) > maxMs);
        if (stale.length) fail(`fresh: ${stale.length} line(s) older than ${r.maxAgeHours ?? 48}h (e.g. ${stale[0].key})`);
        break;
      }
      case "weekOdds": {
        const n = withOddsAll(ctx).length;
        const want = r.minShare !== undefined ? Math.ceil(ctx.games.length * r.minShare) : (r.minGames ?? ctx.games.length);
        if (n < want) fail(`weekOdds: only ${n}/${ctx.games.length} games have lines`);
        break;
      }
      case "spreadEq":
        if (g.absSpread !== Number(r.value)) fail(`spreadEq: ${r.game} is ${fmtSpread(g.spread)}, wanted ${fmtSpread(r.value)}`);
        break;
      case "spreadGte":
        if (g.absSpread < Number(r.value)) fail(`spreadGte: ${r.game} is ${fmtSpread(g.spread)}, wanted >= ${r.value}`);
        break;
      case "spreadLte":
        if (g.absSpread > Number(r.value)) fail(`spreadLte: ${r.game} is ${fmtSpread(g.spread)}, wanted <= ${r.value}`);
        break;
      case "favorite":
        if (g.favorite !== r.team) fail(`favorite: ${r.game} favorite is ${g.favorite}, wanted ${r.team}`);
        break;
      case "maxTotal": {
        const pool = onDay(withOdds(ctx), r.day).filter((x) => x.overUnder !== null);
        const top = Math.max(...pool.map((x) => x.overUnder));
        if (g.overUnder !== top) fail(`maxTotal: ${r.game} O/U ${g.overUnder} is not the ${r.day || "week"} high (${top})`);
        break;
      }
      case "countGte": {
        const n = withOdds(ctx).filter((x) => x.absSpread >= Number(r.value)).length;
        if (n < (r.min ?? 1)) fail(`countGte: ${n} game(s) at ${r.value}+, wanted ${r.min}`);
        if (r.max !== undefined && n > r.max) fail(`countGte: ${n} game(s) at ${r.value}+, wanted <= ${r.max}`);
        break;
      }
      case "kickoff":
        if (r.date && g.date !== r.date) fail(`kickoff: ${r.game} date is "${g.date}", wanted "${r.date}"`);
        if (r.time && g.time !== r.time) fail(`kickoff: ${r.game} time is "${g.time}", wanted "${r.time}"`);
        if (r.network && g.network !== r.network) fail(`kickoff: ${r.game} network is "${g.network}", wanted "${r.network}"`);
        break;
      case "dayHasGame":
        if (!onDay(ctx.games, r.day).length) fail(`dayHasGame: no ${r.day} game in week ${ctx.week}`);
        break;
      // College slate size checks. Pair with "optional": true on the slot so a
      // Saturday with no real slate (Army-Navy week, gaps in bowl season)
      // just skips instead of emailing.
      case "minGames": {
        const n = withOdds(ctx).length;
        if (n < Number(r.value)) fail(`minGames: ${n} upcoming game(s) with lines, wanted ${r.value}`);
        break;
      }
      case "minRanked": {
        const n = (ctx.rankedVsRanked || []).filter((x) => !x.started && x.hasOdds).length;
        if (n < Number(r.value)) fail(`minRanked: ${n} ranked-vs-ranked game(s) with lines, wanted ${r.value}`);
        break;
      }
      case "minUpsets": {
        const n = ctx.league === "cfb" ? upsetWatch(ctx, Number(r.maxSpread ?? 3.5)).length : 0;
        if (n < Number(r.value)) fail(`minUpsets: ${n} upset-watch game(s), wanted ${r.value}`);
        break;
      }
      case "siteContains": {
        try {
          const res = await fetch(`${SITE_BASE}${r.path || "/"}`, { headers: { "Cache-Control": "no-cache" } });
          const html = await res.text();
          if (!res.ok || !html.includes(r.needle)) fail(`siteContains: "${r.needle}" not found at ${r.path || "/"} (${res.status})`);
        } catch (err) {
          fail(`siteContains: fetch failed (${err.message})`);
        }
        break;
      }
      default:
        fail(`unknown assertion kind "${r.kind}"`);
    }
  }

  if (rendered.missing.length) fail(`line not posted for ${rendered.missing.join(", ")}`);
  const len = tweetLength(rendered.text);
  if (len > TWEET_MAX) fail(`rendered text is ${len} chars (max ${TWEET_MAX})`);

  return failures;
}

function tweetLength(text) {
  return text.replace(/\bhttps?:\/\/\S+|\b[a-z0-9-]+\.(com|net|org|io|co)\b\S*/gi, "x".repeat(TCO_LENGTH)).length;
}

// ---------------------------------------------------------------------------
// Buffer API
// ---------------------------------------------------------------------------

async function buffer(query, variables) {
  const token = process.env.BUFFER_TOKEN;
  if (!token) throw new Error("BUFFER_TOKEN is missing");
  const res = await fetch(BUFFER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) {
    const msg = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Buffer API: ${msg}`);
  }
  return body.data;
}

// image = { url, altText } or null.
const assetsFor = (image) => (image ? [{ image: { url: image.url, metadata: { altText: image.altText } } }] : []);

async function bufferCreate(channelId, text, dueAtIso, image = null) {
  const input = { channelId, text, dueAt: dueAtIso, mode: "customScheduled", schedulingType: "automatic", source: "blitz-odds social-verify" };
  if (image) input.assets = assetsFor(image);
  const data = await buffer(
    `mutation Create($input: CreatePostInput!) {
       createPost(input: $input) {
         ... on PostActionSuccess { post { id status dueAt } }
         ... on MutationError { message }
       }
     }`,
    { input },
  );
  const r = data.createPost;
  if (!r?.post) throw new Error(`createPost failed: ${r?.message || "unknown"}`);
  return r.post;
}

// image: { url, altText } to set, null to clear, undefined to leave as is.
async function bufferEdit(id, text, image) {
  const input = { id, text };
  if (image !== undefined) input.assets = assetsFor(image);
  const data = await buffer(
    `mutation Edit($input: EditPostInput!) {
       editPost(input: $input) {
         ... on PostActionSuccess { post { id status dueAt } }
         ... on MutationError { message }
       }
     }`,
    { input },
  );
  const r = data.editPost;
  if (!r?.post) throw new Error(`editPost failed: ${r?.message || "unknown"}`);
  return r.post;
}

async function bufferDelete(id) {
  const data = await buffer(
    `mutation Del($input: DeletePostInput!) {
       deletePost(input: $input) {
         ... on DeletePostSuccess { id }
         ... on MutationError { message }
       }
     }`,
    { input: { id } },
  );
  const r = data.deletePost;
  if (!r?.id) throw new Error(`deletePost failed: ${r?.message || "unknown"}`);
}

async function bufferStatus(id) {
  const data = await buffer(
    `query One($input: PostInput!) { post(input: $input) { id status sentAt text } }`,
    { input: { id } },
  );
  return data.post;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function sendEmail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: "Blitz Odds <support@blitz-odds.com>", to: [to], subject, text }),
  });
  if (!res.ok) {
    log(`Resend returned ${res.status}: ${await res.text().catch(() => "")}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const queue = await loadJson(QUEUE_PATH);
  const logDoc = await loadJson(LOG_PATH, { posts: {}, runs: [], lastTokenWarningAt: null });
  const schedule = await loadJson(SCHEDULE_PATH);

  const alerts = [];
  const run = { at: NOW.toISOString(), dryRun: DRY_RUN, actions: [] };
  const act = (a) => { run.actions.push(a); log(a.post ? `[${a.post}]` : "", a.action, a.detail || ""); };

  let odds = null;
  try {
    odds = await fetchLiveOdds();
    log(`Live odds loaded (last full sweep ${odds.lastFullSweepAt || "unknown"})`);
  } catch (err) {
    log(`Could not load live odds: ${err.message}`);
    alerts.push(`Could not load live odds from ${SITE_BASE}: ${err.message}. Data-dependent posts were left untouched.`);
  }

  const ctxCache = new Map();
  const ctxFor = (week) => {
    if (!ctxCache.has(week)) ctxCache.set(week, buildWeekContext(week, odds, schedule));
    return ctxCache.get(week);
  };

  const horizon = new Date(NOW.getTime() + LOOKAHEAD_HOURS * 3600e3);
  const pending = []; // posts to create or edit in Buffer once images are up

  const allPosts = [...queue.posts, ...expandWeekly(queue, schedule, logDoc)]
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

  // The queue ran dry after Week 2 and nobody noticed for a week. If nothing
  // at all is due in the next 7 days, say so (at most once every 3 days).
  const weekAhead = NOW.getTime() + 7 * 86400e3;
  const upcoming = allPosts.filter((p) => { const t = new Date(p.dueAt).getTime(); return t > NOW.getTime() && t <= weekAhead; });
  if (!upcoming.length) {
    const last = logDoc.lastEmptyQueueWarningAt ? new Date(logDoc.lastEmptyQueueWarningAt) : null;
    if (!last || (NOW - last) / 86400e3 >= 3) {
      alerts.push(`Nothing is queued for @RealBlitzOdds in the next 7 days. The weekly templates in social/queue.json cover weeks ${queue.weekly?.startWeek ?? "?"}-${queue.weekly?.endWeek ?? "?"}; add posts or extend them.`);
      logDoc.lastEmptyQueueWarningAt = run.at;
      act({ action: "empty-queue-warning" });
    }
  }

  for (const post of allPosts) {
    const state = logDoc.posts[post.id] || { status: "pending" };
    const dueAt = new Date(post.dueAt);

    if (state.status === "sent" || state.status === "expired") continue;
    if (state.status === "skipped" && new Date(post.dueAt) <= NOW) { logDoc.posts[post.id] = { ...state, status: "expired" }; continue; }

    // Past due: figure out whether it went out, then stop tracking it.
    if (dueAt <= NOW) {
      if (state.bufferPostId && !DRY_RUN) {
        try {
          const p = await bufferStatus(state.bufferPostId);
          state.status = p?.status === "sent" ? "sent" : "expired";
          state.bufferStatus = p?.status;
        } catch (err) {
          state.status = "expired";
          state.note = `status check failed: ${err.message}`;
        }
      } else {
        state.status = state.bufferPostId ? "sent?" : "expired";
      }
      logDoc.posts[post.id] = state;
      act({ post: post.id, action: "closed", detail: state.status });
      continue;
    }

    if (dueAt > horizon) continue; // not yet in the window

    const isCfb = post.league === "cfb";
    const needsData = !isCfb && post.week !== undefined && (/\{\{/.test(post.text) || (post.requires || []).length || post.fallback);
    if (needsData && !odds) {
      act({ post: post.id, action: "skipped", detail: "no live odds" });
      continue;
    }

    // College posts read ESPN's college scoreboard for their own day(s).
    let ctx = null;
    let ctxError = null;
    if (isCfb) {
      try { ctx = await buildCfbContext(post); } catch (err) { ctxError = err; }
      if (ctxError) {
        act({ post: post.id, action: "skipped", detail: ctxError.message });
        alerts.push(`SKIPPED college post "${post.id}" (due ${post.dueAt}) - ${ctxError.message}`);
        continue;
      }
    }
    const getCtx = () => (isCfb ? ctx : ctxFor(post.week));
    const templated = isCfb || post.week !== undefined;

    // Decide which copy to use.
    let chosen = null;
    let reasons = [];
    const candidates = [{ label: "primary", text: post.text, requires: post.requires || [], imageTitle: post.imageTitle }];
    if (post.fallback) candidates.push({ label: "fallback", text: post.fallback.text, requires: post.fallback.requires || [], imageTitle: post.fallback.imageTitle ?? post.imageTitle });

    for (const c of candidates) {
      let rendered, title = null;
      try {
        rendered = templated ? renderTemplate(c.text, getCtx(), post) : { text: c.text, missing: [], games: [] };
        if (templated && c.imageTitle) title = renderTemplate(c.imageTitle, getCtx(), post).text;
      } catch (err) {
        reasons.push(`${c.label}: ${err.message}`);
        continue;
      }
      const failures = templated ? await evaluate(c.requires, getCtx(), rendered) : [];
      if (!templated && tweetLength(rendered.text) > TWEET_MAX) failures.push(`text is ${tweetLength(rendered.text)} chars (max ${TWEET_MAX})`);
      if (!failures.length) {
        chosen = { ...c, text: rendered.text, image: templated && queue.images !== false ? imageSpecFor(post, getCtx(), rendered, title) : null };
        break;
      }
      reasons.push(`${c.label}: ${failures.join("; ")}`);
    }

    const dueIso = dueAt.toISOString();

    if (!chosen) {
      if (state.bufferPostId) {
        // Was scheduled on an earlier run; the world moved. Pull it.
        if (!DRY_RUN) await bufferDelete(state.bufferPostId);
        act({ post: post.id, action: "deleted", detail: reasons.join(" | ") });
        alerts.push(`PULLED "${post.id}" (was scheduled for ${post.dueAt}):\n  ${reasons.join("\n  ")}\n  Last text:\n${indent(state.text)}`);
        logDoc.posts[post.id] = { ...state, status: "blocked", bufferPostId: null, text: null, imageHash: null, imageUrl: null, reasons, lastCheckedAt: run.at };
      } else if (post.optional) {
        // e.g. a college Saturday with no real Top 25 slate - not worth an email.
        act({ post: post.id, action: "skipped", detail: `optional: ${reasons.join(" | ")}` });
        logDoc.posts[post.id] = { ...state, status: "skipped", reasons, lastCheckedAt: run.at };
      } else {
        act({ post: post.id, action: "blocked", detail: reasons.join(" | ") });
        alerts.push(`BLOCKED "${post.id}" (due ${post.dueAt}) - nothing scheduled:\n  ${reasons.join("\n  ")}`);
        logDoc.posts[post.id] = { ...state, status: "blocked", reasons, lastCheckedAt: run.at };
      }
      continue;
    }

    const imageHash = chosen.image ? hashOf({ v: CARD_VERSION, ...chosen.image }) : null;
    const textChanged = state.text !== chosen.text;
    const imageChanged = (state.imageHash ?? null) !== imageHash;
    if (!state.bufferPostId || textChanged || imageChanged) {
      pending.push({ post, state, chosen, reasons, dueIso, imageHash, textChanged, imageChanged });
    } else {
      act({ post: post.id, action: "verified", detail: `${chosen.label} unchanged` });
      logDoc.posts[post.id] = { ...state, lastCheckedAt: run.at };
    }
    if (chosen.label === "fallback" && !post.optional) {
      alerts.push(`FALLBACK used for "${post.id}" (due ${post.dueAt}) - primary failed:\n  ${reasons.join("\n  ")}\n  Scheduled text:\n${indent(chosen.text)}`);
    }
  }

  // Images: render every new/changed card, push them in one commit, and hand
  // Buffer the raw.githubusercontent.com URL pinned to that commit.
  const images = new Map(); // post id -> { url, altText } | null
  const toPush = [];
  for (const p of pending) {
    if (!p.chosen.image) { images.set(p.post.id, null); continue; }
    const altText = cardAltText(p.chosen.image);
    if (!p.imageChanged && p.state.imageUrl) { images.set(p.post.id, { url: p.state.imageUrl, altText }); continue; }
    const rel = `${IMG_DIR_REL}/${p.post.id}-${p.imageHash}.png`;
    try {
      await mkdir(path.join(REPO_ROOT, IMG_DIR_REL), { recursive: true });
      await writeFile(path.join(REPO_ROOT, rel), await renderCardPng(p.chosen.image));
      toPush.push({ p, rel, altText });
      act({ post: p.post.id, action: "image-rendered", detail: rel });
    } catch (err) {
      images.set(p.post.id, null);
      alerts.push(`IMAGE failed for "${p.post.id}" - posting text only: ${err.message}`);
    }
  }
  if (toPush.length) {
    // Drop cards of posts that have gone out or been replaced. Their
    // SHA-pinned URLs keep working from history, so this only keeps the
    // working tree small.
    const keep = new Set(toPush.map((t) => t.rel));
    for (const st of Object.values(logDoc.posts)) {
      if (st.imageUrl && !["sent", "expired", "sent?"].includes(st.status)) keep.add(st.imageUrl.replace(/^.*?\/(social\/img\/[^/]+)$/, "$1"));
    }
    const stale = (await readdir(path.join(REPO_ROOT, IMG_DIR_REL)).catch(() => []))
      .map((f) => `${IMG_DIR_REL}/${f}`).filter((rel) => rel.endsWith(".png") && !keep.has(rel));
    if (!DRY_RUN) for (const rel of stale) await rm(path.join(REPO_ROOT, rel), { force: true });
    if (stale.length) act({ action: "image-prune", detail: `${stale.length} old card(s)` });
    toPush.stalePaths = stale;

    if (DRY_RUN) {
      for (const t of toPush) images.set(t.p.post.id, { url: `file://${path.join(REPO_ROOT, t.rel)}`, altText: t.altText });
    } else {
      try {
        execFileSync("bash", [path.join(REPO_ROOT, "scripts", "commit-and-push.sh"), `Social verify: ${toPush.length} post image(s)`, ...toPush.map((t) => t.rel), ...toPush.stalePaths], { cwd: REPO_ROOT, stdio: "inherit" });
        const sha = git("rev-parse", "HEAD");
        for (const t of toPush) images.set(t.p.post.id, { url: rawUrl(sha, t.rel), altText: t.altText });
        if (!(await waitForUrl(images.get(toPush[0].p.post.id).url))) throw new Error("pushed images not reachable on raw.githubusercontent.com yet");
      } catch (err) {
        for (const t of toPush) images.set(t.p.post.id, null);
        alerts.push(`IMAGES could not be published (${err.message}) - ${toPush.length} post(s) scheduled as text only.`);
      }
    }
  }

  for (const p of pending) {
    const { post, state, chosen, reasons, dueIso, imageHash } = p;
    let image = images.get(post.id) ?? null;
    try {
      if (!state.bufferPostId) {
        let bufferPostId = "dry-run";
        if (!DRY_RUN) {
          try {
            bufferPostId = (await bufferCreate(queue.channelId, chosen.text, dueIso, image)).id;
          } catch (err) {
            if (!image) throw err;
            alerts.push(`IMAGE rejected by Buffer for "${post.id}" - scheduled text only: ${err.message}`);
            image = null;
            bufferPostId = (await bufferCreate(queue.channelId, chosen.text, dueIso, null)).id;
          }
        }
        act({ post: post.id, action: "scheduled", detail: `${chosen.label}${image ? " + image" : ""} for ${post.dueAt}` });
        logDoc.posts[post.id] = { status: "scheduled", variant: chosen.label, bufferPostId, text: chosen.text, imageHash: image ? imageHash : null, imageUrl: image?.url ?? null, dueAt: dueIso, scheduledAt: run.at, lastCheckedAt: run.at, reasons: reasons.length ? reasons : undefined };
      } else {
        if (!DRY_RUN) {
          try {
            await bufferEdit(state.bufferPostId, chosen.text, image);
          } catch (err) {
            if (!image) throw err;
            alerts.push(`IMAGE rejected by Buffer for "${post.id}" - kept text only: ${err.message}`);
            image = null;
            await bufferEdit(state.bufferPostId, chosen.text, null);
          }
        }
        const what = [p.textChanged && "text", p.imageChanged && "image"].filter(Boolean).join(" + ") || "refresh";
        act({ post: post.id, action: "updated", detail: `${chosen.label}; ${what} changed${image ? " + image" : ""}` });
        logDoc.posts[post.id] = { ...state, status: "scheduled", variant: chosen.label, text: chosen.text, imageHash: image ? imageHash : null, imageUrl: image?.url ?? null, updatedAt: run.at, lastCheckedAt: run.at };
      }
    } catch (err) {
      act({ post: post.id, action: "error", detail: err.message });
      alerts.push(`ERROR scheduling "${post.id}" (due ${post.dueAt}): ${err.message}`);
    }
  }

  // Buffer token expiry reminder.
  if (queue.bufferTokenExpires) {
    const exp = new Date(queue.bufferTokenExpires);
    const daysLeft = Math.ceil((exp - NOW) / 86400e3);
    const last = logDoc.lastTokenWarningAt ? new Date(logDoc.lastTokenWarningAt) : null;
    const dueForWarning = !last || (NOW - last) / 86400e3 >= TOKEN_WARN_EVERY_DAYS;
    if (daysLeft <= TOKEN_WARN_DAYS && dueForWarning) {
      alerts.push(
        daysLeft <= 0
          ? `Buffer API token EXPIRED on ${queue.bufferTokenExpires}. Generate a new key at Buffer > Settings > API, update the BUFFER_TOKEN secret in GitHub, and bump bufferTokenExpires in social/queue.json.`
          : `Buffer API token expires in ${daysLeft} day(s) (${queue.bufferTokenExpires}). Generate a new key at Buffer > Settings > API, update the BUFFER_TOKEN secret in GitHub, and bump bufferTokenExpires in social/queue.json.`,
      );
      logDoc.lastTokenWarningAt = run.at;
      act({ action: "token-warning", detail: `${daysLeft} day(s) left` });
    }
  }

  // Notify.
  let exitCode = 0;
  if (alerts.length) {
    const subject = `[Blitz Odds social] ${alerts.length} item(s) need you`;
    const body = alerts.join("\n\n") + `\n\n— social-verify run ${run.at}${DRY_RUN ? " (dry run)" : ""}`;
    const sent = DRY_RUN ? false : await sendEmail(queue.alertEmail, subject, body);
    run.notified = sent ? "email" : "none";
    if (!sent) {
      log("ALERTS (no email sent):\n" + body);
      exitCode = 1; // let GitHub's failed-run email carry it
    }
  }

  run.alerts = alerts;
  logDoc.runs = [...(logDoc.runs || []), run].slice(-60);
  if (!DRY_RUN) await writeFile(LOG_PATH, JSON.stringify(logDoc, null, 2) + "\n");
  else log("DRY RUN - log not written. Would write:\n" + JSON.stringify({ posts: logDoc.posts }, null, 2));

  process.exitCode = exitCode;
}

function indent(s) {
  return String(s ?? "").split("\n").map((l) => "    " + l).join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

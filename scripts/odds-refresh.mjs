#!/usr/bin/env node
/**
 * Blitz Odds - automated odds refresh (no Claude in the loop).
 *
 * Replaces the blitz-odds-odds-refresh Claude scheduled task with a plain
 * Node script meant to run from a GitHub Actions cron job. It is a
 * deterministic port of that task's logic (see the task's SKILL.md history
 * for the reasoning behind each step) - no LLM judgment is needed anywhere
 * in this flow, it's pure fetch/transform/publish.
 *
 * What it does, in order:
 *   1. Acquire a short-lived concurrency lock (netlify/functions/odds-lock)
 *      so overlapping runs can't double-spend the SportsGameOdds quota.
 *   2. Check API usage and skip the fetch only if no account can fund it.
 *      odds-proxy spreads calls across multiple SportsGameOdds accounts
 *      (2,500 objects/month each on the free tier), each on its own
 *      billing cycle, and reports a per-key pace allowance. This run
 *      proceeds if at least one account is under its own curve with real
 *      headroom left - see checkBudget() below.
 *   3. Decide FULL vs NEAR sweep mode (near-term games get checked far more
 *      often than games a month out, since that's where lines actually move).
 *   4. Fetch events from SportsGameOdds via the odds-proxy Netlify function.
 *   5. Map each event to a week using the schedule JSON files in this repo,
 *      build per-bookmaker + default odds, and merge into the live doc.
 *   6. Diff against odds history and append changed lines.
 *   7. Publish the merged docs to odds-update, verify the publish landed,
 *      and write the same docs to data/odds-2026.json / odds-history.json
 *      so the workflow can commit them for a durable on-disk mirror.
 *   8. Release the lock, no matter how the run ended.
 *
 * Required env vars:
 *   ODDS_UPDATE_SECRET   - shared secret for odds-lock / odds-update
 * Optional env vars:
 *   SITE_BASE            - defaults to https://blitz-odds.com
 *   ANCHOR_DAY           - day-of-month the quota resets on, used ONLY by the
 *                           pooled fallback below (when odds-proxy is an older
 *                           build that doesn't report per-key pacing). Real
 *                           per-key reset dates come from the proxy; override
 *                           those with SPORTSGAMEODDS_API_KEY_{n}_ANCHOR_DAY
 *                           in the Netlify env, not here.
 *   REPO_ROOT            - defaults to CWD; where data/*.json live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.com";
const ODDS_UPDATE_SECRET = process.env.ODDS_UPDATE_SECRET;
const REPO_ROOT = process.env.REPO_ROOT || process.cwd();

// Fallback pacing anchor only. ANCHOR_YEAR/ANCHOR_MONTH used to sit here
// too and were never read by anything - the cycle repeats monthly, so only
// the day-of-month ever mattered. Removed rather than left to imply the
// billing cycle is pinned to a specific month.
const ANCHOR_DAY = Number(process.env.ANCHOR_DAY || 31);

const BOOKMAKERS = ["draftkings", "fanduel", "betmgm", "caesars"];
const NEAR_WINDOW_DAYS = 10;
const FULL_SWEEP_STALE_HOURS = 20;
// Fallback only - used if odds-proxy's usage response doesn't report a
// totalCap (e.g. still running the old single-key build). Once the
// multi-key proxy is live, the real cap comes from that response instead.
const MONTHLY_BUDGET = 2500;
// Don't start a fetch with less than this much real headroom left in the
// pool. A NEAR sweep costs roughly one object per upcoming game (tens); a
// FULL sweep costs the whole remaining slate (low hundreds). Below this,
// a run can only half-complete - burning quota and writing partial odds -
// so it's better to skip and wait for the next reset.
const MIN_REMAINING_RESERVE = 75;
// Per-key floor for the same reason, applied by odds-proxy when it marks a
// key spendable. Mirrored here only so the log line can explain a skip.
const MIN_KEY_HEADROOM = 60;

const TEAM_MAP = {
  "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
  "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
  "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
  "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
  "Kansas City Chiefs": "KC", "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LAR",
  "Las Vegas Raiders": "LV", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
  "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
  "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
  "Seattle Seahawks": "SEA", "San Francisco 49ers": "SF", "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(relPath) {
  const full = path.join(REPO_ROOT, relPath);
  return JSON.parse(await readFile(full, "utf8"));
}

async function writeJson(relPath, data) {
  const full = path.join(REPO_ROOT, relPath);
  await writeFile(full, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Lock

async function acquireLock(runId) {
  const res = await fetch(`${SITE_BASE}/.netlify/functions/odds-lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-odds-update-secret": ODDS_UPDATE_SECRET },
    body: JSON.stringify({ runId }),
  });
  if (res.status === 404) {
    log("odds-lock function not deployed yet - proceeding without a lock this run.");
    return { held: false, deployed: false };
  }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    log(`skipped - another run already holds the lock (holder ${body.holder}, age ${body.ageSeconds}s)`);
    return { held: false, deployed: true, blocked: true };
  }
  if (!res.ok) {
    throw new Error(`odds-lock acquire failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return { held: true, deployed: true };
}

async function releaseLock(runId) {
  try {
    await fetch(`${SITE_BASE}/.netlify/functions/odds-lock`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-odds-update-secret": ODDS_UPDATE_SECRET },
      body: JSON.stringify({ runId }),
    });
  } catch (err) {
    log("warning: lock release failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Budget pacing

function daysInMonth(year, month0) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

// Fallback only - used when odds-proxy is an older build with no per-key
// pacing in its usage response. Assumes every account shares one anchor
// day, which is exactly the assumption the per-key path exists to drop.
function cycleBounds(ref) {
  let y = ref.getUTCFullYear();
  let m = ref.getUTCMonth(); // 0-indexed
  const clampedDay = (yy, mm) => Math.min(ANCHOR_DAY, daysInMonth(yy, mm));
  let start = new Date(Date.UTC(y, m, clampedDay(y, m)));
  if (start > ref) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
    start = new Date(Date.UTC(y, m, clampedDay(y, m)));
  }
  let ny = y, nm = m + 1;
  if (nm > 11) { nm = 0; ny += 1; }
  const end = new Date(Date.UTC(ny, nm, clampedDay(ny, nm)));
  return { start, end };
}

function describeKeyLine(k) {
  const usage = typeof k.usage === "number" ? k.usage : "?";
  const pct = typeof k.cycleElapsed === "number" ? `${(k.cycleElapsed * 100).toFixed(1)}%` : "?";
  const resets = typeof k.cycleEnd === "string" ? k.cycleEnd.slice(0, 10) : "?";
  // Where this key's reset day came from: the vendor's own interval end
  // time, an env override, a day actually observed by watching usage drop,
  // or the fallback default. Worth showing on every line - a key still on
  // "default" is one whose real reset day nothing has pinned down yet.
  const source = k.cycleSource === "vendor"
    ? " reset from vendor"
    : ` anchor ${k.anchorDay} (${k.anchorSource || "default"}${k.resetsObserved ? `, ${k.resetsObserved} reset(s) seen` : ""})`;
  const conflict = k.anchorConflict
    ? ` [override ${k.anchorConflict.env} disagrees with observed ${k.anchorConflict.learned}]`
    : "";
  // A store outage is a warning, not a verdict - a key stays perfectly
  // spendable while it's happening, it just stops learning.
  const notLearning = k.observed === false ? " [observation store unavailable - not learning]" : "";
  let verdict;
  if (typeof k.usage !== "number") verdict = "usage lookup failed";
  else if (k.spendable) verdict = "SPENDABLE";
  else if (k.underPace === false) verdict = "ahead of its own pace";
  else verdict = `headroom below ${MIN_KEY_HEADROOM}`;
  return `budget:   ${k.label} ${k.email} ${usage}/${k.cap} pace<=${k.paceAllowance} rem=${k.remaining ?? "?"} cycle ${pct} resets ${resets}${source}${conflict} -> ${verdict}${notLearning}`;
}

async function checkBudget() {
  const res = await fetch(`${SITE_BASE}/.netlify/functions/odds-proxy?endpoint=usage`);
  if (!res.ok) {
    log("warning: usage check failed, proceeding cautiously this run:", res.status);
    return { proceed: true, usage: null };
  }
  const body = await res.json().catch(() => null);
  const data = body?.data;
  // odds-proxy reports combined usage/cap across every SportsGameOdds key
  // it's configured with (data.totalUsage / data.totalCap). Fall back to
  // the older single-key shape (data.rateLimits...) plus the hardcoded
  // MONTHLY_BUDGET if that's all the proxy has deployed.
  const usage = data?.totalUsage ?? data?.rateLimits?.["per-month"]?.["current-entities"];
  const cap = data?.totalCap ?? MONTHLY_BUDGET;
  const remaining = data?.totalRemaining;
  if (typeof usage !== "number") {
    log("warning: could not parse usage from response, proceeding cautiously this run.", JSON.stringify(body).slice(0, 300));
    return { proceed: true, usage: null };
  }

  // Hard floor, checked before any pace curve. totalRemaining is the real
  // spendable headroom across every account with a known usage number
  // (exhausted accounts contribute 0). A pace allowance alone can green-
  // light a run late in a cycle when the pool is nearly dry - the ratio
  // says "you're under budget for day 29" while there are only a few dozen
  // objects actually left. A part-paid FULL sweep spends quota and still
  // writes incomplete odds, so refuse outright rather than start one we
  // can't finish. Older proxy builds don't report totalRemaining; skip
  // this check rather than guessing when it's absent.
  if (typeof remaining === "number" && remaining < MIN_REMAINING_RESERVE) {
    log(`budget: only ${remaining} objects left in the pool (reserve ${MIN_REMAINING_RESERVE}) - skipping fetch this run.`);
    return { proceed: false, reason: "reserve", usage, remaining };
  }

  // Preferred path: every account paced against its own billing cycle.
  // The accounts were signed up on different days and reset on different
  // days, so a single pooled ratio was comparing this month's spend
  // against a cycle position that was wrong for three keys out of four -
  // and skipping runs the pool could easily afford. A run only needs ONE
  // account under its own curve with real headroom; odds-proxy ranks by
  // pace ratio, so that's the account the fetch will land on anyway.
  const perKey = Array.isArray(data?.perKey) ? data.perKey : [];
  const paced = perKey.filter((k) => typeof k.paceAllowance === "number");
  if (paced.length) {
    const spendable = paced.filter((k) => k.spendable);
    const learned = data?.keysWithLearnedAnchor;
    const awaiting = data?.keysAwaitingFirstReset;
    const cycleNote = [
      typeof learned === "number" && learned > 0 ? `${learned} with a learned reset day` : null,
      typeof awaiting === "number" && awaiting > 0 ? `${awaiting} still awaiting a first observed reset` : null,
    ].filter(Boolean).join(", ");
    log(`budget: pool ${usage}/${cap}, ${remaining ?? "?"} left, ${paced.length} account(s) reporting${cycleNote ? ` - ${cycleNote}` : ""}`);
    for (const k of perKey) log(describeKeyLine(k));
    if (spendable.length === 0) {
      return { proceed: false, reason: "per-key-pace", usage, remaining, nextResetAt: data?.nextResetAt ?? null };
    }
    log(`budget: ${spendable.length} of ${paced.length} account(s) spendable (${spendable.map((k) => k.label).join(", ")}) - proceeding.`);
    return { proceed: true, usage, remaining, spendable: spendable.length };
  }

  // Fallback: older odds-proxy build with no per-key pacing. Pool the cap
  // against one shared anchor day and accept that it's approximate.
  const now = new Date();
  const { start, end } = cycleBounds(now);
  const daysInCycle = Math.round((end - start) / 86400000);
  const dayOfCycle = Math.floor((now - start) / 86400000) + 1;
  const paceAllowance = cap * (dayOfCycle / daysInCycle) * 0.95;

  const accountCount = perKey.length;
  const knownCount = data?.keysWithKnownUsage;
  const accountNote = accountCount
    ? ` (${accountCount} accounts${typeof knownCount === "number" && knownCount !== accountCount ? `, ${knownCount} reporting` : ""})`
    : "";
  log(`budget: pooled fallback - usage=${usage} cap=${cap}${accountNote}${typeof remaining === "number" ? ` remaining=${remaining}` : ""} paceAllowance=${paceAllowance.toFixed(1)} dayOfCycle=${dayOfCycle}/${daysInCycle}`);

  if (usage >= paceAllowance) {
    return { proceed: false, reason: "pooled-pace", usage, paceAllowance };
  }
  return { proceed: true, usage, paceAllowance };
}

// ---------------------------------------------------------------------------
// Fetch odds-current / odds-update

// `strong` asks odds-current for a strongly consistent Blobs read. Only the
// post-publish verification needs it - the two reads at the top of a run are
// happy with whatever the store last settled on, and the strong path is the
// slower/more expensive one, so it stays opt-in on both sides.
async function getOddsCurrent(type, { strong = false } = {}) {
  const qs = type === "history" ? "?type=history" : "";
  const res = await fetch(`${SITE_BASE}/.netlify/functions/odds-current${qs}`, {
    cache: "no-store",
    ...(strong ? { headers: { "x-odds-update-secret": ODDS_UPDATE_SECRET } } : {}),
  });
  if (!res.ok) throw new Error(`odds-current${qs} failed: ${res.status}`);
  return res.json();
}

// Netlify Blobs is eventually consistent by default and can lag a write by
// 15-20 seconds. The original verification read back with a default read
// roughly a second after publishing, saw the pre-write document, and threw -
// failing every FULL sweep run even though the publish had landed correctly.
// The read is strongly consistent now, so one attempt should be enough; the
// retries only cover a transient hiccup on the read path itself.
const VERIFY_ATTEMPTS = 3;
const VERIFY_BACKOFF_MS = 3000;

async function verifyPublish(expectedFullSweepAt) {
  let lastSeen = null;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(VERIFY_BACKOFF_MS);
    let verify;
    try {
      verify = await getOddsCurrent(undefined, { strong: true });
    } catch (err) {
      log(`verify attempt ${attempt}/${VERIFY_ATTEMPTS}: read-back failed: ${err.message}`);
      continue;
    }
    lastSeen = verify.lastFullSweepAt ?? null;
    if (lastSeen === expectedFullSweepAt) {
      log(`verified: publish landed${attempt > 1 ? ` (attempt ${attempt})` : ""}.`);
      return;
    }
    log(`verify attempt ${attempt}/${VERIFY_ATTEMPTS}: live store still shows ${lastSeen ?? "no lastFullSweepAt"}.`);
  }
  throw new Error(
    `verification failed: lastFullSweepAt did not land on the live store (expected ${expectedFullSweepAt}, saw ${lastSeen ?? "none"}).`
  );
}

async function fetchEventsPage(params, attempt = 1) {
  const url = `${SITE_BASE}/.netlify/functions/odds-proxy?endpoint=events&${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (body && body.success === false && /rate limit/i.test(body.error || "") && attempt <= 5) {
    // odds-proxy already rotates across every configured SportsGameOdds
    // key before returning an error, so a rate limit reaching us here
    // means every account hit the vendor's per-minute limit at once.
    // Linear backoff up to 60s gives that a chance to clear.
    const backoffMs = Math.min(15000 * attempt, 60000);
    log(`rate limited, backing off ${backoffMs}ms (attempt ${attempt})...`);
    await sleep(backoffMs);
    return fetchEventsPage(params, attempt + 1);
  }
  if (!res.ok || !body || body.success === false) {
    throw new Error(`odds-proxy events failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

async function fetchAllEvents({ startsAfter, startsBefore }) {
  const events = [];
  let cursor;
  let pageNum = 0;
  do {
    if (pageNum > 0) {
      // Throttle between pages so a FULL sweep's back-to-back pagination
      // doesn't itself burst past the vendor's per-minute rate limit.
      await sleep(1500);
    }
    pageNum += 1;
    const params = new URLSearchParams({
      leagueID: "NFL",
      oddsAvailable: "true",
      bookmakerID: BOOKMAKERS.join(","),
      startsAfter,
    });
    if (startsBefore) params.set("startsBefore", startsBefore);
    if (cursor) params.set("cursor", cursor);
    const page = await fetchEventsPage(params);
    events.push(...(page.data || []));
    cursor = page.nextCursor || null;
  } while (cursor);
  return events;
}

// ---------------------------------------------------------------------------
// Schedule lookup

function parseScheduleDate(dateStr, timeStr, seasonYear) {
  // dateStr like "Wed, Sep 9" or "Sun, Jan 4"; best-effort, used only to
  // disambiguate rare cross-listed matchups (e.g. a team in both the
  // preseason and regular-season files). Not exact-time precision.
  const m = /([A-Za-z]{3})\s+(\d{1,2})/.exec(dateStr || "");
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = months[m[1]];
  if (month === undefined) return null;
  const day = Number(m[2]);
  // Jan/Feb games belong to the following calendar year in a season that
  // starts in September.
  const year = month <= 1 ? seasonYear + 1 : seasonYear;
  return new Date(Date.UTC(year, month, day));
}

async function buildScheduleIndex(seasonYear) {
  const [preseason, full, playoffs] = await Promise.all([
    readJson("data/schedule-preseason-2026.json").catch(() => null),
    readJson("data/schedule-full-2026.json"),
    readJson("data/schedule-playoffs-2026.json").catch(() => null),
  ]);

  // key "AWAY-HOME" -> array of { week, date: Date|null }
  const index = new Map();
  const add = (away, home, week, dateStr, timeStr) => {
    const key = `${away}-${home}`;
    const date = parseScheduleDate(dateStr, timeStr, seasonYear);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ week, date });
  };

  if (preseason?.rounds) {
    for (const round of preseason.rounds) {
      for (const g of round.games || []) add(g.away, g.home, round.week, g.date, g.time);
    }
  }
  if (full?.weeks) {
    for (const wk of full.weeks) {
      for (const g of wk.games || []) add(g.away, g.home, wk.week, g.date, g.time);
    }
  }
  if (playoffs?.rounds) {
    for (const round of playoffs.rounds) {
      for (const g of round.games || []) add(g.away, g.home, round.week, g.date, g.time);
    }
  }
  return index;
}

function resolveWeek(scheduleIndex, away, home, startsAt) {
  const candidates = scheduleIndex.get(`${away}-${home}`);
  if (!candidates || candidates.length === 0) return { week: null, ambiguous: false };
  if (candidates.length === 1) return { week: candidates[0].week, ambiguous: false };
  // Ambiguous (same pair appears in more than one schedule file) - pick the
  // candidate whose date is closest to the event's actual kickoff time.
  const eventDate = startsAt ? new Date(startsAt) : null;
  if (!eventDate) return { week: candidates[0].week, ambiguous: true };
  let best = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    if (!c.date) continue;
    const diff = Math.abs(c.date.getTime() - eventDate.getTime());
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return { week: best.week, ambiguous: false };
}

// ---------------------------------------------------------------------------
// Event -> odds entry

function extractLine(oddsObj, statEntityID, betTypeID, sideID) {
  for (const entry of Object.values(oddsObj || {})) {
    if (entry.statID === "points" && entry.periodID === "game" && entry.betTypeID === betTypeID) {
      if (betTypeID === "ou") {
        if (entry.sideID === sideID) return entry;
      } else if (entry.statEntityID === statEntityID) {
        return entry;
      }
    }
  }
  return null;
}

function buildGameEntry(event) {
  const awayName = event.teams?.away?.names?.long;
  const homeName = event.teams?.home?.names?.long;
  const away = TEAM_MAP[awayName];
  const home = TEAM_MAP[homeName];
  if (!away || !home) return null;

  const mlHome = extractLine(event.odds, "home", "ml");
  const mlAway = extractLine(event.odds, "away", "ml");
  const spHome = extractLine(event.odds, "home", "sp");
  const spAway = extractLine(event.odds, "away", "sp");
  const ouOver = extractLine(event.odds, null, "ou", "over");

  const asOf = new Date().toISOString();
  const books = {};
  for (const book of BOOKMAKERS) {
    const mh = mlHome?.byBookmaker?.[book];
    const ma = mlAway?.byBookmaker?.[book];
    const sh = spHome?.byBookmaker?.[book];
    const sa = spAway?.byBookmaker?.[book];
    const ou = ouOver?.byBookmaker?.[book];
    if (!mh?.available || !ma?.available || !sh?.available || !sa?.available || !ou?.available) continue;
    const homeIsFavorite = Number(sh.spread) < 0;
    books[book] = {
      favorite: homeIsFavorite ? home : away,
      spread: homeIsFavorite ? Number(sh.spread) : Number(sa.spread),
      moneylineHome: Number(mh.odds),
      moneylineAway: Number(ma.odds),
      overUnder: Number(ou.overUnder),
      asOf,
    };
  }

  const priority = BOOKMAKERS.filter((b) => books[b]);
  if (priority.length === 0) return null;
  const defaultBook = books[priority[0]];

  return {
    away,
    home,
    startsAt: event.status?.startsAt || null,
    entry: {
      favorite: defaultBook.favorite,
      spread: defaultBook.spread,
      moneylineHome: defaultBook.moneylineHome,
      moneylineAway: defaultBook.moneylineAway,
      overUnder: defaultBook.overUnder,
      asOf,
      ...(priority.length >= 1 ? { books } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Main

async function main() {
  if (!ODDS_UPDATE_SECRET) {
    console.error("ODDS_UPDATE_SECRET is not set - refusing to run.");
    process.exit(1);
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lock = await acquireLock(runId);
  if (lock.blocked) return;

  try {
    const budget = await checkBudget();
    if (!budget.proceed) {
      // Three distinct reasons, each logged with the number that actually
      // caused it - a skip should never be ambiguous about which gate
      // stopped it or what would clear it.
      if (budget.reason === "reserve") {
        log(`skipping fetch this run - pool headroom (${budget.remaining}) below the ${MIN_REMAINING_RESERVE}-object reserve.`);
      } else if (budget.reason === "per-key-pace") {
        const resets = budget.nextResetAt ? ` next reset ${budget.nextResetAt.slice(0, 10)}.` : "";
        log(`skipping fetch this run - every account is ahead of its own pace curve or out of headroom.${resets}`);
      } else {
        log(`skipping fetch this run - pooled usage (${budget.usage}) at or above pooled pace allowance (${budget.paceAllowance.toFixed(1)}).`);
      }
      return;
    }

    const [liveOdds, liveHistory] = await Promise.all([getOddsCurrent(), getOddsCurrent("history")]);

    const lastFullSweepAt = liveOdds.lastFullSweepAt ? new Date(liveOdds.lastFullSweepAt) : null;
    const hoursSinceFull = lastFullSweepAt ? (Date.now() - lastFullSweepAt.getTime()) / 3600000 : Infinity;
    const sweepMode = hoursSinceFull > FULL_SWEEP_STALE_HOURS ? "FULL" : "NEAR";
    log(`sweep mode: ${sweepMode} (last full sweep ${lastFullSweepAt ? hoursSinceFull.toFixed(1) + "h ago" : "never"})`);

    const now = new Date();
    const startsAfter = now.toISOString();
    const startsBefore = sweepMode === "NEAR"
      ? new Date(now.getTime() + NEAR_WINDOW_DAYS * 86400000).toISOString()
      : undefined;

    const events = await fetchAllEvents({ startsAfter, startsBefore });
    log(`fetched ${events.length} event(s) from SportsGameOdds.`);

    if (events.length === 0 && sweepMode === "NEAR") {
      log("no events in the near-term window - nothing to do this run.");
      return;
    }

    const scheduleIndex = await buildScheduleIndex(liveOdds.season || 2026);

    let gamesChanged = false;
    let historyChanged = false;
    const skipped = [];

    for (const event of events) {
      const built = buildGameEntry(event);
      if (!built) {
        skipped.push(event.eventID || "unknown");
        continue;
      }
      const { away, home, startsAt, entry } = built;
      const { week, ambiguous } = resolveWeek(scheduleIndex, away, home, startsAt);
      if (week === null) {
        skipped.push(`${away}-${home} (no schedule match)`);
        continue;
      }
      if (ambiguous) log(`note: ${away}-${home} matched multiple schedule entries, used closest by date -> week ${week}`);

      const weekKey = String(week);
      if (!liveOdds.weeks[weekKey]) liveOdds.weeks[weekKey] = { isDemo: false, games: {} };
      liveOdds.weeks[weekKey].isDemo = false;
      const gameKey = `${away}-${home}`;
      liveOdds.weeks[weekKey].games[gameKey] = entry;
      gamesChanged = true;

      const priorLine = liveHistory.games?.[gameKey]?.slice(-1)[0];
      const linesDiffer = !priorLine
        || priorLine.favorite !== entry.favorite
        || priorLine.spread !== entry.spread
        || priorLine.moneylineHome !== entry.moneylineHome
        || priorLine.moneylineAway !== entry.moneylineAway
        || priorLine.overUnder !== entry.overUnder;
      if (linesDiffer) {
        if (!liveHistory.games) liveHistory.games = {};
        if (!liveHistory.games[gameKey]) liveHistory.games[gameKey] = [];
        liveHistory.games[gameKey].push(entry);
        historyChanged = true;
      }
    }

    if (skipped.length) log(`skipped ${skipped.length} event(s): ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? "..." : ""}`);

    let fullSweepFlagChanged = false;
    if (sweepMode === "FULL") {
      liveOdds.lastFullSweepAt = new Date().toISOString();
      fullSweepFlagChanged = true;
    }

    if (!gamesChanged && !historyChanged && !fullSweepFlagChanged) {
      log("nothing changed - no publish, no disk write.");
      return;
    }

    const publishBody = { odds: liveOdds };
    if (historyChanged) publishBody.history = liveHistory;

    const publishRes = await fetch(`${SITE_BASE}/.netlify/functions/odds-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-odds-update-secret": ODDS_UPDATE_SECRET },
      body: JSON.stringify(publishBody),
    });
    if (!publishRes.ok) {
      throw new Error(`odds-update publish failed: ${publishRes.status} ${await publishRes.text().catch(() => "")}`);
    }
    log("published to odds-update.");

    // Mirror to disk before verifying, not after. odds-update has already
    // returned 200 by this point, so the data is good regardless of what the
    // read-back says - and when the verification below used to fail
    // spuriously it took the mirror down with it, leaving data/odds-2026.json
    // a full sweep behind on every failed run.
    await writeJson("data/odds-2026.json", liveOdds);
    if (historyChanged) await writeJson("data/odds-history.json", liveHistory);
    log("wrote on-disk mirror (data/odds-2026.json" + (historyChanged ? ", data/odds-history.json" : "") + ").");

    // Only a FULL sweep stamps a value that's cheap to check for round-trip.
    // A NEAR sweep has nothing comparable to assert on, so it was always
    // paying for a read it then ignored.
    if (fullSweepFlagChanged) {
      log("verifying full-sweep publish...");
      await verifyPublish(liveOdds.lastFullSweepAt);
    }
  } finally {
    if (lock.held) await releaseLock(runId);
  }
}

main().catch((err) => {
  console.error("odds-refresh failed:", err);
  process.exit(1);
});

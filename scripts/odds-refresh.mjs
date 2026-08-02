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
 *   2. Check this month's API usage and skip the fetch if we're pacing
 *      ahead of budget (2,500 objects/month on the free tier).
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
 *   SITE_BASE            - defaults to https://blitz-odds.netlify.app
 *   ANCHOR_YEAR/MONTH/DAY - SportsGameOdds primary key's billing anchor date
 *                           (UTC). Defaults below; update if the key rotates
 *                           onto a different date. MONTH is 1-indexed here.
 *   REPO_ROOT            - defaults to CWD; where data/*.json live
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.netlify.app";
const ODDS_UPDATE_SECRET = process.env.ODDS_UPDATE_SECRET;
const REPO_ROOT = process.env.REPO_ROOT || process.cwd();

const ANCHOR_YEAR = Number(process.env.ANCHOR_YEAR || 2026);
const ANCHOR_MONTH = Number(process.env.ANCHOR_MONTH || 7); // 1-indexed (7 = July)
const ANCHOR_DAY = Number(process.env.ANCHOR_DAY || 31);

const BOOKMAKERS = ["draftkings", "fanduel", "betmgm", "caesars"];
const NEAR_WINDOW_DAYS = 10;
const FULL_SWEEP_STALE_HOURS = 20;
const MONTHLY_BUDGET = 2500;

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

async function checkBudget() {
  const res = await fetch(`${SITE_BASE}/.netlify/functions/odds-proxy?endpoint=usage`);
  if (!res.ok) {
    log("warning: usage check failed, proceeding cautiously this run:", res.status);
    return { proceed: true, usage: null };
  }
  const body = await res.json().catch(() => null);
  const usage = body?.data?.rateLimits?.["per-month"]?.["current-entities"];
  if (typeof usage !== "number") {
    log("warning: could not parse usage from response, proceeding cautiously this run.", JSON.stringify(body).slice(0, 300));
    return { proceed: true, usage: null };
  }

  const now = new Date();
  const { start, end } = cycleBounds(now);
  const daysInCycle = Math.round((end - start) / 86400000);
  const dayOfCycle = Math.floor((now - start) / 86400000) + 1;
  const paceAllowance = MONTHLY_BUDGET * (dayOfCycle / daysInCycle) * 0.95;

  log(`budget: usage=${usage} paceAllowance=${paceAllowance.toFixed(1)} dayOfCycle=${dayOfCycle}/${daysInCycle} account=${body?.data?.email || "?"}`);

  if (usage >= paceAllowance) {
    return { proceed: false, usage, paceAllowance };
  }
  return { proceed: true, usage, paceAllowance };
}

// ---------------------------------------------------------------------------
// Fetch odds-current / odds-update

async function getOddsCurrent(type) {
  const qs = type === "history" ? "?type=history" : "";
  const res = await fetch(`${SITE_BASE}/.netlify/functions/odds-current${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`odds-current${qs} failed: ${res.status}`);
  return res.json();
}

async function fetchEventsPage(params, attempt = 1) {
  const url = `${SITE_BASE}/.netlify/functions/odds-proxy?endpoint=events&${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (body && body.success === false && /rate limit/i.test(body.error || "") && attempt <= 3) {
    log(`rate limited, backing off (attempt ${attempt})...`);
    await sleep(18000);
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
  do {
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
      log(`skipping fetch this run - usage (${budget.usage}) at or above pace allowance (${budget.paceAllowance?.toFixed(1)}).`);
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
    log("published to odds-update, verifying...");

    const verify = await getOddsCurrent();
    if (fullSweepFlagChanged && verify.lastFullSweepAt !== liveOdds.lastFullSweepAt) {
      throw new Error("verification failed: lastFullSweepAt did not land on the live store.");
    }
    log("verified: publish landed.");

    await writeJson("data/odds-2026.json", liveOdds);
    if (historyChanged) await writeJson("data/odds-history.json", liveHistory);
    log("wrote on-disk mirror (data/odds-2026.json" + (historyChanged ? ", data/odds-history.json" : "") + ").");
  } finally {
    if (lock.held) await releaseLock(runId);
  }
}

main().catch((err) => {
  console.error("odds-refresh failed:", err);
  process.exit(1);
});

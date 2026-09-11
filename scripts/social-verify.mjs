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

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  const oddsWeek = (odds.weeks || {})[String(week)] || { games: {} };
  const games = sched.games.map((g) => {
    const key = `${g.away}-${g.home}`;
    const o = oddsWeek.games?.[key] || null;
    const spread = o && typeof o.spread === "number" ? o.spread : null;
    return {
      key,
      away: g.away,
      home: g.home,
      date: g.date || "",
      day: (g.date || "").split(",")[0],
      time: g.time || "",
      network: g.network || "",
      favorite: o?.favorite || null,
      spread,
      absSpread: spread === null ? null : Math.abs(spread),
      overUnder: o && typeof o.overUnder === "number" ? o.overUnder : null,
      asOf: o?.asOf || null,
      hasOdds: !!o,
    };
  });
  return { week, games, byKey: Object.fromEntries(games.map((g) => [g.key, g])) };
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

function withOdds(ctx) {
  return ctx.games.filter((g) => g.hasOdds);
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
  const need = (key) => {
    const g = ctx.byKey[key];
    if (!g) throw new Error(`Unknown game ${key} in week ${ctx.week}`);
    if (!g.hasOdds) missing.push(key);
    return g;
  };

  const out = text.replace(/\{\{([^}]+)\}\}/g, (_, raw) => {
    const [name, ...args] = raw.trim().split(":").map((s) => s.trim());
    switch (name) {
      case "fav": return need(args[0]).favorite ?? "?";
      case "spread": return fmtSpread(need(args[0]).spread);
      case "ou": { const g = need(args[0]); return g.overUnder === null ? "?" : String(g.overUnder); }
      case "away": return ctx.byKey[args[0]]?.away ?? "?";
      case "home": return ctx.byKey[args[0]]?.home ?? "?";
      case "time": return (ctx.byKey[args[0]]?.time ?? "?").replace(/\s*ET$/, " ET");
      case "network": return ctx.byKey[args[0]]?.network ?? "?";
      case "line": return fmtLine(need(args[0]));
      case "biggest": {
        const n = Number(args[0] || 4);
        return byBiggest(onDay(withOdds(ctx), args[1])).slice(0, n).map(fmtLine).join("\n");
      }
      case "closest": {
        const n = Number(args[0] || 3);
        return byClosest(onDay(withOdds(ctx), args[1])).slice(0, n).map(fmtLine).join("\n");
      }
      case "countGte": {
        const v = Number(args[0]);
        return numWord(withOdds(ctx).filter((g) => g.absSpread >= v).length);
      }
      case "topFavs": {
        const n = Number(args[0] || 2);
        return joinList(byBiggest(withOdds(ctx)).slice(0, n).map((g) => g.favorite), args[1] || "or");
      }
      case "maxTotal": {
        const games = onDay(withOdds(ctx), args[0]).filter((g) => g.overUnder !== null);
        if (!games.length) return "?";
        const top = [...games].sort((a, b) => b.overUnder - a.overUnder)[0];
        return `${top.away} at ${top.home}, ${top.overUnder}`;
      }
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
      default: throw new Error(`Unknown placeholder {{${raw}}} in post ${post.id}`);
    }
  });
  return { text: out, missing };
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
        const n = withOdds(ctx).length;
        if (n < (r.minGames ?? ctx.games.length)) fail(`weekOdds: only ${n}/${ctx.games.length} games have lines`);
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

async function bufferCreate(channelId, text, dueAtIso) {
  const data = await buffer(
    `mutation Create($input: CreatePostInput!) {
       createPost(input: $input) {
         ... on PostActionSuccess { post { id status dueAt } }
         ... on MutationError { message }
       }
     }`,
    { input: { channelId, text, dueAt: dueAtIso, mode: "customScheduled", schedulingType: "automatic", source: "blitz-odds social-verify" } },
  );
  const r = data.createPost;
  if (!r?.post) throw new Error(`createPost failed: ${r?.message || "unknown"}`);
  return r.post;
}

async function bufferEdit(id, text) {
  const data = await buffer(
    `mutation Edit($input: EditPostInput!) {
       editPost(input: $input) {
         ... on PostActionSuccess { post { id status dueAt } }
         ... on MutationError { message }
       }
     }`,
    { input: { id, text } },
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

  for (const post of queue.posts) {
    const state = logDoc.posts[post.id] || { status: "pending" };
    const dueAt = new Date(post.dueAt);

    if (state.status === "sent" || state.status === "expired") continue;

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

    const needsData = post.week !== undefined && (/\{\{/.test(post.text) || (post.requires || []).length || post.fallback);
    if (needsData && !odds) {
      act({ post: post.id, action: "skipped", detail: "no live odds" });
      continue;
    }

    // Decide which copy to use.
    let chosen = null;
    let reasons = [];
    const candidates = [{ label: "primary", text: post.text, requires: post.requires || [] }];
    if (post.fallback) candidates.push({ label: "fallback", text: post.fallback.text, requires: post.fallback.requires || [] });

    for (const c of candidates) {
      let rendered;
      try {
        rendered = post.week !== undefined ? renderTemplate(c.text, ctxFor(post.week), post) : { text: c.text, missing: [] };
      } catch (err) {
        reasons.push(`${c.label}: ${err.message}`);
        continue;
      }
      const failures = post.week !== undefined ? await evaluate(c.requires, ctxFor(post.week), rendered) : [];
      if (post.week === undefined && tweetLength(rendered.text) > TWEET_MAX) failures.push(`text is ${tweetLength(rendered.text)} chars (max ${TWEET_MAX})`);
      if (!failures.length) { chosen = { ...c, text: rendered.text }; break; }
      reasons.push(`${c.label}: ${failures.join("; ")}`);
    }

    const dueIso = dueAt.toISOString();

    if (!chosen) {
      if (state.bufferPostId) {
        // Was scheduled on an earlier run; the world moved. Pull it.
        if (!DRY_RUN) await bufferDelete(state.bufferPostId);
        act({ post: post.id, action: "deleted", detail: reasons.join(" | ") });
        alerts.push(`PULLED "${post.id}" (was scheduled for ${post.dueAt}):\n  ${reasons.join("\n  ")}\n  Last text:\n${indent(state.text)}`);
        logDoc.posts[post.id] = { ...state, status: "blocked", bufferPostId: null, text: null, reasons, lastCheckedAt: run.at };
      } else {
        act({ post: post.id, action: "blocked", detail: reasons.join(" | ") });
        alerts.push(`BLOCKED "${post.id}" (due ${post.dueAt}) - nothing scheduled:\n  ${reasons.join("\n  ")}`);
        logDoc.posts[post.id] = { ...state, status: "blocked", reasons, lastCheckedAt: run.at };
      }
      continue;
    }

    if (!state.bufferPostId) {
      let bufferPostId = DRY_RUN ? "dry-run" : (await bufferCreate(queue.channelId, chosen.text, dueIso)).id;
      act({ post: post.id, action: "scheduled", detail: `${chosen.label} for ${post.dueAt}` });
      logDoc.posts[post.id] = { status: "scheduled", variant: chosen.label, bufferPostId, text: chosen.text, dueAt: dueIso, scheduledAt: run.at, lastCheckedAt: run.at, reasons: reasons.length ? reasons : undefined };
    } else if (state.text !== chosen.text) {
      if (!DRY_RUN) await bufferEdit(state.bufferPostId, chosen.text);
      act({ post: post.id, action: "updated", detail: `${chosen.label}; text changed` });
      logDoc.posts[post.id] = { ...state, status: "scheduled", variant: chosen.label, text: chosen.text, updatedAt: run.at, lastCheckedAt: run.at };
    } else {
      act({ post: post.id, action: "verified", detail: `${chosen.label} unchanged` });
      logDoc.posts[post.id] = { ...state, lastCheckedAt: run.at };
    }
    if (chosen.label === "fallback") {
      alerts.push(`FALLBACK used for "${post.id}" (due ${post.dueAt}) - primary failed:\n  ${reasons.join("\n  ")}\n  Scheduled text:\n${indent(chosen.text)}`);
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

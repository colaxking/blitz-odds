#!/usr/bin/env node
/**
 * Mirrors ESPN's league-wide injury feed into the site-data blob store under
 * "espnInjuries", for the second layer of the injury block and for the
 * Phase 4 alert diff.
 *
 * THIS IS NOT THE SOURCE OF TRUTH. data/impact-players.json is, and stays
 * so. Measured against the curated file the day this was written: of 71
 * tracked players, 13 disagreed on status and 12 had no ESPN record at all -
 * eight of those being players carried as "out". If ESPN wrote status, the
 * app would have been wrong about eight players that day. What this feed is
 * good at is *timing* and *detail*: a report timestamp, a structured injury
 * type, and an estimated return date on roughly 40% of records, none of
 * which the curated file has a field for.
 *
 * SIZE. The raw feed is ~8.8 MB for 800 records, most of it long comments,
 * headshots and link arrays. Stripped to the fields that get used it's still
 * 279 KB, which is fine server-side and far too much to add to every page
 * load - on a credit-based plan bandwidth is 20 credits/GB, so shipping 279
 * KB to every visitor would cost more than the entire notification system.
 *
 * So this publishes ONLY the players carried in impact-players.json, keyed by
 * the espnId those records were backfilled with. That's around 20 KB, and it
 * loses nothing: the injury block renders curated players and nothing else,
 * so a record for a player the app never lists has no one to display it.
 *
 * The alert diff, which DOES care about the other ~730 (that's how new
 * players reach the review queue), works from the full feed server-side and
 * keeps its own snapshot outside site-data. Untrimmed data never reaches a
 * browser.
 *
 * Usage:
 *   SITE_DATA_UPDATE_SECRET=... node scripts/injury-espn-refresh.mjs
 *   node scripts/injury-espn-refresh.mjs --dry-run    # print, don't publish
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.com";
const FEED_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries";

/** ESPN 403s server IPs without a curl-ish User-Agent. Same reason
 *  results-process-trigger.mjs and lib/livescores.mts carry this header. */
const ESPN_HEADERS = { "User-Agent": "curl/8.4.0", Accept: "application/json" };

/** ESPN's abbreviations differ from ours in two places. */
const ESPN_ABBR_FIX = { WSH: "WAS", LA: "LAR" };
const fixAbbr = (a) => ESPN_ABBR_FIX[String(a || "").toUpperCase()] || String(a || "").toUpperCase();

/**
 * ESPN has six statuses; impact-players.json has three. Collapsing before
 * anything compares them is what stops a routine Out -> Injured Reserve move
 * from looking like an escalation - the two mean the same thing to a pick'em
 * player, and firing an alert for the transition would be noise.
 */
const COLLAPSE = {
  Active: "active",
  Questionable: "questionable",
  Doubtful: "out",
  Out: "out",
  "Injured Reserve": "out",
  Suspension: "out",
};

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

function athleteIdFrom(athlete) {
  // The payload has no athlete.id field; the player-card URL carries it, and
  // did so on 800 of 800 records when this was written.
  for (const link of athlete?.links || []) {
    const m = /\/id\/(\d+)/.exec(link?.href || "");
    if (m) return m[1];
  }
  return null;
}

async function fetchFeed() {
  const res = await fetch(FEED_URL, { headers: ESPN_HEADERS });
  if (!res.ok) throw new Error(`ESPN injuries feed failed: ${res.status}`);
  return res.json();
}

async function curatedEspnIds() {
  const raw = await readFile(path.join(REPO_ROOT, "data", "impact-players.json"), "utf8");
  const doc = JSON.parse(raw);
  const ids = new Set();
  for (const list of Object.values(doc.players || {})) {
    for (const p of list) if (p.espnId) ids.add(String(p.espnId));
  }
  return ids;
}

function compact(feed, keepIds) {
  const players = {};
  let skipped = 0;
  let filtered = 0;

  for (const teamBlock of feed.injuries || []) {
    for (const item of teamBlock.injuries || []) {
      const athlete = item.athlete || {};
      const id = athleteIdFrom(athlete);
      if (!id) { skipped++; continue; }
      if (keepIds && !keepIds.has(id)) { filtered++; continue; }

      const details = item.details || {};
      // Keep the newest record per athlete. ESPN can carry more than one for
      // a player across a season and they arrive in no guaranteed order.
      const existing = players[id];
      if (existing && existing.date >= (item.date || "")) continue;

      players[id] = {
        id,
        name: athlete.displayName || null,
        team: fixAbbr(athlete.team?.abbreviation || teamBlock.abbreviation),
        position: athlete.position?.abbreviation || null,
        // Both forms: `status` is ESPN's own wording, which the UI shows
        // verbatim because it's being attributed to them; `state` is the
        // collapsed form, which is the only thing anything compares.
        status: item.status || null,
        state: COLLAPSE[item.status] || "active",
        // The report timestamp - what makes "is this new" answerable, and
        // what the poller filters on rather than diffing 800 records.
        date: item.date || null,
        type: details.type || null,
        location: details.location || null,
        side: details.side || null,
        detail: details.detail || null,
        returnDate: details.returnDate || null,
        // The short beat-report line. The long one runs to a paragraph and is
        // dropped - it's most of the 8.8 MB and the block has no room for it.
        comment: item.shortComment || null,
        injuryId: item.id || null,
      };
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    source: "ESPN",
    count: Object.keys(players).length,
    skipped,
    filtered,
    players,
  };
}

async function publish(doc) {
  const secret = process.env.SITE_DATA_UPDATE_SECRET;
  if (!secret) throw new Error("SITE_DATA_UPDATE_SECRET is not set");
  const res = await fetch(`${SITE_BASE}/.netlify/functions/site-data-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-site-data-update-secret": secret },
    body: JSON.stringify({ espnInjuries: doc }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`site-data-update returned ${res.status}: ${text}`);
  log(`Published. ${text}`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  log("Fetching ESPN league injury feed...");
  const [feed, keepIds] = await Promise.all([fetchFeed(), curatedEspnIds()]);
  const doc = compact(feed, keepIds);

  const bytes = Buffer.byteLength(JSON.stringify(doc));
  log(`${doc.count} of ${keepIds.size} tracked players have an ESPN record (${doc.filtered} untracked players dropped, ${doc.skipped} unparseable). ${(bytes / 1024).toFixed(0)} KB.`);
  const noRecord = keepIds.size - doc.count;
  if (noRecord > 0) log(`${noRecord} tracked player(s) have no ESPN injury record - expected; those show "Not on the league injury report".`);

  const byState = {};
  for (const p of Object.values(doc.players)) byState[p.state] = (byState[p.state] || 0) + 1;
  log(`By state: ${JSON.stringify(byState)}`);
  const withReturn = Object.values(doc.players).filter((p) => p.returnDate).length;
  log(`${withReturn} carry an estimated return date.`);

  if (dryRun) {
    const sample = Object.values(doc.players).find((p) => p.state !== "active");
    log("Dry run - not publishing. Sample record:");
    console.log(JSON.stringify(sample, null, 2));
    return;
  }

  await publish(doc);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

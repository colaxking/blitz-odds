#!/usr/bin/env node
/**
 * Keeps data/impact-players.json in step with ESPN without waiting on a
 * human, and keeps the two copies of it from drifting apart.
 *
 * Three jobs, in order of how much judgment they need:
 *
 *  1. RESOLVE MISSING espnId. Pure lookup against ESPN's team rosters.
 *     No judgment at all, and it has silently broken twice already: a
 *     player without an espnId never joins to the ESPN feed, so no second
 *     line on the page, no fast alert, and no error to notice.
 *
 *  2. AUTO-APPLY A STATUS CHANGE, when ESPN's report is newer than the last
 *     time this file's opinion was set AND the player is getting worse. A
 *     de-escalation against a human-set status is never applied - see the
 *     direction rule in the status pass, which is the difference between
 *     this being safe to leave running and it quietly destroying the
 *     judgment that makes the file worth having.
 *
 *  3. AUTO-ADD an untracked FIRST-STRING player at a premium position who's
 *     just been ruled out, so the app isn't blind to him until someone
 *     notices. The starter check comes from ESPN's depth charts and is doing
 *     real work: without it, "any premium-position player listed out" pulls
 *     in 52 players in late August - camp bodies and practice-squad names -
 *     which would double the file with noise and feed junk to the model.
 *
 * WHY THIS IS SAFE TO RUN UNATTENDED, AND WHERE IT ISN'T:
 *
 * `statusUpdatedAt` records when a player's status was last decided and by
 * whom (`source`: "curated" or "auto"). A status is only auto-applied when
 * ESPN's REPORT timestamp is newer than that. On the first run every
 * existing player is stamped curated/now WITHOUT being changed - so the
 * disagreements already in the file (13 of 72 the day this was written,
 * mostly cases where you know a player is out and ESPN still says
 * questionable) survive untouched, and only reports filed AFTER today can
 * move anything.
 *
 * `pinned: true` on a player means never auto-apply, permanently. That's the
 * escape hatch for "I know better than the official designation and I don't
 * want to be corrected every Wednesday."
 *
 * impactScore is NOT auto-derived for existing players, and for auto-added
 * ones it's a conservative guess from the position medians of the players
 * you already track, minus one. It feeds the prediction model, so a wrong
 * value skews real output - guessing low under-weights a player rather than
 * over-weighting him, which is the safer direction to be wrong in. Every
 * auto-added player is marked `source: "auto"` so they're visibly
 * provisional and easy to find and fix.
 *
 * Usage:
 *   node scripts/injury-player-sync.mjs --dry-run     # report, change nothing
 *   node scripts/injury-player-sync.mjs               # write both copies
 *   node scripts/injury-player-sync.mjs --publish     # ...and push to Blobs
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PATH = path.join(REPO_ROOT, "data", "impact-players.json");
const INDEX_PATH = path.join(REPO_ROOT, "index.html");
const SITE_BASE = process.env.SITE_BASE || "https://blitz-odds.com";

const ESPN_HEADERS = { "User-Agent": "curl/8.4.0", Accept: "application/json" };
const INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries";
const ROSTER_URL = (slug) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${slug}/roster`;
const DEPTH_URL = (teamId, season) =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/teams/${teamId}/depthcharts?limit=50`;

/** ESPN's abbreviations differ from ours in two places, and its roster
 *  endpoint wants "wsh" rather than "was". */
const ESPN_ABBR_FIX = { WSH: "WAS", LA: "LAR" };
const ROSTER_SLUG_FIX = { WAS: "wsh" };
const fixAbbr = (a) => ESPN_ABBR_FIX[String(a || "").toUpperCase()] || String(a || "").toUpperCase();

/** Six ESPN statuses onto our three. Mirrored in
 *  netlify/functions/lib/espn-injuries.mts - if this changes, change both. */
const COLLAPSE = {
  Active: "active", Questionable: "questionable", Doubtful: "out",
  Out: "out", "Injured Reserve": "out", Suspension: "out",
};

/** Severity ladder. Direction of travel decides whether a change can be
 *  applied without a human, which matters more than it sounds - see the
 *  de-escalation rule in the status pass. */
const SEVERITY = { active: 0, questionable: 1, out: 2 };

/** Positions where an unfamiliar name going down is worth tracking at all. */
const PREMIUM = new Set(["QB", "RB", "WR", "TE", "LT", "RT", "OT", "EDGE", "DE", "CB", "K"]);

/** Medians of the players already tracked, minus one. The tracked set skews
 *  toward stars - if an untracked player were a star, he'd probably already
 *  be here - so a newcomer is more likely second-tier. */
const AUTO_IMPACT = { QB: 6, RB: 6, WR: 6, TE: 6, EDGE: 7, DE: 5, CB: 6, LT: 6, RT: 5, OT: 5, K: 4 };
const AUTO_IMPACT_DEFAULT = 5;

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

const norm = (s) => String(s || "").toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z ]/g, "").replace(/ (jr|sr|ii|iii|iv)$/g, "").trim();

async function getJSON(url) {
  const res = await fetch(url, { headers: ESPN_HEADERS });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** name -> [{id, team, position}] across all 32 rosters. */
async function buildRosterIndex(teamAbbrs, teamIds) {
  const index = new Map();
  for (const abbr of teamAbbrs) {
    const slug = ROSTER_SLUG_FIX[abbr] || abbr.toLowerCase();
    try {
      const d = await getJSON(ROSTER_URL(slug));
      if (d.team?.id) teamIds.set(abbr, String(d.team.id));
      for (const group of d.athletes || []) {
        for (const a of group.items || []) {
          if (!a.displayName) continue;
          const entry = { id: String(a.id), team: abbr, position: a.position?.abbreviation || null };
          index.set(a.displayName, [...(index.get(a.displayName) || []), entry]);
          const n = norm(a.displayName);
          index.set(`~${n}`, [...(index.get(`~${n}`) || []), entry]);
        }
      }
    } catch (err) {
      log(`  roster fetch failed for ${abbr}: ${err.message}`);
    }
  }
  return index;
}

/** Resolves one player to an ESPN athlete id, disambiguating on team then
 *  position - two different NFL players sharing a name is the only case that
 *  needs it, and that's enough to settle every instance so far. */
function resolveId(index, name, team, position) {
  const cands = index.get(name) || index.get(`~${norm(name)}`) || [];
  if (!cands.length) return { id: null, ambiguous: false };
  let picked = cands.filter((c) => c.team === team);
  if (!picked.length) picked = cands;
  if (picked.length > 1) {
    const byPos = picked.filter((c) => c.position === position);
    if (byPos.length) picked = byPos;
  }
  return { id: picked[0].id, ambiguous: cands.length > 1 };
}

/**
 * ESPN athlete ids holding a first-string slot on any formation.
 *
 * This is the gate on auto-adding, and it is load-bearing. Without it, "any
 * premium-position player listed out" pulls in 52 players in late August -
 * camp bodies and practice-squad names nobody has heard of - which would
 * roughly double the tracked file with noise and feed junk into the
 * prediction model. Filtered to actual starters it's a handful.
 *
 * Athlete ids are parsed straight out of the $ref URLs rather than followed:
 * resolving them would be hundreds of extra requests to learn a name this
 * script already has from the injury feed.
 */
async function fetchStarters(teamIds, season) {
  const starters = new Set();
  for (const [abbr, id] of teamIds) {
    try {
      const d = await getJSON(DEPTH_URL(id, season));
      for (const formation of d.items || []) {
        for (const pos of Object.values(formation.positions || {})) {
          for (const a of pos.athletes || []) {
            if (a.slot !== 1) continue;
            const m = /\/athletes\/(\d+)/.exec(a.athlete?.$ref || "");
            if (m) starters.add(m[1]);
          }
        }
      }
    } catch (err) {
      log(`  depth chart fetch failed for ${abbr}: ${err.message}`);
    }
  }
  return starters;
}

async function fetchInjuries() {
  const feed = await getJSON(INJURIES_URL);
  const out = {};
  for (const block of feed.injuries || []) {
    for (const item of block.injuries || []) {
      const a = item.athlete || {};
      let id = null;
      for (const l of a.links || []) {
        const m = /\/id\/(\d+)/.exec(l.href || "");
        if (m) { id = m[1]; break; }
      }
      if (!id) continue;
      if (out[id] && (out[id].date || "") >= (item.date || "")) continue;
      const d = item.details || {};
      out[id] = {
        id, name: a.displayName || null,
        team: fixAbbr(a.team?.abbreviation || block.abbreviation),
        position: a.position?.abbreviation || null,
        status: item.status || null,
        state: COLLAPSE[item.status] || "active",
        date: item.date || null,
        type: d.type && d.type !== "Not Specified" ? d.type : null,
        returnDate: d.returnDate || null,
        comment: item.shortComment || null,
      };
    }
  }
  return out;
}

/** Writes the players doc into BOTH copies: data/impact-players.json and the
 *  embedded players-data seed in index.html. They are separate copies of the
 *  same thing and drift the moment either changes - which has silently
 *  broken the page twice. Anything that edits one must edit the other. */
async function writeBothCopies(doc) {
  const json = JSON.stringify(doc, null, 2);
  await writeFile(DATA_PATH, json + "\n", "utf8");

  const html = await readFile(INDEX_PATH, "utf8");
  const re = /(<script[^>]*id="players-data"[^>]*>)([\s\S]*?)(<\/script>)/;
  const m = re.exec(html);
  if (!m) throw new Error('Could not find the players-data block in index.html');
  await writeFile(INDEX_PATH, html.slice(0, m.index + m[1].length) + "\n" + json + "\n" + html.slice(m.index + m[1].length + m[2].length), "utf8");
}

/** The staging list behind the "Track player" button in analytics.html.
 *
 *  That button writes a new player straight into the live "players" blob so
 *  the site reflects him within seconds - but the blob is the copy, not the
 *  source. site-data-update.mts merges by iterating the INCOMING team array,
 *  so a player who exists only in the blob is dropped the moment this script
 *  publishes the repo's version over it. Absorbing the staging list here,
 *  before anything else runs, is what stops that. */
async function fetchPendingAdds(doPublish) {
  const secret = process.env.INJURY_REVIEW_SECRET;
  if (!secret) {
    // Skipping is only survivable when we're not about to overwrite the
    // blob. With --publish it is actively destructive: site-data-update.mts
    // merges by iterating the incoming team array, so publishing a repo copy
    // that never absorbed the staged adds DELETES those players from the
    // live blob. Fail rather than quietly throw away someone's work.
    if (doPublish) {
      throw new Error(
        "INJURY_REVIEW_SECRET is not set, so staged adds can't be absorbed - and publishing without them " +
        "would delete any player added from the review panel. Set the secret, or run without --publish.");
    }
    log("INJURY_REVIEW_SECRET is not set - skipping the staged-adds check.");
    return [];
  }
  const res = await fetch(`${SITE_BASE}/.netlify/functions/injury-player-add`, {
    headers: { "x-injury-review-secret": secret },
  });
  if (!res.ok) throw new Error(`injury-player-add returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data.pending) ? data.pending : [];
}

/** Only ever called after the repo copy is safely on disk. Clearing earlier
 *  would drop a player into the gap between the two stores. */
async function ackPendingAdds(espnIds) {
  if (!espnIds.length) return;
  const secret = process.env.INJURY_REVIEW_SECRET;
  if (!secret) return;
  const res = await fetch(`${SITE_BASE}/.netlify/functions/injury-player-add`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-injury-review-secret": secret },
    body: JSON.stringify({ ack: espnIds }),
  });
  if (!res.ok) throw new Error(`injury-player-add ack returned ${res.status}: ${await res.text()}`);
  log(`Cleared ${espnIds.length} staged add(s).`);
}

async function publish(doc) {
  const secret = process.env.SITE_DATA_UPDATE_SECRET;
  if (!secret) throw new Error("SITE_DATA_UPDATE_SECRET is not set");
  const res = await fetch(`${SITE_BASE}/.netlify/functions/site-data-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-site-data-update-secret": secret },
    body: JSON.stringify({ players: doc }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`site-data-update returned ${res.status}: ${text}`);
  log(`Published to Blobs. ${text}`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const doPublish = process.argv.includes("--publish");
  const now = new Date().toISOString();

  const doc = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const teams = Object.keys(doc.players);
  const all = () => Object.entries(doc.players).flatMap(([t, ps]) => ps.map((p) => [t, p]));

  // ---- 0. staged adds ----------------------------------------------------
  // Runs first so a staged player is a normal tracked player by the time
  // espnId resolution, status sync and validation see him.
  const staged = { merged: [], alreadyThere: [], ack: [] };
  const pending = await fetchPendingAdds(doPublish);
  if (pending.length) {
    const known = new Set(all().map(([, p]) => String(p.espnId)));
    const knownNames = new Set(all().map(([, p]) => norm(p.name)));
    for (const entry of pending) {
      const p = entry && entry.player;
      if (!p || !p.name || !entry.team) continue;
      staged.ack.push(String(p.espnId));
      // A repeat means a previous run merged him but the ack didn't land.
      // Re-adding would throw on the duplicate-espnId check below.
      if ((p.espnId && known.has(String(p.espnId))) || knownNames.has(norm(p.name))) {
        staged.alreadyThere.push(`${p.name} (${entry.team})`);
        continue;
      }
      if (!Array.isArray(doc.players[entry.team])) {
        log(`WARNING: staged add ${p.name} names team ${entry.team}, which the file doesn't carry - skipped.`);
        continue;
      }
      doc.players[entry.team].push(p);
      known.add(String(p.espnId));
      knownNames.add(norm(p.name));
      staged.merged.push(`${p.name} (${entry.team}, ${p.position}) impact ${p.impactScore}, ${p.status}`);
    }
  }

  const season = new Date().getUTCFullYear();
  const teamIds = new Map();
  log("Fetching ESPN rosters and injury feed...");
  const [rosterIndex, injuries] = await Promise.all([buildRosterIndex(teams, teamIds), fetchInjuries()]);
  log(`Fetching depth charts for ${teamIds.size} teams...`);
  const starters = await fetchStarters(teamIds, season);
  log(`${starters.size} first-string players identified.`);
  const byId = new Map(all().map(([t, p]) => [p.espnId, { team: t, player: p }]));

  const changes = { ids: [], bootstrapped: 0, applied: [], added: [], pinnedSkips: [], needsReview: [], unresolved: [] };

  // ---- 1. espnId ---------------------------------------------------------
  for (const [team, p] of all()) {
    if (p.espnId) continue;
    const { id, ambiguous } = resolveId(rosterIndex, p.name, team, p.position);
    if (id) {
      p.espnId = id;
      changes.ids.push(`${p.name} (${team}) -> ${id}${ambiguous ? " [name shared, took team+position]" : ""}`);
    } else {
      changes.unresolved.push(`${p.name} (${team}, ${p.position})`);
    }
  }

  // ---- 2. status ---------------------------------------------------------
  for (const [team, p] of all()) {
    // Bootstrap: stamp an existing opinion as curated-as-of-now WITHOUT
    // changing it. This is what stops the first run from overwriting every
    // standing disagreement with ESPN's version.
    if (!p.statusUpdatedAt) {
      p.statusUpdatedAt = now;
      p.source = p.source || "curated";
      changes.bootstrapped++;
      continue;
    }

    const e = injuries[p.espnId];
    if (!e || !e.date) continue;
    if (e.state === p.status) continue;
    if (Date.parse(e.date) <= Date.parse(p.statusUpdatedAt)) continue;  // our opinion is newer

    if (p.pinned) {
      changes.pinnedSkips.push(`${p.name} (${team}) ${p.status} vs ESPN ${e.state}`);
      continue;
    }

    // DIRECTION MATTERS, and this is the rule that makes unattended running
    // safe rather than actively harmful.
    //
    // Escalations - a player getting worse - are always applied. They're the
    // timely ones, and ESPN is rarely wrong about someone being MORE hurt
    // than we thought.
    //
    // De-escalations are only applied when we're following ESPN's own chain
    // (source "auto"). When a human set the status, ESPN saying he's better
    // is very often ESPN being behind: measured on the real file, 8 of the
    // 13 standing disagreements were exactly this - a player carried as out
    // whom ESPN still listed questionable. Letting the feed silently
    // downgrade a human's "out" would throw away the judgment that makes
    // this file worth having. Those go to review instead.
    const escalating = SEVERITY[e.state] > SEVERITY[p.status];
    if (!escalating && p.source !== "auto") {
      changes.needsReview.push(`${p.name} (${team}) ours ${p.status} -> ESPN ${e.state} (de-escalation, human-set - not applied)`);
      continue;
    }

    const from = p.status;
    p.status = e.state;
    p.statusUpdatedAt = e.date;
    p.source = "auto";
    if (e.state === "active") {
      // The narrative no longer describes the situation once he's back.
      p.injury = null;
      p.activatedDate = e.date.slice(0, 10);
    } else {
      p.injury = { type: e.type || (p.injury && p.injury.type) || "Undisclosed", note: e.comment || null };
    }
    changes.applied.push(`${p.name} (${team}) ${from} -> ${e.state}  [ESPN ${e.status}, ${e.date}]`);
  }

  // ---- 3. auto-add -------------------------------------------------------
  for (const e of Object.values(injuries)) {
    if (byId.has(e.id)) continue;
    if (e.state !== "out") continue;                       // only real designations
    if (!PREMIUM.has(String(e.position || "").toUpperCase())) continue;
    // The gate that keeps this from adding 52 camp bodies every August.
    if (!starters.has(e.id)) continue;
    if (!doc.players[e.team]) continue;                    // team we don't carry
    const score = AUTO_IMPACT[String(e.position).toUpperCase()] ?? AUTO_IMPACT_DEFAULT;
    doc.players[e.team].push({
      name: e.name, position: e.position, espnId: e.id,
      impactScore: score, status: e.state,
      injury: { type: e.type || "Undisclosed", note: e.comment || null },
      statusUpdatedAt: e.date || now, source: "auto",
    });
    changes.added.push(`${e.name} (${e.team}, ${e.position}) impact ${score} [auto]`);
  }

  // ---- report ------------------------------------------------------------
  const total = Object.values(doc.players).flat().length;
  log(`${total} tracked players.`);
  if (changes.bootstrapped) log(`Bootstrapped ${changes.bootstrapped} existing player(s) as curated-as-of-now (not changed).`);
  const section = (title, list) => { if (list.length) { log(title); list.forEach((l) => console.log("   " + l)); } };
  section(`Merged ${staged.merged.length} player(s) staged from the review panel:`, staged.merged);
  section(`${staged.alreadyThere.length} staged add(s) were already in the file:`, staged.alreadyThere);
  section(`Resolved ${changes.ids.length} missing espnId:`, changes.ids);
  section(`Auto-applied ${changes.applied.length} status change(s):`, changes.applied);
  section(`Auto-added ${changes.added.length} player(s):`, changes.added);
  section(`Skipped ${changes.pinnedSkips.length} pinned player(s):`, changes.pinnedSkips);
  section(`${changes.needsReview.length} de-escalation(s) left for you - ESPN says better, a human said worse:`, changes.needsReview);
  section(`COULD NOT RESOLVE an espnId for ${changes.unresolved.length} player(s) - these will never join to ESPN:`, changes.unresolved);

  // ---- validate ----------------------------------------------------------
  const flat = Object.values(doc.players).flat();
  const missing = flat.filter((p) => !p.espnId).map((p) => p.name);
  const ids = flat.map((p) => p.espnId).filter(Boolean);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new Error(`Duplicate espnId(s): ${[...new Set(dupes)].join(", ")}`);
  if (missing.length) log(`WARNING: ${missing.length} player(s) still without an espnId: ${missing.join(", ")}`);

  const touched = changes.ids.length + changes.applied.length + changes.added.length
    + changes.bootstrapped + staged.merged.length;
  if (!touched) { log("Nothing to change."); return; }

  if (dryRun) { log("Dry run - nothing written."); return; }

  await writeBothCopies(doc);
  log("Wrote data/impact-players.json and the index.html seed.");
  // Only now is it safe to clear the staging list. Note this leaves the
  // player on disk but not yet committed - the git push is still yours.
  await ackPendingAdds(staged.ack);
  if (doPublish) await publish(doc);
}

main().catch((err) => { console.error(err); process.exit(1); });

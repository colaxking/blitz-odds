import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { seasonHasStarted } from "./lib/kickoff.mts";
import {
  HOUSE_SERIES, LEAGUE_STORE, ROLLOVER_AT, MAX_INSTANCES,
  buildHouseLeague, houseLeagueId, houseLeagueName,
} from "./lib/house-leagues.mts";

// Keeps the official house leagues alive across the season. Idempotent by
// construction - safe to run as often as you like, and safe to re-run after
// a partial failure.
//
// POST /.netlify/functions/house-leagues-maintain
//   Header: x-house-leagues-secret: $HOUSE_LEAGUES_SECRET
//   Body (optional): { "season": 2026, "dryRun": true }
//
// Four jobs, in order:
//
//   1. SEED    - create any catalog series that has no instance yet.
//   2. RECOUNT - recompute every house league's memberCount from its members
//                doc. This is the only thing that ever writes that number.
//                Nothing here invents members; a league that nobody has
//                joined reports 0 and shows as empty, which is the honest
//                and correct thing for it to do.
//   3. ROLLOVER - when the newest instance of a series passes ROLLOVER_AT of
//                capacity, open the next one, so there is always somewhere
//                with room to join without ever showing a wall of empty
//                leagues nobody asked for.
//   4. CLOSE   - lock survivor instances once the season opener kicks off
//                (entry is Week 1 only), since a mid-season entrant in a
//                one-team-a-week elimination format has no coherent state.
//
// DELETION IS RESPECTED. Every instance this job creates is recorded in
// house:index:{season}. If an id is in that index but its league blob is
// gone, an admin deleted it on purpose (via admin-league) and this job will
// NOT resurrect it. Without that record, "create anything missing" would
// silently undo every deletion on the next run.
//
// Auth is a shared secret header, same pattern as hotpicks-update - this is
// called by GitHub Actions (see .github/workflows/house-leagues-maintain.yml),
// not by a signed-in user, so there's no Identity JWT to verify.

const SITE_DATA_STORE = "blitz-site-data";
const CURRENT_SEASON = 2026;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-house-leagues-secret",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const secret = process.env.HOUSE_LEAGUES_SECRET;
  if (!secret) return jsonResponse(500, { ok: false, error: "HOUSE_LEAGUES_SECRET is not configured" });
  if (req.headers.get("x-house-leagues-secret") !== secret) {
    return jsonResponse(403, { ok: false, error: "Forbidden" });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is the normal case from the scheduled caller.
  }
  const season = typeof body.season === "number" ? body.season : CURRENT_SEASON;
  const dryRun = body.dryRun === true;

  // Strong consistency throughout: this is a read-modify-write over the
  // index and over each league's memberCount, and the job can overlap with
  // a live join writing the same members doc.
  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const actions: string[] = [];

  try {
    const schedule: any = await getStore(SITE_DATA_STORE).get("schedule", { type: "json" });
    const started = seasonHasStarted(schedule, season);

    const indexKey = `house:index:${season}`;
    const indexDoc: any = (await leagueStore.get(indexKey, { type: "json" })) || { season, created: [] };
    const created: string[] = Array.isArray(indexDoc.created) ? indexDoc.created : [];
    const createdSet = new Set(created);

    for (const series of HOUSE_SERIES) {
      // Every instance this job has ever created for this series, whether or
      // not it still exists.
      const known: number[] = created
        .filter((id) => id.startsWith(`house-${season}-${series.slug}-`))
        .map((id) => Number(id.slice(id.lastIndexOf("-") + 1)))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);

      // Load the ones that are still live. A gap here means an admin deleted
      // that instance; it stays deleted.
      const live: any[] = [];
      for (const seq of known) {
        const rec: any = await leagueStore.get(`league:${houseLeagueId(season, series.slug, seq)}`, { type: "json" });
        if (rec) live.push(rec);
      }

      /* ---- 1. SEED: no instance has ever been created for this series ---- */
      if (!known.length) {
        // Survivor is season-long with Week 1 entry only, so there's no
        // point standing one up after the opener - it would be locked the
        // moment it appeared.
        if (series.closesAtSeasonOpener && started) {
          actions.push(`skip-seed ${series.slug} (season already started)`);
          continue;
        }
        const league = buildHouseLeague(series, season, 1);
        if (!dryRun) {
          await leagueStore.setJSON(`league:${league.id}`, league);
          await leagueStore.setJSON(`members:${league.id}`, { leagueId: league.id, members: [] });
          createdSet.add(league.id);
        }
        actions.push(`seed ${league.id} (${league.name})`);
        continue;
      }

      /* ---- 2. RECOUNT + 4. CLOSE, per live instance ---- */
      for (const league of live) {
        const membersDoc: any = await leagueStore.get(`members:${league.id}`, { type: "json" });
        const actual = Array.isArray(membersDoc?.members) ? membersDoc.members.length : 0;

        // Entry closes at the season opener for survivor. league-join.mts
        // already refuses a locked league, so this is the whole enforcement.
        const shouldLock = series.closesAtSeasonOpener && started;

        const needsWrite = league.memberCount !== actual || (shouldLock && !league.locked);
        if (needsWrite) {
          if (league.memberCount !== actual) {
            actions.push(`recount ${league.id}: ${league.memberCount} -> ${actual}`);
          }
          if (shouldLock && !league.locked) {
            actions.push(`close ${league.id} (season opener passed, entry was week 1 only)`);
          }
          if (!dryRun) {
            await leagueStore.setJSON(`league:${league.id}`, {
              ...league,
              memberCount: actual,
              locked: shouldLock ? true : league.locked,
              updatedAt: new Date().toISOString(),
            });
          }
        }
        league.memberCount = actual; // for the rollover check below
      }

      /* ---- 3. ROLLOVER ---- */
      const newestSeq = known[known.length - 1];
      const newest = live.find((l) => l.houseSeq === newestSeq);
      // Only the newest instance can trigger a rollover. If it was deleted,
      // that was deliberate and the series is being wound down.
      if (!newest) continue;
      if (series.closesAtSeasonOpener && started) continue; // no new survivor pools mid-season
      if (newestSeq >= MAX_INSTANCES) {
        actions.push(`skip-rollover ${series.slug} (at MAX_INSTANCES ${MAX_INSTANCES})`);
        continue;
      }

      const cap = newest.maxMembers || series.maxMembers;
      if (newest.memberCount >= Math.floor(cap * ROLLOVER_AT)) {
        const next = buildHouseLeague(series, season, newestSeq + 1);
        if (!dryRun) {
          await leagueStore.setJSON(`league:${next.id}`, next);
          await leagueStore.setJSON(`members:${next.id}`, { leagueId: next.id, members: [] });
          createdSet.add(next.id);
        }
        actions.push(
          `rollover ${series.slug}: ${houseLeagueName(series, newestSeq)} at ${newest.memberCount}/${cap} -> opened ${next.name}`
        );
      }
    }

    if (!dryRun && createdSet.size !== created.length) {
      await leagueStore.setJSON(indexKey, {
        season,
        created: Array.from(createdSet).sort(),
        updatedAt: new Date().toISOString(),
      });
    }

    return jsonResponse(200, {
      ok: true,
      season,
      dryRun,
      seasonStarted: started,
      actions,
      changed: actions.length,
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/house-leagues-maintain",
};

import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requireAdmin, adminJson, forbidden, audit, ADMIN_CORS } from "./lib/admin.mts";
import { makeGameId } from "./lib/gameId.mts";
import { rescoreLeague } from "./lib/rescore.mts";

// GET  /.netlify/functions/admin-picks?leagueId=..&week=..&userId=..
//        -> { ok, league, games, picks, scored }
// POST /.netlify/functions/admin-picks
//        { leagueId, week, userId, changes: [{ gameId, team, confidence? }] }
//        -> { ok, saved, rescore }
//
// The one endpoint in this console that writes something a user is supposed
// to own, so it's the one with the most guard rails:
//
//  - Every change is compared against what's stored and no-ops are dropped,
//    so an accidental re-save doesn't produce an audit line claiming an edit.
//  - The audit row records the BEFORE value of each pick. Nothing else does;
//    picks-submit overwrites in place, so once this endpoint has written,
//    the previous pick exists nowhere except that log line.
//  - A confidence league's uniqueness rule is enforced across the resulting
//    set, not just the changed rows. Two games sharing a confidence value
//    scores wrong quietly rather than failing loudly, which is worse.
//  - Kickoff is NOT checked. Editing a locked pick is the entire purpose.

const LEAGUE_STORE = "blitz-leagues";
const SITE_DATA_STORE = "blitz-site-data";
const CURRENT_SEASON = 2026;

async function weekGamesFor(week: number): Promise<Array<{ away: string; home: string; gameId: string }>> {
  const schedule: any = await getStore(SITE_DATA_STORE, { consistency: "strong" }).get("schedule", { type: "json" });
  const entry = schedule?.weeks?.find((w: any) => w.week === week);
  return (entry?.games || []).map((g: any) => ({
    away: g.away,
    home: g.home,
    gameId: makeGameId(CURRENT_SEASON, week, g.away, g.home),
  }));
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ADMIN_CORS });

  const actor = await requireAdmin(req);
  if (!actor) return forbidden();

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });

  try {
    /* ---------------- read ---------------- */
    if (req.method === "GET") {
      const params = new URL(req.url).searchParams;
      const leagueId = String(params.get("leagueId") || "");
      const week = Number(params.get("week"));
      const userId = String(params.get("userId") || "");
      if (!leagueId || !week || !userId) {
        return adminJson(400, { ok: false, error: "leagueId, week and userId are required" });
      }

      const [league, games, storedResults] = await Promise.all([
        leagueStore.get(`league:${leagueId}`, { type: "json" }) as Promise<any>,
        weekGamesFor(week),
        leagueStore.get(`results:${leagueId}:${week}`, { type: "json" }) as Promise<any>,
      ]);
      if (!league) return adminJson(404, { ok: false, error: "No such league" });

      const picks: Record<string, any> = {};
      await Promise.all(
        games.map(async (g) => {
          const pick = await leagueStore.get(`picks:${leagueId}:${week}:${userId}:${g.gameId}`, { type: "json" });
          if (pick) picks[g.gameId] = pick;
        })
      );

      return adminJson(200, {
        ok: true,
        league: { id: leagueId, name: league.name, format: league.format, scoringSettings: league.scoringSettings || {} },
        games,
        picks,
        results: storedResults?.results || null,
        scored: Boolean(storedResults?.results),
        scores: storedResults?.scores?.[userId] || null,
      });
    }

    /* ---------------- write ---------------- */
    if (req.method !== "POST") return adminJson(405, { ok: false, error: "Method not allowed" });

    let body: any;
    try {
      body = await req.json();
    } catch {
      return adminJson(400, { ok: false, error: "Body must be JSON" });
    }

    const leagueId = String(body.leagueId || "");
    const week = Number(body.week);
    const userId = String(body.userId || "");
    const changes: any[] = Array.isArray(body.changes) ? body.changes : [];
    if (!leagueId || !week || !userId || !changes.length) {
      return adminJson(400, { ok: false, error: "leagueId, week, userId and at least one change are required" });
    }

    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return adminJson(404, { ok: false, error: "No such league" });

    const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
    if (!membersDoc?.members?.some((m: any) => m.userId === userId)) {
      return adminJson(404, { ok: false, error: "That user isn't in this league" });
    }

    const games = await weekGamesFor(week);
    const gameById = new Map(games.map((g) => [g.gameId, g]));

    // Load the full existing week so validation sees the resulting state, not
    // just the rows being touched.
    const existing: Record<string, any> = {};
    await Promise.all(
      games.map(async (g) => {
        const pick = await leagueStore.get(`picks:${leagueId}:${week}:${userId}:${g.gameId}`, { type: "json" });
        if (pick) existing[g.gameId] = pick;
      })
    );

    const applied: Array<{ gameId: string; from: any; to: any }> = [];
    const proposed: Record<string, any> = { ...existing };

    for (const change of changes) {
      const gameId = String(change.gameId || "");
      const game = gameById.get(gameId);
      if (!game) return adminJson(400, { ok: false, error: `Game ${gameId} isn't in week ${week}` });

      const team = String(change.team || "").toUpperCase();
      if (team !== game.away.toUpperCase() && team !== game.home.toUpperCase()) {
        return adminJson(400, { ok: false, error: `${team} isn't playing in ${game.away} @ ${game.home}` });
      }

      const prior = existing[gameId] || null;
      const next: any = { ...(prior || {}), team, updatedAt: new Date().toISOString(), editedByAdmin: actor.id };

      if (change.confidence !== undefined && change.confidence !== null && change.confidence !== "") {
        const confidence = Number(change.confidence);
        if (!Number.isInteger(confidence) || confidence < 1 || confidence > games.length) {
          return adminJson(400, {
            ok: false,
            error: `Confidence must be a whole number from 1 to ${games.length}`,
          });
        }
        next.confidence = confidence;
      }

      // Nothing actually different - drop it so the audit log stays honest.
      if (prior && prior.team === next.team && prior.confidence === next.confidence) continue;

      proposed[gameId] = next;
      applied.push({ gameId, from: prior ? { team: prior.team, confidence: prior.confidence } : null, to: { team: next.team, confidence: next.confidence } });
    }

    if (!applied.length) return adminJson(200, { ok: true, saved: 0, message: "Nothing changed" });

    if (league.format === "confidence" && league.scoringSettings?.uniqueConfidence) {
      const seen = new Map<number, string>();
      for (const [gameId, pick] of Object.entries(proposed)) {
        const c = (pick as any).confidence;
        if (c === undefined || c === null) continue;
        if (seen.has(c)) {
          const other = gameById.get(seen.get(c)!);
          return adminJson(409, {
            ok: false,
            error: `Confidence ${c} would be on two games — also on ${other?.away} @ ${other?.home}`,
          });
        }
        seen.set(c, gameId);
      }
    }

    for (const { gameId } of applied) {
      await leagueStore.setJSON(`picks:${leagueId}:${week}:${userId}:${gameId}`, proposed[gameId]);
    }

    // Dan's call: fixing a pick restores that week's standings and rankings
    // rather than leaving them to be redone by hand. Only runs if the week
    // was actually scored - an in-progress week has nothing to restore, and
    // rescoreLeague reports it as skipped rather than zeroing it.
    let rescore: any = { weeksRescored: [], weeksSkipped: [week] };
    try {
      rescore = await rescoreLeague(leagueStore, leagueId, [week]);
    } catch (err) {
      // The picks are already saved. Surfacing this as a failure would invite
      // a retry that re-saves them and produces a duplicate audit line, so it
      // is reported as a partial success instead.
      return adminJson(200, {
        ok: true,
        saved: applied.length,
        rescoreFailed: err instanceof Error ? err.message : "Rescore failed",
      });
    }

    const member = membersDoc.members.find((m: any) => m.userId === userId);
    const summary = applied
      .map((a) => {
        const g = gameById.get(a.gameId);
        const label = g ? `${g.away} @ ${g.home}` : a.gameId;
        return a.from ? `${label}: ${a.from.team} → ${a.to.team}` : `${label}: → ${a.to.team}`;
      })
      .join("; ");

    await audit(
      actor,
      "picks.edit",
      `changed ${applied.length} of ${member?.displayName || userId}'s week ${week} picks in ${league.name} (${summary})`,
      { target: `${leagueId}:${week}:${userId}`, meta: { applied, rescore } }
    );

    return adminJson(200, { ok: true, saved: applied.length, rescore });
  } catch (err) {
    return adminJson(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/admin-picks",
};

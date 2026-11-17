import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { loadSlate } from "./lib/bowls.mts";
import {
  leagueGames, titleGame, computeStandings, buildGrid, emptyPicksDoc, bowlSettingsOf,
  type BowlPicksDoc,
} from "./lib/bowl-league.mts";

// GET /.netlify/functions/bowl-league?leagueId=...
//   -> { ok, league, games, title, me: { picks, tiebreaker }, standings, grid, members }
//
// Everything a bowl pool screen needs in one call: the league's slate, the
// caller's own sheet, live standings and the pick grid. Members only.
//
// Not behind the "bowls" feature flag on purpose. The flag decides who can
// discover bowls and create a pool; someone who was invited into an existing
// pool is already in, and locking them out of it while Dan tests with "admins
// only" would break exactly the test he's running.
//
// Other members' picks are stripped server-side until each game locks (see
// buildGrid) - hiding them in the UI alone would leave them readable in the
// network panel.

const LEAGUE_STORE = "blitz-leagues";
const CORS_HEADERS: Record<string, string> = { ...CORS_HEADERS_BASE, "Access-Control-Allow-Methods": "GET, OPTIONS" };

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId = claims.id;

  const leagueId = new URL(req.url).searchParams.get("leagueId") || "";
  if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId is required" }, CORS_HEADERS);

  const store = getStore(LEAGUE_STORE, { consistency: "strong" });
  try {
    const [league, membersDoc]: any[] = await Promise.all([
      store.get(`league:${leagueId}`, { type: "json" }),
      store.get(`members:${leagueId}`, { type: "json" }),
    ]);
    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);
    if (league.sport !== "bowls") return jsonResponse(400, { ok: false, error: "Not a bowl pool" }, CORS_HEADERS);
    const members: any[] = membersDoc?.members || [];
    if (!members.some((m) => m.userId === userId)) {
      return jsonResponse(403, { ok: false, error: "Not a member of this league" }, CORS_HEADERS);
    }

    const slate = await loadSlate(league.season);
    const games = leagueGames(slate, league);
    const title = titleGame(slate);

    const docs: Record<string, BowlPicksDoc> = {};
    await Promise.all(members.map(async (m) => {
      try {
        const d: any = await store.get(`bowlpicks:${leagueId}:${m.userId}`, { type: "json" });
        docs[m.userId] = d && d.picks ? d : emptyPicksDoc();
      } catch {
        docs[m.userId] = emptyPicksDoc();
      }
    }));

    const now = Date.now();
    const standings = computeStandings(league, games, title, members, docs, userId, now);
    const grid = buildGrid(league, games, members, docs, userId, now);
    const mine = docs[userId] || emptyPicksDoc();

    return jsonResponse(200, {
      ok: true,
      league,
      settings: bowlSettingsOf(league),
      fetchedAt: slate.fetchedAt,
      games,
      title,
      me: { picks: mine.picks, tiebreaker: mine.tiebreaker, updatedAt: mine.updatedAt },
      standings,
      grid,
      members: members.map((m) => ({ userId: m.userId, displayName: m.displayName, avatar: m.avatar || null, role: m.role })),
    }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/bowl-league",
};

import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { loadSlate } from "./lib/bowls.mts";
import { leagueGames, titleGame, mergeSheet, emptyPicksDoc, type BowlPicksDoc } from "./lib/bowl-league.mts";

// POST /.netlify/functions/bowl-picks-submit
// Body: { leagueId, picks: { [espnEventId]: { teamId: string|null, confidence?: number } }, tiebreaker?: number|null }
//   -> { ok, me: { picks, tiebreaker, updatedAt } }  or  { ok:false, error, errors[] }
//
// Saves a member's whole bowl sheet in one write. Every rule is enforced here,
// not in the UI: picks on games that have kicked off are carried over from
// the stored sheet whatever the client sent, teams must be the two actually
// playing, confidence points must be in range and (by default) unique, ATS
// picks snapshot the line at the moment they're made, and the tiebreaker
// freezes when the title game kicks off.
//
// Nothing is written when any rule fails - a half-saved confidence sheet
// would leave two games on the same points.

const LEAGUE_STORE = "blitz-leagues";
const CORS_HEADERS: Record<string, string> = { ...CORS_HEADERS_BASE, "Access-Control-Allow-Methods": "POST, OPTIONS" };

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId = claims.id;

  let body: any;
  try { body = await req.json(); } catch { return jsonResponse(400, { ok: false, error: "Invalid JSON body" }, CORS_HEADERS); }
  const leagueId = typeof body?.leagueId === "string" ? body.leagueId : "";
  if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId is required" }, CORS_HEADERS);

  const store = getStore(LEAGUE_STORE, { consistency: "strong" });
  try {
    const [league, membersDoc]: any[] = await Promise.all([
      store.get(`league:${leagueId}`, { type: "json" }),
      store.get(`members:${leagueId}`, { type: "json" }),
    ]);
    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);
    if (league.sport !== "bowls") return jsonResponse(400, { ok: false, error: "Not a bowl pool" }, CORS_HEADERS);
    if (league.locked) return jsonResponse(403, { ok: false, error: "This league is locked" }, CORS_HEADERS);
    if (!(membersDoc?.members || []).some((m: any) => m.userId === userId)) {
      return jsonResponse(403, { ok: false, error: "Not a member of this league" }, CORS_HEADERS);
    }

    // Fresh-enough slate is what decides locks. loadSlate's own cache is at
    // most ~75s old around kickoff, and isLocked() also checks the clock
    // against the scheduled kickoff, so a stale "pre" can't sneak a late pick in.
    const slate = await loadSlate(league.season);
    const games = leagueGames(slate, league);
    const title = titleGame(slate);

    const key = `bowlpicks:${leagueId}:${userId}`;
    const storedRaw: any = await store.get(key, { type: "json" });
    const stored: BowlPicksDoc = storedRaw && storedRaw.picks ? storedRaw : emptyPicksDoc();

    const { doc, errors } = mergeSheet(league, games, title, stored, {
      picks: body.picks,
      tiebreaker: body.tiebreaker,
    });
    if (errors.length) {
      return jsonResponse(400, { ok: false, error: errors[0], errors }, CORS_HEADERS);
    }

    await store.setJSON(key, doc);
    return jsonResponse(200, { ok: true, me: { picks: doc.picks, tiebreaker: doc.tiebreaker, updatedAt: doc.updatedAt } }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/bowl-picks-submit",
};

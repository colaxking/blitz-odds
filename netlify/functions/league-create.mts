import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, displayNameFromClaims } from "./lib/auth.mts";

// Creates a new pick'em league. Authenticated (Netlify Identity JWT)
// callers only - the creator becomes the owner and first member.
//
// POST /.netlify/functions/league-create   Body: { name: string }
//
// Data model (single "blitz-leagues" store, prefixed keys - same pattern as
// blitz-site-data's teams/players/schedule/etc):
//   league:{leagueId}          -> league record (name, owner, invite code, season, memberCount)
//   members:{leagueId}         -> { members: [{ userId, displayName, role, joinedAt }] }
//   invite:{inviteCode}        -> { leagueId }   (fast lookup for league-join.mts)
//
// The caller's users:{id} blob (in the separate "blitz-users" store) is
// updated to include the new league in its `leagues` array, so
// leagues-mine.mts doesn't need to scan every league in the store.

const LEAGUE_STORE = "blitz-leagues";
const USER_STORE = "blitz-users";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I - avoids ambiguous invite codes
const CURRENT_SEASON = 2026;

// "ats" is accepted here (schema-complete) but scoringEngine.js throws if
// actually scored with it - it's gated on point-spread data availability
// from the odds provider, not yet wired up. See js/scoringEngine.js header.
const VALID_FORMATS = new Set(["straight_up", "confidence", "survivor", "ats"]);
const VALID_VISIBILITY = new Set(["private", "public"]);
const VALID_TIE_BREAKERS = new Set(["most_correct", "fewest_incorrect", null]);
const DEFAULT_FORMAT = "straight_up";

// Deadlines lock per-game at that game's own kickoff (Dan's call - not a
// whole-week lock at the first game). "per_game" is the only value
// implemented; the field exists so a future "whole_week" mode doesn't need
// a schema migration.
const VALID_PICK_DEADLINES = new Set(["per_game"]);

function defaultScoringSettings(format: string) {
  return {
    pointsPerCorrect: 1,
    tieHandling: "void", // "void" | "both_correct" | "incorrect"
    uniqueConfidence: format === "confidence" ? true : undefined,
    survivorTieHandling: format === "survivor" ? "eliminate" : undefined, // "eliminate" | "survive"
    survivorShowEliminated: format === "survivor" ? true : undefined,
    // How many losing picks it takes to be eliminated. 1 = classic Survivor.
    // Chosen at creation and frozen once the season's first game kicks off
    // (see league-settings-update.mts) - it changes who is already out, so
    // it can't move under members mid-season.
    survivorStrikes: format === "survivor" ? 1 : undefined,
    atsEnabled: false,
  };
}

function sanitizeScoringSettings(format: string, incoming: any) {
  const base = defaultScoringSettings(format);
  if (!incoming || typeof incoming !== "object") return base;
  const out: any = { ...base };
  if (typeof incoming.pointsPerCorrect === "number" && incoming.pointsPerCorrect > 0) {
    out.pointsPerCorrect = incoming.pointsPerCorrect;
  }
  if (["void", "both_correct", "incorrect"].includes(incoming.tieHandling)) {
    out.tieHandling = incoming.tieHandling;
  }
  if (format === "confidence" && typeof incoming.uniqueConfidence === "boolean") {
    out.uniqueConfidence = incoming.uniqueConfidence;
  }
  if (format === "survivor") {
    if (["eliminate", "survive"].includes(incoming.survivorTieHandling)) {
      out.survivorTieHandling = incoming.survivorTieHandling;
    }
    if (typeof incoming.survivorShowEliminated === "boolean") {
      out.survivorShowEliminated = incoming.survivorShowEliminated;
    }
    if (typeof incoming.survivorStrikes === "number" && incoming.survivorStrikes >= 1 && incoming.survivorStrikes <= 4) {
      out.survivorStrikes = Math.floor(incoming.survivorStrikes);
    }
  }
  return out;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

// Auth: verifies the caller's Netlify Identity JWT against the site's own
// hosted Identity (GoTrue) endpoint. context.clientContext.user - what
// older docs describe - is a v1/Lambda-handler-only mechanism and is never
// populated for modern v2 "export default" functions like this one
// (confirmed via a temporary debug endpoint). Hitting the Identity
// endpoint's /user route with the same Bearer token is what GoTrue's own
// client libraries do internally, and works regardless of function runtime.
// Auth is the shared lib/auth.mts verifier, which this function used to
// carry its own copy of. The copy is gone deliberately: the shared one also
// refuses a SUSPENDED account, and a local duplicate would quietly opt this
// endpoint out of that.

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" });

  const userId: string = claims.id;
  const claimsDisplayName = displayNameFromClaims(claims);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 50) : "";
  if (!name) return jsonResponse(400, { ok: false, error: "League name is required" });

  const description = typeof body.description === "string" ? body.description.trim().slice(0, 280) : "";

  const format = VALID_FORMATS.has(body.format) ? body.format : DEFAULT_FORMAT;
  const visibility = VALID_VISIBILITY.has(body.visibility) ? body.visibility : "private";
  const pickDeadline = VALID_PICK_DEADLINES.has(body.pickDeadline) ? body.pickDeadline : "per_game";
  const tieBreaker = VALID_TIE_BREAKERS.has(body.tieBreaker ?? null) ? (body.tieBreaker ?? null) : null;

  let maxMembers: number | null = null;
  if (typeof body.maxMembers === "number" && body.maxMembers >= 2 && body.maxMembers <= 500) {
    maxMembers = Math.floor(body.maxMembers);
  }

  const scoringSettings = sanitizeScoringSettings(format, body.scoringSettings);

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  // Strong consistency, same reasoning as league-join.mts's own read-your-
  // writes fix - a client that creates a league and immediately reloads
  // leagues-mine.mts shouldn't be able to read its own write as stale.
  const userStore = getStore(USER_STORE, { consistency: "strong" });

  try {
    // Generate a unique invite code - collisions are astronomically unlikely
    // at this scale (32^6) but check anyway rather than trust the odds.
    let inviteCode = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateInviteCode();
      const existing = await leagueStore.get(`invite:${candidate}`, { type: "json" });
      if (!existing) {
        inviteCode = candidate;
        break;
      }
    }
    if (!inviteCode) return jsonResponse(500, { ok: false, error: "Could not generate a unique invite code, try again" });

    const leagueId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Prefer the user's already-saved profile displayName/avatar (set via
    // Settings) over the raw Identity claims - otherwise a member who
    // customized their name/icon before ever creating/joining a league
    // would see the un-customized claims version baked into this league's
    // roster from day one.
    const profile: any = (await userStore.get(`users:${userId}`, { type: "json" })) || {
      id: userId,
      email: claims.email || null,
      displayName: claimsDisplayName,
      subscriptionTier: "free",
      leagues: [],
      createdAt: now,
    };
    const displayName = (typeof profile.displayName === "string" && profile.displayName.trim())
      ? profile.displayName
      : claimsDisplayName;
    const avatar = typeof profile.avatar === "string" ? profile.avatar : null;

    const league = {
      id: leagueId,
      name,
      description,
      ownerId: userId,
      ownerName: displayName,
      season: CURRENT_SEASON,
      inviteCode,
      memberCount: 1,
      format,
      visibility,
      maxMembers,
      pickDeadline,
      tieBreaker,
      scoringSettings,
      locked: false,
      createdAt: now,
      updatedAt: now,
    };

    const members = {
      leagueId,
      members: [{ userId, displayName, avatar, role: "owner", joinedAt: now }],
    };

    await Promise.all([
      leagueStore.setJSON(`league:${leagueId}`, league),
      leagueStore.setJSON(`members:${leagueId}`, members),
      leagueStore.setJSON(`invite:${inviteCode}`, { leagueId }),
    ]);

    // Merge-update the owner's profile with the new league id.
    const leagues = Array.isArray(profile.leagues) ? profile.leagues : [];
    if (!leagues.includes(leagueId)) leagues.push(leagueId);
    await userStore.setJSON(`users:${userId}`, { ...profile, leagues, updatedAt: now });

    return jsonResponse(201, { ok: true, league });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-create",
};

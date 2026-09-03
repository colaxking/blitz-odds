import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { seasonHasStarted } from "./lib/kickoff.mts";

// Updates the editable settings of a league the caller owns. Owner-only -
// every other member gets a 403, same as they'd get from any other write
// endpoint on someone else's league.
//
// POST /.netlify/functions/league-settings-update
// Body: { leagueId, name?, description?, visibility?, maxMembers?,
//         tieBreaker?, scoringSettings?: { pointsPerCorrect?, tieHandling?,
//         uniqueConfidence?, survivorTieHandling?, survivorShowEliminated?,
//         survivorStrikes? } }
//
// survivorStrikes (how many losing picks eliminate you) is the one scoring
// setting that FREEZES once the season's first game kicks off. Everything
// else here is cosmetic or forward-looking, but this one retroactively
// decides who is already eliminated - dropping it from 3 to 1 mid-season
// would knock out members who were alive a second earlier. Attempting to
// change it after kickoff rejects with a 409 rather than being silently
// ignored, so a stale client fails loudly. Sending the value it already
// has is a no-op and always allowed, so a form that posts the whole
// settings object doesn't start failing in week 2.
//
// format is intentionally NOT accepted here, ever - a league's pick'em
// format (straight_up/confidence/survivor/ats) defines what picks even
// mean (a Straight-Up pick has no confidence value, a Survivor pick has no
// per-game independence, an ats pick needs a spread snapshot) - changing
// it after members have already made picks under the old format would
// leave existing picks in a shape the new format's scoring code doesn't
// understand. If the body includes a "format" key at all (even if it
// matches the league's current format), this rejects with a 400 rather
// than silently ignoring it, so a client bug that tries to send it fails
// loudly instead of looking like it worked.
//
// scoringSettings is a partial merge over the league's EXISTING settings
// (not the defaults-for-format league-create.mts uses), so updating just
// pointsPerCorrect doesn't reset uniqueConfidence back to its default.

const LEAGUE_STORE = "blitz-leagues";
const SITE_DATA_STORE = "blitz-site-data";

const VALID_VISIBILITY = new Set(["private", "public"]);
const VALID_TIE_BREAKERS = new Set(["most_correct", "fewest_incorrect", null]);

function sanitizeScoringSettingsPatch(format: string, existing: any, incoming: any) {
  const out: any = { ...(existing || {}) };
  if (!incoming || typeof incoming !== "object") return out;

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
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  const userId = claims.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" }, CORS_HEADERS);
  }

  const leagueId = typeof body.leagueId === "string" ? body.leagueId : "";
  if (!leagueId) return jsonResponse(400, { ok: false, error: "leagueId is required" }, CORS_HEADERS);

  if (Object.prototype.hasOwnProperty.call(body, "format")) {
    return jsonResponse(400, { ok: false, error: "League format can't be changed after creation" }, CORS_HEADERS);
  }

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });

  try {
    const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
    if (!league) return jsonResponse(404, { ok: false, error: "League not found" }, CORS_HEADERS);
    if (league.ownerId !== userId) {
      return jsonResponse(403, { ok: false, error: "Only the league owner can change settings" }, CORS_HEADERS);
    }

    const updated: any = { ...league };

    if (typeof body.name === "string") {
      const name = body.name.trim().slice(0, 50);
      if (!name) return jsonResponse(400, { ok: false, error: "League name can't be empty" }, CORS_HEADERS);
      updated.name = name;
    }
    if (typeof body.description === "string") {
      updated.description = body.description.trim().slice(0, 280);
    }
    if (typeof body.visibility === "string") {
      if (!VALID_VISIBILITY.has(body.visibility)) {
        return jsonResponse(400, { ok: false, error: `Invalid visibility. Valid: ${[...VALID_VISIBILITY].join(", ")}` }, CORS_HEADERS);
      }
      updated.visibility = body.visibility;
    }
    if (body.maxMembers !== undefined) {
      if (body.maxMembers === null) {
        updated.maxMembers = null;
      } else if (typeof body.maxMembers === "number" && body.maxMembers >= 2 && body.maxMembers <= 500) {
        if (typeof league.memberCount === "number" && body.maxMembers < league.memberCount) {
          return jsonResponse(400, { ok: false, error: `maxMembers can't be less than the current member count (${league.memberCount})` }, CORS_HEADERS);
        }
        updated.maxMembers = Math.floor(body.maxMembers);
      } else {
        return jsonResponse(400, { ok: false, error: "maxMembers must be between 2 and 500, or null for unlimited" }, CORS_HEADERS);
      }
    }
    if (body.tieBreaker !== undefined) {
      if (!VALID_TIE_BREAKERS.has(body.tieBreaker)) {
        return jsonResponse(400, { ok: false, error: `Invalid tieBreaker. Valid: ${[...VALID_TIE_BREAKERS].filter(Boolean).join(", ")}, or null` }, CORS_HEADERS);
      }
      updated.tieBreaker = body.tieBreaker;
    }
    if (body.scoringSettings !== undefined) {
      const incomingStrikes = body.scoringSettings?.survivorStrikes;
      const currentStrikes = league.scoringSettings?.survivorStrikes ?? 1;
      const wantsStrikeChange =
        league.format === "survivor" &&
        typeof incomingStrikes === "number" &&
        Math.floor(incomingStrikes) !== currentStrikes;

      if (wantsStrikeChange) {
        const schedule: any = await getStore(SITE_DATA_STORE).get("schedule", { type: "json" });
        if (seasonHasStarted(schedule, league.season)) {
          return jsonResponse(409, {
            ok: false,
            error: "Losses before elimination is locked once the season's first game has started",
          }, CORS_HEADERS);
        }
      }

      updated.scoringSettings = sanitizeScoringSettingsPatch(league.format, league.scoringSettings, body.scoringSettings);
    }

    updated.updatedAt = new Date().toISOString();
    await leagueStore.setJSON(`league:${leagueId}`, updated);

    return jsonResponse(200, { ok: true, league: updated }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/league-settings-update",
};

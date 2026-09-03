import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { TERMS_VERSION, VALID_TERMS_SOURCES, MAX_TERMS_HISTORY } from "./lib/terms.mts";
import { verifyToken, isSuspended, suspensionInfo, suspendedResponse, isUnverified, unverifiedResponse, displayNameFromClaims } from "./lib/auth.mts";

// Authenticated read/write for a single user's profile blob. This is the
// unified record backing both the (future) Pro subscription gate and
// pick'em leagues - one identity, one blob, two feature sets reading/writing
// different fields on it.
//
// Auth: requires a Netlify Identity JWT as a Bearer token, verified by
// lib/auth.mts. (This function used to carry its own copy of that
// verification, predating the shared lib; the copy is gone so that the
// suspension check added to the shared verifier applies here too.) The
// original note is worth keeping: context.clientContext.user, which older
// Netlify Functions docs describe, is a v1/Lambda-compatible-handler-only
// mechanism and is never populated for modern v2 "export default" functions
// (confirmed via a temporary debug endpoint: Authorization header arrived
// with a valid-looking JWT, but context.clientContext was entirely absent).
// Hitting GET {site}/.netlify/identity/user with the same Bearer token is
// the same verification GoTrue's own client libraries use, and works
// identically regardless of function runtime version. We never trust a
// userId passed in the request body/query for anything other than
// admin-style lookups (not exposed here) - the authenticated user can only
// ever read/write their own record, keyed by their Identity user id.
//
// WHY verifyToken AND NOT getAuthenticatedUser. This is the one endpoint a
// suspended user must get a MEANINGFUL refusal from. The app fetches this on
// sign-in, so it's the natural channel for telling them what happened;
// getAuthenticatedUser would return null and this would answer 401, which
// the client reads as "sign in" and bounces them into a login they can
// complete and still get nowhere. Every other endpoint uses the gated
// verifier and gives them the ordinary 401.
//
// GET  /.netlify/functions/user-profile          -> caller's own profile
//        (creates a default record on first login if none exists yet)
// POST /.netlify/functions/user-profile           -> merge-update caller's
//        own profile. Body: { displayName?, leagues?: string[], settings?: {
//        themeMode?, sportsbookId?, tzId?, favorites? } }
//        subscriptionTier is intentionally not settable here - that will be
//        driven by the Stripe webhook once billing exists.
//
// `settings` mirrors the device-local preferences the app already keeps in
// localStorage (theme, sportsbook, timezone, favorite teams). For signed-in
// users this is the source of truth instead - the client fetches it once on
// sign-in and applies it over whatever was on this device, then pushes any
// further changes back here so the same preferences follow the user to
// their next login/device. Signed-out users keep using localStorage only.

const STORE_NAME = "blitz-users";
const LEAGUE_STORE = "blitz-leagues";

// TERMS_VERSION and friends are shared with auth-signup.mts - see lib/terms.mts.
const VALID_THEME_MODES = new Set(["light", "dark", "system"]);
// Mirrors the `id` values in PROFILE_AVATARS in index.html - keep these two
// lists in sync if avatar options are ever added/removed.
const VALID_AVATAR_IDS = new Set([
  "blitz-edge", "bolt", "check",
  "football", "trophy", "medal", "target", "fire", "goat", "chart",
  "shield", "cleat", "cap", "clipboard", "party", "muscle", "flag",
  "clock", "stadium", "horn",
]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

function defaultSettings() {
  return {
    themeMode: "system",
    sportsbookId: "draftkings",
    tzId: "auto",
    favorites: [] as string[],
    tutorialSeen: false,
    tutorialOutcome: null as string | null,
    tutorialLastStep: null as string | null,
    tutorialSeenAt: null as string | null,
  };
}

function defaultProfile(claims: any) {
  const now = new Date().toISOString();
  return {
    id: claims.id,
    email: claims.email || null,
    displayName: displayNameFromClaims(claims),
    subscriptionTier: "free",
    leagues: [],
    settings: defaultSettings(),
    // Null rather than absent so the shape is stable for every reader. A
    // profile created before this existed backfills to the same thing, and
    // both cases are correctly treated as "has not accepted yet".
    termsAcceptedVersion: null,
    termsAcceptedAt: null,
    termsHistory: [] as any[],
    createdAt: now,
    updatedAt: now,
  };
}

// Decorates a stored profile with the two derived terms fields the client
// actually reads. Deliberately computed on every response instead of stored:
// `termsAcceptanceRequired` is a comparison against TERMS_VERSION, and
// storing it would leave every existing record stale the moment the version
// is bumped.
function withTermsState(profile: any, claims?: any) {
  /* Two places an acceptance can live, and the identity metadata is checked
     first because it is the earlier of the two. auth-signup.mts stamps the
     version into user_metadata at account creation, which happens before any
     profile blob exists - so on a brand new account the blob says null while
     the account has genuinely accepted. Reading only the blob would show
     every new signup the re-consent gate on their very first load. */
  const meta = claims?.user_metadata || {};
  const acceptedVersion = profile.termsAcceptedVersion ?? meta.terms_accepted_version ?? null;
  const acceptedAt = profile.termsAcceptedAt ?? meta.terms_accepted_at ?? null;
  return {
    ...profile,
    termsAcceptedVersion: acceptedVersion,
    termsAcceptedAt: acceptedAt,
    termsCurrentVersion: TERMS_VERSION,
    termsAcceptanceRequired: acceptedVersion !== TERMS_VERSION,
  };
}

// Whitelists and coerces incoming settings fields rather than trusting the
// body wholesale - this blob is small and cheap to write, but it's still
// client-supplied input.
function sanitizeSettings(input: any, existing: any) {
  const base = existing && typeof existing === "object" ? existing : defaultSettings();
  const out = { ...base };

  if (VALID_THEME_MODES.has(input.themeMode)) out.themeMode = input.themeMode;
  if (typeof input.sportsbookId === "string" && input.sportsbookId.trim()) {
    out.sportsbookId = input.sportsbookId.trim().slice(0, 40);
  }
  if (typeof input.tzId === "string" && input.tzId.trim()) {
    out.tzId = input.tzId.trim().slice(0, 60);
  }
  if (Array.isArray(input.favorites)) {
    out.favorites = [...new Set(input.favorites.filter((f: unknown) => typeof f === "string"))].slice(0, 32);
  }
  /* One-way flip: once true (tour completed or skipped), never revert to
     false from a stale client payload that simply omitted the field. Only
     an admin can clear it - see admin-user-update.mts's reset-tutorial,
     which writes the blob directly rather than coming through here.

     The three fields beside it say WHICH of those two happened, since the
     boolean alone can't: Done and Skip both set it, so without these every
     account that has met the tour looks the same afterwards. They're only
     accepted in the same payload that sets the flag, so a client can't
     rewrite the outcome of a run it isn't reporting. */
  if (input.tutorialSeen === true) {
    out.tutorialSeen = true;
    out.tutorialOutcome = input.tutorialOutcome === "completed" ? "completed" : "skipped";
    out.tutorialLastStep =
      typeof input.tutorialLastStep === "string" && input.tutorialLastStep
        ? input.tutorialLastStep.slice(0, 40)
        : null;
    // Client-stamped, and treated as approximate for that reason - it is a
    // support and product signal, not an audit record.
    out.tutorialSeenAt =
      typeof input.tutorialSeenAt === "string" && !Number.isNaN(Date.parse(input.tutorialSeenAt))
        ? input.tutorialSeenAt
        : new Date().toISOString();
  }

  return out;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const claims = await verifyToken(req);
  if (!claims || !claims.id) {
    return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" });
  }

  // Answered before anything is read or written. A suspended account gets
  // the reason and nothing else - not their profile, and certainly not a
  // successful write.
  if (isSuspended(claims)) return suspendedResponse(suspensionInfo(claims));

  // Same reasoning one step down: this is the endpoint the app fetches on
  // sign-in, so it is the one that has to say WHY an account can't do
  // anything. Every other endpoint just 401s an unverified caller (see
  // getAuthenticatedUser); if this one did too, the app would show a
  // generic error instead of the screen with the Resend button on it.
  if (isUnverified(claims)) return unverifiedResponse(claims.email);

  const userId: string = claims.id;
  const store = getStore(STORE_NAME, { consistency: "strong" });
  const key = `users:${userId}`;

  try {
    if (req.method === "GET") {
      let profile: any = await store.get(key, { type: "json" });
      if (!profile) {
        profile = defaultProfile(claims);
        await store.setJSON(key, profile);
      } else if (!profile.settings) {
        // Profile created before `settings` existed - backfill defaults
        // rather than sending the client an undefined settings object.
        profile = { ...profile, settings: defaultSettings() };
      }
      return jsonResponse(200, withTermsState(profile, claims));
    }

    if (req.method === "POST") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
      }

      const existing: any = (await store.get(key, { type: "json" })) || defaultProfile(claims);

      // --- Terms acceptance ---
      // One-way and version-stamped server-side. The client sends
      // `acceptTerms: true` (optionally with a source), never a version, so
      // there is no way to record consent to anything but what is currently
      // published. Re-accepting the same version is a no-op rather than a
      // duplicate history entry, which keeps a retried POST idempotent.
      const acceptingTerms = body.acceptTerms === true;
      const alreadyOnCurrent =
        (existing.termsAcceptedVersion ?? claims?.user_metadata?.terms_accepted_version) === TERMS_VERSION;
      const termsPatch: Record<string, unknown> = {};
      if (acceptingTerms && !alreadyOnCurrent) {
        const acceptedAt = new Date().toISOString();
        const entry: Record<string, unknown> = { version: TERMS_VERSION, acceptedAt };
        if (typeof body.termsSource === "string" && VALID_TERMS_SOURCES.has(body.termsSource)) {
          entry.source = body.termsSource;
        }
        const history = Array.isArray(existing.termsHistory) ? existing.termsHistory : [];
        termsPatch.termsAcceptedVersion = TERMS_VERSION;
        termsPatch.termsAcceptedAt = acceptedAt;
        termsPatch.termsHistory = [...history, entry].slice(-MAX_TERMS_HISTORY);
      }

      const updated = {
        ...existing,
        ...termsPatch,
        ...(typeof body.displayName === "string" && body.displayName.trim()
          ? { displayName: body.displayName.trim().slice(0, 40) }
          : {}),
        ...(typeof body.avatar === "string" && VALID_AVATAR_IDS.has(body.avatar)
          ? { avatar: body.avatar }
          : {}),
        ...(Array.isArray(body.leagues)
          ? { leagues: body.leagues.filter((l: unknown) => typeof l === "string") }
          : {}),
        ...(body.settings && typeof body.settings === "object"
          ? { settings: sanitizeSettings(body.settings, existing.settings) }
          : {}),
        updatedAt: new Date().toISOString(),
      };

      await store.setJSON(key, updated);

      // Fan out a changed name/avatar to every league roster this user
      // belongs to. League membership rows snapshot displayName/avatar at
      // join time (so standings-get.mts doesn't need to look up every
      // member's profile on every read) - without this, a Settings change
      // here would never show up in League/Standings, which only ever read
      // the frozen copy on the members:{leagueId} blob.
      const nameChanged = updated.displayName !== existing.displayName;
      const avatarChanged = updated.avatar !== existing.avatar;
      if ((nameChanged || avatarChanged) && Array.isArray(updated.leagues) && updated.leagues.length) {
        const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
        await Promise.all(
          updated.leagues.map(async (leagueId: string) => {
            try {
              const membersDoc: any = await leagueStore.get(`members:${leagueId}`, { type: "json" });
              if (!membersDoc || !Array.isArray(membersDoc.members)) return;
              const member = membersDoc.members.find((m: any) => m.userId === userId);
              if (!member) return;
              member.displayName = updated.displayName;
              member.avatar = updated.avatar ?? null;
              await leagueStore.setJSON(`members:${leagueId}`, membersDoc);

              if (nameChanged) {
                const league: any = await leagueStore.get(`league:${leagueId}`, { type: "json" });
                if (league && league.ownerId === userId && league.ownerName !== updated.displayName) {
                  league.ownerName = updated.displayName;
                  await leagueStore.setJSON(`league:${leagueId}`, league);
                }
              }
            } catch {
              // Best-effort - a failure to update one league's roster
              // shouldn't fail the profile save itself.
            }
          })
        );
      }

      return jsonResponse(200, withTermsState(updated, claims));
    }

    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/user-profile",
};

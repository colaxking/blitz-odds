import { getStore } from "@netlify/blobs";
import { getAuthenticatedUser } from "./auth.mts";
import { claimsAreAdmin } from "./admin.mts";

// Runtime feature switches, flipped from the admin console's Features tab
// without a deploy.
//
// Each flag has three states:
//   "off"      - nobody sees it
//   "admins"   - only accounts with the admin role (or the seed admin) see it,
//                which is how Dan tests a feature on the live site before
//                anyone else can reach it
//   "everyone" - live for all visitors, signed in or not
//
// Stored as one small JSON doc so a single read answers every flag. Read with
// strong consistency: the whole point of the admin toggle is "flip it, reload,
// see it", and an eventually-consistent read would make that flaky for
// exactly the person testing it.
//
// The client hides UI off the resolved booleans from /features, but that is a
// courtesy. Every endpoint behind a flag re-checks it here with
// isFeatureOnFor(), so "admins" really does mean admins only.

export const FEATURE_STORE = "blitz-site-config";
const FEATURE_KEY = "features";

export type FeatureMode = "off" | "admins" | "everyone";

/** Every flag the site knows about, with its default when never set. New
 *  flags default to "off" so shipping the code never exposes the feature. */
export const FEATURE_DEFAULTS: Record<string, FeatureMode> = {
  bowls: "off",
  mobileNav: "off",
};

export const FEATURE_LABELS: Record<string, { title: string; blurb: string }> = {
  bowls: {
    title: "Bowl Pick'em",
    blurb: "Bowls tab, bowl slate, bowl pool leagues and pick grid.",
  },
  mobileNav: {
    title: "Custom mobile bottom bar",
    blurb: "Phone bottom bar with a Menu button and pinnable tabs. Desktop is unchanged.",
  },
};

const VALID_MODES = new Set<FeatureMode>(["off", "admins", "everyone"]);

export interface FeatureDoc {
  flags: Record<string, FeatureMode>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function readFeatures(): Promise<FeatureDoc> {
  let stored: any = null;
  try {
    stored = await getStore(FEATURE_STORE, { consistency: "strong" }).get(FEATURE_KEY, { type: "json" });
  } catch {
    // A flags read must never take an endpoint down; fall back to defaults.
  }
  const flags: Record<string, FeatureMode> = { ...FEATURE_DEFAULTS };
  if (stored && stored.flags && typeof stored.flags === "object") {
    for (const k of Object.keys(FEATURE_DEFAULTS)) {
      if (VALID_MODES.has(stored.flags[k])) flags[k] = stored.flags[k];
    }
  }
  return {
    flags,
    updatedAt: stored?.updatedAt || null,
    updatedBy: stored?.updatedBy || null,
  };
}

export async function writeFeature(name: string, mode: FeatureMode, actorName: string): Promise<FeatureDoc> {
  if (!(name in FEATURE_DEFAULTS)) throw new Error(`Unknown feature: ${name}`);
  if (!VALID_MODES.has(mode)) throw new Error(`Invalid mode: ${mode}`);
  const current = await readFeatures();
  const next: FeatureDoc = {
    flags: { ...current.flags, [name]: mode },
    updatedAt: new Date().toISOString(),
    updatedBy: actorName,
  };
  await getStore(FEATURE_STORE, { consistency: "strong" }).setJSON(FEATURE_KEY, next);
  return next;
}

export function resolveFlag(mode: FeatureMode, isAdmin: boolean): boolean {
  return mode === "everyone" || (mode === "admins" && isAdmin);
}

/** Server-side gate for a flagged endpoint. Pass the request so the caller's
 *  admin status can be checked only when it matters ("admins" mode). */
export async function isFeatureOnFor(name: string, req: Request, claims?: any): Promise<boolean> {
  const { flags } = await readFeatures();
  const mode = flags[name] || "off";
  if (mode === "everyone") return true;
  if (mode === "off") return false;
  const c = claims !== undefined ? claims : await getAuthenticatedUser(req);
  return claimsAreAdmin(c as any);
}

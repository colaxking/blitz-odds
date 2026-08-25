import { getStore } from "@netlify/blobs";
import { USER_STORE } from "./notif.mts";

// The single place that answers "is this user allowed to have that?".
//
// Nothing is gated today - every check returns true. This exists now, empty,
// because the expensive version of a paywall is the one retrofitted through
// a dozen call sites months later. One function, called from one place
// (where an alert is composed), means turning something Pro is a change here
// and nowhere else.
//
// WHY CAPABILITY STRINGS AND NOT A TIER ENUM. `tier >= PRO` forces you to
// have decided what the tiers are, and that decision hasn't been made. A
// capability list grows one entry at a time and each entry can be flipped
// independently, so "live scoring is Pro but injury alerts aren't" needs no
// tier model at all. When the tiers do get designed, they become a mapping
// from tier to capability set, and every call site here still reads the same.

export type Capability =
  | "alerts.kickoff"
  | "alerts.scoring"
  | "alerts.final"
  | "alerts.injuries"
  | "alerts.last-call";

/** Capabilities that will eventually require a paid plan. Listed - not
 *  enforced - so the usage stamped on each alert row can be filtered to
 *  "who would this affect" before anything is switched on. */
export const PLANNED_PRO_CAPABILITIES: Capability[] = ["alerts.scoring"];

export interface Entitlements {
  tier: string;
  has: (capability: Capability) => boolean;
}

/**
 * Loads a user's entitlements once per dispatch pass. Takes the profile if
 * the caller already has it (the dispatcher does), so this doesn't add a
 * Blobs read per user per tick.
 */
export async function getEntitlements(userId: string, profile?: any): Promise<Entitlements> {
  let tier = "free";
  try {
    const record = profile || (await getStore(USER_STORE, { consistency: "strong" }).get(`users:${userId}`, { type: "json" }));
    if (record && typeof (record as any).subscriptionTier === "string") tier = (record as any).subscriptionTier;
  } catch {
    // A profile read failure must not silently downgrade someone into
    // losing alerts they're entitled to - fall through to the permissive
    // default, which is what every tier gets today anyway.
  }
  return {
    tier,
    // Deliberately unconditional. When gating starts, this becomes a lookup
    // of `tier` against a capability set, and only this line changes.
    has: (_capability: Capability) => true,
  };
}

/* The version of /terms/index.html currently in force.
 *
 * Lives in its own module because two functions need to agree on it and
 * neither is a natural owner: auth-signup.mts stamps it onto a brand new
 * account at creation, and user-profile.mts compares it against what an
 * existing account accepted in order to decide whether the blocking gate
 * should appear. If those two ever disagreed, every account created would
 * immediately be told its terms were out of date.
 *
 * The client never sends a version - only "accepted" - so this is the single
 * source of truth for what that acceptance refers to. A stale cached
 * index.html therefore cannot record consent to terms that are no longer
 * published.
 *
 * Bumping this immediately makes `termsAcceptanceRequired` true for every
 * existing account, which puts the blocking re-consent gate in front of them
 * on their next sign-in. That is the intended mechanism, and it is the whole
 * mechanism - so only bump it for a material change, per section 16 of the
 * terms themselves.
 */
export const TERMS_VERSION = "2026-08-29";

/** Where an acceptance came from. Allowlisted rather than passed through, so
 *  a spoofed body cannot write an arbitrary value into the audit trail. */
export const VALID_TERMS_SOURCES = new Set(["signup", "oauth", "gate"]);

/** Cap on the append-only acceptance log. Ten covers every version a single
 *  account could plausibly have accepted; the current acceptance is also held
 *  flat on the record, so the history is an audit trail, not the read path. */
export const MAX_TERMS_HISTORY = 10;

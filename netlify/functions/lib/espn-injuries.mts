// ESPN's league-wide injury feed, server-side.
//
// Deliberately fetches the FULL feed rather than reading the trimmed mirror
// that scripts/injury-espn-refresh.mjs publishes to site-data. The mirror is
// cut down to the ~71 players impact-players.json tracks, because that's all
// the UI can render; the diff below needs the other ~730 too, since an
// unfamiliar name appearing with a serious designation is exactly how a
// player gets onto Dan's radar in the first place.
//
// (The normalisation here is a near-twin of the one in that script. Kept
// separate on purpose: the script is a plain .mjs run from a GitHub Action
// and can't import a .mts module. If the COLLAPSE map below ever changes,
// change it there too.)

export const ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries";

/** ESPN 403s server IPs without a curl-ish User-Agent. */
export const ESPN_HEADERS: Record<string, string> = {
  "User-Agent": "curl/8.4.0",
  Accept: "application/json",
};

const ESPN_ABBR_FIX: Record<string, string> = { WSH: "WAS", LA: "LAR" };
export const fixAbbr = (a: unknown): string => {
  const up = String(a || "").toUpperCase();
  return ESPN_ABBR_FIX[up] || up;
};

/**
 * ESPN has six statuses; impact-players.json has three. Everything compares
 * the collapsed form, never the raw one - otherwise a routine Out -> Injured
 * Reserve move looks like an escalation and fires an alert for a transition
 * that means nothing to a pick'em player.
 */
export const COLLAPSE: Record<string, InjuryState> = {
  Active: "active",
  Questionable: "questionable",
  Doubtful: "out",
  Out: "out",
  "Injured Reserve": "out",
  Suspension: "out",
};

export type InjuryState = "active" | "questionable" | "out";

/** Severity ladder, for deciding whether a transition got worse or better. */
export const SEVERITY: Record<InjuryState, number> = { active: 0, questionable: 1, out: 2 };

export interface EspnInjury {
  id: string;
  name: string | null;
  team: string;
  position: string | null;
  /** ESPN's own wording - shown verbatim when attributed to them. */
  status: string | null;
  /** The collapsed form. The only thing anything compares. */
  state: InjuryState;
  /** Timestamp of the REPORT, not of our poll. Lets a tick ask "what's new
   *  since last time" instead of diffing 800 records. */
  date: string | null;
  type: string | null;
  side: string | null;
  detail: string | null;
  returnDate: string | null;
  comment: string | null;
  injuryId: string | null;
}

function athleteIdFrom(athlete: any): string | null {
  // No athlete.id field in this payload; the player-card URL carries one,
  // and did on 800 of 800 records when this was written.
  for (const link of athlete?.links || []) {
    const m = /\/id\/(\d+)/.exec(link?.href || "");
    if (m) return m[1];
  }
  return null;
}

/** Every current injury record, keyed by ESPN athlete id. */
export async function fetchEspnInjuries(): Promise<Record<string, EspnInjury>> {
  const res = await fetch(ESPN_INJURIES_URL, { headers: ESPN_HEADERS });
  if (!res.ok) throw new Error(`ESPN injuries feed failed: ${res.status}`);
  const feed: any = await res.json();

  const out: Record<string, EspnInjury> = {};
  for (const teamBlock of feed.injuries || []) {
    for (const item of teamBlock.injuries || []) {
      const athlete = item.athlete || {};
      const id = athleteIdFrom(athlete);
      if (!id) continue;

      // Keep the newest record per athlete - ESPN can carry more than one
      // across a season, in no guaranteed order.
      const existing = out[id];
      if (existing && (existing.date || "") >= (item.date || "")) continue;

      const details = item.details || {};
      out[id] = {
        id,
        name: athlete.displayName || null,
        team: fixAbbr(athlete.team?.abbreviation || teamBlock.abbreviation),
        position: athlete.position?.abbreviation || null,
        status: item.status || null,
        state: COLLAPSE[item.status] || "active",
        date: item.date || null,
        type: details.type || null,
        side: details.side || null,
        detail: details.detail || null,
        returnDate: details.returnDate || null,
        comment: item.shortComment || null,
        injuryId: item.id ? String(item.id) : null,
      };
    }
  }
  return out;
}

/** "Achilles, right, surgery", or null when ESPN specified nothing useful.
 *  Type keeps its casing (usually a proper noun); the rest is lowercased so
 *  it reads as prose. "Not Specified" means "we don't know" and is dropped
 *  rather than printed. */
export function detailPhrase(e: Pick<EspnInjury, "type" | "side" | "detail">): string | null {
  const clean = (v: string | null) => (v && v !== "Not Specified" ? v : null);
  const parts = [clean(e.type), clean(e.side), clean(e.detail)]
    .filter(Boolean)
    .map((v, i) => (i === 0 ? String(v) : String(v).toLowerCase()));
  return parts.length ? parts.join(", ") : null;
}

/** Positions where a status change moves a line enough to be worth an
 *  unfamiliar name reaching the review queue. A backup guard going
 *  questionable is not news; a quarterback is. */
export const PREMIUM_POSITIONS = new Set(["QB", "RB", "WR", "TE", "LT", "EDGE", "DE", "CB", "K"]);

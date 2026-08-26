import { makeGameId } from "./gameId.mts";
import {
  getPrefs, inQuietHours, alreadySentEvent, markSentEvent, type NotifPrefs,
} from "./notif.mts";
import { sendPush, type PushPayload } from "./push.mts";
import { getEntitlements, type Capability } from "./entitlements.mts";

// The rules every push alert shares: which games a reader follows, whether
// it's a civilised hour to tell them, whether they've already been told, and
// whether they're entitled to the alert at all.
//
// Kept out of the dispatcher so that adding an alert type is writing the
// message and the trigger, not re-deriving the gating. Phase 1 uses this for
// kickoff, final score, and last-call; scoring and injury alerts should use
// it unchanged.

export interface AlertUser {
  userId: string;
  email: string;
  leagues: string[];
  favorites: string[];
  profile?: any;
}

export interface ScheduleGame { away: string; home: string; date: string; time: string; network?: string }

/* ------------------------------------------------------------------------ */
/* Scope                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Does this reader follow this game?
 *
 * "fav" is answered from the profile with no I/O. "picks" needs a Blobs read
 * per league, which is why callers must narrow to candidate games FIRST -
 * the games kicking off in this window, or the ones that just went final,
 * usually one to three - rather than asking this about all sixteen. Asking
 * per user per league per game across a full slate would be hundreds of
 * reads a tick for no benefit.
 */
export async function followsGame(
  user: AlertUser,
  prefs: NotifPrefs,
  season: number,
  week: number,
  game: ScheduleGame,
  io: { leagueStore: any }
): Promise<boolean> {
  const scope = prefs.push.scope;

  const byFavorite = user.favorites.includes(game.away) || user.favorites.includes(game.home);
  if (scope === "fav") return byFavorite;
  if (scope === "both" && byFavorite) return true;

  // scope is "picks", or "both" and the favourite test didn't match.
  if (!user.leagues.length) return false;
  const gameId = makeGameId(season, week, game.away, game.home);
  for (const leagueId of user.leagues) {
    try {
      const pick = await io.leagueStore.get(`picks:${leagueId}:${week}:${user.userId}:${gameId}`, { type: "json" });
      if (pick) return true;
    } catch {
      // A league that can't be read shouldn't suppress an alert the reader
      // might be owed from another one.
    }
  }
  return false;
}

/* ------------------------------------------------------------------------ */
/* Delivery                                                                  */
/* ------------------------------------------------------------------------ */

export interface AlertArgs {
  user: AlertUser;
  prefs: NotifPrefs;
  /** Alert family, e.g. "kick" | "final" | "lastcall". Part of the ledger key. */
  type: string;
  /** Identifies the specific occurrence - a game id, a play id. */
  event: string;
  season: number;
  week: number;
  capability: Capability;
  payload: PushPayload;
  now: Date;
  /** Last-call only: a pick deadline you slept through is worse than being
   *  woken, so it's the one thing allowed through quiet hours. */
  pierceQuietHours?: boolean;
  dryRun?: boolean;
}

export type AlertOutcome =
  | "sent"
  | "duplicate"
  | "quiet-hours"
  | "not-entitled"
  | "no-devices"
  | "dry-run"
  | "failed";

/**
 * One alert to one reader, with every gate applied in the order that costs
 * least. The ledger write happens BEFORE the send, matching the email path's
 * reasoning: a crash between the two loses that one alert, which is a better
 * failure than sending it twice.
 */
export async function deliverAlert(args: AlertArgs): Promise<AlertOutcome> {
  const { user, prefs, type, event, season, week, capability, payload, now } = args;

  // Cheapest checks first - each of these avoids a Blobs read or a network
  // call for the ones below it.
  if (!args.pierceQuietHours && inQuietHours(now, prefs)) return "quiet-hours";

  const entitlements = await getEntitlements(user.userId, user.profile);
  if (!entitlements.has(capability)) return "not-entitled";

  if (await alreadySentEvent(type, season, week, event, user.userId)) return "duplicate";

  if (args.dryRun) return "dry-run";

  await markSentEvent(type, season, week, event, user.userId);
  try {
    const result = await sendPush(user.userId, payload);
    if (result.noDevices) return "no-devices";
    return result.sent > 0 ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/* ------------------------------------------------------------------------ */
/* Timing                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Is `now` inside the window that should trigger an alert `leadMinutes`
 * before `target`?
 *
 * The dispatcher ticks every 15 minutes, so "10 minutes before kickoff"
 * cannot be delivered at 10 minutes before - it lands wherever the tick
 * falls. The window is one tick wide plus a small margin, because
 * cron-job.org does not fire on the exact minute: a window of exactly 15
 * would let two slightly-drifted ticks straddle it and leave nobody inside.
 * The margin means an overlap is possible instead, which the event ledger
 * makes harmless - and a duplicate the ledger swallows is a much better
 * failure than a kickoff alert that silently never fires.
 *
 * Because the actual lead varies across the window, copy must state the real
 * remaining time computed at send - "kicks off in 18 minutes" - rather than
 * a fixed number that would frequently be wrong.
 */
export function inLeadWindow(now: Date, target: Date, leadMinutes: number, windowMinutes = 18): boolean {
  const ms = target.getTime() - now.getTime();
  const maxLead = (leadMinutes + windowMinutes) * 60000;
  const minLead = leadMinutes * 60000;
  return ms > minLead && ms <= maxLead;
}

/** Whole minutes from now until `target`, for use in copy. */
export function minutesUntil(now: Date, target: Date): number {
  return Math.max(0, Math.round((target.getTime() - now.getTime()) / 60000));
}

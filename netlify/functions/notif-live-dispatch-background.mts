import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { makeGameId } from "./lib/gameId.mts";
import { parseKickoffUTC } from "./lib/kickoff.mts";
import { getPrefs, notifStore, USER_STORE } from "./lib/notif.mts";
import { followsGame, deliverAlert, type AlertUser, type ScheduleGame } from "./lib/alerts.mts";
import { createAlertLog } from "./lib/alertlog.mts";
import {
  fetchLiveWeek, leaderOf, clockLabel, scoreDelta, fetchScoringPlays, playClockLabel,
  type LiveGame, type ScoringPlay,
} from "./lib/livescores.mts";
import { loadAllWeeks, espnParamsFor, type PhaseWeek } from "./lib/schedule.mts";
import { loadWeekFollows } from "./lib/follows.mts";

// The fast tick. Watches games that are actually in progress and alerts on
// scoring plays and final whistles.
//
// POST /.netlify/functions/notif-live-dispatch-background
// Header: x-notif-dispatch-secret        (same secret as the 15-minute tick)
// Body (all optional): { now?, dryRun?, userId?, force? }
//
// WHY A SEPARATE DISPATCHER. The 15-minute tick can carry anything whose
// timing is measured in hours - a pick reminder, a recap, a kickoff warning.
// A touchdown is not that. By the time a 15-minute tick notices a score, the
// next one has often happened. This runs every 90 seconds instead, and only
// while there are games on.
//
// WHY IT COSTS ALMOST NOTHING. Running every 90 seconds year-round would be
// ~350k invocations a year to discover that it's Tuesday in March. Two
// things prevent that: the cron job is restricted to NFL game windows
// (see .github/workflows/notif-live-dispatch.yml), and the first thing this
// does is a cheap schedule check that returns before touching ESPN, the user
// list, or anything else if no game is plausibly in progress.
//
// SNAPSHOTS. Alerts fire on a diff against what we saw last tick, stored per
// game. That's what makes "the score changed" answerable at all - ESPN's
// scoreboard reports state, not events. A missing snapshot (first sighting
// of a game) deliberately produces no alert: on the first tick of a game
// that's already in progress, everything looks new, and we'd fire an alert
// for a touchdown scored twenty minutes ago.

const SITE_DATA_STORE = "blitz-site-data";
const LEAGUE_STORE = "blitz-leagues";
const CURRENT_SEASON = 2026;

/** How far either side of a kickoff a game is worth polling. Games run ~3¼
 *  hours; the tail covers overtime and a slow final whistle. */
const WINDOW_BEFORE_MS = 15 * 60 * 1000;
const WINDOW_AFTER_MS = 5 * 60 * 60 * 1000;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

interface Snapshot {
  awayScore: number;
  homeScore: number;
  state: string;
  period: number;
  leader: string | null;
  lastPlayId: string | null;
  /** Cursor into the game's scoring plays: the last one an alert was built
   *  from. Anything after it in the feed is a score nobody has been told
   *  about, which survives a missed tick or a dispatcher outage. */
  lastScoringPlayId?: string | null;
  updatedAt: string;
}

const snapKey = (season: number, week: number, gameId: string) => `live:${season}:${week}:${gameId}`;

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const expectedSecret = process.env.NOTIF_DISPATCH_SECRET;
  if (!expectedSecret) return jsonResponse(500, { ok: false, error: "NOTIF_DISPATCH_SECRET not configured on this site" });
  const provided = req.headers.get("x-notif-dispatch-secret");
  if (!provided || provided !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-notif-dispatch-secret header" });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is the normal cron case */ }

  const now = body.now ? new Date(body.now) : new Date();
  const dryRun = body.dryRun === true;
  const alertLog = createAlertLog("live", now, dryRun);
  const onlyUser: string | null = body.userId || null;

  const siteDataStore = getStore(SITE_DATA_STORE);
  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const userStore = getStore(USER_STORE, { consistency: "strong" });
  const store = notifStore();

  const report: any = {
    ok: true, at: now.toISOString(), dryRun,
    polledWeeks: [], liveGames: [], scoring: { sent: 0, outcomes: {} }, final: { sent: 0, outcomes: {} },
    errors: [],
  };

  try {
    // The whole season, not just weeks 1-18: a touchdown in a playoff game
    // is exactly the thing someone turned these alerts on for. See
    // lib/schedule.mts for why the three phases arrive separately.
    const weeks: PhaseWeek[] = await loadAllWeeks(siteDataStore);
    if (!weeks.length) return jsonResponse(200, { ...report, note: "No schedule available" });

    // ---- Is anything plausibly on right now? --------------------------
    // Cheapest possible check, deliberately first. Off-season and midweek
    // this returns here, having done exactly one Blobs read.
    // Carries the whole PhaseWeek, not just the number, because ESPN's
    // scoreboard numbering for a preseason or playoff round can't be derived
    // from our week number - it only exists in the schedule data.
    const activeWeeks: PhaseWeek[] = [];
    for (const w of weeks) {
      for (const g of w.games || []) {
        const k = parseKickoffUTC(CURRENT_SEASON, g.date, g.time);
        if (!k) continue;
        const delta = now.getTime() - k.getTime();
        if (delta >= -WINDOW_BEFORE_MS && delta <= WINDOW_AFTER_MS) { activeWeeks.push(w); break; }
      }
    }
    if (!activeWeeks.length && !body.force) {
      return jsonResponse(200, { ...report, note: "No games in progress" });
    }
    report.polledWeeks = activeWeeks.map((w) => w.week);

    // ---- What does ESPN say? -------------------------------------------
    const liveByWeek = new Map<number, LiveGame[]>();
    for (const w of activeWeeks) {
      const week = w.week;
      try {
        liveByWeek.set(week, await fetchLiveWeek(CURRENT_SEASON, week, espnParamsFor(w)));
      } catch (err) {
        // One bad week must not take down the tick; the next one is 90
        // seconds away and the snapshot is unchanged, so nothing is lost.
        report.errors.push({ week, stage: "fetch", error: err instanceof Error ? err.message : "unknown" });
      }
    }

    // ---- Diff against last tick ----------------------------------------
    interface Change {
      week: number; gameId: string; game: ScheduleGame; live: LiveGame;
      scored: boolean; leadChanged: boolean; wentFinal: boolean;
      /* The scores this tick is diffing against - the fallback description
       * is computed from the difference. */
      prev: { awayScore: number; homeScore: number };
      /* Scoring plays not yet alerted on, oldest first. Empty when the
       * summary feed couldn't be read, in which case the points delta
       * stands in. */
      pending: ScoringPlay[];
    }
    const changes: Change[] = [];

    for (const [week, games] of liveByWeek) {
      const scheduled = (weeks.find((w) => w.week === week)?.games || []) as ScheduleGame[];
      for (const live of games) {
        if (live.state === "pre") continue;
        const game = scheduled.find((g) => g.away === live.away && g.home === live.home);
        if (!game) continue;   // ESPN has a game our schedule doesn't; not ours to alert on

        const gameId = makeGameId(CURRENT_SEASON, week, live.away, live.home);
        const prev = (await store.get(snapKey(CURRENT_SEASON, week, gameId), { type: "json" })) as Snapshot | null;
        const leader = leaderOf(live);

        const scored = !!prev && (live.awayScore !== prev.awayScore || live.homeScore !== prev.homeScore);

        // The scoring-play feed is only worth a request when the score has
        // actually moved - about ten times across a whole game rather than
        // once per game per tick. A first sighting reads it too, purely to
        // set the cursor, so the next real score isn't mistaken for a
        // backlog of every score so far.
        let pending: ScoringPlay[] = [];
        let cursor: string | null | undefined = prev?.lastScoringPlayId ?? null;
        if ((scored || !prev) && live.eventId) {
          try {
            const plays = await fetchScoringPlays(live.eventId);
            if (plays.length) {
              const at = cursor ? plays.findIndex((pl) => pl.id === cursor) : -1;
              // An unknown cursor - first sighting, or a play id that has
              // vanished from the feed - must not replay the whole game.
              // Only the newest play is treated as news.
              pending = prev && cursor && at >= 0
                ? plays.slice(at + 1)
                : prev
                  ? plays.slice(-1)
                  : [];
              cursor = plays[plays.length - 1].id;
            }
          } catch (err) {
            // The scoreline is still trustworthy without this, and the
            // points delta describes the play well enough to send. Losing
            // the alert entirely would be the worse failure.
            report.errors.push({ week, stage: "scoring-plays", error: err instanceof Error ? err.message : "unknown" });
          }
        }

        const next: Snapshot = {
          awayScore: live.awayScore, homeScore: live.homeScore, state: live.state,
          period: live.period, leader, lastPlayId: live.lastPlayId,
          lastScoringPlayId: cursor, updatedAt: now.toISOString(),
        };
        if (!dryRun) await store.setJSON(snapKey(CURRENT_SEASON, week, gameId), next);

        if (live.state === "in") report.liveGames.push(`${live.away}@${live.home} ${live.awayScore}-${live.homeScore} ${clockLabel(live)}`);

        // First sighting: record the state, alert on nothing. Otherwise a
        // game already in progress when this starts up would fire for a
        // score that happened long before anyone was watching.
        if (!prev) continue;
        // "Lead change" means the trailing team went ahead. A drop into a
        // tie isn't one - otherwise a tie-then-retake fires twice for what
        // a viewer experiences as a single swing.
        const leadChanged = !!leader && leader !== prev.leader;
        const wentFinal = live.state === "post" && prev.state !== "post";

        if (scored || wentFinal) {
          changes.push({
            week, gameId, game, live, scored, leadChanged, wentFinal,
            prev: { awayScore: prev.awayScore, homeScore: prev.homeScore },
            pending,
          });
        }
      }
    }

    if (!changes.length) return jsonResponse(200, { ...report, note: "No changes this tick" });

    // ---- Who cares? -----------------------------------------------------
    // Only loaded once something actually happened, so a quiet tick during
    // a game never touches the user list at all.

    // Explicit per-game follows first, because the user filter below needs
    // them: someone following one game with no starred team and no league
    // is exactly who that feature is for, and "no leagues and no
    // favourites" would drop them silently - the same shape of bug as the
    // `if (!leagues.length) continue;` that used to exclude everyone
    // without a pool. Scoped to the weeks that actually changed, so this is
    // one list per live week and nothing on a quiet tick.
    const followsByWeek = new Map<number, Map<string, Set<string>>>();
    for (const w of new Set(changes.map((c) => c.week))) {
      followsByWeek.set(w, await loadWeekFollows(CURRENT_SEASON, w));
    }
    const followedBy = (week: number, userId: string) => followsByWeek.get(week)?.get(userId) || null;
    const anyFollows = new Set<string>();
    for (const weekMap of followsByWeek.values()) {
      for (const followerId of weekMap.keys()) anyFollows.add(followerId);
    }

    const users: AlertUser[] = [];
    for await (const page of userStore.list({ prefix: "users:", paginate: true })) {
      for (const b of page.blobs) {
        const userId = b.key.slice("users:".length);
        if (onlyUser && userId !== onlyUser) continue;
        try {
          const profile: any = await userStore.get(b.key, { type: "json" });
          if (!profile?.email) continue;
          const leagues: string[] = Array.isArray(profile.leagues) ? profile.leagues : [];
          const favorites: string[] = Array.isArray(profile?.settings?.favorites) ? profile.settings.favorites : [];
          if (!leagues.length && !favorites.length && !anyFollows.has(userId)) continue;
          users.push({ userId, email: profile.email, leagues, favorites, profile });
        } catch (err) {
          report.errors.push({ userId, stage: "profile", error: err instanceof Error ? err.message : "unknown" });
        }
      }
    }

    const teamsDoc: any = await siteDataStore.get("teams", { type: "json" });
    const teamName = new Map<string, string>((teamsDoc?.teams || []).map((t: any) => [String(t.id).toUpperCase(), t.name as string]));
    const nameOf = (abbr: string) => teamName.get(String(abbr).toUpperCase()) || String(abbr).toUpperCase();

    const tally = (
      bucket: any,
      outcome: string,
      ctx?: { userId: string; type: string; event: string; week: number; label?: string }
    ) => {
      bucket.outcomes[outcome] = (bucket.outcomes[outcome] || 0) + 1;
      if (outcome === "sent") bucket.sent++;
      if (ctx) alertLog.add({ ...ctx, outcome });
    };

    for (const ch of changes) {
      const { live } = ch;
      const scoreLine = `${live.away} ${live.awayScore}, ${live.home} ${live.homeScore}`;
      const gameLabel = `${live.away}@${live.home}`;

      for (const u of users) {
        try {
          const prefs = await getPrefs(u.userId);
          const wantsScoring = ch.scored && prefs.push.scoring !== "off"
            && (prefs.push.scoring === "all" || ch.leadChanged);
          const wantsFinal = ch.wentFinal && prefs.push.final;
          if (!wantsScoring && !wantsFinal) continue;

          if (!(await followsGame(u, prefs, CURRENT_SEASON, ch.week, ch.game, { leagueStore, followed: followedBy(ch.week, u.userId) }))) {
            const ctx = { userId: u.userId, event: ch.gameId, week: ch.week, label: gameLabel };
            if (wantsFinal) tally(report.final, "not-followed", { ...ctx, type: "final" });
            else tally(report.scoring, "not-followed", { ...ctx, type: "score" });
            continue;
          }

          if (wantsFinal) {
            // Same ledger type and event as the history-driven final alert
            // in notif-dispatch-background, on purpose: whichever notices
            // first wins and the other finds the key and stays quiet. This
            // one is normally first by a wide margin - history only
            // refreshes on its own schedule - so that path becomes a
            // backstop for a tick this one missed.
            const tie = live.awayScore === live.homeScore;
            const winner = tie ? null : (live.awayScore > live.homeScore ? live.away : live.home);
            const outcome = await deliverAlert({
              user: u, prefs, type: "final", event: ch.gameId,
              season: CURRENT_SEASON, week: ch.week,
              capability: "alerts.final", now, dryRun,
              log: alertLog, label: gameLabel,
              payload: {
                title: tie ? `Final: ${scoreLine} (tie)` : `Final: ${nameOf(winner as string)} win`,
                body: `${scoreLine}.`,
                url: `/g/${ch.gameId}`,
                collapseKey: `game:${ch.gameId}`,
                data: { kind: "final", gameId: ch.gameId },
              },
            });
            tally(report.final, outcome);
            continue;   // a final is not also a scoring alert
          }

          // The play id is the dedupe unit. Without it (ESPN drops
          // `situation` at dead-ball moments, which is exactly when a score
          // has just happened) fall back to the scoreline, which is unique
          // per scoring event within a game barring an exact repeat.
          const leadNote = ch.leadChanged ? ` ${nameOf(leaderOf(live) as string)} take the lead.` : "";

          // What actually happened, which the scoreline and clock never said.
          //
          // ONE ALERT PER TICK, NOT ONE PER PLAY. Every alert for a game
          // shares a collapseKey, so a device only ever shows the most recent
          // one - sending three would deliver three and display one. Anything
          // the reader missed is folded into that single message instead.
          const newest = ch.pending.length ? ch.pending[ch.pending.length - 1] : null;
          const missed = ch.pending.length - 1;

          let event: string;
          let body: string;
          if (newest) {
            const when = playClockLabel(newest) || clockLabel(live);
            const who = newest.team ? `, ${nameOf(newest.team)}` : "";
            const missedNote = missed > 0
              ? ` Plus ${missed} earlier score${missed === 1 ? "" : "s"} you missed.`
              : "";
            body = `${newest.type}${who}. ${newest.text}. ${when}.${leadNote}${missedNote}`;
            // Dedupe on the play, not the tick: the ledger then makes a
            // retried or overlapping tick free.
            event = `${ch.gameId}:${newest.id}`;
          } else {
            // No scoring feed this tick. The points delta still says whether
            // it was a touchdown or a field goal, which is most of the value.
            const delta = scoreDelta(ch.prev, live);
            const headline = delta.kind
              ? `${delta.kind}${delta.team ? `, ${nameOf(delta.team)}` : ""}.`
              : "";
            // A truncated play already ends in an ellipsis; a full stop after
            // it reads as a typo.
            const detail = delta.detail
              ? ` ${delta.detail}${delta.detail.endsWith("\u2026") ? "" : "."}`
              : "";
            body = `${headline}${detail} ${clockLabel(live)}.${leadNote}`;
            event = `${ch.gameId}:${live.lastPlayId || `${live.awayScore}-${live.homeScore}`}`;
          }

          const outcome = await deliverAlert({
            user: u, prefs, type: "score", event,
            season: CURRENT_SEASON, week: ch.week,
            capability: "alerts.scoring", now, dryRun,
            log: alertLog, label: gameLabel,
            payload: {
              // Title stays the scoreline - it's the fact people want at a
              // glance - and the body now leads with the play rather than
              // opening on a clock nobody asked about.
              title: scoreLine,
              body: body.replace(/\s+/g, " ").trim(),
              url: `/g/${ch.gameId}`,
              // Successive updates for one game replace each other rather
              // than stacking - six scores in a game is six notifications
              // without this.
              collapseKey: `game:${ch.gameId}`,
              data: { kind: "score", gameId: ch.gameId },
            },
          });
          tally(report.scoring, outcome);
        } catch (err) {
          report.errors.push({ userId: u.userId, stage: "live", error: err instanceof Error ? err.message : "unknown" });
        }
      }
    }

    await alertLog.flush({ games: changes.map((c) => c.gameId) });
    return jsonResponse(200, report);
  } catch (err) {
    await alertLog.flush({ failed: true });
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error", report });
  }
};

export const config: Config = {
  path: "/.netlify/functions/notif-live-dispatch-background",
};

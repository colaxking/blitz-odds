import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { makeGameId } from "./lib/gameId.mts";
import { parseKickoffUTC } from "./lib/kickoff.mts";
import {
  getPrefs, unsubUrl, sendEmail, alreadySent, markSent, localParts, USER_STORE,
} from "./lib/notif.mts";
import { buildReminderEmail, buildRecapEmail, type RecapLeague, type RecapHighlight } from "./lib/notif-emails.mts";
import { FORMAT_LABELS } from "./lib/email-shell.mts";
import { followsGame, deliverAlert, inLeadWindow, minutesUntil, type AlertUser } from "./lib/alerts.mts";

// @ts-ignore - plain JS UMD module, no type declarations
import ScoringEngine from "../../js/scoringEngine.js";

// Decides who is due for an email right now and sends it. Same
// secret-header write-endpoint pattern as results-process.mts /
// odds-update.mts: an external scheduler (cron-job.org -> GitHub Actions
// workflow_dispatch, per the repo's note on native cron being unreliable
// here) pokes this every 15 minutes and it works out the rest.
//
// POST /.netlify/functions/notif-dispatch-background
// Header: x-notif-dispatch-secret
// Body (all optional): { now?: ISO string, dryRun?: boolean, only?: "reminder"|"recap"|"push", userId?: string }
//   -> { ok, at, reminder: {...}, recap: {...} }
//
// A background function (the -background filename suffix is what Netlify
// keys off) because the work is O(users x leagues x games) direct Blobs
// gets: a 15-minute ceiling, not the ~10s a synchronous function gets.
// The caller gets a 202 immediately and never sees the result body, which
// is why `dryRun` exists - run it by hand with dryRun to read the plan out
// of the function log before letting it send anything.
//
// WHY A 15-MINUTE TICK. Send times are local to each reader (7pm the
// evening before the first kickoff; 9am Tuesday for the recap) and readers
// span every timezone, so there is no single UTC moment to fire at. The
// tick asks, for each user, "is it their moment yet."
//
// SCALING NOTE. This lists every user on every tick. That's fine at the
// current roster size and stays fine into the low thousands; past that,
// the fix is to bucket users by timezone at pref-write time and only load
// the buckets whose local hour matches, rather than to shorten the tick.

const LEAGUE_STORE = "blitz-leagues";
const SITE_DATA_STORE = "blitz-site-data";
const ODDS_STORE = "blitz-odds-live";
const CURRENT_SEASON = 2026;

/** Evening-before send hour, local to the reader. */
const REMINDER_LOCAL_HOUR = 19;
/** Never send a reminder inside this window before kickoff - too late to be useful. */
const REMINDER_CUTOFF_MS = 3 * 60 * 60 * 1000;
/** Tuesday recap send hour, local to the reader. */
const RECAP_LOCAL_HOUR = 9;

/* Push alert timing. These are *minimum* leads, not exact ones: the tick is
 * 15 minutes, so an alert lands somewhere between the lead and the lead plus
 * one tick. Copy states the real remaining minutes rather than these numbers
 * (see inLeadWindow in lib/alerts.mts). */
const KICKOFF_LEAD_MIN = 10;
const LAST_CALL_LEAD_MIN = 90;
/** Rough elapsed time from kickoff to a final whistle, used only to date a
 *  result the history doc doesn't timestamp. */
const APPROX_GAME_MS = 3.25 * 60 * 60 * 1000;
/** How long after a game's estimated end a final-score alert is still worth
 *  sending. Also the guard that stops an empty ledger - a first deploy, or a
 *  swept week - from firing an alert for every completed game at once. */
const FINAL_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

interface ScheduleGame { away: string; home: string; date: string; time: string; network?: string }

/** Earliest parseable kickoff in a week, or null if none are pinned down yet. */
export function firstKickoffOf(season: number, games: ScheduleGame[]): Date | null {
  let earliest: Date | null = null;
  for (const g of games) {
    const k = parseKickoffUTC(season, g.date, g.time);
    if (!k) continue; // flexed/TBD week 16-18 placeholder
    if (!earliest || k.getTime() < earliest.getTime()) earliest = k;
  }
  return earliest;
}

function gameWithKickoff(season: number, games: ScheduleGame[], at: Date): ScheduleGame | null {
  let best: ScheduleGame | null = null;
  let bestMs = Infinity;
  for (const g of games) {
    const k = parseKickoffUTC(season, g.date, g.time);
    if (!k) continue;
    if (k.getTime() < bestMs) { bestMs = k.getTime(); best = g; }
  }
  return best;
}

/** "Thursday 8:15 PM ET" - the league-wide deadline, always stated in ET. */
export function kickoffLabel(at: Date): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "long", hour: "numeric", minute: "2-digit", hour12: true,
  });
  const parts = dtf.formatToParts(at).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.weekday} ${parts.hour}:${parts.minute} ${parts.dayPeriod} ET`;
}

/**
 * The instant at REMINDER_LOCAL_HOUR on the calendar day *before* the one
 * kickoff falls on, as the reader's own timezone sees it. Someone in Tokyo
 * and someone in Denver get genuinely different UTC instants for the same
 * game, which is the whole point.
 */
export function reminderSendInstant(kickoff: Date, tz: string): Date {
  const k = localParts(kickoff, tz);
  // Step back one local day via a UTC-anchored date (safe across month and
  // year boundaries), then bind the target wall-clock hour to that date.
  const dayBefore = new Date(Date.UTC(k.year, k.month - 1, k.day) - 86400000);
  const p = { y: dayBefore.getUTCFullYear(), m: dayBefore.getUTCMonth(), d: dayBefore.getUTCDate() };

  // Same two-pass trick kickoff.mts uses: treat the wall clock as UTC, ask
  // what offset the zone was really running at that instant, correct.
  const guess = new Date(Date.UTC(p.y, p.m, p.d, REMINDER_LOCAL_HOUR, 0));
  const seen = localParts(guess, tz);
  const asIfUTC = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
  const offsetMin = (asIfUTC - guess.getTime()) / 60000;
  return new Date(guess.getTime() - offsetMin * 60000);
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const expectedSecret = process.env.NOTIF_DISPATCH_SECRET;
  if (!expectedSecret) return jsonResponse(500, { ok: false, error: "NOTIF_DISPATCH_SECRET not configured on this site" });
  const provided = req.headers.get("x-notif-dispatch-secret");
  if (!provided || provided !== expectedSecret) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-notif-dispatch-secret header" });
  }
  if (!process.env.NOTIF_UNSUB_SECRET) {
    return jsonResponse(500, { ok: false, error: "NOTIF_UNSUB_SECRET not configured - unsubscribe links can't be signed" });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is the normal cron case */ }

  const now = body.now ? new Date(body.now) : new Date();
  const dryRun = body.dryRun === true;
  const only: string | null = body.only || null;
  const onlyUser: string | null = body.userId || null;

  const leagueStore = getStore(LEAGUE_STORE, { consistency: "strong" });
  const siteDataStore = getStore(SITE_DATA_STORE);
  const oddsStore = getStore(ODDS_STORE);
  const userStore = getStore(USER_STORE, { consistency: "strong" });

  const report: any = {
    ok: true, at: now.toISOString(), dryRun,
    reminder: { sent: [], skipped: 0 },
    recap: { sent: [], skipped: 0 },
    kickoff: { sent: 0, outcomes: {}, games: [] },
    final: { sent: 0, outcomes: {}, games: [] },
    lastCall: { sent: 0, outcomes: {} },
    errors: [],
  };

  try {
    const schedule: any = await siteDataStore.get("schedule", { type: "json" });
    const weeks: Array<{ week: number; games: ScheduleGame[] }> = schedule?.weeks || [];
    if (!weeks.length) return jsonResponse(200, { ...report, note: "No schedule available" });

    const teamsDoc: any = await siteDataStore.get("teams", { type: "json" });
    const teamName = new Map<string, string>(
      (teamsDoc?.teams || []).map((t: any) => [String(t.id).toUpperCase(), t.name as string])
    );
    const nameOf = (abbr: string) => teamName.get(String(abbr).toUpperCase()) || String(abbr).toUpperCase();

    // --- Which week is each email about? -----------------------------------
    // Reminder: the earliest week whose first kickoff hasn't happened yet.
    // Recap: the latest week whose first kickoff is in the past.
    let reminderWeek: { week: number; games: ScheduleGame[]; kickoff: Date } | null = null;
    let recapWeekNum: number | null = null;
    for (const w of weeks) {
      const k = firstKickoffOf(CURRENT_SEASON, w.games || []);
      if (!k) continue;
      if (k.getTime() > now.getTime()) {
        if (!reminderWeek || k.getTime() < reminderWeek.kickoff.getTime()) {
          reminderWeek = { week: w.week, games: w.games || [], kickoff: k };
        }
      } else {
        if (recapWeekNum === null || w.week > recapWeekNum) recapWeekNum = w.week;
      }
    }

    // --- Who might get something? ------------------------------------------
    // This used to drop anyone with no leagues right here, which was correct
    // while pick reminders and the recap were the only two things that
    // existed - both are about leagues, so a user without one had nothing
    // coming either way.
    //
    // It stopped being correct the moment alerts started keying off
    // favourite teams. Someone with three starred teams and no pool is a
    // perfectly ordinary user of this app, and silently excluding them from
    // the whole dispatch pass would have been invisible from the outside:
    // no error, no log line, just a reader who never hears anything. The
    // list is now built once, and each alert type applies its own filter.
    const users: Array<{ userId: string; email: string; leagues: string[]; favorites: string[]; profile: any }> = [];
    for await (const page of userStore.list({ prefix: "users:", paginate: true })) {
      for (const b of page.blobs) {
        const userId = b.key.slice("users:".length);
        if (onlyUser && userId !== onlyUser) continue;
        try {
          const profile: any = await userStore.get(b.key, { type: "json" });
          if (!profile?.email) continue;          // no address, nothing to send to
          const leagues: string[] = Array.isArray(profile.leagues) ? profile.leagues : [];
          const favorites: string[] = Array.isArray(profile?.settings?.favorites) ? profile.settings.favorites : [];
          if (!leagues.length && !favorites.length) continue;   // genuinely nothing to say
          users.push({ userId, email: profile.email, leagues, favorites, profile });
        } catch (err) {
          report.errors.push({ userId, error: err instanceof Error ? err.message : "profile read failed" });
        }
      }
    }

    // Leagues are shared across users; read each one once.
    const leagueCache = new Map<string, any>();
    const membersCache = new Map<string, any>();
    const standingsCache = new Map<string, any>();
    const survivorCache = new Map<string, any>();
    const resultsCache = new Map<string, any>();

    const loadLeague = async (id: string) => {
      if (!leagueCache.has(id)) leagueCache.set(id, await leagueStore.get(`league:${id}`, { type: "json" }));
      return leagueCache.get(id);
    };
    const loadMembers = async (id: string) => {
      if (!membersCache.has(id)) membersCache.set(id, await leagueStore.get(`members:${id}`, { type: "json" }));
      return membersCache.get(id);
    };
    const loadStandings = async (id: string) => {
      if (!standingsCache.has(id)) standingsCache.set(id, await leagueStore.get(`standings:${id}`, { type: "json" }));
      return standingsCache.get(id);
    };
    const loadSurvivor = async (id: string) => {
      if (!survivorCache.has(id)) survivorCache.set(id, await leagueStore.get(`survivor:${id}`, { type: "json" }));
      return survivorCache.get(id);
    };
    const loadResults = async (id: string, wk: number) => {
      const k = `${id}:${wk}`;
      if (!resultsCache.has(k)) resultsCache.set(k, await leagueStore.get(`results:${id}:${wk}`, { type: "json" }));
      return resultsCache.get(k);
    };

    // =======================================================================
    // PICK REMINDER
    // =======================================================================
    if (reminderWeek && (!only || only === "reminder")) {
      const rw = reminderWeek;
      const tooLate = now.getTime() >= rw.kickoff.getTime() - REMINDER_CUTOFF_MS;

      // The line for the opener, if odds are published - the teaser is
      // decoration, so a missing line degrades it rather than blocking send.
      let openerLine: string | undefined;
      const opener = gameWithKickoff(CURRENT_SEASON, rw.games, now);
      if (opener) {
        try {
          const oddsDoc: any = await oddsStore.get("odds", { type: "json" });
          const og = oddsDoc?.weeks?.[String(rw.week)]?.games?.[`${opener.away}-${opener.home}`];
          if (og && typeof og.spread === "number" && og.favorite) {
            const ou = typeof og.overUnder === "number" ? ` - O/U ${og.overUnder}` : "";
            openerLine = `${og.favorite} ${og.spread}${ou}`;
          }
        } catch { /* teaser line is optional */ }
      }

      for (const u of users) {
        if (tooLate) { report.reminder.skipped++; continue; }
        if (!u.leagues.length) { report.reminder.skipped++; continue; }   // league-only alert
        try {
          const prefs = await getPrefs(u.userId);
          if (!prefs.emailPickReminders) { report.reminder.skipped++; continue; }
          if (await alreadySent("reminder", CURRENT_SEASON, rw.week, u.userId)) { report.reminder.skipped++; continue; }

          const due = now.getTime() >= reminderSendInstant(rw.kickoff, prefs.timezone).getTime();
          if (!due) { report.reminder.skipped++; continue; }

          const open = await openLeaguesFor(u, rw.week, rw.games, { loadLeague, loadMembers, loadSurvivor, leagueStore });
          if (!open.length) { report.reminder.skipped++; continue; }

          const email = buildReminderEmail({
            season: CURRENT_SEASON,
            week: rw.week,
            kickLabel: kickoffLabel(rw.kickoff),
            leagues: open,
            firstGame: opener
              ? {
                  away: opener.away, home: opener.home,
                  awayName: nameOf(opener.away), homeName: nameOf(opener.home),
                  line: openerLine,
                }
              : undefined,
            unsubUrl: unsubUrl(u.userId, "reminders"),
          });

          if (!dryRun) {
            await markSent("reminder", CURRENT_SEASON, rw.week, u.userId);
            await sendEmail({ to: u.email, subject: email.subject, html: email.html, text: email.text, type: "reminders", userId: u.userId });
          }
          report.reminder.sent.push({ userId: u.userId, leagues: open.length, subject: email.subject });
        } catch (err) {
          report.errors.push({ userId: u.userId, stage: "reminder", error: err instanceof Error ? err.message : "unknown" });
        }
      }
    }

    // =======================================================================
    // WEEKLY RECAP
    // =======================================================================
    if (recapWeekNum !== null && (!only || only === "recap")) {
      const rw = recapWeekNum;
      const weekGames = (weeks.find((w) => w.week === rw)?.games || []) as ScheduleGame[];

      for (const u of users) {
        try {
          const prefs = await getPrefs(u.userId);
          if (!prefs.emailWeeklyRecap) { report.recap.skipped++; continue; }
          // BUG 3 (see below): the recap is no longer league-only, so a
          // user with favourites but no league is still eligible if they
          // asked for the team-news block.
          const wantsTeamNews = prefs.emailRecapTeamNews && u.favorites.length > 0;
          if (!u.leagues.length && !wantsTeamNews) { report.recap.skipped++; continue; }
          if (await alreadySent("recap", CURRENT_SEASON, rw, u.userId)) { report.recap.skipped++; continue; }

          const lp = localParts(now, prefs.timezone);
          if (lp.weekday !== "Tue" || lp.hour < RECAP_LOCAL_HOUR) { report.recap.skipped++; continue; }

          const built = await buildRecapFor(u, rw, weekGames, {
            loadLeague, loadMembers, loadStandings, loadSurvivor, loadResults, leagueStore, nameOf,
          });
          // Nothing scored for this reader in any league. An empty recap is
          // worse than no recap - but "empty" now depends on what they asked
          // for. Someone who opted into favourite-team news and has no
          // league (or has one that hasn't scored yet) still has an email
          // worth sending; before this, they'd have opted in and then
          // received nothing, forever, with nothing to indicate why.
          if (!built && !wantsTeamNews) { report.recap.skipped++; continue; }

          const email = buildRecapEmail({
            season: CURRENT_SEASON, week: rw,
            intro: built ? built.intro : "",
            leagues: built ? built.leagues : [],
            highlights: built ? built.highlights : [],
            unsubUrl: unsubUrl(u.userId, "weekly"),
          });

          if (!dryRun) {
            await markSent("recap", CURRENT_SEASON, rw, u.userId);
            await sendEmail({ to: u.email, subject: email.subject, html: email.html, text: email.text, type: "weekly", userId: u.userId });
          }
          report.recap.sent.push({ userId: u.userId, leagues: built ? built.leagues.length : 0, subject: email.subject });
        } catch (err) {
          report.errors.push({ userId: u.userId, stage: "recap", error: err instanceof Error ? err.message : "unknown" });
        }
      }
    }

    // =======================================================================
    // PUSH: KICKOFF, FINAL SCORE, LAST CALL  (Phase 1)
    // =======================================================================
    // All three run off data already in Blobs - the schedule for kickoff
    // times, the history doc for final scores - so none of them polls
    // anything. That's the whole reason this phase comes before live
    // scoring: it finds out whether people keep alerts switched on before
    // any money is spent on a 90-second poller.
    //
    // Candidate games are worked out FIRST, then per-user follow status.
    // The reverse - asking every user about every game - would be hundreds
    // of Blobs reads a tick to discover that one game is starting.

    const tally = (bucket: any, outcome: string) => {
      bucket.outcomes[outcome] = (bucket.outcomes[outcome] || 0) + 1;
      if (outcome === "sent") bucket.sent++;
    };

    if (!only || only === "push") {
      // ---- Which games are candidates right now? -------------------------
      const kickoffCandidates: Array<{ week: number; game: ScheduleGame; kickoff: Date }> = [];
      const finalCandidates: Array<{ week: number; game: ScheduleGame; kickoff: Date; away: number; home: number }> = [];

      let historyDoc: any = null;
      try {
        historyDoc = await siteDataStore.get("history", { type: "json" });
      } catch { /* finals degrade to "none this tick" rather than failing the pass */ }

      for (const w of weeks) {
        for (const g of (w.games || []) as ScheduleGame[]) {
          const kickoff = parseKickoffUTC(CURRENT_SEASON, g.date, g.time);
          if (!kickoff) continue;   // flexed/TBD placeholder

          // Kickoff: one tick-wide window, positioned so exactly one tick can
          // land in it. See inLeadWindow - a fixed "10 minutes before" can't
          // be honoured on a 15-minute tick, so the copy states the real
          // remaining time instead of a number that would usually be wrong.
          if (inLeadWindow(now, kickoff, KICKOFF_LEAD_MIN)) {
            kickoffCandidates.push({ week: w.week, game: g, kickoff });
          }

          // Final: the history doc is refreshed on its own schedule, so a
          // game can appear final at any tick after it ends. The recency
          // guard is what stops a first run (empty ledger) from firing an
          // alert for every completed game of the season at once - only
          // games that plausibly ended in the last few hours qualify.
          const endedApprox = kickoff.getTime() + APPROX_GAME_MS;
          const age = now.getTime() - endedApprox;
          if (age < 0 || age > FINAL_MAX_AGE_MS) continue;

          const weekHistory = (historyDoc?.weeks || []).find((h: any) => h.week === w.week);
          const result = weekHistory?.results?.[`${g.away}-${g.home}`];
          if (result?.final && typeof result.awayScore === "number" && typeof result.homeScore === "number") {
            finalCandidates.push({ week: w.week, game: g, kickoff, away: result.awayScore, home: result.homeScore });
          }
        }
      }

      report.kickoff.games = kickoffCandidates.map((c) => `${c.game.away}@${c.game.home}`);
      report.final.games = finalCandidates.map((c) => `${c.game.away}@${c.game.home}`);

      // ---- Kickoff --------------------------------------------------------
      for (const c of kickoffCandidates) {
        const gameId = makeGameId(CURRENT_SEASON, c.week, c.game.away, c.game.home);
        let line: string | undefined;
        try {
          const oddsDoc: any = await oddsStore.get("odds", { type: "json" });
          const og = oddsDoc?.weeks?.[String(c.week)]?.games?.[`${c.game.away}-${c.game.home}`];
          if (og && typeof og.spread === "number" && og.favorite) {
            line = `${og.favorite} ${og.spread}${typeof og.overUnder === "number" ? ` · O/U ${og.overUnder}` : ""}`;
          }
        } catch { /* the line is decoration; a missing one shortens the copy */ }

        for (const u of users) {
          try {
            const prefs = await getPrefs(u.userId);
            if (!prefs.push.kickoff) { tally(report.kickoff, "off"); continue; }
            if (!(await followsGame(u, prefs, CURRENT_SEASON, c.week, c.game, { leagueStore }))) {
              tally(report.kickoff, "not-followed"); continue;
            }
            const mins = minutesUntil(now, c.kickoff);
            const outcome = await deliverAlert({
              user: u, prefs, type: "kick", event: gameId,
              season: CURRENT_SEASON, week: c.week,
              capability: "alerts.kickoff", now, dryRun,
              payload: {
                title: `${nameOf(c.game.away)} at ${nameOf(c.game.home)}`,
                body: line
                  ? `Kicks off in ${mins} minutes. ${line}`
                  : `Kicks off in ${mins} minutes.`,
                url: `/g/${gameId}`,
                collapseKey: `game:${gameId}`,
                data: { kind: "kickoff", gameId },
              },
            });
            tally(report.kickoff, outcome);
          } catch (err) {
            report.errors.push({ userId: u.userId, stage: "kickoff", error: err instanceof Error ? err.message : "unknown" });
          }
        }
      }

      // ---- Final score ----------------------------------------------------
      for (const c of finalCandidates) {
        const gameId = makeGameId(CURRENT_SEASON, c.week, c.game.away, c.game.home);
        const tie = c.away === c.home;
        const winner = tie ? null : (c.away > c.home ? c.game.away : c.game.home);
        const title = tie
          ? `Final: ${c.game.away} ${c.away}, ${c.game.home} ${c.home} (tie)`
          : `Final: ${nameOf(winner as string)} win`;
        const scoreLine = `${c.game.away} ${c.away}, ${c.game.home} ${c.home}`;

        for (const u of users) {
          try {
            const prefs = await getPrefs(u.userId);
            if (!prefs.push.final) { tally(report.final, "off"); continue; }
            if (!(await followsGame(u, prefs, CURRENT_SEASON, c.week, c.game, { leagueStore }))) {
              tally(report.final, "not-followed"); continue;
            }

            // If they picked this game, say whether it came in. Read once per
            // user per game rather than per league-per-game: the first league
            // with a pick answers it.
            let pickNote = "";
            for (const leagueId of u.leagues) {
              try {
                const pick: any = await leagueStore.get(`picks:${leagueId}:${c.week}:${u.userId}:${gameId}`, { type: "json" });
                if (pick?.team) {
                  pickNote = tie ? " Your pick pushed." : pick.team === winner ? " Your pick came in." : " Your pick missed.";
                  break;
                }
              } catch { /* no pick note rather than no alert */ }
            }

            const outcome = await deliverAlert({
              user: u, prefs, type: "final", event: gameId,
              season: CURRENT_SEASON, week: c.week,
              capability: "alerts.final", now, dryRun,
              payload: {
                title,
                body: `${scoreLine}.${pickNote}`,
                url: `/g/${gameId}`,
                collapseKey: `game:${gameId}`,
                data: { kind: "final", gameId },
              },
            });
            tally(report.final, outcome);
          } catch (err) {
            report.errors.push({ userId: u.userId, stage: "final", error: err instanceof Error ? err.message : "unknown" });
          }
        }
      }

      // ---- Last call ------------------------------------------------------
      // One per user per week, ahead of the week's first kickoff - the point
      // at which picks start locking. Deliberately not one per slate: the
      // evening-before email already covers the week, this is the final
      // safety net, and a nudge that can fire on Thursday, Sunday and Monday
      // is how a safety net becomes nagging. Per-slate nudges want the
      // 90-second tick from Phase 3 anyway, so they can be revisited there.
      if (reminderWeek && inLeadWindow(now, reminderWeek.kickoff, LAST_CALL_LEAD_MIN)) {
        const rw = reminderWeek;
        for (const u of users) {
          if (!u.leagues.length) { tally(report.lastCall, "no-leagues"); continue; }
          try {
            const prefs = await getPrefs(u.userId);
            if (!prefs.push.lastCall) { tally(report.lastCall, "off"); continue; }

            const open = await openLeaguesFor(u, rw.week, rw.games, { loadLeague, loadMembers, loadSurvivor, leagueStore });
            if (!open.length) { tally(report.lastCall, "nothing-open"); continue; }

            const missing = open.reduce((sum, l) => sum + l.missing, 0);
            const mins = minutesUntil(now, rw.kickoff);
            const outcome = await deliverAlert({
              user: u, prefs, type: "lastcall", event: `w${rw.week}`,
              season: CURRENT_SEASON, week: rw.week,
              capability: "alerts.last-call", now, dryRun,
              // The one alert allowed through quiet hours: a pick deadline
              // slept through is worse than being woken for it.
              pierceQuietHours: true,
              payload: {
                title: `${mins} minutes to pick`,
                body: open.length === 1
                  ? `${missing} game${missing === 1 ? "" : "s"} still open in ${open[0].name}.`
                  : `${missing} games still open across ${open.length} leagues.`,
                url: "/leagues",
                collapseKey: `lastcall:${CURRENT_SEASON}:${rw.week}`,
                data: { kind: "last-call", week: rw.week },
              },
            });
            tally(report.lastCall, outcome);
          } catch (err) {
            report.errors.push({ userId: u.userId, stage: "lastCall", error: err instanceof Error ? err.message : "unknown" });
          }
        }
      }
    }

    return jsonResponse(200, report);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error", report });
  }
};

// ---------------------------------------------------------------------------
// Reminder: which of this reader's leagues still have games open
// ---------------------------------------------------------------------------

async function openLeaguesFor(
  u: { userId: string; leagues: string[] },
  week: number,
  games: ScheduleGame[],
  io: any
): Promise<Array<{ format: string; name: string; missing: number; total: number }>> {
  const out: Array<{ format: string; name: string; missing: number; total: number }> = [];

  for (const leagueId of u.leagues) {
    const league = await io.loadLeague(leagueId);
    if (!league || league.locked || league.season !== 2026) continue;

    const members = await io.loadMembers(leagueId);
    if (!members?.members?.some((m: any) => m.userId === u.userId)) continue; // stale users:{}.leagues entry

    // An eliminated Survivor player has nothing left to pick. Reminding them
    // would be worse than useless.
    if (league.format === "survivor") {
      const state = await io.loadSurvivor(leagueId);
      if (state?.[u.userId]?.alive === false) continue;
    }

    const picked = await Promise.all(
      games.map((g: ScheduleGame) => {
        const gid = makeGameId(league.season, week, g.away, g.home);
        return io.leagueStore.get(`picks:${leagueId}:${week}:${u.userId}:${gid}`, { type: "json" });
      })
    );
    const pickedCount = picked.filter(Boolean).length;

    // Survivor is one pick for the whole week, not one per game.
    const total = league.format === "survivor" ? 1 : games.length;
    const missing = league.format === "survivor" ? (pickedCount > 0 ? 0 : 1) : games.length - pickedCount;
    if (missing <= 0) continue;

    out.push({ format: league.format, name: league.name, missing, total });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Recap: standings, movement, survivor pick, highlights
// ---------------------------------------------------------------------------

async function buildRecapFor(
  u: { userId: string; leagues: string[] },
  week: number,
  games: ScheduleGame[],
  io: any
): Promise<{ intro: string; leagues: RecapLeague[]; highlights: RecapHighlight[] } | null> {
  const leagues: RecapLeague[] = [];
  const highlights: RecapHighlight[] = [];
  let totalCorrect = 0, totalIncorrect = 0, anyScored = false;

  for (const leagueId of u.leagues) {
    const league = await io.loadLeague(leagueId);
    if (!league || league.season !== 2026) continue;

    const members = await io.loadMembers(leagueId);
    if (!members?.members?.some((m: any) => m.userId === u.userId)) continue;

    const standings = await io.loadStandings(leagueId);
    const weekScores = standings?.weeks?.[week];
    if (!weekScores || !weekScores[u.userId]) continue; // nothing scored for this reader
    anyScored = true;

    const mine = weekScores[u.userId];
    totalCorrect += mine.correct || 0;
    totalIncorrect += mine.incorrect || 0;

    const nameById = new Map<string, string>(
      (members?.members || []).map((m: any) => [m.userId, m.displayName || "Player"])
    );

    // Rank movement without a stored snapshot: standings.weeks holds every
    // scored week, so last week's table is just the same sum over weeks < W,
    // ranked by the same engine. One less thing to keep in sync.
    const seasonRows: any[] = standings?.season || [];
    const myRow = seasonRows.find((r: any) => r.userId === u.userId);
    const currentRank = myRow?.rank ?? seasonRows.length + 1;

    const priorTotals: Record<string, { points: number; correct: number; incorrect: number }> = {};
    for (const wk of Object.keys(standings?.weeks || {})) {
      if (Number(wk) >= week) continue;
      const wkScores = standings.weeks[wk];
      for (const uid of Object.keys(wkScores)) {
        const t = priorTotals[uid] || (priorTotals[uid] = { points: 0, correct: 0, incorrect: 0 });
        t.points += wkScores[uid].points;
        t.correct += wkScores[uid].correct;
        t.incorrect += wkScores[uid].incorrect;
      }
    }
    const priorRanked: any[] = Object.keys(priorTotals).length
      ? ScoringEngine.rankStandings(priorTotals, league.tieBreaker)
      : [];
    const priorRank = priorRanked.find((r: any) => r.userId === u.userId)?.rank ?? null;
    // Positive = moved up the table (rank number went down).
    const delta = priorRank === null ? 0 : priorRank - currentRank;

    const memberCount = (members?.members || []).length;
    const results = await io.loadResults(leagueId, week);
    const weekResults: Record<string, any> = results?.results || {};

    // ---- Survivor: the strip carries the pick, not a leaderboard --------
    if (league.format === "survivor") {
      const state = await io.loadSurvivor(leagueId);
      const mineState = state?.[u.userId] || { alive: true, eliminatedWeek: null };
      const aliveCount = Object.values(state || {}).filter((s: any) => s?.alive !== false).length || memberCount;

      let pickRow: RecapLeague["pick"];
      for (const g of games) {
        const gid = makeGameId(league.season, week, g.away, g.home);
        const p: any = await io.leagueStore.get(`picks:${leagueId}:${week}:${u.userId}:${gid}`, { type: "json" });
        if (!p?.team) continue;
        const res = weekResults[gid];
        const won = res && !res.tie && res.winner === p.team;
        const score = res && typeof res.homeScore === "number" && typeof res.awayScore === "number"
          ? (p.team === res.home
              ? `${won ? "W" : "L"} ${res.homeScore}-${res.awayScore}`
              : `${won ? "W" : "L"} ${res.awayScore}-${res.homeScore}`)
          : (won ? "Won" : "Lost");
        pickRow = { teamAbbr: p.team, teamName: io.nameOf(p.team), result: score, tone: won ? "alive" : "out" };
        break;
      }

      const eliminatedThisWeek = mineState.alive === false && mineState.eliminatedWeek === week;
      const alreadyOut = mineState.alive === false && mineState.eliminatedWeek !== week;
      if (alreadyOut) continue; // out weeks ago; nothing new to report

      leagues.push({
        format: league.format,
        name: league.name,
        seasonLabel: `${league.season} season`,
        headline: eliminatedThisWeek ? `Eliminated in Week ${week}` : "Survived",
        headlineTone: eliminatedThisWeek ? "loss" : "win",
        rank: eliminatedThisWeek ? "Out" : String(aliveCount),
        total: eliminatedThisWeek ? null : memberCount,
        delta: 0,
        pick: pickRow,
        stripLabel: pickRow ? "Your pick" : undefined,
        foot: eliminatedThisWeek
          ? `${aliveCount} of ${memberCount} still alive. You lasted ${week} week${week === 1 ? "" : "s"}.`
          : `${memberCount - aliveCount} knocked out in Week ${week}`,
      });
      continue;
    }

    // ---- Everything else: a three-row slice around the reader ----------
    const window: any[] = [];
    const myIdx = seasonRows.findIndex((r: any) => r.userId === u.userId);
    if (myIdx >= 0) {
      const start = Math.max(0, myIdx - 1);
      window.push(...seasonRows.slice(start, start + 3));
    } else {
      window.push(...seasonRows.slice(0, 3));
    }

    const isAts = league.format === "ats";
    const standingRows = window.map((r: any) => ({
      rank: r.rank,
      name: r.userId === u.userId ? "You" : (nameById.get(r.userId) || "Player"),
      value: isAts ? `${r.correct}-${r.incorrect}` : String(r.points),
      isMe: r.userId === u.userId,
    }));

    const leader = seasonRows[0];
    const gap = leader && myRow ? (leader.points || 0) - (myRow.points || 0) : 0;
    const foot = myIdx === 0
      ? "You're leading the league"
      : gap > 0
        ? `${gap} pt${gap === 1 ? "" : "s"} back of 1st`
        : "Tied at the top";

    leagues.push({
      format: league.format,
      name: league.name,
      seasonLabel: `${league.season} season`,
      headline: `${mine.correct}-${mine.incorrect}${isAts ? " ATS" : ` - ${mine.points} pts`}`,
      headlineTone: "neutral",
      rank: currentRank,
      total: memberCount,
      delta,
      standings: standingRows,
      foot,
    });

    // ---- Highlights: only where the pick carried a weight ---------------
    // In a confidence league, the size of a hit or miss is the whole story.
    // In straight-up or ATS every pick is worth the same, so "best call"
    // would just be an arbitrary correct one - omitted rather than faked.
    if (league.format === "confidence" && !highlights.length) {
      let best: { conf: number; team: string } | null = null;
      let worst: { conf: number; team: string } | null = null;
      for (const g of games) {
        const gid = makeGameId(league.season, week, g.away, g.home);
        const p: any = await io.leagueStore.get(`picks:${leagueId}:${week}:${u.userId}:${gid}`, { type: "json" });
        if (!p?.team || typeof p.confidence !== "number") continue;
        const res = weekResults[gid];
        if (!res || !res.final) continue;
        const correct = !res.tie && res.winner === p.team;
        if (correct && (!best || p.confidence > best.conf)) best = { conf: p.confidence, team: p.team };
        if (!correct && (!worst || p.confidence > worst.conf)) worst = { conf: p.confidence, team: p.team };
      }
      if (best) {
        highlights.push({
          label: "Best call", tone: "win",
          headline: `${io.nameOf(best.team)} - banked ${best.conf} pts`,
          detail: `Your highest-ranked pick that came in.`,
        });
      }
      if (worst) {
        highlights.push({
          label: "Costliest miss", tone: "loss",
          headline: `${io.nameOf(worst.team)} - lost ${worst.conf} pts`,
          detail: `Your ${worst.conf}-point pick didn't land.`,
        });
      }
    }
  }

  if (!anyScored || !leagues.length) return null;

  const moved = leagues.filter((l) => l.delta > 0).length;
  const intro = moved
    ? `You went ${totalCorrect}-${totalIncorrect} across ${leagues.length} league${leagues.length === 1 ? "" : "s"} and moved up in ${moved}.`
    : `You went ${totalCorrect}-${totalIncorrect} across ${leagues.length} league${leagues.length === 1 ? "" : "s"}.`;

  return { intro, leagues, highlights };
}

export const config: Config = {
  path: "/.netlify/functions/notif-dispatch-background",
};

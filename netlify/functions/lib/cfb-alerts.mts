import { getStore } from "@netlify/blobs";
import { notifStore, getPrefs, USER_STORE } from "./notif.mts";
import { deliverAlert, type AlertUser } from "./alerts.mts";
import type { AlertLog } from "./alertlog.mts";
import { CFB_SEASON, CFB_STORE, fetchScoreboard, loadWeekCfbFollows } from "./cfb.mts";

function num(v: any): number | null {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------------ */
/* Live alerts                                                               */
/* ------------------------------------------------------------------------ */
//
// Run from notif-live-dispatch-background on its 90-second tick. Its cron
// window already covers Saturday noon-midnight ET; weeknight college games
// (Tuesday/Wednesday MACtion, Friday nights) only alert if that window is
// widened on cron-job.org.

interface CfbLiveGame {
  eventId: string;
  week: number;
  date: string;
  state: "pre" | "in" | "post";
  period: number;
  clock: string;
  away: { id: string; abbr: string; name: string; score: number };
  home: { id: string; abbr: string; name: string; score: number };
  line: string | null;
}

interface CfbSnapshot { awayScore: number; homeScore: number; state: string; leader: string | null; updatedAt: string }

const KICKOFF_LEAD_MS = 15 * 60 * 1000;
const KICKOFF_LATE_MS = 5 * 60 * 1000;

function liveGamesOf(sb: any): CfbLiveGame[] {
  const week = Number(sb?.week?.number) || 0;
  const out: CfbLiveGame[] = [];
  for (const e of sb?.events || []) {
    const comp = e?.competitions?.[0];
    if (!comp) continue;
    const hc = (comp.competitors || []).find((c: any) => c.homeAway === "home");
    const ac = (comp.competitors || []).find((c: any) => c.homeAway === "away");
    if (!hc?.team?.id || !ac?.team?.id) continue;
    const st = comp.status?.type?.state;
    if (st !== "pre" && st !== "in" && st !== "post") continue;
    const o = Array.isArray(comp.odds) ? comp.odds[0] : null;
    const line = o?.details ? `${o.details}${num(o.overUnder) !== null ? ` · O/U ${o.overUnder}` : ""}` : null;
    out.push({
      eventId: String(e.id), week, date: comp.date || e.date, state: st,
      period: Number(comp.status?.period) || 0, clock: String(comp.status?.displayClock || ""),
      away: { id: String(ac.team.id), abbr: ac.team.abbreviation, name: ac.team.shortDisplayName || ac.team.location || ac.team.abbreviation, score: Number(ac.score) || 0 },
      home: { id: String(hc.team.id), abbr: hc.team.abbreviation, name: hc.team.shortDisplayName || hc.team.location || hc.team.abbreviation, score: Number(hc.score) || 0 },
      line,
    });
  }
  return out;
}

function clockOf(g: CfbLiveGame): string {
  if (g.state === "post") return "Final";
  if (g.period > 4) return `OT${g.period > 5 ? g.period - 4 : ""}`;
  return `Q${g.period} ${g.clock}`.trim();
}

function playKind(delta: number): string | null {
  if (delta >= 6) return "Touchdown";
  if (delta === 3) return "Field goal";
  if (delta === 2) return "Safety";
  return null;
}

export async function runCfbLivePass(args: {
  now: Date; dryRun: boolean; onlyUser: string | null; log: AlertLog; force?: boolean;
}): Promise<any> {
  const { now, dryRun, onlyUser, log } = args;
  const report: any = { polled: false, live: 0, kickoff: { sent: 0, outcomes: {} }, scoring: { sent: 0, outcomes: {} }, final: { sent: 0, outcomes: {} }, errors: [] };
  const tally = (bucket: any, outcome: string) => {
    bucket.outcomes[outcome] = (bucket.outcomes[outcome] || 0) + 1;
    if (outcome === "sent") bucket.sent++;
  };

  // Cheapest check first: does anyone follow a college game or star a
  // college team at all? Kept as a tiny marker written by cfb-follow and by
  // user-profile, so a quiet Saturday tick costs one Blobs read.
  const cfbStore = getStore(CFB_STORE, { consistency: "strong" });
  const marker: any = await cfbStore.get("alerts-interest", { type: "json" }).catch(() => null);
  if (!marker?.any && !args.force) return { ...report, note: "No college follows or favourites" };

  const sb = await fetchScoreboard({});
  report.polled = true;
  const games = liveGamesOf(sb);
  if (!games.length) return report;
  // Follows file the whole postseason under week 20 (see cfbFollowWeek in
  // the app), since ESPN restarts its numbering at 1 for bowl season.
  const week = Number(sb?.season?.type) === 3 ? 20 : games[0].week;

  // Housekeeping, three weeks back: follows and score snapshots are only
  // ever read for the current week, so anything older is dead weight. A
  // prefix list on a week with nothing left in it costs one cheap call.
  if (!dryRun && week > 3) {
    const st = notifStore();
    for (const prefix of [`cfbfollow:${CFB_SEASON}:${week - 3}:`, `cfblive:${CFB_SEASON}:${week - 3}:`]) {
      try {
        for await (const page of st.list({ prefix, paginate: true })) {
          for (const b of page.blobs) await st.delete(b.key);
        }
      } catch { /* next tick tries again */ }
    }
  }

  interface Change { g: CfbLiveGame; kind: "kickoff" | "score" | "final"; prev?: CfbSnapshot }
  const changes: Change[] = [];
  const store = notifStore();

  for (const g of games) {
    const kick = Date.parse(g.date);
    if (g.state === "pre") {
      if (Number.isFinite(kick) && kick - now.getTime() <= KICKOFF_LEAD_MS && now.getTime() - kick <= KICKOFF_LATE_MS) {
        changes.push({ g, kind: "kickoff" });
      }
      continue;
    }
    if (g.state === "in") report.live++;
    const key = `cfblive:${CFB_SEASON}:${week}:${g.eventId}`;
    const prev = (await store.get(key, { type: "json" }).catch(() => null)) as CfbSnapshot | null;
    // A game that ended before we ever saw it isn't news.
    if (!prev && g.state === "post") continue;
    const leader = g.away.score === g.home.score ? null : (g.away.score > g.home.score ? g.away.id : g.home.id);
    const changed = !prev || prev.awayScore !== g.away.score || prev.homeScore !== g.home.score || prev.state !== g.state;
    if (changed && !dryRun) {
      await store.setJSON(key, { awayScore: g.away.score, homeScore: g.home.score, state: g.state, leader, updatedAt: now.toISOString() });
    }
    if (!prev) continue;   // first sighting is silent - see the NFL dispatcher
    if (g.state === "post" && prev.state !== "post") changes.push({ g, kind: "final", prev });
    else if (prev.awayScore !== g.away.score || prev.homeScore !== g.home.score) changes.push({ g, kind: "score", prev });
  }
  if (!changes.length) return { ...report, note: "No changes this tick" };

  const follows = await loadWeekCfbFollows(week);
  const userStore = getStore(USER_STORE, { consistency: "strong" });
  const users: (AlertUser & { cfbFavorites: string[] })[] = [];
  for await (const page of userStore.list({ prefix: "users:", paginate: true })) {
    for (const b of page.blobs) {
      const userId = b.key.slice("users:".length);
      if (onlyUser && userId !== onlyUser) continue;
      try {
        const profile: any = await userStore.get(b.key, { type: "json" });
        if (!profile?.email || profile.suspended) continue;
        const cfbFavorites: string[] = Array.isArray(profile?.settings?.cfbFavorites) ? profile.settings.cfbFavorites : [];
        if (!cfbFavorites.length && !follows.has(userId)) continue;
        users.push({ userId, email: profile.email, leagues: [], favorites: [], profile, cfbFavorites });
      } catch (err) {
        report.errors.push({ userId, stage: "profile", error: err instanceof Error ? err.message : "unknown" });
      }
    }
  }

  for (const ch of changes) {
    const { g } = ch;
    const event = `cfb-${g.eventId}`;
    const label = `${g.away.abbr}@${g.home.abbr}`;
    const scoreLine = `${g.away.name} ${g.away.score}, ${g.home.name} ${g.home.score}`;
    const url = `/college/?game=${g.eventId}`;
    for (const u of users) {
      try {
        const followed = follows.get(u.userId)?.has(g.eventId) || false;
        // College has no pools, so a starred team is the only standing
        // signal there is - it stands in whatever the scope setting says,
        // same as the NFL preseason and playoff weeks.
        const byFav = u.cfbFavorites.includes(g.away.id) || u.cfbFavorites.includes(g.home.id);
        if (!followed && !byFav) continue;
        const prefs = await getPrefs(u.userId);

        if (ch.kind === "kickoff") {
          if (!prefs.push.kickoff) { tally(report.kickoff, "off"); continue; }
          const mins = Math.max(1, Math.round((Date.parse(g.date) - now.getTime()) / 60000));
          const outcome = await deliverAlert({
            user: u, prefs, type: "kick", event, season: CFB_SEASON, week,
            capability: "alerts.kickoff", now, dryRun, log, label,
            payload: {
              title: `${g.away.name} at ${g.home.name}`,
              body: g.line ? `Kicks off in ${mins} minutes. ${g.line}` : `Kicks off in ${mins} minutes.`,
              url, collapseKey: `game:${event}`, data: { kind: "kickoff", gameId: event },
            },
          });
          tally(report.kickoff, outcome);
          continue;
        }

        if (ch.kind === "final") {
          if (!prefs.push.final) { tally(report.final, "off"); continue; }
          const tie = g.away.score === g.home.score;
          const winner = tie ? null : (g.away.score > g.home.score ? g.away.name : g.home.name);
          const outcome = await deliverAlert({
            user: u, prefs, type: "final", event, season: CFB_SEASON, week,
            capability: "alerts.final", now, dryRun, log, label,
            payload: {
              title: tie ? `Final: ${scoreLine}` : `Final: ${winner} win`,
              body: `${scoreLine}.`,
              url, collapseKey: `game:${event}`, data: { kind: "final", gameId: event },
            },
          });
          tally(report.final, outcome);
          continue;
        }

        // Scoring
        if (prefs.push.scoring === "off") { tally(report.scoring, "off"); continue; }
        const prev = ch.prev!;
        const prevLeader = prev.leader;
        const leader = g.away.score === g.home.score ? null : (g.away.score > g.home.score ? g.away.id : g.home.id);
        const leadChanged = !!leader && leader !== prevLeader;
        if (prefs.push.scoring === "lead" && !leadChanged) { tally(report.scoring, "not-lead-change"); continue; }
        const awayDelta = g.away.score - prev.awayScore;
        const homeDelta = g.home.score - prev.homeScore;
        const scorer = awayDelta > homeDelta ? g.away : g.home;
        const kind = playKind(Math.max(awayDelta, homeDelta));
        const leadNote = leadChanged ? ` ${(leader === g.away.id ? g.away : g.home).name} take the lead.` : "";
        const outcome = await deliverAlert({
          user: u, prefs, type: "score", event: `${event}:${g.away.score}-${g.home.score}`, season: CFB_SEASON, week,
          capability: "alerts.scoring", now, dryRun, log, label,
          payload: {
            title: scoreLine,
            body: `${kind ? `${kind}, ${scorer.name}. ` : ""}${clockOf(g)}.${leadNote}`.trim(),
            url, collapseKey: `game:${event}`, data: { kind: "score", gameId: event },
          },
        });
        tally(report.scoring, outcome);
      } catch (err) {
        report.errors.push({ userId: u.userId, stage: `cfb-${ch.kind}`, error: err instanceof Error ? err.message : "unknown" });
      }
    }
  }
  return report;
}


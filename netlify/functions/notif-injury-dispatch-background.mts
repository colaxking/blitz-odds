import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getPrefs, notifStore, USER_STORE } from "./lib/notif.mts";
import { deliverAlert, type AlertUser } from "./lib/alerts.mts";
import { createAlertLog } from "./lib/alertlog.mts";
import {
  fetchEspnInjuries, detailPhrase, SEVERITY, PREMIUM_POSITIONS,
  type EspnInjury, type InjuryState,
} from "./lib/espn-injuries.mts";
import {
  fetchTeamDepth, bestSpot, foldHealthyDepth, checkStanding, suggestImpactScore, describeSpot,
  DEPTH_SNAPSHOT_KEY, DEPTH_REFETCH_MS, DOWN_SET_KEY,
  type DepthSnapshot, type DepthSpot, type HealthyDepth,
} from "./lib/espn-depth.mts";

// Watches ESPN's injury feed for changes, alerts on the ones that matter,
// and queues the rest for review.
//
// POST /.netlify/functions/notif-injury-dispatch-background
// Header: x-notif-dispatch-secret
// Body (all optional): { now?, dryRun?, userId? }
//
// THE CENTRAL RULE: DIFF ESPN AGAINST ITSELF, NEVER AGAINST THE CURATED FILE.
//
// The two sources disagree constantly and always have - 13 of 71 tracked
// players on the day this was written. Those disagreements are standing
// drift, not events: ESPN reports the official designation, the curated file
// reports what actually happened. Diffing ESPN against impact-players.json
// would fire 13 alerts on the first tick for nothing at all, and keep firing
// every time the snapshot was lost.
//
// Diffing ESPN against its own previous snapshot means a permanent
// disagreement never fires. An alert requires ESPN itself to have moved.
//
// ESPN IS ALSO NEVER THE SOURCE OF TRUTH. Nothing here writes a player's
// status. The alert says what ESPN now lists, attributed to ESPN, and the
// curated file continues to drive what the app displays and what the model
// consumes.

const SITE_DATA_STORE = "blitz-site-data";
const CURRENT_SEASON = 2026;

/** One document rather than 800 keys: a per-athlete key would be 800 reads
 *  and 800 writes a tick, against one of each. */
const SNAPSHOT_KEY = "espn-injury-snapshot";

/** A report older than this is treated as pre-existing rather than new, so a
 *  lost snapshot can't replay a fortnight of injuries at once. */
const MAX_REPORT_AGE_MS = 36 * 60 * 60 * 1000;

/** impactScore at or above which a curated player counts as "key" for the
 *  purposes of the injuries: "key" | "all" preference. */
const KEY_PLAYER_IMPACT = 7;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

interface SnapshotEntry { state: InjuryState; status: string | null; date: string | null; injuryId: string | null }
interface Snapshot { updatedAt: string; players: Record<string, SnapshotEntry> }

export interface ReviewItem {
  id: string;
  espnId: string;
  name: string | null;
  team: string;
  position: string | null;
  kind: "tracked-change" | "untracked-candidate";
  /** What the curated file says today, for a tracked player. */
  ours: InjuryState | null;
  from: InjuryState | null;
  to: InjuryState;
  espnStatus: string | null;
  detail: string | null;
  returnDate: string | null;
  comment: string | null;
  reportedAt: string | null;
  /** Where he sits when healthy, from the depth snapshot. Null when he has
   *  no healthy reading on file - which is "unknown", never "buried". */
  depth?: { index: number; size: number; pos: string | null; label: string | null } | null;
  /** A starting number for the queue row's 1-10 box, so applying a row is
   *  one tap instead of a research question. Always overridable. */
  suggestedImpact?: number | null;
  /** Where he stood when the change landed. Kept for the row's own copy so
   *  the panel doesn't have to re-derive it from a chart that has since moved. */
  standing?: "starter" | "next-man-up" | "covered" | "unknown";
  /** Set when the dispatcher resolved this itself because
   *  injury-player-sync.mjs is going to handle it. Never set by a human. */
  autoHandled?: string;
  seenAt: string;
  resolved?: boolean;
  resolvedAt?: string;
}

const reviewKey = (id: string) => `review:${id}`;

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
  const alertLog = createAlertLog("injury", now, dryRun);
  const onlyUser: string | null = body.userId || null;

  const store = notifStore();
  const siteDataStore = getStore(SITE_DATA_STORE);
  const userStore = getStore(USER_STORE, { consistency: "strong" });

  const report: any = {
    ok: true, at: now.toISOString(), dryRun,
    fetched: 0, changes: [], alerts: { sent: 0, outcomes: {} }, queued: 0,
    skippedDismissed: [], skippedAgreed: [], errors: [],
  };

  try {
    const fresh = await fetchEspnInjuries();
    report.fetched = Object.keys(fresh).length;

    const prev = (await store.get(SNAPSHOT_KEY, { type: "json" })) as Snapshot | null;

    const nextSnapshot: Snapshot = { updatedAt: now.toISOString(), players: {} };
    for (const [id, e] of Object.entries(fresh)) {
      nextSnapshot.players[id] = { state: e.state, status: e.status, date: e.date, injuryId: e.injuryId };
    }

    // First run: record the world and alert on nothing. Every record looks
    // new against an empty snapshot, and firing 800 alerts because a blob
    // was missing is not a recoverable mistake.
    if (!prev || !prev.players) {
      if (!dryRun) await store.setJSON(SNAPSHOT_KEY, nextSnapshot);
      return jsonResponse(200, { ...report, note: "First run - snapshot recorded, no alerts sent." });
    }

    // ---- Which curated players do we track, and how important? ----------
    const playersDoc: any = await siteDataStore.get("players", { type: "json" });
    const curated = new Map<string, {
      name: string; team: string; status: InjuryState; impactScore: number;
      statusUpdatedAt: string | null; source: string | null; pinned: boolean;
    }>();
    for (const [team, list] of Object.entries<any>(playersDoc?.players || {})) {
      for (const p of list || []) {
        if (p.espnId) curated.set(String(p.espnId), {
          name: p.name, team, status: p.status, impactScore: p.impactScore || 0,
          // Read only to predict what injury-player-sync.mjs will do with
          // this player on its next run - see autoHandledReason below.
          statusUpdatedAt: p.statusUpdatedAt || null, source: p.source || null, pinned: p.pinned === true,
        });
      }
    }

    // ---- What moved? -----------------------------------------------------
    interface Change { e: EspnInjury; from: InjuryState | null; to: InjuryState; tracked: boolean }
    const changes: Change[] = [];

    for (const [id, e] of Object.entries(fresh)) {
      const before = prev.players[id];
      const from = before ? before.state : null;

      // Unchanged collapsed state and the same underlying report: nothing
      // happened. A new injuryId with the same state is a fresh report about
      // the same situation - also not an event worth waking anyone for.
      if (before && before.state === e.state) continue;

      // A report we've never seen but which is stale on its own timestamp is
      // backfill, not news - most often a player who appeared in the feed
      // late. Recorded, not alerted.
      if (e.date && now.getTime() - Date.parse(e.date) > MAX_REPORT_AGE_MS) continue;

      changes.push({ e, from, to: e.state, tracked: curated.has(id) });
    }

    report.changes = changes.map((c) => `${c.e.name} (${c.e.team}) ${c.from ?? "—"} → ${c.to}${c.tracked ? " [tracked]" : ""}`);

    if (!changes.length) {
      if (!dryRun) await store.setJSON(SNAPSHOT_KEY, nextSnapshot);
      return jsonResponse(200, { ...report, note: "No changes this tick" });
    }

    // ---- Depth charts, for the teams that actually moved -----------------
    // Two uses: filtering out genuine depth pieces before they reach the
    // queue, and pre-filling the impact score each row asks for.
    //
    // ESPN DEMOTES AN INJURED PLAYER ON HIS OWN DEPTH CHART, at the same
    // moment it designates him out. 44 of the 74 players impact-players.json
    // carries as "out" are listed third-or-deeper with nobody behind them
    // today - Josh Jacobs, Laremy Tunsil, Owusu-Koramoah among them - against
    // 0 of the 71 carried active or questionable. So a live reading of an
    // injured player says nothing about how much he matters, and everything
    // about the designation that just landed.
    //
    // The snapshot therefore records a player ONLY on a tick where ESPN
    // lists him healthy, and keeps the best index ever seen. That's "where
    // he plays when he plays". A player with no healthy reading is unknown
    // rather than buried, and is never filtered on that basis.
    //
    // Only teams with a change this tick are fetched, and each at most every
    // DEPTH_REFETCH_MS, so a two-minute tick usually adds zero requests.
    const depthSnapshot: DepthSnapshot =
      ((await store.get(DEPTH_SNAPSHOT_KEY, { type: "json" })) as DepthSnapshot | null)
      || { updatedAt: now.toISOString(), teams: {}, players: {} };
    depthSnapshot.teams = depthSnapshot.teams || {};
    depthSnapshot.players = depthSnapshot.players || {};

    // Healthy per ESPN right now: either no injury record at all, or one
    // that collapses to "active".
    const isHealthy = (athleteId: string) => {
      const rec = fresh[athleteId];
      return !rec || rec.state === "active";
    };

    /** This tick's live readings, for players with no healthy reading on
     *  file - used for scoring only, never for filtering. */
    const liveDepth: Record<string, DepthSpot[]> = {};
    let depthFetched = 0;
    const changedTeams = [...new Set(changes.map((c) => c.e.team))];
    for (const team of changedTeams) {
      const last = Date.parse(depthSnapshot.teams[team] || "");
      if (Number.isFinite(last) && now.getTime() - last < DEPTH_REFETCH_MS) continue;
      try {
        const { byAthlete, slots } = await fetchTeamDepth(team);
        Object.assign(liveDepth, byAthlete);
        foldHealthyDepth(depthSnapshot, team, byAthlete, isHealthy, now, slots);
        depthFetched++;
      } catch (err) {
        // A missing depth chart costs a suggested score and a filter, not a
        // queue row. Never a reason to lose the tick.
        report.errors.push(`depth chart ${team}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    report.depthFetched = depthFetched;
    report.covered = [];
    report.autoHandled = [];

    /** Down per ESPN right now. The running order comes from the depth
     *  snapshot (up to DEPTH_REFETCH_MS old, which is fine - charts move on a
     *  practice-report cadence); who can actually play comes from this
     *  tick's feed, which is current. */
    const isDown = (athleteId: string) => {
      const rec = fresh[athleteId];
      return !!rec && rec.state !== "active";
    };

    /**
     * What injury-player-sync.mjs will do with this player unaided, mirroring
     * its status pass exactly (scripts/injury-player-sync.mjs, "DIRECTION
     * MATTERS"). If it's going to apply the change itself, the row is not a
     * decision and shouldn't be sitting in front of Dan.
     *
     * IF THAT SCRIPT'S RULES CHANGE, CHANGE THESE.
     */
    const syncWillApply = (
      ours: { status: InjuryState; statusUpdatedAt: string | null; source: string | null; pinned: boolean },
      to: InjuryState,
      reportedAt: string | null,
    ): boolean => {
      if (!reportedAt || !ours.statusUpdatedAt) return false;      // no date, no auto-apply
      if (Date.parse(reportedAt) <= Date.parse(ours.statusUpdatedAt)) return false;  // our opinion is newer
      if (ours.pinned) return false;                                // never auto-apply, permanently
      return SEVERITY[to] > SEVERITY[ours.status] || ours.source === "auto";
    };

    // ---- Review queue ----------------------------------------------------
    // Every change lands here, tracked or not. This is the half of the
    // system that's for Dan rather than for readers: the curated file isn't
    // slow because research is slow, it's slow because nothing says when to
    // look. Untracked players are filtered to premium positions and real
    // designations, or the queue becomes 800 rows of practice reports.
    for (const c of changes) {
      const isCandidate = !c.tracked
        && c.to !== "active"
        && PREMIUM_POSITIONS.has(String(c.e.position || "").toUpperCase());
      if (!c.tracked && !isCandidate) continue;

      const ours = curated.get(c.e.id);

      // ESPN CAUGHT UP TO A CALL ALREADY MADE. The diff above is ESPN
      // against ESPN, which is right for alerting - the feed genuinely
      // moved - but a queue row is a question ("should the curated file say
      // something else?"), and when ESPN's new state is what the file
      // already says, there is no question. These are the rows that render
      // as "active → active": Dan had the player active, ESPN spent a week
      // calling him questionable, and has now agreed. Nothing to apply.
      if (ours && ours.status === c.to) {
        report.skippedAgreed.push(`${c.e.name} (${c.e.team}) — already ${c.to} on file`);
        continue;
      }

      // A HEALTHY reading, never a live one, for the suggested score - see
      // the depth-chart note above.
      const healthySpot: HealthyDepth | null = depthSnapshot.players[c.e.id] || null;
      const scoringSpot = healthySpot || bestSpot(liveDepth[c.e.id], c.e.position);

      // DOES HIS ABSENCE CHANGE WHO PLAYS? For an unfamiliar name that's the
      // whole question, and for 121 of 126 of them today the answer is no:
      // somebody healthy is still ahead of him, so the snap gets taken and
      // the line doesn't move. Tracked players are exempt - being in the
      // curated file is Dan's own statement that the player matters, and it
      // outranks a depth chart.
      const standing = checkStanding(depthSnapshot.slots?.[c.e.team], c.e.id, isDown);
      if (!c.tracked && standing.covered) {
        report.covered.push(`${c.e.name} (${c.e.team}) — healthy body still ahead of him`);
        continue;
      }

      // ---- Is this a decision, or something the automation already makes? --
      // A row that injury-player-sync.mjs will apply on its own run is not a
      // question for anyone. It is still WRITTEN, pre-resolved rather than
      // skipped: if that script fails or a run is delayed, a skipped row is a
      // change nobody ever sees, whereas a pre-resolved one is out of the
      // default view and still there under ?all=1.
      let autoHandled: string | null = null;
      if (c.tracked && ours && syncWillApply(ours, c.to, c.e.date)) {
        autoHandled = "sync-applies";
      } else if (!c.tracked && standing.starter) {
        // The sync auto-adds an untracked first-stringer at a premium
        // position who's been ruled out. Questionable isn't in its remit, so
        // that stays a real row.
        if (c.to === "out") autoHandled = "sync-adds";
      }

      // The alert path above already refuses to fire twice for the same
      // `{espnId}:{to}` (the evt ledger inside deliverAlert). The queue had no
      // equivalent, and it needs one: `id` collapses to `{espnId}:{to}`
      // whenever ESPN gives no injuryId, so a player who bounces
      // questionable -> active -> questionable lands back on a key he has
      // already been on. A blind setJSON writes a fresh object with no
      // `resolved` field, which silently undoes a dismissal and puts him back
      // in the queue looking brand new. Dan ignores him again, ESPN flips him
      // again, and the row never stays gone.
      //
      // Three things have to line up before a repeat is treated as a repeat:
      //   - the row was dismissed by hand, not folded away by collapseRepeats
      //     (a superseded row's `to` is stale by definition, so a change back
      //     to it is real news and must re-open);
      //   - ESPN is asking for the same destination status as last time;
      //   - the curated file still says what it said when it was dismissed -
      //     if Dan has since changed his own call, the same ESPN report is a
      //     different question and deserves asking again.
      const key = reviewKey(`${c.e.id}:${c.e.injuryId || c.to}`);
      const existing = (await store.get(key, { type: "json" })) as
        (ReviewItem & { supersededBy?: string }) | null;
      // `autoHandled` excluded deliberately: those rows are resolved by the
      // dispatcher, not by Dan, so treating one as a dismissal would suppress
      // the genuine row that follows when the sync's own rules stop covering
      // the player.
      const dismissedByHand = !!existing && existing.resolved === true
        && !existing.supersededBy && !(existing as any).autoHandled;
      if (dismissedByHand && existing!.to === c.to && (existing!.ours ?? null) === (ours ? ours.status : null)) {
        report.skippedDismissed.push(`${c.e.name} (${c.e.team}) → ${c.to}`);
        continue;
      }

      const item: ReviewItem = {
        id: `${c.e.id}:${c.e.injuryId || c.to}`,
        espnId: c.e.id,
        name: c.e.name,
        team: c.e.team,
        position: c.e.position,
        kind: c.tracked ? "tracked-change" : "untracked-candidate",
        ours: ours ? ours.status : null,
        from: c.from,
        to: c.to,
        espnStatus: c.e.status,
        detail: detailPhrase(c.e),
        returnDate: c.e.returnDate,
        comment: c.e.comment,
        reportedAt: c.e.date,
        depth: scoringSpot
          ? { index: scoringSpot.index, size: scoringSpot.size, pos: scoringSpot.pos, label: describeSpot(scoringSpot) }
          : null,
        // A tracked player already has a number Dan chose; suggesting one
        // over the top of it would invite overwriting a real decision with a
        // guess. Suggest only where there is nothing on file.
        suggestedImpact: ours ? null : suggestImpactScore(c.e.position, scoringSpot),
        standing: standing.starter ? "starter"
          : standing.nextManUp ? "next-man-up"
          : standing.unknown ? "unknown" : "covered",
        seenAt: now.toISOString(),
      };
      if (autoHandled) {
        item.autoHandled = autoHandled;
        item.resolved = true;
        item.resolvedAt = now.toISOString();
        report.autoHandled.push(`${c.e.name} (${c.e.team}) → ${c.to} [${autoHandled}]`);
      }
      if (!dryRun) await store.setJSON(key, item);
      if (!autoHandled) report.queued++;
    }

    // ---- Alerts ----------------------------------------------------------
    // Tracked players only. An untracked name has no impact score, no
    // curated note, and no reason to believe the app's readers care - it
    // goes to the queue and starts alerting once Dan adds it.
    const alertable = changes.filter((c) => c.tracked);
    if (alertable.length) {
      const users: AlertUser[] = [];
      for await (const page of userStore.list({ prefix: "users:", paginate: true })) {
        for (const b of page.blobs) {
          const userId = b.key.slice("users:".length);
          if (onlyUser && userId !== onlyUser) continue;
          try {
            const profile: any = await userStore.get(b.key, { type: "json" });
            if (!profile?.email) continue;
            // A suspended account can't open the site, so alerting it is
            // pure nuisance: cut off and still nagged. The flag is mirrored
            // onto the profile blob by admin-user-update precisely so this
            // loop can see it without an Identity token.
            if (profile.suspended) continue;
            const favorites: string[] = Array.isArray(profile?.settings?.favorites) ? profile.settings.favorites : [];
            if (!favorites.length) continue;   // injury alerts are favourites-only
            users.push({
              userId, email: profile.email,
              leagues: Array.isArray(profile.leagues) ? profile.leagues : [],
              favorites, profile,
            });
          } catch (err) {
            report.errors.push({ userId, stage: "profile", error: err instanceof Error ? err.message : "unknown" });
          }
        }
      }

      const tally = (
        outcome: string,
        ctx?: { userId: string; type: string; event: string; week: number; label?: string }
      ) => {
        report.alerts.outcomes[outcome] = (report.alerts.outcomes[outcome] || 0) + 1;
        if (outcome === "sent") report.alerts.sent++;
        if (ctx) alertLog.add({ ...ctx, outcome });
      };

      for (const c of alertable) {
        const ours = curated.get(c.e.id)!;
        // The curated file's team, not ESPN's: a starred team follows the
        // roster the app believes in, and the two can differ after a trade.
        const team = ours.team || c.e.team;
        const worse = c.from !== null && SEVERITY[c.to] > SEVERITY[c.from];
        const detail = detailPhrase(c.e);

        const injuryLabel = `${ours.name || c.e.name} (${team}) \u2192 ${c.e.status}`;

        for (const u of users) {
          const logCtx = {
            userId: u.userId, type: "inj", event: `${c.e.id}:${c.to}`,
            week: 0, label: injuryLabel,
          };
          try {
            if (!u.favorites.includes(team)) continue;
            const prefs = await getPrefs(u.userId);
            if (prefs.push.injuries === "off") { tally("off", logCtx); continue; }
            if (prefs.push.injuries === "key" && ours.impactScore < KEY_PLAYER_IMPACT) { tally("below-key-threshold", logCtx); continue; }

            // Copy reports the DESIGNATION, not the player's availability.
            // "ESPN now lists him Questionable" stays true even when the
            // curated file says out - because ESPN does list him that way.
            // Never assert duration, never say "for Sunday".
            const outcome = await deliverAlert({
              user: u, prefs, type: "inj", event: `${c.e.id}:${c.to}`,
              season: CURRENT_SEASON, week: 0,   // injuries aren't week-scoped
              capability: "alerts.injuries", now, dryRun,
              log: alertLog, label: injuryLabel,
              payload: {
                title: `Injury update — ${ours.name || c.e.name} (${team})`,
                body: `ESPN now lists him ${c.e.status}${detail ? `. ${detail}` : ""}. Tap for the full picture.`,
                url: `/teams/${teamSlugFor(team)}/injuries`,
                collapseKey: `injury:${c.e.id}`,
                data: { kind: "injury", espnId: c.e.id, worse },
              },
            });
            tally(outcome);
          } catch (err) {
            report.errors.push({ userId: u.userId, stage: "injury-alert", error: err instanceof Error ? err.message : "unknown" });
          }
        }
      }
    }

    if (!dryRun) {
      await store.setJSON(SNAPSHOT_KEY, nextSnapshot);
      // Every tick, unconditionally: injury-review reads this to retire rows
      // whose starter has since been cleared, and a stale copy would keep
      // them sitting in the queue.
      await store.setJSON(DOWN_SET_KEY, {
        updatedAt: now.toISOString(),
        ids: Object.entries(fresh).filter(([, e]) => e.state !== "active").map(([id]) => id),
      });
      // Only when a team was actually read this tick - otherwise this is a
      // full rewrite of an unchanged document every couple of minutes.
      if (depthFetched) await store.setJSON(DEPTH_SNAPSHOT_KEY, depthSnapshot);
    }
    await alertLog.flush({ changes: report.changes?.length ?? undefined });
    return jsonResponse(200, report);
  } catch (err) {
    await alertLog.flush({ failed: true });
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error", report });
  }
};

/** Team page slug. Falls back to the abbreviation, which degrades safely -
 *  parseLocationPath matches on the slugified team NAME, so an unknown abbr
 *  lands on the week view rather than a 404. */
function teamSlugFor(abbr: string): string {
  return TEAM_SLUGS[abbr] || abbr.toLowerCase();
}

/** Slugs match slugify(team.name) in index.html, which is what
 *  parseLocationPath resolves against. */
const TEAM_SLUGS: Record<string, string> = {
  ARI: "arizona-cardinals", ATL: "atlanta-falcons", BAL: "baltimore-ravens", BUF: "buffalo-bills",
  CAR: "carolina-panthers", CHI: "chicago-bears", CIN: "cincinnati-bengals", CLE: "cleveland-browns",
  DAL: "dallas-cowboys", DEN: "denver-broncos", DET: "detroit-lions", GB: "green-bay-packers",
  HOU: "houston-texans", IND: "indianapolis-colts", JAX: "jacksonville-jaguars", KC: "kansas-city-chiefs",
  LAC: "los-angeles-chargers", LAR: "los-angeles-rams", LV: "las-vegas-raiders", MIA: "miami-dolphins",
  MIN: "minnesota-vikings", NE: "new-england-patriots", NO: "new-orleans-saints", NYG: "new-york-giants",
  NYJ: "new-york-jets", PHI: "philadelphia-eagles", PIT: "pittsburgh-steelers", SEA: "seattle-seahawks",
  SF: "san-francisco-49ers", TB: "tampa-bay-buccaneers", TEN: "tennessee-titans", WAS: "washington-commanders",
};

export const config: Config = {
  path: "/.netlify/functions/notif-injury-dispatch-background",
};

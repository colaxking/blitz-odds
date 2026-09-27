import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getPrefs, notifStore, USER_STORE } from "./lib/notif.mts";
import { deliverAlert, type AlertUser } from "./lib/alerts.mts";
import { createAlertLog } from "./lib/alertlog.mts";
import {
  fetchEspnInjuries, detailPhrase, SEVERITY,
  type EspnInjury, type InjuryState,
} from "./lib/espn-injuries.mts";

// Watches ESPN's injury feed for changes and alerts on the ones that matter.
//
// There is no review queue any more. It used to write a `review:` row per
// change for the admin Injuries tab; that tab is gone, because
// scripts/injury-player-sync.mjs now applies every ESPN move to the curated
// file on its own (escalations, recoveries, and auto-adds of ruled-out
// starters). Leftover `review:` rows are deleted once - see REVIEW_PURGED_KEY.
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

/** Set once the leftover `review:` rows from the retired admin queue have
 *  been deleted, so later ticks don't re-list an empty prefix. */
const REVIEW_PURGED_KEY = "injury-review-purged";

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
    fetched: 0, changes: [], alerts: { sent: 0, outcomes: {} }, errors: [],
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
    }>();
    for (const [team, list] of Object.entries<any>(playersDoc?.players || {})) {
      for (const p of list || []) {
        if (p.espnId) curated.set(String(p.espnId), {
          name: p.name, team, status: p.status, impactScore: p.impactScore || 0,
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
      if (!dryRun) {
        await store.setJSON(SNAPSHOT_KEY, nextSnapshot);
        await purgeReviewRows(store, report);
      }
      return jsonResponse(200, { ...report, note: "No changes this tick" });
    }

    // ---- Alerts ----------------------------------------------------------
    // Tracked players only. An untracked name has no impact score, no
    // curated note, and no reason to believe the app's readers care - it
    // starts alerting once injury-player-sync.mjs adds it to the file.
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
      await purgeReviewRows(store, report);
    }
    await alertLog.flush({ changes: report.changes?.length ?? undefined });
    return jsonResponse(200, report);
  } catch (err) {
    await alertLog.flush({ failed: true });
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error", report });
  }
};

/** One-time cleanup of the retired admin review queue. Safe to leave in:
 *  after the first successful pass it's a single marker read per tick. */
async function purgeReviewRows(store: ReturnType<typeof notifStore>, report: any) {
  try {
    if (await store.get(REVIEW_PURGED_KEY)) return;
    let deleted = 0;
    for await (const page of store.list({ prefix: "review:", paginate: true })) {
      for (const b of page.blobs) { await store.delete(b.key); deleted++; }
    }
    for (const key of ["espn-depth-healthy", "espn-down-set"]) {
      try { await store.delete(key); } catch { /* absent is fine */ }
    }
    await store.set(REVIEW_PURGED_KEY, new Date().toISOString());
    report.reviewRowsPurged = deleted;
  } catch (err) {
    // Housekeeping only - never costs the tick. Retried next run.
    report.errors.push(`review purge: ${err instanceof Error ? err.message : "failed"}`);
  }
}

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

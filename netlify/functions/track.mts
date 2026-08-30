import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(extraHeaders || {}),
    },
  });
}

const VALID_TYPES = new Set([
  "pageview",
  "team_click",
  "favorite",
  "team_tab",
  "roster_side",
  // Team page redesign. The injury report is collapsed by default on mobile
  // now and the mobile schedule's rows became links into the per-matchup
  // pages - neither the open rate nor the click-through existed as an event
  // before, and both are what decide whether those two calls were right.
  "team_injury_toggle",
  "team_schedule_game",
  "player_view",
  "news_click",
  "boxscore_click",
  // The "Alert me" bell on a game card. Per-game follows are the only alert
  // control with no server-side usage signal worth having on its own: the
  // store knows how many follows exist right now, not how many were tried
  // and undone, and it's swept a few weeks later, so it can't answer
  // "is anyone using this" after the fact.
  "game_follow",
  "view_change",
  // Which in-app link (account menu vs footer) sends people into the
  // historical archive. Added when Archive gave up its tab slot - the
  // existing history_* events only fire once you're already inside the
  // archive, so they can't tell an in-app visit from a search landing.
  "archive_entry",
  "history_nav_click",
  "history_week_select",
  "history_game_click",
  "history_team_game_click",
  // Playbook. The tab has four sub-screens and a paywall gate, none of which
  // were observable before - gate_cta in particular is the conversion event
  // for every gated surface.
  "playbook_subtab",
  "playbook_format",
  "gate_cta",
  "book_compare",
  // Push registration health. A subscription lives in two places - the
  // browser and the server's device row - and only the browser can change
  // its side unannounced. When it does, the app reports push as on and
  // nothing is ever delivered, which is invisible from both ends. These
  // three make the rate of that visible: desync is detection, the other two
  // are whether the automatic repair worked.
  "push_device_desync",
  "push_device_repaired",
  "push_device_repair_failed",
  // Account lifecycle. Self-service deletion is irreversible and the account
  // is gone by the time it completes, so there is no after-the-fact way to
  // measure it: the profile, the picks and the login have all been removed,
  // and the audit log only covers deletions an ADMIN performed. Without
  // these three the only visible trace of someone leaving is a number that
  // silently gets smaller.
  //
  // The funnel matters more than the total. "started" fires when the confirm
  // panel is opened, "completed" when the endpoint returns ok - a large gap
  // between them means people are opening it to see what it says, or trying
  // and failing, and those are opposite problems.
  "account_delete_start",
  "account_delete_complete",
  // A suspended user reaching the block screen. Counts how often the gate
  // actually fires, which is the only signal that a suspension is landing
  // on a live session rather than an account nobody was using.
  "account_suspended_block",
  // Account creation, now that signup runs through auth-signup.mts rather
  // than the Netlify widget. The three together are the funnel: submit ->
  // success tells you how many attempts get through, submit -> error with a
  // reason tells you what stops the rest, and the commonest reason by far
  // will be email_taken, which is a "they already have an account" signal
  // rather than a fault.
  "signup_submit",
  "signup_success",
  "signup_error",
  // The verification gap. verify_block fires when an unverified session hits
  // the gate, verify_resend when someone asks for the mail again, and
  // verify_complete when a link is actually followed. A large block count
  // against few completes is deliverability, not UX.
  "verify_block",
  "verify_resend",
  "verify_complete",
  // Password reset, which is ours now too (GoTrue's /recover would mail
  // Netlify's own template).
  "password_forgot_submit",
  "password_reset_submit",
  "password_reset_success",
  "password_reset_error",
  // Sign-in, now that the login form is ours rather than the widget's. The
  // ratio that matters is submits to successes: the widget gave no visibility
  // into failed sign-ins at all, so a rise in people who cannot get into an
  // account they own was previously invisible.
  "login_submit",
  "login_success",
  "login_error",
]);

// Coarse buckets sent by js/analytics.js's UA-based detectDeviceType().
// Anything else (missing, malformed, or a detection failure on the client,
// which sends "unknown") is simply omitted from the record rather than
// stored - same convention as location below.
const VALID_DEVICES = new Set(["mobile", "tablet", "desktop"]);

// Best-effort extraction of Netlify's built-in geolocation (derived from the
// edge node that served the request, via the `x-nf-geo` header). This is
// approximate (city-level at best) and never involves storing a raw IP.
function extractLocation(context: Context): Record<string, unknown> | null {
  try {
    const geo = context && (context as any).geo;
    if (!geo) return null;

    const location: Record<string, unknown> = {};
    if (geo.city) location.city = String(geo.city).slice(0, 128);
    if (geo.country && geo.country.name) location.country = String(geo.country.name).slice(0, 128);
    if (geo.country && geo.country.code) location.countryCode = String(geo.country.code).slice(0, 8);
    if (geo.subdivision && geo.subdivision.name) location.region = String(geo.subdivision.name).slice(0, 128);
    if (geo.subdivision && geo.subdivision.code) location.regionCode = String(geo.subdivision.code).slice(0, 16);
    if (geo.timezone) location.timezone = String(geo.timezone).slice(0, 64);
    if (typeof geo.latitude === "number" && Number.isFinite(geo.latitude)) location.lat = geo.latitude;
    if (typeof geo.longitude === "number" && Number.isFinite(geo.longitude)) location.lon = geo.longitude;

    return Object.keys(location).length > 0 ? location : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage model
// ---------------------------------------------------------------------------
// Every visitor gets exactly ONE blob - `session:{visitorId}` - holding their
// running event log (capped) plus a small denormalized summary. This is a
// deliberate change from the old one-blob-per-event model: blob COUNT for
// sessions stays bounded by unique visitors (not total events), so reading
// "everything this visitor did" is a single key lookup, and a full-store scan
// (analytics-summary.mts) has far fewer blobs to fetch as traffic grows.
//
// For "click a tile, see matching visitors" drill-down, we also write tiny
// secondary-index blobs shaped:
//   idx:{dimension}:{encodedValue}:{invertedTimestamp}:{visitorId}
// The inverted timestamp makes lexicographic key order == most-recent-first,
// so a drill-down list is just `store.list({ prefix })` capped at N results -
// no read-modify-write, no sorting, no race conditions on shared state. The
// tradeoff: a returning visitor writes a fresh index entry each time they
// touch the same dimension/value (e.g. every pageview from the same device),
// so historical duplicates accumulate under a given prefix over time. Reads
// dedupe by visitorId and stop once they have enough unique matches, so this
// never slows a request down - it's purely a storage-growth concern, which
// analytics-reindex-background.mts sweeps up periodically.
const MAX_EVENTS_PER_SESSION = 300;

type SessionRecord = {
  visitorId: string;
  firstSeen: number;
  lastSeen: number;
  device?: string;
  location?: Record<string, unknown>;
  pageviews: number;
  favoriteTeams: Record<string, true>;
  theme?: string;
  sportsbookPref?: string;
  tzPref?: string;
  displayMode?: string;
  host?: string;
  events: Record<string, unknown>[];
};

function invertedTimestamp(ts: number): string {
  // 13 digits covers ms-epoch through the year 2286, zero-padded so string
  // comparison sorts numerically. Inverting means "most recent" sorts first.
  return String(9999999999999 - Math.floor(ts)).padStart(13, "0");
}

function indexKey(dimension: string, value: string, ts: number, visitorId: string): string {
  // No percent-encoding here: Netlify Blobs persists keys in their literal
  // (decoded) form regardless of what you pass in, so encoding a value like
  // "Ashburn, Virginia" before writing just gets silently undone on write -
  // the stored key ends up with real commas/spaces either way. What matters
  // is that this stays byte-for-byte identical to the prefix analytics-
  // sessions.mts builds for the same dimension/value on read.
  return `idx:${dimension}:${value}:${invertedTimestamp(ts)}:${visitorId}`;
}

// Mirrors hourBucketLabel/dayBucketLabel/monthBucketLabel in
// analytics-summary.mts exactly, so a bucket string produced here for
// indexing matches the bucket string the chart hands back on click.
function hourBucketLabel(ts: number): string {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
function dayBucketLabel(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
function monthBucketLabel(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const raw = await req.text();
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
    }

    const { type, visitorId, ts, team, teamName, adding, week, tab, side, player, source, device, theme, sportsbook, timezone, displayMode, headline, origin, placement, away, home, page, pathname, host, referrerHost, nav, filter, value, subtab, format, action, surface, open, stage, outcome, state, reason, emailSent } = body || {};

    if (!VALID_TYPES.has(type)) {
      return jsonResponse(400, { ok: false, error: "Invalid or missing type" });
    }

    if (!visitorId || typeof visitorId !== "string") {
      return jsonResponse(400, { ok: false, error: "Missing visitorId" });
    }

    const cleanVisitorId = String(visitorId).slice(0, 128);
    const timestamp = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();

    const record: Record<string, unknown> = {
      type,
      ts: timestamp,
    };

    if (
      type === "team_click" ||
      type === "favorite" ||
      type === "team_tab" ||
      type === "roster_side" ||
      type === "player_view" ||
      type === "team_injury_toggle" ||
      type === "team_schedule_game"
    ) {
      record.team = team ? String(team).slice(0, 64) : "unknown";
      if (teamName) record.teamName = String(teamName).slice(0, 128);
    }

    // Whether the reader was opening the collapsed injury panel or closing
    // it. Only "open" is interesting as a rate, but storing both means the
    // denominator is the toggle count rather than an assumption.
    if (type === "team_injury_toggle") {
      record.open = open === true;
    }

    // Which week's row was tapped. Kept as a number so the summary can tell
    // preseason (negative) from regular-season rows without re-parsing.
    if (type === "team_schedule_game") {
      const weekNum = Number(week);
      if (Number.isFinite(weekNum)) record.week = weekNum;
    }

    if (type === "team_click" && (origin === "game_card" || origin === "favorites_bar")) {
      record.origin = origin;
    }

    if (type === "favorite") {
      record.adding = adding === true;
    }

    if (type === "team_tab" && tab) {
      record.tab = String(tab).slice(0, 64);
    }

    if (type === "roster_side" && side) {
      record.side = String(side).slice(0, 64);
    }

    if (type === "player_view") {
      if (player) record.player = String(player).slice(0, 128);
      if (source) record.source = String(source).slice(0, 32);
    }

    if (type === "news_click") {
      record.newsSource = source ? String(source).slice(0, 128) : "unknown";
      if (headline) record.headline = String(headline).slice(0, 200);
      if (placement === "ticker" || placement === "team_news") record.placement = placement;
    }

    if (type === "boxscore_click") {
      if (away) record.away = String(away).slice(0, 64);
      if (home) record.home = String(home).slice(0, 64);
      // js/analytics.js has always sent `source` for this event and
      // analytics-summary.mts has always grouped by it, but it was never
      // stored here - so boxscoreClicksBySource counted nothing and the
      // dashboard's panel sat empty. Values today: "full_details" (the
      // "View Full Box Score" button inside a game card's Full Details
      // panel) and "score_tap" (the tappable score still on the
      // picks/results and team schedule views).
      if (source) record.source = String(source).slice(0, 32);
    }

    if (type === "game_follow") {
      if (away) record.away = String(away).slice(0, 64);
      if (home) record.home = String(home).slice(0, 64);
      // `adding` matches the `favorite` event's field rather than inventing
      // a second name for the same idea - the dashboard already knows how
      // to read a boolean called that.
      record.adding = adding === true;
      // Whether the game had started when the bell was tapped. The bell
      // used to vanish at kickoff; it now stays up until the final
      // whistle, and this field is the only thing that can say whether
      // anyone actually uses the window that opened up. Restricted to the
      // three values the card emits so a malformed body can't seed the
      // dashboard with junk categories.
      if (state === "scheduled" || state === "started" || state === "live") {
        record.gameState = state;
      }
    }

    if (type === "playbook_subtab" && subtab) {
      record.subtab = String(subtab).slice(0, 64);
    }

    if (type === "playbook_format" && format) {
      record.format = String(format).slice(0, 64);
    }

    if (type === "gate_cta") {
      if (action) record.action = String(action).slice(0, 64);
      // "signin" is the preview's sign-in wall, "pro" the subscription gate.
      // Kept apart because they convert on different things.
      if (surface === "signin" || surface === "pro") record.surface = surface;
    }

    // Historical archive events (see js/analytics.js header comment for
    // exactly what fires each one). `away`/`home`/`page` are shared with
    // boxscore_click's shape above rather than reinvented, since a game
    // link click and a box-score-modal click are structurally the same
    // "which matchup" fact.
    if (type === "history_game_click" || type === "history_team_game_click") {
      if (away) record.away = String(away).slice(0, 64);
      if (home) record.home = String(home).slice(0, 64);
      if (team) record.team = String(team).slice(0, 64);
    }
    if (type === "archive_entry") {
      // Constrained to the two known link sites rather than passed through,
      // so a stray or spoofed value can't open a new dimension in the
      // dashboard's bar list.
      if (source === "menu" || source === "footer") record.source = source;
    }
    if (type === "history_nav_click" && (nav === "season" || nav === "team")) {
      record.nav = nav;
    }
    if (type === "history_week_select") {
      if (filter === "week" || filter === "team") record.filter = filter;
      if (value) record.value = String(value).slice(0, 64);
    }
    if (
      (type === "history_game_click" ||
        type === "history_team_game_click" ||
        type === "history_nav_click" ||
        type === "history_week_select") &&
      typeof page === "string" &&
      page
    ) {
      record.page = page.slice(0, 160);
    }

    // Where the desync was caught and repaired from. "load" and "rotated"
    // are the silent path (app start), "auto" the Settings reconcile,
    // "manual" the reader pressing the repair button - a rising share of
    // "manual" would mean the automatic paths are failing.
    if (
      type === "push_device_desync" ||
      type === "push_device_repaired" ||
      type === "push_device_repair_failed"
    ) {
      if (typeof stage === "string" && stage) record.stage = stage.slice(0, 32);
    }

    // Account lifecycle. `surface` says where the delete was started from
    // (today only "settings", but an admin-side or email-link route would
    // need to be told apart from it), and on completion `outcome` separates
    // a success from the two failures worth knowing about - a mistyped
    // confirmation, and the endpoint itself erroring after the data sweep.
    if (type === "account_delete_start" || type === "account_delete_complete") {
      if (typeof surface === "string" && surface) record.surface = surface.slice(0, 32);
    }
    if (type === "account_delete_complete") {
      if (typeof outcome === "string" && outcome) record.outcome = outcome.slice(0, 32);
    }

    // Signup and reset failures. `reason` is the endpoint's own stable code
    // (email_taken, weak_password, token_expired, network...) - never a
    // message and never anything the user typed, so nothing here can carry
    // an address or a password into the analytics store.
    if (type === "signup_error" || type === "password_reset_error" || type === "login_error") {
      if (typeof reason === "string" && reason) record.reason = reason.slice(0, 32);
    }
    // Whether the confirmation mail actually went out. A signup that
    // succeeded with emailSent="no" is an account nobody can use, and it is
    // invisible without this.
    if (type === "signup_success") {
      if (typeof emailSent === "string" && emailSent) record.emailSent = emailSent.slice(0, 8);
    }
    if (type === "verify_complete") {
      if (typeof outcome === "string" && outcome) record.outcome = outcome.slice(0, 32);
    }

    if (week !== undefined && week !== null && week !== "") {
      record.week = String(week).slice(0, 32);
    }

    if (typeof device === "string" && VALID_DEVICES.has(device)) {
      record.device = device;
    }

    // Local-only display preferences (theme / sportsbook / time zone), sent
    // as a snapshot on every pageview - see readPreference() in
    // js/analytics.js. Capped to a small allowlist-shaped length rather than
    // a fixed enum since SPORTSBOOKS/TIMEZONES are data-driven lists in
    // index.html that can grow without a matching deploy of this function.
    if (type === "pageview") {
      if (typeof theme === "string" && theme) record.theme = theme.slice(0, 32);
      if (typeof sportsbook === "string" && sportsbook) record.sportsbook = sportsbook.slice(0, 64);
      if (typeof timezone === "string" && timezone) record.tzPref = timezone.slice(0, 64);
      // Unlike the three above, this is a closed set the client fully
      // controls (see getDisplayMode in js/analytics.js), so it's checked
      // against an enum rather than length-capped - an unrecognised value
      // means the client and this function have drifted, and silently
      // storing it would put junk in the dashboard's breakdown.
      if (displayMode === "standalone" || displayMode === "browser") {
        record.displayMode = displayMode;
      }
    }

    // `page` applies to both a hard pageview and a soft view_change (SPA
    // navigation with no URL change - see js/analytics.js) - same free-form
    // display label either way, just no preference snapshot on the latter.
    if ((type === "pageview" || type === "view_change") && typeof page === "string" && page) {
      record.page = page.slice(0, 160);
    }

    // `pathname`/`referrerHost` only apply to a hard pageview - a
    // view_change never touches the URL (that's what makes it "soft"), so
    // both would just repeat whatever the last real pageview already
    // recorded. See js/analytics.js's getReferrerHost() for how the latter
    // is derived (hostname only, never a raw referrer URL/query string).
    if (type === "pageview") {
      if (typeof pathname === "string" && pathname) record.pathname = pathname.slice(0, 200);
      if (typeof referrerHost === "string" && referrerHost) record.referrerHost = referrerHost.slice(0, 128);
      // Which host served this pageview - see js/analytics.js. Lets the
      // dashboard scope itself to blitz-odds.com and leave deploy-preview
      // and localhost traffic out. Events written before this shipped have
      // no host at all; readers treat that as production rather than
      // discarding all history (see PRODUCTION_HOSTS in analytics-summary).
      if (typeof host === "string" && host) record.host = host.slice(0, 128);
    }

    const location = extractLocation(context);
    if (location) {
      record.location = location;
    }

    const store = getStore("blitz-analytics");
    const sessionKey = `session:${cleanVisitorId}`;

    let session: SessionRecord | null = null;
    try {
      session = (await store.get(sessionKey, { type: "json" })) as SessionRecord | null;
    } catch {
      session = null;
    }
    if (!session || typeof session !== "object") {
      session = {
        visitorId: cleanVisitorId,
        firstSeen: timestamp,
        lastSeen: timestamp,
        pageviews: 0,
        favoriteTeams: {},
        events: [],
      };
    }

    session.lastSeen = Math.max(session.lastSeen || 0, timestamp);
    session.firstSeen = session.firstSeen ? Math.min(session.firstSeen, timestamp) : timestamp;
    if (record.device) session.device = record.device as string;
    if (record.location) session.location = record.location as Record<string, unknown>;
    if (record.theme) session.theme = record.theme as string;
    if (record.sportsbook) session.sportsbookPref = record.sportsbook as string;
    if (record.tzPref) session.tzPref = record.tzPref as string;
    if (record.displayMode) session.displayMode = record.displayMode as string;
    if (record.host) session.host = record.host as string;
    if (type === "pageview") session.pageviews = (session.pageviews || 0) + 1;
    if (!session.favoriteTeams) session.favoriteTeams = {};
    if (type === "favorite") {
      const favTeam = record.team as string;
      if (favTeam && favTeam !== "unknown") {
        if (record.adding) session.favoriteTeams[favTeam] = true;
        else delete session.favoriteTeams[favTeam];
      }
    }
    if (!Array.isArray(session.events)) session.events = [];
    session.events.push(record);
    if (session.events.length > MAX_EVENTS_PER_SESSION) {
      session.events = session.events.slice(session.events.length - MAX_EVENTS_PER_SESSION);
    }

    const writes: Promise<unknown>[] = [store.setJSON(sessionKey, session)];

    // Secondary indexes - one tiny blob write per dimension this event is
    // relevant to. Skipped for "unknown" values since drilling into "unknown"
    // isn't a useful filter. See storage-model comment above for the key shape.
    function addIndex(dimension: string, value: string | undefined) {
      if (!value || value === "unknown") return;
      writes.push(store.set(indexKey(dimension, value, timestamp, cleanVisitorId), "1"));
    }

    if (type === "pageview") {
      addIndex("device", record.device as string | undefined);
      const loc = record.location as Record<string, unknown> | undefined;
      if (loc && loc.city) {
        const cityLabel = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
        addIndex("city", cityLabel);
      }
      if (loc && loc.country) addIndex("country", loc.country as string);
      // One entry per granularity - the chart can be showing hour/day/month
      // buckets depending on the selected range, and each is its own cheap
      // O(1) write, so there's no need to guess which one will get clicked.
      addIndex("pvHour", hourBucketLabel(timestamp));
      addIndex("pvDay", dayBucketLabel(timestamp));
      addIndex("pvMonth", monthBucketLabel(timestamp));
      addIndex("theme", record.theme as string | undefined);
      addIndex("sportsbook", record.sportsbook as string | undefined);
      addIndex("tzPref", record.tzPref as string | undefined);
      addIndex("displayMode", record.displayMode as string | undefined);
      addIndex("pathname", record.pathname as string | undefined);
      addIndex("referrer", record.referrerHost as string | undefined);
      addIndex("host", record.host as string | undefined);
    }
    if (type === "team_click") {
      addIndex("teamClick", record.team as string | undefined);
      addIndex("teamClickOrigin", record.origin as string | undefined);
    }
    if (type === "favorite" && record.adding) addIndex("favTeam", record.team as string | undefined);
    if (type === "team_tab" && record.tab === "Roster & Depth Chart") {
      addIndex("rosterTeam", record.team as string | undefined);
    }
    if (type === "roster_side") addIndex("rosterSide", record.side as string | undefined);
    // Only opens get indexed. Clicking the tile should list the people who
    // went looking for the injury report, not everyone who touched the
    // toggle - a close is the tail end of an open, not its own intent.
    if (type === "team_injury_toggle" && record.open) {
      addIndex("injuryOpenTeam", record.team as string | undefined);
    }
    if (type === "team_schedule_game") addIndex("schedGameTeam", record.team as string | undefined);
    if (type === "player_view") addIndex("player", record.player as string | undefined);
    if (type === "news_click") {
      addIndex("newsSource", record.newsSource as string | undefined);
      addIndex("newsPlacement", record.placement as string | undefined);
    }
    if (type === "boxscore_click") {
      // Indexed under both teams in the matchup, so "who's clicking into
      // DEN box scores" works regardless of whether DEN was home or away.
      addIndex("boxscoreTeam", record.away as string | undefined);
      addIndex("boxscoreTeam", record.home as string | undefined);
    }
    if (type === "history_game_click" || type === "history_team_game_click") {
      addIndex("historyGameTeam", record.away as string | undefined);
      addIndex("historyGameTeam", record.home as string | undefined);
    }
    if (type === "archive_entry") addIndex("archiveEntrySource", record.source as string | undefined);
    if (type === "history_nav_click") addIndex("historyNav", record.nav as string | undefined);
    if (type === "history_week_select") addIndex("historyFilter", record.filter as string | undefined);

    await Promise.all(writes);

    return jsonResponse(200, { ok: true });
  } catch (err) {
    // Never let a malformed/unexpected request take the endpoint down hard;
    // respond with a soft failure the client already treats as fire-and-forget.
    return jsonResponse(200, { ok: false });
  }
};

export const config: Config = {
  path: "/.netlify/functions/track",
};

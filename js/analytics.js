/**
 * Blitz Odds - lightweight first-party analytics.
 *
 * This file is intentionally standalone vanilla JS with zero dependencies on
 * the React app above it. It never touches app state, never mutates the DOM
 * (other than reading it), and every entry point is wrapped in try/catch so
 * a failure here can never break the page.
 *
 * Tracks:
 *  - "pageview" once per page load, including `pathname` (the real URL
 *    path - meaningful since Phase 3 added routing) and `referrerHost`
 *    (document.referrer's hostname, or "(direct)"/"(internal)")
 *  - "team_click" whenever a `.team-click` element (logo/name, opens a team's
 *    schedule) or a descendant of one is clicked
 *  - "favorite" whenever a `.star-btn` (the favorite-star toggle) is clicked,
 *    with `adding: true/false` depending on whether the star was being turned
 *    on or off at the moment of the click
 *  - "team_tab" whenever a tab inside a team page (Schedule / Roster & Depth
 *    Chart / News) is opened, via `.team-tab-btn`
 *  - "roster_side" whenever the Offense/Defense/Special Teams side toggle
 *    inside the depth chart is clicked, via `.roster-side-tab-btn`
 *  - "boxscore_click" whenever box score content is opened, from the "View
 *    Full Box Score" button inside a card's Full Details panel
 *    (`.view-boxscore-link`), a tappable score (`.score-link-btn`, still
 *    used on the picks/results and team schedule views), or a Past Matchups
 *    row expanding its inline archive box score (`.h2h-row-header`), with
 *    `source` distinguishing the three
 *  - "player_view" whenever a player's name is clicked to open their detail
 *    modal, from either the depth chart (`.depth-player-name-btn`) or the
 *    full roster table (`.roster-player-name-btn`)
 *  - "game_follow" whenever the "Alert me" bell on a game card is tapped
 *    (`.gc-follow`), with `adding: true/false` for whether the tap was
 *    turning the follow on or off, plus the two teams and the week. This is
 *    the only signal for whether per-game alerts are used at all - the
 *    server knows how many follows exist, but not how many people tried and
 *    changed their mind, and not which games attract them
 *  - "archive_entry" whenever an in-app link into the historical archive is
 *    clicked (`.archive-entry-link`), with `source` naming which one -
 *    "menu" (the account dropdown) or "footer". These are the only two
 *    in-app paths to /historical/ since the Archive tab was removed
 *  - "history_game_click" / "history_team_game_click" whenever a game link
 *    (`.season-index-game`) is clicked on a historical archive page - the
 *    "_team_" variant fires when that link lives on a team archive page
 *    (`/historical/teams/{team}/`) rather than a season/week listing, per
 *    its `data-origin` attribute (see backfill-historical-season.mjs)
 *  - "history_nav_click" whenever the root archive index's "Browse by
 *    season" / "Browse by team" select navigates (`#year-nav`/`#team-nav`)
 *  - "history_week_select" whenever a season/year index page's "Jump to:"
 *    week/round or team filter select changes (`#week-select`/`#team-select`)
 *
 * The click listener is registered in the CAPTURE phase, not bubble. The
 * favorite star's own onClick calls `event.stopPropagation()` (to keep the
 * click from also triggering the team-click "view schedule" action next to
 * it), which would silently swallow a bubble-phase document listener. Using
 * capture means this listener always runs before that stopPropagation() can
 * take effect, and before React re-renders, so the DOM still reflects the
 * pre-click state (used to tell "adding" a favorite from "removing" one).
 *
 * Events are POSTed to a Netlify Function at /.netlify/functions/track.
 */
(function () {
  "use strict";

  try {
    // Bail out entirely for bots/crawlers before any listener is wired up
    // or any event is sent, so they never appear in pageviews, unique
    // visitors, or any other analytics KPI. Two signals are used:
    //  1. `navigator.webdriver` - set to true by essentially every headless
    //     automation stack (Puppeteer, Playwright, Selenium, etc.) even
    //     when the UA string itself is spoofed to look like a real browser.
    //  2. A UA substring match against known crawlers/bots: traditional
    //     search engine crawlers (Googlebot, Bingbot, ...), social/link-
    //     preview fetchers (Facebook, Twitter/X, Slack, Discord, ...), SEO
    //     tools (Ahrefs, SEMrush, ...), AI/LLM crawlers (GPTBot, ClaudeBot,
    //     PerplexityBot, ...), and generic HTTP clients/headless browsers
    //     (curl, wget, python-requests, HeadlessChrome, PhantomJS, ...).
    // This is best-effort (a bot can always spoof both signals away), but
    // it filters out the overwhelming majority of non-human traffic that
    // executes this script.
    function isLikelyBot() {
      try {
        if (navigator && navigator.webdriver) return true;
        var ua = ((navigator && navigator.userAgent) || "").toLowerCase();
        if (!ua) return false;
        var BOT_UA_PATTERN = new RegExp(
          [
            "bot", "crawler", "spider", "slurp", "archiver", "headless",
            "phantomjs", "puppeteer", "playwright", "selenium",
            "curl", "wget", "python-requests", "python-urllib", "go-http-client",
            "okhttp", "java/", "node-fetch", "axios", "scrapy", "libwww-perl",
            "facebookexternalhit", "whatsapp", "telegrambot", "discordbot",
            "slackbot", "linkedinbot", "pinterest", "twitterbot",
            "gptbot", "chatgpt-user", "oai-searchbot", "claudebot",
            "anthropic-ai", "perplexitybot", "ccbot", "bytespider",
            "petalbot", "applebot", "screaming frog"
          ].join("|"),
          "i"
        );
        return BOT_UA_PATTERN.test(ua);
      } catch (e) {
        return false;
      }
    }

    if (isLikelyBot()) return;

    var ENDPOINT = "/.netlify/functions/track";
    var VISITOR_ID_KEY = "blitz-odds-vid";

    function uuidv4() {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
      // Fallback UUID v4 generator for older browsers.
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        var v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }

    function getVisitorId() {
      try {
        var existing = window.localStorage.getItem(VISITOR_ID_KEY);
        if (existing) return existing;
        var fresh = uuidv4();
        window.localStorage.setItem(VISITOR_ID_KEY, fresh);
        return fresh;
      } catch (storageErr) {
        // localStorage unavailable (private mode, disabled, etc.) - use an
        // in-memory id for the lifetime of this page load only.
        return uuidv4();
      }
    }

    var visitorId = getVisitorId();

    // Coarse device bucketing from the UA string - "mobile" / "tablet" /
    // "desktop". Order matters: iPad's UA doesn't contain "Mobile", and
    // Android tablets omit "Mobile" too, so both are checked before the
    // general mobile check below. Best-effort only; never blocks tracking.
    function detectDeviceType() {
      try {
        var ua = (navigator && navigator.userAgent) || "";
        var isIpadOS13Plus =
          /Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document;
        if (/iPad/.test(ua) || isIpadOS13Plus) return "tablet";
        if (/Android/.test(ua) && !/Mobile/.test(ua)) return "tablet";
        if (/Tablet|Kindle|Silk|PlayBook/.test(ua)) return "tablet";
        if (/Mobi|iPhone|iPod|Android/.test(ua)) return "mobile";
        return "desktop";
      } catch (e) {
        return "unknown";
      }
    }

    var deviceType = detectDeviceType();

    // Same storage keys and fallback defaults the app itself uses (see
    // useThemeManager / useSportsbookManager / useTimezoneManager in
    // index.html) - read directly rather than hooking React state, so a
    // visitor who never opens Settings still reports their effective
    // (default) preference instead of being silently absent from the data.
    var THEME_KEY = "blitz-odds-theme";
    var SPORTSBOOK_KEY = "blitz-odds-sportsbook";
    var TIMEZONE_KEY = "blitz-odds-timezone";
    var THEME_DEFAULT = "system";
    var SPORTSBOOK_DEFAULT = "draftkings";
    var TIMEZONE_DEFAULT = "auto";

    function readPreference(key, fallback) {
      try {
        var v = window.localStorage.getItem(key);
        return v || fallback;
      } catch (e) {
        return fallback;
      }
    }

    function getCurrentWeekLabel() {
      try {
        // The custom week dropdown ("WeekNav") renders its current selection
        // as text inside .week-nav-trigger, e.g. "Week 5". This is read-only
        // DOM inspection - no interaction with the underlying React state.
        var trigger = document.querySelector(".week-nav-trigger");
        if (trigger && trigger.textContent) {
          var text = trigger.textContent.trim();
          if (text) return text;
        }
      } catch (e) {
        /* ignore */
      }
      return null;
    }

    // A human-readable label for whatever's currently on screen. Phase 3
    // added real pushState routing for team/game views (see index.html's
    // buildTeamPath/buildGamePath), so `pathname` on the pageview event
    // (added alongside this) is now the authoritative machine-readable
    // signal for which page this is - this label stays purely for
    // display/legacy grouping (matches pre-Phase-3 events that predate
    // pathname tracking) rather than being the primary way to tell pages
    // apart. Presence of ".team-view-header" means a team page is open (and
    // which tab - Schedule/Roster & Depth Chart/News - is read from the
    // active ".team-tab-btn"); ".game-page" means a per-matchup page is
    // open; otherwise it's the week view, labeled by the selected week.
    //
    // Static historical archive pages (historical/**/*.html, generated by
    // scripts/backfill-historical-preseason.mjs) also load this same file -
    // they're plain HTML with no React/WeekNav at all, so they're detected
    // via the ".archive-badge" marker those pages render instead. Using
    // document.title's own "Team A vs. Team B ... | Blitz Odds" /
    // "20XX NFL Preseason Results ..." wording rather than duplicating page
    // structure knowledge here - one less place to keep in sync if the
    // generator's copy changes.
    function getCurrentPageLabel() {
      try {
        // Standalone static documents that aren't part of the SPA shell and
        // have none of the structural markers the branches below look for.
        // Without this they fall all the way through to a null label and get
        // bucketed as "unknown" in the dashboard.
        var path = (window.location.pathname || "").replace(/\/$/, "");
        if (path === "/privacy" || path === "/privacy/index.html") return "Privacy Policy";

        var archiveBadge = document.querySelector(".archive-badge");
        if (archiveBadge) {
          var titleText = document.title || "";
          var label = titleText.split(" | ")[0].trim();
          return "Historical archive: " + (label || archiveBadge.textContent.trim());
        }

        var gamePage = document.querySelector(".game-page");
        if (gamePage) {
          var gameTitleText = document.title || "";
          var gameLabel = gameTitleText.split(" | ")[0].trim();
          return gameLabel ? "Game: " + gameLabel : "Game page";
        }

        var header = document.querySelector(".team-view-header");
        if (header) {
          var img = header.querySelector("img.badge-img");
          var team = img && img.getAttribute("alt") ? img.getAttribute("alt") : null;
          if (!team) {
            var fallback = header.querySelector(".badge-fallback");
            if (fallback && fallback.textContent) team = fallback.textContent.trim();
          }
          var nameEl = header.querySelector("h2");
          var teamName = nameEl && nameEl.textContent ? nameEl.textContent.trim() : null;
          var teamLabel = teamName || team || "a team";

          var tabEl = document.querySelector(".team-tab-btn.active");
          var tab = tabEl && tabEl.textContent ? tabEl.textContent.trim() : null;
          return tab ? teamLabel + " \u2014 " + tab : teamLabel + " team page";
        }
        // Everything below is a tab in the SPA shell rather than its own
        // document. Without this branch every one of them - Home, Games,
        // Playbook, News - fell through to the week label, so the dashboard
        // could not tell them apart: opening the Playbook looked identical to
        // sitting on the week view.
        var activeTab = document.querySelector(".tab-btn.active");
        var tabLabelEl = activeTab && activeTab.querySelector(".tab-label");
        var tabLabel = tabLabelEl && tabLabelEl.textContent ? tabLabelEl.textContent.trim() : null;

        if (tabLabel) {
          // The Playbook's sub-tabs are four genuinely different screens, and
          // which one people open is the whole question about the redesign,
          // so the label carries it.
          var subEl = document.querySelector(".hot-picks-subtab-btn.active");
          var sub = subEl && subEl.textContent ? subEl.textContent.trim() : null;
          if (sub) return tabLabel + " \u2014 " + sub;

          var weekForTab = getCurrentWeekLabel();
          return weekForTab ? tabLabel + " \u2014 " + weekForTab : tabLabel;
        }

        var week = getCurrentWeekLabel();
        return week || null;
      } catch (e) {
        return null;
      }
    }

    function sendEvent(payload) {
      try {
        payload.device = deviceType;
        var body = JSON.stringify(payload);
        if (window.fetch) {
          fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: body,
            keepalive: true,
          }).catch(function () {
            /* network errors are non-fatal, swallow silently */
          });
        }
      } catch (e) {
        /* never let a tracking failure surface to the user */
      }
    }

    function getReferrerHost() {
      try {
        if (!document.referrer) return "(direct)";
        var url = new URL(document.referrer);
        if (url.hostname === window.location.hostname) return "(internal)";
        return url.hostname.replace(/^www\./, "");
      } catch (e) {
        return null;
      }
    }

    function trackPageview() {
      try {
        sendEvent({
          type: "pageview",
          visitorId: visitorId,
          ts: Date.now(),
          week: getCurrentWeekLabel(),
          page: getCurrentPageLabel(),
          pathname: window.location.pathname,
          // Which host this pageview actually happened on. Without it a view
          // on a Netlify deploy preview or localhost is indistinguishable
          // from one on blitz-odds.com, so the dashboard can't scope itself
          // to real traffic. Hostname only - never the full URL.
          host: (window.location.hostname || "").replace(/^www\./, ""),
          referrerHost: getReferrerHost(),
          theme: readPreference(THEME_KEY, THEME_DEFAULT),
          sportsbook: readPreference(SPORTSBOOK_KEY, SPORTSBOOK_DEFAULT),
          timezone: readPreference(TIMEZONE_KEY, TIMEZONE_DEFAULT),
        });
      } catch (e) {
        /* ignore */
      }
    }

    // Both TeamBadge (view-schedule) and FavoriteStar (favorite toggle) live
    // inside the same ".team-block", alongside a ".team-name" div. This reads
    // the team abbreviation from the logo/fallback badge and the human name
    // from the sibling ".team-name" - all read-only DOM inspection.
    function findTeamInfo(withinTeamBlockEl) {
      var team = null;
      var teamName = null;
      try {
        var img = withinTeamBlockEl.querySelector("img.badge-img");
        if (img && img.getAttribute("alt")) {
          team = img.getAttribute("alt");
        }
        if (!team) {
          var fallback = withinTeamBlockEl.querySelector(".badge-fallback");
          if (fallback && fallback.textContent) {
            team = fallback.textContent.trim();
          }
        }
        var nameEl = withinTeamBlockEl.querySelector(".team-name");
        if (nameEl && nameEl.textContent) {
          teamName = nameEl.textContent.trim();
        }
      } catch (e) {
        /* ignore, return whatever was found so far */
      }
      return { team: team, teamName: teamName };
    }

    // Team-page-only controls (team tabs, roster side toggle, player names)
    // don't live inside a ".team-block" the way logo/star clicks do - the
    // page they're on only ever shows one team at a time, in
    // ".team-view-header", so that's read instead. Same read-only
    // logo-alt / fallback-text / heading-text pattern as findTeamInfo.
    function findActiveTeamContext() {
      var team = null;
      var teamName = null;
      try {
        var header = document.querySelector(".team-view-header");
        if (!header) return { team: null, teamName: null };
        var img = header.querySelector("img.badge-img");
        if (img && img.getAttribute("alt")) {
          team = img.getAttribute("alt");
        }
        if (!team) {
          var fallback = header.querySelector(".badge-fallback");
          if (fallback && fallback.textContent) {
            team = fallback.textContent.trim();
          }
        }
        var nameEl = header.querySelector("h2");
        if (nameEl && nameEl.textContent) {
          teamName = nameEl.textContent.trim();
        }
      } catch (e) {
        /* ignore, return whatever was found so far */
      }
      return { team: team, teamName: teamName };
    }

    function handleDocumentClick(event) {
      try {
        var target = event && event.target;
        if (!target || typeof target.closest !== "function") return;

        var starEl = target.closest(".star-btn");
        if (starEl) {
          // Captured before React processes the click, so this class list
          // still reflects the state BEFORE this toggle takes effect.
          var wasActive = starEl.classList.contains("active");
          var block = typeof starEl.closest === "function" ? starEl.closest(".team-block") : null;
          var info = block ? findTeamInfo(block) : { team: null, teamName: null };
          var teamValue = info.team || info.teamName || "unknown";

          sendEvent({
            type: "favorite",
            visitorId: visitorId,
            ts: Date.now(),
            team: teamValue,
            teamName: info.teamName || undefined,
            adding: !wasActive,
            week: getCurrentWeekLabel(),
          });
          return;
        }

        var teamClickEl = target.closest(".team-click");
        if (teamClickEl) {
          var ci = findTeamInfo(teamClickEl.closest(".team-block") || teamClickEl);
          var teamVal = ci.team || ci.teamName || "unknown";

          sendEvent({
            type: "team_click",
            visitorId: visitorId,
            ts: Date.now(),
            team: teamVal,
            teamName: ci.teamName || undefined,
            week: getCurrentWeekLabel(),
            origin: "game_card",
          });
          return;
        }

        var favChipEl = target.closest(".fav-chip");
        if (favChipEl) {
          sendEvent({
            type: "team_click",
            visitorId: visitorId,
            ts: Date.now(),
            team: favChipEl.getAttribute("data-team") || "unknown",
            teamName: favChipEl.getAttribute("data-team-name") || undefined,
            week: getCurrentWeekLabel(),
            origin: "favorites_bar",
          });
          return;
        }

        // Two entry points open the same BoxScoreModal, so both fire the same
        // event type and are told apart by `source`:
        //  - ".score-link-btn" (GameScoreLink) - tapping the score itself.
        //    The GameCard redesign REMOVED this from the game card; it now
        //    only survives on the picks/results view and the team schedule.
        //  - ".view-boxscore-link" (ShortBoxScore) - the "View Full Box
        //    Score" button inside a card's Full Details panel, which is the
        //    only path to a box score from a game card since the redesign.
        // Missing the second selector is why game-card box score opens
        // stopped being counted at all after that change shipped.
        // The archive's in-app entry points. Archive used to be a tab in the
        // primary bar and nothing counted taps on it, so "does anyone go
        // there from inside the app" was never answerable - only that
        // /historical/ got pageviews, which is dominated by search traffic
        // landing directly. Now that the tab is gone and the archive lives
        // one level down in the account menu, that question is the whole
        // basis for deciding whether it earns a slot back, so both surviving
        // links carry `data-archive-source` and fire here.
        // Capture phase, so aria-pressed still holds the PRE-click state -
        // "true" means this tap is about to unfollow. Same trick the
        // favorite star uses above, and for the same reason: React hasn't
        // re-rendered yet.
        var followEl = target.closest(".gc-follow");
        if (followEl) {
          if (!followEl.disabled) {
            sendEvent({
              type: "game_follow",
              visitorId: visitorId,
              ts: Date.now(),
              away: followEl.getAttribute("data-away") || undefined,
              home: followEl.getAttribute("data-home") || undefined,
              week: followEl.getAttribute("data-week") || getCurrentWeekLabel(),
              adding: followEl.getAttribute("aria-pressed") !== "true",
            });
          }
          return;
        }

        var archiveEl = target.closest(".archive-entry-link");
        if (archiveEl) {
          sendEvent({
            type: "archive_entry",
            visitorId: visitorId,
            ts: Date.now(),
            source: archiveEl.getAttribute("data-archive-source") || "unknown",
          });
          return;
        }

        var boxScoreEl = target.closest(".score-link-btn, .view-boxscore-link");
        if (boxScoreEl) {
          sendEvent({
            type: "boxscore_click",
            visitorId: visitorId,
            ts: Date.now(),
            away: boxScoreEl.getAttribute("data-away") || undefined,
            home: boxScoreEl.getAttribute("data-home") || undefined,
            week: boxScoreEl.getAttribute("data-week") || getCurrentWeekLabel(),
            source: boxScoreEl.getAttribute("data-boxscore-source") || "unknown",
          });
          return;
        }

        // Past Matchups rows in Full Details expand an inline box score
        // lifted from that game's archive page - a third way into box score
        // content, and previously untracked, so whether anyone opens a past
        // meeting at all was unknowable. Same event type as above with its
        // own `source`, rather than a new type, so it lands in the existing
        // dashboard tiles. Only the expand is counted, not the collapse:
        // this listener runs in the capture phase before React re-renders,
        // so aria-expanded still holds the PRE-click state - "false" means
        // this click is about to open the row. `week` is the past game's
        // season/round, not the current week being browsed.
        var h2hEl = target.closest(".h2h-row-header");
        if (h2hEl) {
          if (h2hEl.getAttribute("aria-expanded") !== "true") {
            sendEvent({
              type: "boxscore_click",
              visitorId: visitorId,
              ts: Date.now(),
              away: h2hEl.getAttribute("data-away") || undefined,
              home: h2hEl.getAttribute("data-home") || undefined,
              week: h2hEl.getAttribute("data-year") || undefined,
              source: "past_matchup",
            });
          }
          return;
        }

        var teamTabEl = target.closest(".team-tab-btn");
        if (teamTabEl) {
          var ttCtx = findActiveTeamContext();
          // data-tab-label is the canonical, stable name for the tab. The
          // visible text now shortens on mobile ("Roster & Depth Chart" ->
          // "Roster") to keep the strip on one line, and reporting the
          // visible text would have split the depth-chart KPI in
          // analytics-summary.mts into two names mid-series.
          var ttLabel = teamTabEl.getAttribute("data-tab-label");
          if (!ttLabel && teamTabEl.textContent) ttLabel = teamTabEl.textContent.trim();
          sendEvent({
            type: "team_tab",
            visitorId: visitorId,
            ts: Date.now(),
            team: ttCtx.team || "unknown",
            teamName: ttCtx.teamName || undefined,
            tab: ttLabel || undefined,
          });
          return;
        }

        /* The injury report is collapsed by default on mobile now, so how
           often people actually open it is the question that decides whether
           that was the right call - and it was previously unanswerable, since
           the report was always expanded and never generated an event.
           `open` is read before React re-renders (capture phase), so it
           describes the state being moved *to*. */
        var injuryToggleEl = target.closest(".team-injury-toggle");
        if (injuryToggleEl) {
          var itCtx = findActiveTeamContext();
          sendEvent({
            type: "team_injury_toggle",
            visitorId: visitorId,
            ts: Date.now(),
            team: itCtx.team || "unknown",
            teamName: itCtx.teamName || undefined,
            open: injuryToggleEl.getAttribute("data-injury-open") !== "1",
          });
          return;
        }

        /* A row on the mobile team schedule. These are new internal links to
           the per-matchup pages - nothing on a team page linked to them
           before - so this measures whether the schedule actually feeds
           traffic into them. */
        var schedCardEl = target.closest(".sched-card");
        if (schedCardEl) {
          sendEvent({
            type: "team_schedule_game",
            visitorId: visitorId,
            ts: Date.now(),
            team: schedCardEl.getAttribute("data-team") || "unknown",
            week: schedCardEl.getAttribute("data-week") || undefined,
          });
          return;
        }

        var rosterSideEl = target.closest(".roster-side-tab-btn");
        if (rosterSideEl) {
          var rsCtx = findActiveTeamContext();
          sendEvent({
            type: "roster_side",
            visitorId: visitorId,
            ts: Date.now(),
            team: rsCtx.team || "unknown",
            teamName: rsCtx.teamName || undefined,
            side: rosterSideEl.textContent ? rosterSideEl.textContent.trim() : undefined,
          });
          return;
        }

        var depthPlayerEl = target.closest(".depth-player-name-btn");
        var rosterPlayerEl = !depthPlayerEl ? target.closest(".roster-player-name-btn") : null;
        var playerEl = depthPlayerEl || rosterPlayerEl;
        if (playerEl) {
          var pvCtx = findActiveTeamContext();
          sendEvent({
            type: "player_view",
            visitorId: visitorId,
            ts: Date.now(),
            team: pvCtx.team || "unknown",
            teamName: pvCtx.teamName || undefined,
            player: playerEl.textContent ? playerEl.textContent.trim() : undefined,
            source: depthPlayerEl ? "depth_chart" : "full_roster",
          });
          return;
        }

        // Playbook sub-tab pills. Which of the four screens people actually
        // open is the question the redesign has to answer, and none of it was
        // observable before.
        var subTabEl = target.closest(".hot-picks-subtab-btn");
        if (subTabEl) {
          sendEvent({
            type: "playbook_subtab",
            visitorId: visitorId,
            ts: Date.now(),
            subtab: (subTabEl.textContent || "").trim() || "unknown",
            page: getCurrentPageLabel(),
          });
          return;
        }

        // Format selector on the signed-out preview - tells us which pool
        // format visitors care about before they ever create an account,
        // which is the one piece of audience data nothing else captures.
        var fmtEl = target.closest(".pbp-fmt-tab");
        if (fmtEl) {
          // The button holds both a full and a short label (one hidden by a
          // media query), so reading the <b> wholesale concatenates them into
          // "Against the SpreadSpread". Take the canonical one.
          var fmtLabel = fmtEl.querySelector(".pbp-lbl-full") || fmtEl.querySelector("b");
          sendEvent({
            type: "playbook_format",
            visitorId: visitorId,
            ts: Date.now(),
            format: ((fmtLabel && fmtLabel.textContent) || "").trim() || "unknown",
            page: getCurrentPageLabel(),
          });
          return;
        }

        // The gate's call to action. This is the conversion event for every
        // paywall surface - without it the blur is unmeasurable and there's
        // no way to tell a working gate from one people ignore.
        var gateEl = target.closest(".pbp-gate, .pbc-gate");
        if (gateEl && target.closest("button")) {
          sendEvent({
            type: "gate_cta",
            visitorId: visitorId,
            ts: Date.now(),
            action: (target.closest("button").textContent || "").trim() || "unknown",
            surface: gateEl.className.indexOf("pbc-gate") !== -1 ? "pro" : "signin",
            page: getCurrentPageLabel(),
          });
          return;
        }

        // Opening the per-book price comparison - the affiliate surface, so
        // worth knowing whether anyone uses it before wiring money to it.
        var booksEl = target.closest(".pba-books-toggle");
        if (booksEl) {
          sendEvent({
            type: "book_compare",
            visitorId: visitorId,
            ts: Date.now(),
            page: getCurrentPageLabel(),
          });
          return;
        }

        var newsEl = target.closest(".news-ticker-item");
        if (newsEl) {
          var headlineEl = newsEl.querySelector(".news-ticker-headline");
          sendEvent({
            type: "news_click",
            visitorId: visitorId,
            ts: Date.now(),
            source: newsEl.getAttribute("data-news-source") || "Unknown",
            headline: headlineEl && headlineEl.textContent ? headlineEl.textContent.trim().slice(0, 160) : undefined,
            placement: "ticker",
          });
          return;
        }

        // Team News panel - a second, separate news surface (per-team page)
        // from the scrolling ticker above. Same event type, tagged with
        // `placement` so the two can be told apart or looked at together.
        var teamNewsEl = target.closest(".news-item");
        if (teamNewsEl) {
          var headlineTextEl = teamNewsEl.querySelector(".news-item-headline");
          sendEvent({
            type: "news_click",
            visitorId: visitorId,
            ts: Date.now(),
            source: teamNewsEl.getAttribute("data-news-source") || "Unknown",
            headline: headlineTextEl && headlineTextEl.textContent ? headlineTextEl.textContent.trim().slice(0, 160) : undefined,
            placement: "team_news",
          });
          return;
        }

        // Historical archive game link - present on season/year/phase index
        // pages AND team archive pages (`/historical/teams/{team}/`), same
        // `.season-index-game` class both places. `data-origin` (set at
        // generation time, see backfill-historical-season.mjs) tells them
        // apart: "team" pages get their own event type since that's a
        // materially different browsing path (drilling into one team's
        // history) than jumping into a game from a season/week listing.
        var historyGameEl = target.closest(".season-index-game");
        if (historyGameEl) {
          var historyOrigin = historyGameEl.getAttribute("data-origin");
          sendEvent({
            type: historyOrigin === "team" ? "history_team_game_click" : "history_game_click",
            visitorId: visitorId,
            ts: Date.now(),
            away: historyGameEl.getAttribute("data-away") || undefined,
            home: historyGameEl.getAttribute("data-home") || undefined,
            team: historyGameEl.getAttribute("data-team") || undefined,
            page: getCurrentPageLabel(),
          });
        }
      } catch (e) {
        /* ignore, never break the click handling for the real app */
      }
    }

    // Separate from handleDocumentClick because <select> elements fire
    // "change", not "click", for the interaction that actually matters here
    // (choosing an option) - a click on a <select> alone doesn't tell you
    // what got picked. Same capture-phase-listener convention as clicks.
    function handleDocumentChange(evt) {
      try {
        var target = evt.target;
        if (!target || !target.id) return;

        // Root archive index (`/historical/index.html`) "Browse by season" /
        // "Browse by team" selects - these navigate on change (see
        // rebuildRootIndex's pageScript), so this is a real navigation
        // action, not a filter - distinct event type from history_week_select.
        if (target.id === "year-nav" || target.id === "team-nav") {
          if (!target.value) return; // the placeholder "Select a..." option
          sendEvent({
            type: "history_nav_click",
            visitorId: visitorId,
            ts: Date.now(),
            nav: target.id === "year-nav" ? "season" : "team",
            page: getCurrentPageLabel(),
          });
          return;
        }

        // Season/year index page filter dropdowns ("Jump to:" week/round
        // select, "Team:" select) - these filter the current page in place,
        // no navigation, so they're their own event distinct from the nav
        // selects above.
        if (target.id === "week-select" || target.id === "team-select") {
          var selectedLabel = target.options && target.selectedIndex >= 0 ? target.options[target.selectedIndex].textContent : undefined;
          sendEvent({
            type: "history_week_select",
            visitorId: visitorId,
            ts: Date.now(),
            filter: target.id === "week-select" ? "week" : "team",
            value: selectedLabel ? String(selectedLabel).trim().slice(0, 64) : undefined,
            page: getCurrentPageLabel(),
          });
        }
      } catch (e) {
        /* ignore, never break change handling for the real app */
      }
    }

    function init() {
      // The app is a client-rendered SPA (React root mounted after a
      // runtime Babel transpile), so by the time this script runs there's
      // no guarantee the week nav / team header markup getCurrentPageLabel
      // and getCurrentWeekLabel read from has actually painted yet. Poll
      // briefly for recognizable app markup before sending the initial
      // pageview, rather than risk it going out with a null page/week.
      // Bounded so a page that genuinely never renders that markup (error
      // state, etc.) doesn't block the pageview from ever being sent.
      whenAppReady(function () {
        lastSentPage = getCurrentPageLabel();
        trackPageview();
        initViewChangeTracking();
      });
      // true = capture phase, see comment at top of file for why.
      document.addEventListener("click", handleDocumentClick, true);
      document.addEventListener("change", handleDocumentChange, true);
    }

    function whenAppReady(cb, attemptsLeft) {
      attemptsLeft = typeof attemptsLeft === "number" ? attemptsLeft : 40; // ~40 x 50ms = 2s max wait
      try {
        if (
          attemptsLeft <= 0 ||
          document.querySelector(".week-nav-trigger") ||
          document.querySelector(".team-view-header") ||
          document.querySelector(".game-page") ||
          document.querySelector(".archive-badge")
        ) {
          cb();
          return;
        }
      } catch (e) {
        cb();
        return;
      }
      setTimeout(function () { whenAppReady(cb, attemptsLeft - 1); }, 50);
    }

    // There's no URL/route change to hook for SPA navigation (this app
    // never changes window.location), so a hard pageview only ever fires
    // once per full page load - meaning without this, `page` could only
    // ever say "Week X" (everyone lands on the week view) and would never
    // reflect a visitor navigating into a team page or switching tabs.
    // Instead of hooking every individual click handler that might change
    // the visible screen (team click, favorites-bar chip, team switcher,
    // back button, week nav arrows, week picker...), watch the DOM
    // generically: whenever it changes, recompute getCurrentPageLabel()
    // and record a lightweight view_change event if it's different from
    // the last one sent. This is NOT counted as a pageview (doesn't affect
    // the Total Pageviews / Unique Visitors KPIs) - it exists purely so a
    // visitor's timeline reads as a real path through the site.
    var lastSentPage = null;
    var viewChangeDebounceTimer = null;

    function maybeTrackViewChange() {
      try {
        var page = getCurrentPageLabel();
        if (!page || page === lastSentPage) return;
        lastSentPage = page;
        sendEvent({
          type: "view_change",
          visitorId: visitorId,
          ts: Date.now(),
          page: page,
        });
      } catch (e) {
        /* ignore */
      }
    }

    function initViewChangeTracking() {
      try {
        if (!window.MutationObserver) return;
        var observer = new MutationObserver(function () {
          if (viewChangeDebounceTimer) return;
          viewChangeDebounceTimer = setTimeout(function () {
            viewChangeDebounceTimer = null;
            maybeTrackViewChange();
          }, 200);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (e) {
        /* ignore */
      }
    }

    // A hook for events the app knows about but the DOM doesn't show.
    //
    // Everything else in this file is a delegated listener over rendered
    // markup, which works because the thing being measured is a thing
    // somebody clicked. Push registration health isn't: it's the outcome of
    // an async check against the server, with no element to hang a
    // data-attribute on and no click to catch. Rather than teach this file
    // about push, it exposes one narrow emitter that index.html can call.
    //
    // Deliberately minimal: a type, a small flat payload, and the same
    // visitorId/device stamping every other event gets. Bot filtering and
    // the endpoint stay in here, so a caller can't route around either.
    window.blitzTrack = function (type, payload) {
      try {
        if (!type) return;
        var body = { type: String(type), visitorId: visitorId, ts: Date.now() };
        if (payload && typeof payload === "object") {
          for (var key in payload) {
            if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
            var value = payload[key];
            if (value === undefined || value === null) continue;
            // Scalars only - this is a dashboard counter, not a log sink,
            // and an object here would land in the summary as "[object
            // Object]" rather than failing visibly.
            if (typeof value === "object") continue;
            body[key] = value;
          }
        }
        sendEvent(body);
      } catch (e) {
        /* never let a tracking failure surface to the user */
      }
    };

    if (document.readyState === "complete" || document.readyState === "interactive") {
      init();
    } else {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    }
  } catch (outerErr) {
    // Absolute last resort guard - analytics must never break Blitz Odds.
  }
})();

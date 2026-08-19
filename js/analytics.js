/**
 * Blitz Odds - lightweight first-party analytics.
 *
 * This file is intentionally standalone vanilla JS with zero dependencies on
 * the React app above it. It never touches app state, never mutates the DOM
 * (other than reading it), and every entry point is wrapped in try/catch so
 * a failure here can never break the page.
 *
 * Tracks:
 *  - "pageview" once per page load
 *  - "team_click" whenever a `.team-click` element (logo/name, opens a team's
 *    schedule) or a descendant of one is clicked
 *  - "favorite" whenever a `.star-btn` (the favorite-star toggle) is clicked,
 *    with `adding: true/false` depending on whether the star was being turned
 *    on or off at the moment of the click
 *  - "team_tab" whenever a tab inside a team page (Schedule / Roster & Depth
 *    Chart / News) is opened, via `.team-tab-btn`
 *  - "roster_side" whenever the Offense/Defense/Special Teams side toggle
 *    inside the depth chart is clicked, via `.roster-side-tab-btn`
 *  - "player_view" whenever a player's name is clicked to open their detail
 *    modal, from either the depth chart (`.depth-player-name-btn`) or the
 *    full roster table (`.roster-player-name-btn`)
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

    // A human-readable label for whatever's currently on screen, since this
    // is a single-page app with no URL/route changes to read instead - every
    // pageview otherwise looks identical in a visitor's timeline. Read-only
    // DOM inspection, same pattern as getCurrentWeekLabel/findActiveTeamContext:
    // presence of ".team-view-header" means a team page is open (and which
    // tab - Schedule/Roster & Depth Chart/News - is read from the active
    // ".team-tab-btn"); otherwise it's the week view, labeled by the
    // selected week.
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
        var archiveBadge = document.querySelector(".archive-badge");
        if (archiveBadge) {
          var titleText = document.title || "";
          var label = titleText.split(" | ")[0].trim();
          return "Historical archive: " + (label || archiveBadge.textContent.trim());
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

    function trackPageview() {
      try {
        sendEvent({
          type: "pageview",
          visitorId: visitorId,
          ts: Date.now(),
          week: getCurrentWeekLabel(),
          page: getCurrentPageLabel(),
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

        var boxScoreEl = target.closest(".score-link-btn");
        if (boxScoreEl) {
          sendEvent({
            type: "boxscore_click",
            visitorId: visitorId,
            ts: Date.now(),
            away: boxScoreEl.getAttribute("data-away") || undefined,
            home: boxScoreEl.getAttribute("data-home") || undefined,
            week: boxScoreEl.getAttribute("data-week") || getCurrentWeekLabel(),
          });
          return;
        }

        var teamTabEl = target.closest(".team-tab-btn");
        if (teamTabEl) {
          var ttCtx = findActiveTeamContext();
          sendEvent({
            type: "team_tab",
            visitorId: visitorId,
            ts: Date.now(),
            team: ttCtx.team || "unknown",
            teamName: ttCtx.teamName || undefined,
            tab: teamTabEl.textContent ? teamTabEl.textContent.trim() : undefined,
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

    if (document.readyState === "complete" || document.readyState === "interactive") {
      init();
    } else {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    }
  } catch (outerErr) {
    // Absolute last resort guard - analytics must never break Blitz Odds.
  }
})();

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
          });
        }
      } catch (e) {
        /* ignore, never break the click handling for the real app */
      }
    }

    function init() {
      trackPageview();
      // true = capture phase, see comment at top of file for why.
      document.addEventListener("click", handleDocumentClick, true);
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

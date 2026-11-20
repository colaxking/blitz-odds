/* Blitz Odds - historical archive hub behaviour.
 *
 * Progressive enhancement for the pages scripts/build-archive-hub.mjs writes.
 * Every season, team and game is a plain <a> in the HTML; nothing here is
 * needed to reach a page. This file adds:
 *
 *   1. the "Find Historical Games" finder on the archive landing page
 *      (season select + searchable team combobox -> an existing archive URL)
 *   2. the team directory search / conference filter on the landing page
 *   3. the filters on season, season-phase and team pages, mirrored into the
 *      query string so a filtered view can be shared and Back / Forward work
 *
 * Filtered views are the same document as the unfiltered page (its canonical
 * does not change), so they add no indexable URL variants.
 *
 * No dependencies, no network requests.
 */
(function () {
  "use strict";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim(); }
  function track(type, payload) {
    try { if (typeof window.blitzTrack === "function") window.blitzTrack(type, payload); } catch (e) { /* analytics is optional */ }
  }
  function pageLabel() { return "Historical archive: " + (document.title || "").split(" | ")[0]; }

  /** "2015,2016,2017,2019" -> "2015–2017, 2019" */
  function ranges(years) {
    var ys = years.map(Number).sort(function (a, b) { return a - b; }), out = [];
    for (var i = 0; i < ys.length; i++) {
      var j = i;
      while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++;
      out.push(i === j ? String(ys[i]) : ys[i] + "–" + ys[j]);
      i = j;
    }
    return out.join(", ");
  }

  // ---- 1. Finder -----------------------------------------------------------

  function initCombo(root) {
    var input = $("input[role=combobox]", root);
    var list = $("[role=listbox]", root);
    var clearBtn = $("[data-ah-combo-clear]", root);
    var none = $("[data-ah-combo-none]", root);
    var options = $all("[role=option]", list);
    var active = -1;       // index into visible()
    var selected = null;   // the chosen option element

    function visible() { return options.filter(function (o) { return !o.hidden; }); }
    function isOpen() { return !list.hidden; }
    function setActive(i) {
      var vis = visible();
      options.forEach(function (o) { o.classList.remove("is-active"); });
      active = vis.length ? Math.max(0, Math.min(i, vis.length - 1)) : -1;
      if (active < 0) { input.removeAttribute("aria-activedescendant"); return; }
      var el = vis[active];
      el.classList.add("is-active");
      input.setAttribute("aria-activedescendant", el.id);
      if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
    function filter() {
      var q = norm(input.value);
      var shown = 0;
      options.forEach(function (o) {
        var hay = norm(o.getAttribute("data-name") + " " + o.getAttribute("data-abbr"));
        o.hidden = !!q && hay.indexOf(q) < 0;
        if (!o.hidden) shown++;
      });
      none.hidden = shown > 0;
    }
    function open() {
      if (isOpen()) return;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }
    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      options.forEach(function (o) { o.classList.remove("is-active"); });
      active = -1;
    }
    function choose(opt) {
      selected = opt || null;
      options.forEach(function (o) { o.setAttribute("aria-selected", o === selected ? "true" : "false"); });
      input.value = selected ? selected.getAttribute("data-name") : "";
      clearBtn.hidden = !input.value;
      input.removeAttribute("aria-invalid");
      close();
    }

    input.addEventListener("input", function () {
      selected = null;
      options.forEach(function (o) { o.setAttribute("aria-selected", "false"); });
      clearBtn.hidden = !input.value;
      filter(); open(); setActive(0);
    });
    input.addEventListener("click", function () { if (!isOpen()) { filter(); open(); } });
    input.addEventListener("keydown", function (e) {
      var vis;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (!isOpen()) { filter(); open(); setActive(0); } else setActive(active + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (!isOpen()) { filter(); open(); setActive(visible().length - 1); } else setActive(active - 1);
          break;
        case "Home": if (isOpen()) { e.preventDefault(); setActive(0); } break;
        case "End": if (isOpen()) { e.preventDefault(); setActive(visible().length - 1); } break;
        case "Enter":
          vis = visible();
          if (isOpen() && active >= 0 && vis[active]) { e.preventDefault(); choose(vis[active]); }
          break;
        case "Escape":
          if (isOpen()) { e.preventDefault(); close(); } else if (input.value) { choose(null); }
          break;
        case "Tab": close(); break;
      }
    });
    // mousedown, not click: the option must win over the input's blur.
    list.addEventListener("mousedown", function (e) {
      var opt = e.target.closest ? e.target.closest("[role=option]") : null;
      if (opt) { e.preventDefault(); choose(opt); input.focus(); }
    });
    input.addEventListener("blur", function () { setTimeout(close, 120); });
    clearBtn.addEventListener("click", function () { choose(null); filter(); input.focus(); });

    return {
      input: input,
      /** The chosen option, the unambiguous match for what was typed, or null. */
      value: function () {
        if (selected) return selected;
        var q = norm(input.value);
        if (!q) return null;
        var exact = options.filter(function (o) { return norm(o.getAttribute("data-name")) === q || norm(o.getAttribute("data-abbr")) === q; });
        if (exact.length === 1) { choose(exact[0]); return exact[0]; }
        var partial = options.filter(function (o) { return norm(o.getAttribute("data-name")).indexOf(q) >= 0; });
        if (partial.length === 1) { choose(partial[0]); return partial[0]; }
        return null;
      },
      hasText: function () { return !!norm(input.value); }
    };
  }

  function initFinder() {
    var form = $("[data-ah-finder]");
    if (!form) return;
    var season = $("#finder-season", form);
    var msg = $("[data-ah-finder-msg]", form);
    var combo = initCombo($("[data-ah-combo]", form));

    function fail(text, field) {
      msg.textContent = text;
      if (field) { field.setAttribute("aria-invalid", "true"); field.focus(); }
    }
    function clearError() {
      msg.textContent = "";
      season.removeAttribute("aria-invalid");
      combo.input.removeAttribute("aria-invalid");
    }
    season.addEventListener("change", clearError);
    combo.input.addEventListener("input", clearError);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearError();
      var year = season.value;
      var team = combo.value();
      if (!team && combo.hasText()) return fail("Choose a team from the list, or clear the team field.", combo.input);
      if (!year && !team) return fail("Choose a season, a team, or both.", season);

      var url;
      if (team) {
        var years = (team.getAttribute("data-years") || "").split(",");
        var name = team.getAttribute("data-name");
        if (year && years.indexOf(year) < 0) {
          return fail("The archive has no " + name + " games from " + year + ". Seasons on file for this team: " + ranges(years) + ".", season);
        }
        url = "/historical/teams/" + team.getAttribute("data-slug") + "/index.html" + (year ? "?season=" + encodeURIComponent(year) : "");
      } else {
        url = "/historical/" + encodeURIComponent(year) + "/index.html";
      }
      track("history_nav_click", { nav: team ? "team" : "season", page: pageLabel() });
      window.location.assign(url);
    });
  }

  // ---- 2. Team directory -----------------------------------------------------

  function initTeamDirectory() {
    var tools = $("[data-ah-teamtools]");
    if (!tools) return;
    var search = $("#team-search", tools);
    var confBtns = $all("[data-ah-conf]", tools);
    var cards = $all("[data-ah-team]");
    var legacy = $("[data-ah-legacy]");
    var empty = $("[data-ah-team-empty]");
    var count = $("[data-ah-team-count]");
    var conf = "all";

    function apply() {
      var q = norm(search.value), shown = 0, legacyShown = 0;
      cards.forEach(function (c) {
        var cardConf = c.getAttribute("data-conf");
        var ok = (!q || norm(c.getAttribute("data-name")).indexOf(q) >= 0) &&
          (conf === "all" || cardConf === conf);
        c.hidden = !ok;
        if (ok) { shown++; if (cardConf === "legacy") legacyShown++; }
      });
      if (legacy) legacy.hidden = legacyShown === 0;
      empty.hidden = shown > 0;
      count.textContent = shown === 1 ? "1 team shown" : shown + " teams shown";
    }
    search.addEventListener("input", apply);
    confBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        conf = b.getAttribute("data-ah-conf");
        confBtns.forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
        apply();
      });
    });
  }

  // ---- 3. Results filters ----------------------------------------------------

  function initResultsFilters() {
    var form = $("[data-ah-filters]");
    var results = $("[data-ah-results]");
    if (!form || !results) return;
    var kind = form.getAttribute("data-ah-filters");
    var count = $("[data-ah-count]", form);
    var empty = $("[data-ah-empty]", results);
    var rows = $all(".ah-game", results);
    var rounds = $all(".ah-round", results);
    var phases = $all("[data-ah-phase]", results);

    // Each filter: the <select>, its query-string key, how a row is tested,
    // and how an option maps to/from the value written in the URL.
    var filters = kind === "team"
      ? [
          { el: $("#season-select"), key: "season", test: function (row, v) { return row.getAttribute("data-season") === v; } },
          { el: $("#type-select"), key: "type", test: function (row, v) { return row.getAttribute("data-type") === v; } }
        ]
      : [
          { el: $("#week-select"), key: "round", toUrl: function (v) { return v.replace(/^group-/, ""); }, fromUrl: function (v) { return "group-" + v; },
            test: function (row, v) { var r = row.closest(".ah-round"); return !!r && r.id === v; } },
          { el: $("#team-select"), key: "team", slug: true,
            test: function (row, v) { return row.getAttribute("data-away") === v || row.getAttribute("data-home") === v; } }
        ];
    filters = filters.filter(function (f) { return !!f.el; });

    function optionFor(f, urlValue) {
      var opts = $all("option", f.el);
      for (var i = 0; i < opts.length; i++) {
        var o = opts[i];
        if (o.value === "all") continue;
        var candidate = f.slug ? o.getAttribute("data-slug") : (f.toUrl ? f.toUrl(o.value) : o.value);
        if (candidate === urlValue || (f.slug && o.value.toLowerCase() === String(urlValue).toLowerCase())) return o.value;
      }
      return "all";
    }
    function urlValueFor(f) {
      if (f.el.value === "all") return null;
      if (f.slug) return f.el.options[f.el.selectedIndex].getAttribute("data-slug");
      return f.toUrl ? f.toUrl(f.el.value) : f.el.value;
    }

    function apply() {
      var shown = 0;
      rows.forEach(function (row) {
        var ok = filters.every(function (f) { return f.el.value === "all" || f.test(row, f.el.value); });
        row.hidden = !ok;
        if (ok) shown++;
      });
      rounds.forEach(function (r) { r.hidden = !$(".ah-game:not([hidden])", r); });
      phases.forEach(function (p) { p.hidden = !$(".ah-game:not([hidden])", p); });
      if (empty) empty.hidden = shown > 0;
      var filtered = filters.some(function (f) { return f.el.value !== "all"; });
      count.textContent = (filtered ? "Showing " + shown + " of " + rows.length : rows.length) + (rows.length === 1 ? " game" : " games");
    }
    function readUrl() {
      var params;
      try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
      filters.forEach(function (f) {
        var v = params.get(f.key);
        f.el.value = v ? optionFor(f, v) : "all";
      });
    }
    function writeUrl() {
      if (!window.history || !window.history.pushState) return;
      var params;
      try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
      filters.forEach(function (f) {
        var v = urlValueFor(f);
        if (v) params.set(f.key, v); else params.delete(f.key);
      });
      var qs = params.toString();
      var next = window.location.pathname + (qs ? "?" + qs : "");
      if (next !== window.location.pathname + window.location.search) window.history.pushState(null, "", next);
    }

    filters.forEach(function (f) {
      f.el.addEventListener("change", function () { apply(); writeUrl(); });
    });
    $all("[data-ah-reset]", results).forEach(function (b) {
      b.addEventListener("click", function () {
        filters.forEach(function (f) { f.el.value = "all"; });
        apply(); writeUrl();
        filters[0].el.focus();
      });
    });
    window.addEventListener("popstate", function () { readUrl(); apply(); });

    readUrl();
    apply();
  }

  function init() { initFinder(); initTeamDirectory(); initResultsFilters(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

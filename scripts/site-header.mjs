// The one site header for every page that is NOT the React app: the results
// archive, the standalone college pages, /teams/, /terms/, /privacy/ and
// 404.html. Styled by css/site-nav.css; the app's own header (src/app.jsx
// <TabBar> inside header.top, styled in src/app.css) is the reference - the
// items, order and labels here must match it.
//
// Used by:
//   scripts/build-college-pages.mjs   (college games / teams / bowls pages)
//   scripts/build-static-pages.mjs    (/teams/ index)
//   scripts/sync-site-header.mjs      (archive, terms, privacy, 404 - files
//                                      that are edited in place)
//
// After changing the nav here: run all three, and bump SITE_NAV_VERSION if
// css/site-nav.css changed.

export const SITE_NAV_VERSION = "1";
export const SITE_NAV_LINK = `<link rel="stylesheet" href="/css/site-nav.css?v=${SITE_NAV_VERSION}" />`;
export const SITE_HDR_START = "<!-- site-hdr:start -->";
export const SITE_HDR_END = "<!-- site-hdr:end -->";

/** Same tabs, order and labels as TabBar in src/app.jsx. "Pick'em Leagues"
 *  is desktop-only there too (phones reach leagues from Home / the Menu). */
const TABS = [
  { id: "home", href: "/", label: "Home", icon: "home" },
  { id: "games", href: "/games/", label: "Games", icon: "games" },
  { id: "bowls", href: "/bowls/", label: "Bowls", icon: "bowls", flag: "bowls" },
  { id: "picks", href: "/picks/", label: "Playbook", icon: "playbook" },
  { id: "news", href: "/news/", label: "News", icon: "news" },
  { id: "league", href: "/leagues/", label: "Pick'em Leagues", icon: "leagues", desktopOnly: true },
];

// = BOWLS_VISIBLE_UNTIL in src/app.jsx
const BOWLS_VISIBLE_UNTIL = Date.parse("2027-02-01T12:00:00Z");

/* The Bowls tab follows the `bowls` feature flag, exactly like the app's tab
 * bar. A static page can't know the flag at build time without going stale
 * the moment it is flipped (the archive is 3,600 files nobody regenerates),
 * so the link ships hidden and this asks the same public features endpoint
 * the app does - once per browser session. */
const FLAG_SCRIPT = `<script>(function(){try{var k="blitz-public-flags",c=sessionStorage.getItem(k);function a(f){if(f&&f.bowls===true&&Date.now()<${BOWLS_VISIBLE_UNTIL}){var e=document.querySelector('.site-nav-btn[data-flag="bowls"]');if(e)e.hidden=false}}if(c){a(JSON.parse(c));return}fetch("/.netlify/functions/features",{headers:{accept:"application/json"}}).then(function(r){return r.json()}).then(function(b){if(b&&b.ok&&b.features){sessionStorage.setItem(k,JSON.stringify({bowls:b.features.bowls===true}));a(b.features)}}).catch(function(){})}catch(e){}})();</script>`;

/**
 * @param {object} [o]
 * @param {string|null} [o.active]  tab id to mark current, or null
 * @param {string|null} [o.acts]    HTML for the right-hand slot; default is Sign in + Create a Free League
 * @param {string} [o.top]          the page container's top padding, so the bar sits flush with the viewport
 * @param {string} [o.side]         the page container's side padding
 */
export function siteHeaderHtml({ active = null, acts = null, top = "0px", side = "16px" } = {}) {
  const nav = TABS.map((t) =>
    `<a class="site-nav-btn${t.desktopOnly ? " site-nav-desktop" : ""}" href="${t.href}"${t.flag ? ` data-flag="${t.flag}" hidden` : ""}${active === t.id ? ` aria-current="page"` : ""}><span class="site-nav-ico" aria-hidden="true"><img src="/branding/tab-icon-${t.icon}.png" alt="" width="34" height="34" loading="lazy" decoding="async" /></span><span>${t.label}</span></a>`
  ).join("");
  const slot = acts != null ? acts
    : `<a class="site-hdr-cta" href="/leagues/">Create a Free League</a><a class="site-hdr-link" href="/leagues/">Sign in</a>`;
  return `${SITE_HDR_START}<header class="site-hdr" style="--sn-top:${top};--sn-side:${side}"><a class="site-hdr-brand" href="/" aria-label="Blitz Odds home"><img class="site-hdr-logo-dark" src="/branding/blitz-odds-wordmark-dark.svg" alt="Blitz Odds" width="900" height="252" decoding="async" /><img class="site-hdr-logo-light" src="/branding/blitz-odds-wordmark-light.svg" alt="" width="900" height="252" loading="lazy" decoding="async" /></a><nav class="site-nav" aria-label="Primary">${nav}</nav><div class="site-hdr-acts">${slot}</div></header>${FLAG_SCRIPT}${SITE_HDR_END}`;
}

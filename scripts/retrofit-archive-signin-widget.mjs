// One-off migration: adds the Netlify Identity sign-in widget (mirroring
// the live app's AccountButton) to every already-generated static archive
// page under historical/, and folds the standalone gear-icon Settings
// button into that widget's dropdown instead of showing it separately.
// Operates on the files directly - no ESPN/network calls, only chrome
// changed. Idempotent: skips files that already have .account-menu CSS
// so it's safe to re-run. Mirrors the approach in
// scripts/retrofit-archive-tabbar.mjs.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const HISTORICAL_DIR = path.join(ROOT, "historical");

const IDENTITY_SCRIPT_TAG =
  '<script src="https://identity.netlify.com/v1/netlify-identity-widget.js"></script>\n';

const OLD_SETTINGS_CSS = `.settings-btn {
  position: absolute; top: 2px; right: 0; display: flex; align-items: center; justify-content: center;
  width: 38px; height: 38px; border-radius: 50%; background: var(--card-bg); border: 1px solid var(--card-border);
  color: var(--text-dim); cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.settings-btn:hover, .settings-btn:focus-visible { color: var(--accent); border-color: var(--accent); background: rgba(var(--accent-rgb),0.08); }
@media (max-width: 480px) { .settings-btn { width: 34px; height: 34px; top: 0; } }`;

// Same visual language/classes as index.html's .account-menu / AccountButton,
// just positioned with plain absolute top-right (matching where the old
// gear icon sat) instead of the app's flex header-right-cluster.
const NEW_ACCOUNT_CSS = `.account-menu { position: absolute; top: 2px; right: 0; }
.account-btn { display: flex; align-items: center; justify-content: center; border-radius: 999px; border: 1px solid var(--card-border); cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s; }
.account-btn-signin { height: 38px; padding: 0 14px; background: var(--card-bg); color: var(--text-dim); font-size: 13px; font-weight: 600; }
.account-btn-signin:hover, .account-btn-signin:focus-visible { color: var(--accent); border-color: var(--accent); background: rgba(var(--accent-rgb),0.08); }
.account-signedout-row { display: flex; align-items: stretch; }
.account-signedout-row .account-btn-signin { border-radius: 999px 0 0 999px; border-right: none; }
.account-menu-toggle { display: flex; align-items: center; justify-content: center; width: 26px; height: 38px; border-radius: 0 999px 999px 0; border: 1px solid var(--card-border); background: var(--card-bg); color: var(--text-dim); cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s; }
.account-menu-toggle:hover, .account-menu-toggle:focus-visible { color: var(--accent); border-color: var(--accent); background: rgba(var(--accent-rgb),0.08); }
.account-menu-toggle-chevron { font-size: 10px; line-height: 1; }
.account-avatar { width: 38px; height: 38px; background: var(--accent); color: #062018; border-color: var(--accent); font-size: 15px; font-weight: 700; }
.account-avatar:hover, .account-avatar:focus-visible { filter: brightness(1.08); }
.account-dropdown { position: absolute; top: 46px; right: 0; min-width: 170px; z-index: 20; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.28); padding: 6px; text-align: left; }
.account-dropdown-name { padding: 8px 10px 6px; font-size: 12.5px; font-weight: 600; color: var(--text); border-bottom: 1px solid var(--card-border); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.account-dropdown-item { display: block; width: 100%; box-sizing: border-box; text-align: left; background: none; border: none; cursor: pointer; padding: 8px 10px; border-radius: 6px; font-size: 13.5px; color: var(--text-dim); text-decoration: none; font-family: inherit; }
.account-dropdown-item:hover, .account-dropdown-item:focus-visible { background: rgba(var(--accent-rgb),0.08); color: var(--accent); }
@media (max-width: 480px) {
  .account-menu { top: 0; }
  .account-btn-signin { height: 34px; padding: 0 12px; font-size: 12.5px; }
  .account-menu-toggle { height: 34px; }
  .account-avatar { width: 34px; height: 34px; font-size: 13px; }
}`;

const OLD_SETTINGS_BUTTON = `<button type="button" class="settings-btn" id="settingsBtn" aria-label="Open settings" title="Settings"><svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="2" />
      <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.5-2.4.6a7.7 7.7 0 0 0-1.7-1L14.9 3h-3.8l-.4 2.6a7.7 7.7 0 0 0-1.7 1l-2.4-.6-2 3.5 2 1.5a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.5 2.4-.6a7.7 7.7 0 0 0 1.7 1l.4 2.6h3.8l.4-2.6a7.7 7.7 0 0 0 1.7-1l2.4.6 2-3.5-2-1.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
    </svg></button>`;

const NEW_ACCOUNT_MARKUP = `<div class="account-menu" id="accountMenu">
    <div class="account-signedout-row" id="accountSignedOutRow">
      <button type="button" class="account-btn account-btn-signin" id="accountSignInBtn">Sign in</button>
      <button type="button" class="account-menu-toggle" id="accountMenuToggle" aria-label="More options" aria-expanded="false">
        <span class="account-menu-toggle-chevron">&#9662;</span>
      </button>
    </div>
    <button type="button" class="account-btn account-avatar" id="accountAvatarBtn" aria-label="Account menu" aria-expanded="false" style="display:none"></button>
    <div class="account-dropdown" id="accountDropdown" style="display:none">
      <div class="account-dropdown-name" id="accountDropdownName" style="display:none"></div>
      <button type="button" class="account-dropdown-item" id="accountSettingsItem">Settings</button>
      <button type="button" class="account-dropdown-item" id="accountSignOutItem" style="display:none">Sign out</button>
    </div>
  </div>`;

const OLD_SCRIPT_BLOCK = `<script>(function () {
  var KEY = "blitz-odds-theme";
  var btn = document.getElementById("settingsBtn");
  var overlay = document.getElementById("settingsOverlay");
  var closeBtn = document.getElementById("settingsClose");
  var toggle = document.getElementById("themeToggle");
  if (!btn || !overlay || !toggle) return;

  function getMode() {
    try {
      var saved = localStorage.getItem(KEY);
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    } catch (e) { return "system"; }
  }
  function resolve(mode) {
    if (mode !== "system") return mode;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  function applyTheme(mode) {
    var resolved = resolve(mode);
    if (resolved === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  }
  function highlightActive(mode) {
    var btns = toggle.querySelectorAll(".theme-toggle-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].getAttribute("data-mode") === mode);
    }
  }
  function setMode(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    applyTheme(mode);
    highlightActive(mode);
  }

  highlightActive(getMode());
  toggle.addEventListener("click", function (e) {
    var target = e.target.closest(".theme-toggle-btn");
    if (target) setMode(target.getAttribute("data-mode"));
  });

  function openModal() { overlay.style.display = "flex"; document.body.style.overflow = "hidden"; }
  function closeModal() { overlay.style.display = "none"; document.body.style.overflow = ""; }
  btn.addEventListener("click", openModal);
  closeBtn.addEventListener("click", closeModal);
  overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
})();</script>`;

// Replacement keeps every line of the original theme-toggle/settings-modal
// logic (just re-targets the modal trigger from #settingsBtn to the new
// dropdown's #accountSettingsItem) and appends the sign-in widget logic:
// dropdown open/close, Netlify Identity init/login/logout wiring, and the
// same iframe-stray-hide poll used in index.html's useAuth() to work around
// the widget's iframe sometimes staying interactive after it visually closes.
const NEW_SCRIPT_BLOCK = `<script>(function () {
  var KEY = "blitz-odds-theme";
  var overlay = document.getElementById("settingsOverlay");
  var closeBtn = document.getElementById("settingsClose");
  var toggle = document.getElementById("themeToggle");
  var settingsItem = document.getElementById("accountSettingsItem");
  if (!overlay || !toggle || !settingsItem) return;

  function getMode() {
    try {
      var saved = localStorage.getItem(KEY);
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    } catch (e) { return "system"; }
  }
  function resolve(mode) {
    if (mode !== "system") return mode;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  function applyTheme(mode) {
    var resolved = resolve(mode);
    if (resolved === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  }
  function highlightActive(mode) {
    var btns = toggle.querySelectorAll(".theme-toggle-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].getAttribute("data-mode") === mode);
    }
  }
  function setMode(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    applyTheme(mode);
    highlightActive(mode);
  }

  highlightActive(getMode());
  toggle.addEventListener("click", function (e) {
    var target = e.target.closest(".theme-toggle-btn");
    if (target) setMode(target.getAttribute("data-mode"));
  });

  function openSettingsModal() { overlay.style.display = "flex"; document.body.style.overflow = "hidden"; }
  function closeSettingsModal() { overlay.style.display = "none"; document.body.style.overflow = ""; }
  closeBtn.addEventListener("click", closeSettingsModal);
  overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeSettingsModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeSettingsModal(); });

  // ---- Sign-in widget (vanilla-JS port of index.html's AccountButton) ----
  var menu = document.getElementById("accountMenu");
  var signedOutRow = document.getElementById("accountSignedOutRow");
  var signInBtn = document.getElementById("accountSignInBtn");
  var menuToggle = document.getElementById("accountMenuToggle");
  var avatarBtn = document.getElementById("accountAvatarBtn");
  var dropdown = document.getElementById("accountDropdown");
  var dropdownName = document.getElementById("accountDropdownName");
  var signOutItem = document.getElementById("accountSignOutItem");
  var dropdownOpen = false;

  function closeAccountDropdown() {
    dropdownOpen = false;
    if (dropdown) dropdown.style.display = "none";
    if (menuToggle) menuToggle.setAttribute("aria-expanded", "false");
    if (avatarBtn) avatarBtn.setAttribute("aria-expanded", "false");
  }
  function openAccountDropdown() {
    dropdownOpen = true;
    if (dropdown) dropdown.style.display = "block";
    if (menuToggle) menuToggle.setAttribute("aria-expanded", "true");
    if (avatarBtn) avatarBtn.setAttribute("aria-expanded", "true");
  }
  function toggleAccountDropdown() { if (dropdownOpen) closeAccountDropdown(); else openAccountDropdown(); }

  settingsItem.addEventListener("click", function () { closeAccountDropdown(); openSettingsModal(); });
  if (menuToggle) menuToggle.addEventListener("click", toggleAccountDropdown);
  if (avatarBtn) avatarBtn.addEventListener("click", toggleAccountDropdown);
  document.addEventListener("mousedown", function (e) {
    if (dropdownOpen && menu && !menu.contains(e.target)) closeAccountDropdown();
  });

  function renderSignedOut() {
    if (signedOutRow) signedOutRow.style.display = "flex";
    if (avatarBtn) avatarBtn.style.display = "none";
    if (dropdownName) dropdownName.style.display = "none";
    if (signOutItem) signOutItem.style.display = "none";
  }
  function renderSignedIn(user) {
    var name = (user && user.user_metadata && user.user_metadata.full_name) || (user && user.email) || "Player";
    if (signedOutRow) signedOutRow.style.display = "none";
    if (avatarBtn) {
      avatarBtn.style.display = "flex";
      avatarBtn.textContent = name.charAt(0).toUpperCase();
    }
    if (dropdownName) {
      dropdownName.style.display = "block";
      dropdownName.textContent = name;
    }
    if (signOutItem) signOutItem.style.display = "block";
  }

  var identity = window.netlifyIdentity;
  if (signInBtn) signInBtn.addEventListener("click", function () { identity && identity.open("login"); });
  if (signOutItem) signOutItem.addEventListener("click", function () { closeAccountDropdown(); identity && identity.logout(); });

  if (!identity) {
    // Widget script failed to load (ad blocker, offline first paint, etc) -
    // fail open to the signed-out row rather than leaving nothing visible.
    renderSignedOut();
  } else {
    // Same iframe-stray-hide poll as index.html's useAuth(): the widget's
    // full-page overlay iframe can stay interactive (invisible but still
    // intercepting clicks) after it should have closed, so this forces it
    // hidden any time we don't believe it should be open.
    var widgetShouldBeOpen = false;
    function hideWidgetIframeIfStray() {
      if (widgetShouldBeOpen) return;
      var iframe = document.getElementById("netlify-identity-widget");
      if (iframe && iframe.style.display !== "none") iframe.style.display = "none";
    }
    identity.on("init", function (u) { u ? renderSignedIn(u) : renderSignedOut(); });
    identity.on("login", function (u) {
      renderSignedIn(u);
      widgetShouldBeOpen = false;
      identity.close();
    });
    identity.on("logout", function () { renderSignedOut(); widgetShouldBeOpen = false; });
    identity.on("open", function () { widgetShouldBeOpen = true; });
    identity.on("close", function () { widgetShouldBeOpen = false; });
    identity.init();
    setInterval(hideWidgetIframeIfStray, 250);
  }
})();</script>`;

async function listHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listHtmlFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(full);
  }
  return files;
}

async function retrofitFile(filePath) {
  const original = await readFile(filePath, "utf8");
  if (original.includes(".account-menu {")) return "skipped"; // already retrofitted

  if (
    !original.includes('<meta name="twitter:card" content="summary" />') ||
    !original.includes(OLD_SETTINGS_CSS) ||
    !original.includes(OLD_SETTINGS_BUTTON) ||
    !original.includes(OLD_SCRIPT_BLOCK)
  ) {
    return "no-match";
  }

  let updated = original.replace(
    '<meta name="twitter:card" content="summary" />\n',
    '<meta name="twitter:card" content="summary" />\n' + IDENTITY_SCRIPT_TAG
  );
  updated = updated.replace(OLD_SETTINGS_CSS, NEW_ACCOUNT_CSS);
  updated = updated.replace(OLD_SETTINGS_BUTTON, NEW_ACCOUNT_MARKUP);
  updated = updated.replace(OLD_SCRIPT_BLOCK, NEW_SCRIPT_BLOCK);

  if (updated === original) return "no-match";

  await writeFile(filePath, updated, "utf8");
  return "updated";
}

async function main() {
  const files = await listHtmlFiles(HISTORICAL_DIR);
  let updated = 0, skipped = 0, noMatch = 0;
  for (const file of files) {
    const result = await retrofitFile(file);
    if (result === "updated") updated++;
    else if (result === "skipped") skipped++;
    else { noMatch++; console.warn("no-match:", path.relative(ROOT, file)); }
  }
  console.log(`done. ${files.length} files scanned, ${updated} updated, ${skipped} already had it, ${noMatch} did not match expected structure.`);
}

main();

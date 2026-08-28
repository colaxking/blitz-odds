// One-off migration: brings the static archive pages' primary navigation in
// line with the live app's TabBar as of the illustrated-icon change.
//
// What was wrong. Every page under historical/ carries its own inlined copy
// of the tab bar - it's a static site, not the SPA - and that copy had
// drifted badly from index.html:
//
//   1. No Home tab at all. Home became the site root months ago; the archive
//      never learned about it, so its first tab was Games pointing at "/",
//      which is now Home. The label and the destination disagreed.
//   2. "Hot Picks" with a fire emoji. That tab is Playbook now.
//   3. Hash routes - "/#picks" and "/#news". Phase 3 replaced the hash
//      scheme with real paths, and index.html's router explicitly falls a
//      stray hash through to Games. So both of these were BROKEN links:
//      they didn't land on the wrong tab by accident, they landed on Games
//      every time.
//   4. An Archive tab, marked active. Archive gave up its tab slot in the
//      app and moved into the account menu, so a five-tab bar with Archive
//      in it no longer matches anything.
//   5. Emoji icons, where the app now uses the illustrated brand marks.
//
// It also adds an "Archive" entry to the archive pages' own account
// dropdown. That's not cosmetic: with the Archive tab gone, a deep page
// like /historical/2024/regular-season/week-1/dal-at-cle.html had no link
// back to the archive root - its breadcrumb goes Home -> 2024 Regular
// Season -> Week 1, skipping /historical/ entirely. The menu entry is the
// replacement, and it mirrors where Archive lives in the app's own menu.
//
// Deliberately NOT tagged with .archive-entry-link / data-archive-source.
// That hook feeds the archive_entry event, which exists to measure in-app
// demand for the archive; a click from a page that is already inside the
// archive would inflate it with navigation that proves nothing.
//
// Operates on the files directly - no ESPN/network calls - since only the
// header chrome changes, not any game data. Idempotent: skips files that
// already carry the new markup, so it's safe to re-run.
//
// Run: node scripts/retrofit-archive-nav-v3.mjs
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const HISTORICAL_DIR = path.join(ROOT, "historical");

/* ---------------------------------------------------------------------
 * The exact strings currently on disk. All 3,615 pages share one byte-
 * identical copy of each, which is what makes a literal replace safe here
 * rather than a regex - verified before this script was written, and
 * re-verified per file below (a file that doesn't contain them is reported,
 * never silently skipped).
 * ------------------------------------------------------------------- */

const OLD_CSS = `.tab-bar { display: flex; gap: 28px; margin: 18px 0 0; border-bottom: 1px solid var(--card-border); }
.tab-btn { display: flex; align-items: center; gap: 9px; background: none; border: none; cursor: pointer;
  color: var(--text-dim); font-family: inherit; font-size: 0.86rem; font-weight: 700; text-decoration: none;
  padding: 0 0 14px; position: relative; transition: color 0.15s; }
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--text); }
.tab-btn.active::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: var(--accent); border-radius: 2px; }
.tab-icon { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 13px; line-height: 1; flex-shrink: 0; background: rgba(255,255,255,0.05);
  border: 1px solid var(--card-border); transition: background 0.15s, border-color 0.15s; }
.tab-btn.active .tab-icon { background: rgba(var(--accent-rgb),0.16); border-color: var(--accent); }
@media (max-width: 720px) {
  .app { padding-bottom: 82px; }
  .tab-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 500; margin: 0; gap: 0;
    background: var(--card-bg); border-bottom: none; border-top: 1px solid var(--card-border);
    padding: 6px 4px calc(6px + env(safe-area-inset-bottom, 0px)); }
  .tab-btn { flex: 1; flex-direction: column; gap: 3px; padding: 4px 2px 0; font-size: 0.64rem; }
  .tab-btn.active::after { content: none; }
  .tab-icon { width: 24px; height: 24px; font-size: 12px; background: none; border-color: transparent; }
  .tab-btn.active .tab-icon { background: rgba(var(--accent-rgb),0.16); border-color: transparent; }
  .tab-btn.active { color: var(--accent); }
}`;

/* index.html's .tab-bar block is the source of truth for everything below.
 * The differences are deliberate and each has a reason:
 *   - `text-decoration: none` on .tab-btn, because these are <a> elements
 *     rather than <button>s. (Already present before this change.)
 *   - No .tab-btn.active rules are exercised in practice: no archive page
 *     is one of the four app tabs, so none is ever marked active. The rules
 *     are kept anyway so the two files stay diffable.
 * Keep this in sync by hand when index.html's block changes - the archive
 * is a separate static site and can't import it. */
const NEW_CSS = `.tab-bar { display: flex; gap: 28px; margin: 18px 0 0; border-bottom: 1px solid var(--card-border); }
.tab-btn { display: flex; align-items: center; gap: 9px; background: none; border: none; cursor: pointer;
  color: var(--text-dim); font-family: inherit; font-size: 0.86rem; font-weight: 700; text-decoration: none;
  padding: 0 0 14px; position: relative; transition: color 0.15s; }
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--text); }
.tab-btn.active::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: var(--accent); border-radius: 2px; }
.tab-icon { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 13px; line-height: 1; flex-shrink: 0; background: rgba(255,255,255,0.05);
  border: 1px solid var(--card-border); transition: background 0.15s, border-color 0.15s; }
.tab-btn.active .tab-icon { background: rgba(var(--accent-rgb),0.16); border-color: var(--accent); }
.tab-icon.has-img { width: 28px; height: 28px; background: none; border-color: transparent; }
.tab-btn.active .tab-icon.has-img { background: none; border-color: transparent; }
.tab-icon-img { width: 100%; height: 100%; object-fit: contain; display: block;
  opacity: 0.62; filter: grayscale(0.6) saturate(0.85) brightness(1.3);
  transition: opacity 0.15s, filter 0.15s, transform 0.15s; }
html[data-theme="light"] .tab-icon-img { opacity: 0.55; filter: grayscale(0.65) saturate(0.85); }
.tab-btn:hover .tab-icon-img,
.tab-btn.active .tab-icon-img { opacity: 1; filter: none; }
.tab-btn.active .tab-icon-img { transform: scale(1.06); }
@media (prefers-reduced-motion: reduce) {
  .tab-icon-img { transition: none; }
  .tab-btn.active .tab-icon-img { transform: none; }
}
@media (max-width: 720px) {
  .app { padding-bottom: 96px; }
  .tab-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 500; margin: 0; gap: 0;
    background: var(--card-bg);
    background: color-mix(in srgb, var(--card-bg) 74%, transparent);
    -webkit-backdrop-filter: saturate(180%) blur(22px);
    backdrop-filter: saturate(180%) blur(22px);
    border-bottom: none; border-top: 1px solid var(--card-border);
    padding: 8px 4px calc(14px + env(safe-area-inset-bottom, 0px)); }
  .tab-btn { flex: 1; flex-direction: column; gap: 4px; padding: 8px 2px; font-size: 0.64rem;
    min-height: 48px; transition: transform 0.1s ease; }
  .tab-btn:active { transform: scale(0.9); }
  .tab-btn.active::after { content: none; }
  .tab-icon { width: 24px; height: 24px; font-size: 12px; background: none; border-color: transparent; }
  .tab-btn.active .tab-icon { background: rgba(var(--accent-rgb),0.16); border-color: transparent; }
  .tab-icon.has-img { width: 30px; height: 30px; }
  .tab-btn.active .tab-icon.has-img { background: none; }
  .tab-btn.active { color: var(--accent); }
}`;

const OLD_NAV = `<nav class="tab-bar" aria-label="Primary">
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#x1F3C8;</span><span class="tab-label">Games</span></a>
    <a class="tab-btn" href="/#picks"><span class="tab-icon" aria-hidden="true">&#x1F525;</span><span class="tab-label">Hot Picks</span></a>
    <a class="tab-btn" href="/#news"><span class="tab-icon" aria-hidden="true">&#x1F4F0;</span><span class="tab-label">News</span></a>
    <a class="tab-btn active" href="/historical/index.html" aria-current="page"><span class="tab-icon" aria-hidden="true">&#x1F5C2;&#xFE0F;</span><span class="tab-label">Archive</span></a>
  </nav>`;

/* No tab carries `active` or `aria-current`. An archive page isn't any of
 * the four app tabs - it's a destination outside the tab set, the way the
 * account menu's other entries are - so marking one would be a lie about
 * where the reader is. The breadcrumb and the "Historical Archive" badge
 * already say that. */
function tab(href, label, icon) {
  return `    <a class="tab-btn" href="${href}"><span class="tab-icon has-img" aria-hidden="true"><img class="tab-icon-img" src="/branding/tab-icon-${icon}.png" alt="" width="30" height="30" decoding="async" /></span><span class="tab-label">${label}</span></a>`;
}

const NEW_NAV = `<nav class="tab-bar" aria-label="Primary">
${tab("/", "Home", "home")}
${tab("/games", "Games", "games")}
${tab("/picks", "Playbook", "playbook")}
${tab("/news", "News", "news")}
  </nav>`;

const OLD_MENU = `      <button type="button" class="account-dropdown-item" id="accountSettingsItem">Settings</button>`;

/* Alphabetical, matching the app's own dropdown, where the list is sorted
 * for exactly this reason. "How this works" and "My Leagues" are absent on
 * purpose - both open in-app React surfaces that don't exist on a static
 * page, and a menu entry that can't do anything is worse than no entry. */
const NEW_MENU = `      <a class="account-dropdown-item" href="/historical/index.html">Archive</a>
      <button type="button" class="account-dropdown-item" id="accountSettingsItem">Settings</button>`;

/* No CSS change is needed for the new <a> in that dropdown: the archive's
 * .account-dropdown-item rule already carries text-decoration: none,
 * font-family: inherit and box-sizing: border-box, so an anchor and a
 * button render identically there. index.html needed those three added;
 * this stylesheet already had them. */

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

/**
 * Every replacement for one file is checked before ANY of them is applied.
 * A half-patched page - new nav, old CSS - renders as a broken header with
 * no error anywhere, and with 3,615 files nobody would find it by looking.
 * So: verify all three edits are possible, then write, or touch nothing and
 * report the file.
 */
function patch(original, filePath) {
  const edits = [
    { name: "css", from: OLD_CSS, to: NEW_CSS },
    { name: "nav", from: OLD_NAV, to: NEW_NAV },
    { name: "menu", from: OLD_MENU, to: NEW_MENU },
  ];

  const missing = edits.filter((e) => !original.includes(e.from));
  if (missing.length) {
    return { status: "error", detail: `${filePath}: missing ${missing.map((m) => m.name).join(", ")}` };
  }
  const ambiguous = edits.filter((e) => original.split(e.from).length - 1 !== 1);
  if (ambiguous.length) {
    return { status: "error", detail: `${filePath}: ambiguous ${ambiguous.map((m) => m.name).join(", ")}` };
  }

  let out = original;
  for (const e of edits) out = out.replace(e.from, e.to);
  return { status: "patched", content: out };
}

async function main() {
  const files = await listHtmlFiles(HISTORICAL_DIR);
  let patched = 0;
  let skipped = 0;
  const errors = [];

  for (const file of files) {
    const original = await readFile(file, "utf8");
    // Idempotency check first: .tab-icon-img only exists in the new markup.
    if (original.includes(".tab-icon-img")) {
      skipped++;
      continue;
    }
    const result = patch(original, path.relative(ROOT, file));
    if (result.status === "error") {
      errors.push(result.detail);
      continue;
    }
    await writeFile(file, result.content, "utf8");
    patched++;
  }

  console.log(`Archive nav retrofit: ${patched} patched, ${skipped} already current, ${errors.length} errors.`);
  for (const e of errors.slice(0, 20)) console.log("  " + e);
  if (errors.length > 20) console.log(`  ...and ${errors.length - 20} more`);
  if (errors.length) process.exitCode = 1;
}

main();

// Syncs the static archive pages' primary navigation to whatever index.html
// currently says it should be. Run it after any change to the app's tab bar.
//
// WHY THIS IS A SYNC AND NOT ANOTHER ONE-OFF MIGRATION
//
// Every page under historical/ carries its own inlined copy of the tab-bar
// CSS and markup - it's a static site, not the SPA, so it can't share the
// app's stylesheet. That copy has drifted every time the real tab bar
// changed, and each drift got its own migration script: retrofit-archive-
// tabbar.mjs, fix-archive-tabbar-alignment.mjs, fix-archive-tabbar-v2.mjs,
// and this file's predecessor. By the last of those the archive was serving
// a nav with no Home tab, a "Hot Picks" label, and two hash links that had
// been dead since Phase 3 - across 3,615 pages.
//
// Those scripts each hardcoded both the old and the new CSS, so a fifth
// change meant a fifth script and a fifth chance to forget. This one reads
// the canonical block straight out of index.html instead, which makes
// index.html the single source of truth and reduces "the archive drifted"
// to "nobody ran the sync". It's idempotent by comparing against the target
// rather than sniffing for a marker: the previous version keyed off a
// marker class, which meant it would silently skip every file the moment
// the CSS changed again - exactly the case that brought it back.
//
// Run: node scripts/sync-archive-nav.mjs
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const HISTORICAL_DIR = path.join(ROOT, "historical");
const INDEX_HTML = path.join(ROOT, "index.html");

/* The block in an archive page runs from the top-level `.tab-bar` rule to
 * the last line of its mobile media query.
 *
 * The start marker is a newline followed by an UNINDENTED `.tab-bar {`.
 * Both parts matter. `.tab-bar {` on its own is not unique - it appears
 * again inside the media query - and it's the indentation that tells the
 * two apart. Anchoring on the rule's contents instead (".tab-bar { display:
 * flex;") would have been more specific but breaks the moment the block is
 * reformatted, which is exactly what this script does to it on first run:
 * the archive's original was one line per rule, index.html's is not.
 *
 * Both markers are re-checked per file at runtime rather than assumed. */
const CSS_START = "\n.tab-bar {";
const CSS_END = ".tab-btn.active { color: var(--accent); }\n}";

/* In index.html the same block is bounded by the rule that follows it. */
const INDEX_CSS_START = "  .tab-bar {";
const INDEX_CSS_END = "  .tab-placeholder";

/**
 * Lifts the tab-bar CSS out of index.html and adapts it for the archive.
 *
 * Two adaptations, both needed:
 *  - index.html indents its CSS two spaces (it sits in a <style> nested in
 *    JSX); the archive stylesheet isn't indented. Leaving it would still
 *    work, but it makes the two impossible to diff by eye.
 *  - the archive's tabs are <a> elements, not <button>s, so .tab-btn needs
 *    `text-decoration: none`. index.html has no anchors in its bar and so
 *    carries no such rule.
 */
async function canonicalCss() {
  const index = await readFile(INDEX_HTML, "utf8");
  const start = index.indexOf(INDEX_CSS_START);
  const end = index.indexOf(INDEX_CSS_END, start);
  if (start === -1 || end === -1) {
    throw new Error("Could not locate the .tab-bar block in index.html - has it been renamed or moved?");
  }
  const block = index
    .slice(start, end)
    .trimEnd()
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");

  const anchored = block.replace(
    "color: var(--text-dim); font-family: inherit;",
    "color: var(--text-dim); font-family: inherit; text-decoration: none;"
  );
  if (anchored === block) {
    throw new Error("Could not add text-decoration:none to .tab-btn - has the rule been reformatted?");
  }
  return anchored;
}

/* No tab carries `active` or `aria-current`. An archive page isn't any of
 * the app's tabs - it's a destination outside the tab set, the way the
 * account menu's other entries are - so marking one would misstate where
 * the reader is. The breadcrumb and the "Historical Archive" badge already
 * do that job. Paths are real, not hashes: "/#picks" has been dead since
 * Phase 3, because the router falls a stray hash through to Games. */
const TABS = [
  ["/", "Home", "home"],
  ["/games", "Games", "games"],
  ["/picks", "Playbook", "playbook"],
  ["/news", "News", "news"],
];

const NAV_HTML = `<nav class="tab-bar" aria-label="Primary">
${TABS.map(
  ([href, label, icon]) =>
    `    <a class="tab-btn" href="${href}"><span class="tab-icon has-img" aria-hidden="true"><img class="tab-icon-img" src="/branding/tab-icon-${icon}.png" alt="" width="40" height="40" decoding="async" /></span><span class="tab-label">${label}</span></a>`
).join("\n")}
  </nav>`;

/* With the Archive tab gone, a deep page like
 * /historical/2024/regular-season/week-1/dal-at-cle.html has no link back to
 * the archive root - its breadcrumb runs Home -> 2024 Regular Season ->
 * Week 1, skipping /historical/ entirely. This is the replacement, and it
 * mirrors where Archive sits in the app's own account menu.
 *
 * Deliberately NOT tagged .archive-entry-link / data-archive-source: that
 * hook feeds the archive_entry event, which measures in-app demand for the
 * archive, and a click from a page already inside it would inflate the
 * number with navigation that proves nothing. */
const MENU_ANCHOR = `      <button type="button" class="account-dropdown-item" id="accountSettingsItem">Settings</button>`;
const ARCHIVE_ITEM = `      <a class="account-dropdown-item" href="/historical/index.html">Archive</a>`;

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
 * Builds the updated file, or reports why it can't.
 *
 * Every edit is validated before ANY is applied. A half-synced page - new
 * nav, old CSS - renders as a broken header with no error raised anywhere,
 * and across 3,615 files nobody would find it by looking.
 */
function sync(original, css, relPath) {
  const cssStart = original.indexOf(CSS_START);
  if (cssStart === -1) return { status: "error", detail: `${relPath}: no tab-bar CSS block` };
  if (original.indexOf(CSS_START, cssStart + 1) !== -1) {
    return { status: "error", detail: `${relPath}: tab-bar CSS block is not unique` };
  }
  const cssEnd = original.indexOf(CSS_END, cssStart);
  if (cssEnd === -1) return { status: "error", detail: `${relPath}: tab-bar CSS block has no end marker` };

  const navMatch = original.match(/<nav class="tab-bar"[\s\S]*?<\/nav>/);
  if (!navMatch) return { status: "error", detail: `${relPath}: no tab-bar nav` };

  const hasArchiveItem = original.includes(ARCHIVE_ITEM);
  if (!hasArchiveItem && !original.includes(MENU_ANCHOR)) {
    return { status: "error", detail: `${relPath}: no account dropdown to add Archive to` };
  }

  let out = original.slice(0, cssStart) + "\n" + css + original.slice(cssEnd + CSS_END.length);
  out = out.replace(navMatch[0], NAV_HTML);
  if (!hasArchiveItem) out = out.replace(MENU_ANCHOR, `${ARCHIVE_ITEM}\n${MENU_ANCHOR}`);

  return out === original ? { status: "current" } : { status: "synced", content: out };
}

async function main() {
  const css = await canonicalCss();
  const files = await listHtmlFiles(HISTORICAL_DIR);
  let synced = 0;
  let current = 0;
  const errors = [];

  for (const file of files) {
    const original = await readFile(file, "utf8");
    const result = sync(original, css, path.relative(ROOT, file));
    if (result.status === "error") {
      errors.push(result.detail);
      continue;
    }
    if (result.status === "current") {
      current++;
      continue;
    }
    await writeFile(file, result.content, "utf8");
    synced++;
  }

  console.log(`Archive nav sync: ${synced} updated, ${current} already current, ${errors.length} errors.`);
  for (const e of errors.slice(0, 20)) console.log("  " + e);
  if (errors.length > 20) console.log(`  ...and ${errors.length - 20} more`);
  if (errors.length) process.exitCode = 1;
}

main();

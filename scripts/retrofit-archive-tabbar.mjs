// One-off migration: injects the new tab-bar nav (badge-underline style,
// matching the live app's TabBar) + its CSS into every already-generated
// static archive page under historical/. Operates on the files directly -
// no ESPN/network calls - since only the header chrome changed, not any
// game data. Idempotent: skips files that already have .tab-bar CSS so
// it's safe to re-run.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const HISTORICAL_DIR = path.join(ROOT, "historical");

const TAB_BAR_CSS = `.tab-bar { display: flex; gap: 28px; margin: 18px 0 0; border-bottom: 1px solid var(--card-border); justify-content: center; }
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
}
</style>`;

const TAB_BAR_HTML = `  <nav class="tab-bar" aria-label="Primary">
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#127880;</span><span class="tab-label">Games</span></a>
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#128293;</span><span class="tab-label">Hot Picks</span></a>
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#127942;</span><span class="tab-label">League</span></a>
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#128240;</span><span class="tab-label">News</span></a>
    <a class="tab-btn active" href="/historical/index.html" aria-current="page"><span class="tab-icon" aria-hidden="true">&#128450;&#65039;</span><span class="tab-label">Archive</span></a>
  </nav>
</header>`;

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
  if (original.includes(".tab-bar {")) return "skipped"; // already retrofitted
  if (!original.includes("</style>") || !original.includes("</header>")) return "no-match";

  let updated = original.replace("</style>", TAB_BAR_CSS);
  updated = updated.replace("</header>", TAB_BAR_HTML);
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

main().catch((err) => {
  console.error("retrofit-archive-tabbar failed:", err);
  process.exit(1);
});

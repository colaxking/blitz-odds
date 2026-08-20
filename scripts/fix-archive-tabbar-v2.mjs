// Corrective pass over scripts/retrofit-archive-tabbar.mjs's original output.
// That first pass had two bugs, both fixed here by exact string replacement
// (no network calls, header/CSS only, same as the original retrofit):
//   1. Games used the wrong decimal HTML entity (&#127880; = 🎈 balloon)
//      instead of the football (&#x1F3C8; = 🏈) - rendered as a plain
//      reddish circle instead of a football.
//   2. Hot Picks/League/News all linked to "/" with no way to land on
//      that actual tab - clicking "News" from an archive page just
//      dropped you on Games. Now links to "/#picks" / "/#league" /
//      "/#news", matching the hash-based initial-tab support added to
//      index.html. League is also dropped to match LEAGUES_UI_ENABLED
//      being false in the live app right now (was showing unconditionally).
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const HISTORICAL_DIR = path.join(ROOT, "historical");

const OLD_NAV = `    <nav class="tab-bar" aria-label="Primary">
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#127880;</span><span class="tab-label">Games</span></a>
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#128293;</span><span class="tab-label">Hot Picks</span></a>
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#127942;</span><span class="tab-label">League</span></a>
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#128240;</span><span class="tab-label">News</span></a>
    <a class="tab-btn active" href="/historical/index.html" aria-current="page"><span class="tab-icon" aria-hidden="true">&#128450;&#65039;</span><span class="tab-label">Archive</span></a>
  </nav>`;

const NEW_NAV = `    <nav class="tab-bar" aria-label="Primary">
    <a class="tab-btn" href="/"><span class="tab-icon" aria-hidden="true">&#x1F3C8;</span><span class="tab-label">Games</span></a>
    <a class="tab-btn" href="/#picks"><span class="tab-icon" aria-hidden="true">&#x1F525;</span><span class="tab-label">Hot Picks</span></a>
    <a class="tab-btn" href="/#news"><span class="tab-icon" aria-hidden="true">&#x1F4F0;</span><span class="tab-label">News</span></a>
    <a class="tab-btn active" href="/historical/index.html" aria-current="page"><span class="tab-icon" aria-hidden="true">&#x1F5C2;&#xFE0F;</span><span class="tab-label">Archive</span></a>
  </nav>`;

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

async function fixFile(filePath) {
  const original = await readFile(filePath, "utf8");
  if (original.includes(NEW_NAV)) return "already-fixed";
  if (!original.includes(OLD_NAV)) return "no-match";
  const updated = original.replace(OLD_NAV, NEW_NAV);
  await writeFile(filePath, updated, "utf8");
  return "fixed";
}

async function main() {
  const files = await listHtmlFiles(HISTORICAL_DIR);
  let fixed = 0, already = 0, noMatch = 0;
  for (const file of files) {
    const result = await fixFile(file);
    if (result === "fixed") fixed++;
    else if (result === "already-fixed") already++;
    else { noMatch++; console.warn("no-match:", path.relative(ROOT, file)); }
  }
  console.log(`done. ${files.length} files scanned, ${fixed} fixed, ${already} already fixed, ${noMatch} did not match expected structure.`);
}

main().catch((err) => {
  console.error("fix-archive-tabbar-v2 failed:", err);
  process.exit(1);
});

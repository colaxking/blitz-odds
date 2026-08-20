// Corrective pass: the archive template's .tab-bar had justify-content:
// center baked in, which the live app's .tab-bar never had - so the
// archive nav rendered centered while every other page's nav sits left-
// aligned within the same max-width container. Strips that one property.
// No network calls, CSS-only, same approach as the prior retrofit passes.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const HISTORICAL_DIR = path.join(ROOT, "historical");

const OLD_RULE = `.tab-bar { display: flex; gap: 28px; margin: 18px 0 0; border-bottom: 1px solid var(--card-border); justify-content: center; }`;
const NEW_RULE = `.tab-bar { display: flex; gap: 28px; margin: 18px 0 0; border-bottom: 1px solid var(--card-border); }`;

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
  if (original.includes(NEW_RULE) && !original.includes(OLD_RULE)) return "already-fixed";
  if (!original.includes(OLD_RULE)) return "no-match";
  const updated = original.replace(OLD_RULE, NEW_RULE);
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
  console.error("fix-archive-tabbar-alignment failed:", err);
  process.exit(1);
});

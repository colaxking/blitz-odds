#!/usr/bin/env node
/**
 * build-app.mjs
 *
 * Compiles the app once, at build time, instead of in every visitor's
 * browser.
 *
 * Until October 2026 index.html carried the whole React app as ~1 MB of raw
 * JSX inside <script type="text/babel">, and every page load pulled down
 * babel-standalone (2.8 MB) to transpile it on the fly. On a desktop with a
 * fast connection that was ~4 s before React mounted; on a phone it was well
 * past 10 s, which put every URL in the "Poor" Core Web Vitals bucket and
 * gave Googlebot's renderer a workload it could not reliably finish. Because
 * build-static-pages.mjs stamps the full index.html into every one of the
 * ~4,000 prerendered pages, that cost was paid per page.
 *
 * Now:
 *   src/app.jsx  --(esbuild, JSX -> JS, minified)-->  js/app.js
 *   src/app.css  --(esbuild, minified)------------->  css/app.css
 *
 * and index.html references both by URL with a content hash in the query
 * string (`/js/app.js?v=<hash>`), so a changed bundle is always fetched and an
 * unchanged one is served from cache across every page on the site.
 *
 * The compiled js/app.js IS committed. The static-pages-refresh workflow runs
 * build-static-pages.mjs in GitHub Actions with no `npm install`, so it has no
 * esbuild - it just reuses the committed bundle, which is correct because the
 * app source and the bundle always land in the same commit. This script is
 * the one that has to run (directly, or via build-static-pages.mjs, which
 * calls it when esbuild is available) after any edit to src/app.jsx or
 * src/app.css.
 *
 * Why a plain transform and not a bundle: the app is a classic script. Its
 * top-level declarations are globals that the inline scripts in index.html
 * and the other /js/*.js files rely on, and React/ReactDOM come from the CDN
 * <script> tags in <head>. `--bundle` would wrap everything in a function
 * scope and break that; a transform keeps the file's shape and only rewrites
 * JSX (plus whatever syntax is newer than the target). esbuild does not
 * rename top-level symbols in a non-bundled script, so `--minify` is safe.
 *
 * Run: node scripts/build-app.mjs
 *      node scripts/build-app.mjs --check   (exit 1 if js/app.js is stale)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_JSX = path.join(REPO_ROOT, "src", "app.jsx");
const OUT_JS = path.join(REPO_ROOT, "js", "app.js");
const SRC_CSS = path.join(REPO_ROOT, "src", "app.css");
const OUT_CSS = path.join(REPO_ROOT, "css", "app.css");
const INDEX = path.join(REPO_ROOT, "index.html");

/** Short content hash, used as the cache-busting `?v=` on the asset URLs. */
function hashOf(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

/** The `<script defer src="/js/app.js?v=...">` and
 *  `<link rel="stylesheet" href="/css/app.css?v=...">` tags in index.html. */
// Global: the script tag at the end of <body> and the <link rel="preload">
// in <head> both carry the hash.
const JS_TAG = /(\/js\/app\.js\?v=)([^"]*)(")/g;
const CSS_TAG = /(\/css\/app\.css\?v=)([^"]*)(")/g;

export async function buildApp({ check = false, log = console.log } = {}) {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new Error("esbuild is not installed - run `npm install` first (it's a devDependency).");
  }

  const source = await readFile(SRC_JSX, "utf8");
  const result = await esbuild.transform(source, {
    loader: "jsx",
    jsx: "transform",          // React.createElement, same as the old Babel preset
    target: "es2020",
    minify: true,
    legalComments: "none",
    // index.html loads React 18 UMD from the CDN; the global is `React`.
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    sourcefile: "src/app.jsx",
  });
  for (const w of result.warnings) log(`esbuild warning: ${w.text}`);

  // The banner records a hash of the SOURCE it was built from, so a build
  // that can't run esbuild (CI, or a checkout without node_modules) can
  // still tell whether the committed artifact matches the committed source
  // instead of silently shipping a stale bundle - see assertArtifactsFresh().
  const banner = `/* Built from src/app.jsx (source sha256:${hashOf(source)}) by scripts/build-app.mjs - do not edit; edit the source and rebuild. */\n`;
  const js = banner + result.code;
  const cssSource = await readFile(SRC_CSS, "utf8");
  const cssResult = await esbuild.transform(cssSource, { loader: "css", minify: true, sourcefile: "src/app.css" });
  for (const w of cssResult.warnings) log(`esbuild css warning: ${w.text}`);
  const css = `/* Built from src/app.css (source sha256:${hashOf(cssSource)}) by scripts/build-app.mjs - do not edit; edit the source and rebuild. */\n` + cssResult.code;
  const jsHash = hashOf(js);
  const cssHash = hashOf(css);

  let index = await readFile(INDEX, "utf8");
  if (!index.match(JS_TAG)) throw new Error("index.html has no /js/app.js?v=... reference");
  if (!index.match(CSS_TAG)) throw new Error("index.html has no /css/app.css?v=... reference");
  const nextIndex = index
    .replace(JS_TAG, `$1${jsHash}$3`)
    .replace(CSS_TAG, `$1${cssHash}$3`);

  let existingJs = null;
  let existingCss = null;
  try { existingJs = await readFile(OUT_JS, "utf8"); } catch {}
  try { existingCss = await readFile(OUT_CSS, "utf8"); } catch {}
  const jsChanged = existingJs !== js;
  const cssChanged = existingCss !== css;
  const indexChanged = nextIndex !== index;

  if (check) {
    if (jsChanged || cssChanged || indexChanged) {
      log(`build-app --check: stale (${[jsChanged && "js/app.js", cssChanged && "css/app.css", indexChanged && "index.html hash tags"].filter(Boolean).join(", ")}). Run node scripts/build-app.mjs.`);
      return { stale: true, jsHash, cssHash };
    }
    log("build-app --check: up to date.");
    return { stale: false, jsHash, cssHash };
  }

  await mkdir(path.dirname(OUT_JS), { recursive: true });
  await mkdir(path.dirname(OUT_CSS), { recursive: true });
  if (jsChanged) await writeFile(OUT_JS, js, "utf8");
  if (cssChanged) await writeFile(OUT_CSS, css, "utf8");
  if (indexChanged) await writeFile(INDEX, nextIndex, "utf8");
  log(`build-app: js/app.js ${(js.length / 1024).toFixed(0)} KB (from ${(source.length / 1024).toFixed(0)} KB JSX) v=${jsHash}${jsChanged ? "" : " (unchanged)"}; css/app.css ${(css.length / 1024).toFixed(0)} KB (from ${(cssSource.length / 1024).toFixed(0)} KB) v=${cssHash}${cssChanged ? "" : " (unchanged)"}${indexChanged ? "; index.html tags updated" : ""}`);
  return { stale: false, jsHash, cssHash, jsChanged, cssChanged, indexChanged };
}

/** Without esbuild, verify the committed artifacts were built from the
 *  current sources by comparing the source hash each banner records. Throws
 *  with instructions when either is stale. */
export async function assertArtifactsFresh() {
  const pairs = [[SRC_JSX, OUT_JS, "src/app.jsx", "js/app.js"], [SRC_CSS, OUT_CSS, "src/app.css", "css/app.css"]];
  for (const [src, out, srcName, outName] of pairs) {
    let built;
    try { built = await readFile(out, "utf8"); } catch { throw new Error(`${outName} is missing. Run \`npm install && node scripts/build-app.mjs\`.`); }
    const m = /source sha256:([0-9a-f]+)/.exec(built.slice(0, 300));
    const current = hashOf(await readFile(src, "utf8"));
    if (!m || m[1] !== current) {
      throw new Error(`${outName} was not built from the current ${srcName} (and esbuild is not installed to rebuild it). Run \`npm install && node scripts/build-app.mjs\`.`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  buildApp({ check: process.argv.includes("--check") })
    .then((r) => process.exit(r.stale ? 1 : 0))
    .catch((err) => { console.error(err.message || err); process.exit(1); });
}

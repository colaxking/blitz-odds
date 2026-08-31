import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// IndexNow submitter. Tells Bing / Yandex / Naver / Seznam which pages
// changed, instead of waiting for them to re-crawl and notice.
//
// NOT GOOGLE. Google declined to join the IndexNow protocol and still runs
// on crawling + Search Console. Nothing here affects Google ranking or
// indexing speed at all - this is the ~5-10% of search traffic that comes
// from everyone else.
//
// WHY IT READS THE LIVE SITEMAP OVER HTTP. The obvious place for this is
// the end of scripts/build-static-pages.mjs, and that would be wrong. That
// script runs in GitHub Actions and commits; the resulting Netlify deploy
// then sits UNPUBLISHED until a human clicks publish. Bing fetches an
// IndexNow-submitted URL within minutes, so pinging at build time means
// Bing re-crawls and re-reads the OLD page - a submission spent to confirm
// no change, and no way to un-spend it.
//
// Fetching https://blitz-odds.com/sitemap.xml over the public internet
// makes that structurally impossible: the only lastmod dates this function
// can ever see are ones already served to the public. Manual publish stops
// being a thing to work around. It also means zero changes to
// build-static-pages.mjs, zero new commits, and therefore zero extra
// production deploys (see static-pages-refresh.yml's COST NOTE).
//
// WHY THE SITEMAP IS A VALID CHANGE MANIFEST. Because lastmod is honest
// now. build-static-pages.mjs only stamps today's date on a page whose
// bytes actually changed and carries the previous date forward otherwise
// (see updateSitemap there). Before that fix every URL restamped daily and
// this whole approach would have submitted 3,975 URLs every single day.
//
// The ~3,600 /historical/ URLs need no special handling for the same
// reason: they're `kept` lines the build script never restamps, so after
// the bootstrap seed they never resubmit.
//
// POST /.netlify/functions/indexnow-submit-background
// Header: x-indexnow-secret
// Body (all optional): { dryRun?, force? }
//   dryRun -> compute and log the diff, submit nothing, leave the blob alone
//   force  -> submit even URLs whose date matches the blob (recovery only)

const SITE_BASE = "https://blitz-odds.com";
const SITEMAP_URL = `${SITE_BASE}/sitemap.xml`;
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

const SITE_DATA_STORE = "blitz-site-data";
const SUBMITTED_KEY = "indexnow:submitted";

// Per-run ceiling. A normal week regenerates ~350 pages, so two runs drain
// a full week's worth. The cap is not about IndexNow's own limits (10,000
// URLs per request) - it's damage control for the case where an index.html
// template change restamps all 3,975 URLs at once. Dumping the entire site
// on Bing in one request looks like spam; bleeding it out over a day
// doesn't.
const MAX_URLS_PER_RUN = 200;

// A truncated, half-deployed, or error-page sitemap must not be read as
// "everything changed." The real file has ~3,975 URLs and only ever grows.
const MIN_PLAUSIBLE_URLS = 1000;

// robots.txt Disallows these. They aren't in the sitemap today, so this is
// belt-and-braces: a future sitemap change shouldn't be able to leak a
// per-user league URL or a notification alias into a search index.
const EXCLUDED_PREFIXES = ["/g/", "/join/", "/leagues/"];

type SubmittedMap = Record<string, string>;

function log(...args: unknown[]) {
  console.log("[indexnow-submit]", ...args);
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Matched as <url> BLOCKS, not as the single-line shape
// build-static-pages.mjs emits. The sitemap holds two entry formats: ~3,974
// generated one-liners, plus the hand-written homepage entry at the top,
// which spans several lines and carries changefreq/priority. A one-line
// regex parses 3,974 of 3,975 URLs and drops "/" - the single most
// important URL on the site - which is exactly the kind of miss that would
// never show up in a success log.
//
// lastmod is still required: a URL without one carries no change signal, so
// there's nothing to diff it against.
const URL_BLOCK = /<url>([\s\S]*?)<\/url>/g;
const LOC = /<loc>([^<]*)<\/loc>/;
const LASTMOD = /<lastmod>([^<]*)<\/lastmod>/;

function parseSitemap(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of xml.matchAll(URL_BLOCK)) {
    const inner = block[1];
    const loc = inner.match(LOC)?.[1].trim();
    const lastmod = inner.match(LASTMOD)?.[1].trim();
    if (!loc || !lastmod) continue;
    if (!loc.startsWith(SITE_BASE)) continue;
    const path = loc.slice(SITE_BASE.length);
    if (EXCLUDED_PREFIXES.some((p) => path.startsWith(p))) continue;
    out.set(loc, lastmod);
  }
  return out;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  // Re-checked here even though indexnow-submit.mts already checked it.
  // This is a usable error surface, not the security boundary - Netlify
  // answers a background function with 202 before this code runs, so the
  // caller never sees this status. See indexnow-submit.mts's header.
  const expectedSecret = process.env.INDEXNOW_SECRET;
  const provided = req.headers.get("x-indexnow-secret")?.trim();
  if (!expectedSecret || !provided || provided !== expectedSecret.trim()) {
    return jsonResponse(401, { ok: false, error: "Missing or invalid x-indexnow-secret header" });
  }

  const key = process.env.INDEXNOW_KEY;
  if (!key) return jsonResponse(500, { ok: false, error: "INDEXNOW_KEY is not set on this site" });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is the normal cron case */ }
  const dryRun = body.dryRun === true;
  const force = body.force === true;

  // 1. Read the sitemap as the public sees it.
  let xml: string;
  try {
    const res = await fetch(SITEMAP_URL, {
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) {
      log(`Sitemap fetch returned ${res.status} - aborting.`);
      return jsonResponse(502, { ok: false, error: `Sitemap fetch returned ${res.status}` });
    }
    xml = await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sitemap fetch failed";
    log(`Sitemap fetch failed: ${message}`);
    return jsonResponse(502, { ok: false, error: message });
  }

  const live = parseSitemap(xml);
  if (live.size < MIN_PLAUSIBLE_URLS) {
    // Bail rather than treat a bad parse as a site-wide change.
    log(`Sitemap parsed to only ${live.size} URLs (min ${MIN_PLAUSIBLE_URLS}) - aborting without submitting.`);
    return jsonResponse(500, {
      ok: false,
      error: `Sitemap parsed to only ${live.size} URLs - refusing to treat that as a change set`,
    });
  }

  // 2. Diff against what was last submitted. Strong consistency because
  // this is a read-modify-write: a stale read resubmits URLs already sent.
  const store = getStore(SITE_DATA_STORE, { consistency: "strong" });
  let submitted: SubmittedMap | null = null;
  try {
    submitted = (await store.get(SUBMITTED_KEY, { type: "json" })) as SubmittedMap | null;
  } catch {
    submitted = null;
  }

  // 3. Bootstrap. With no ledger there's no way to tell a changed page from
  // one that's been sitting there since 2025, and "submit all 3,975" is the
  // wrong guess. Record the current state and submit nothing; the next run
  // has a real baseline to diff against.
  if (!submitted) {
    const seed: SubmittedMap = Object.fromEntries(live);
    if (!dryRun) await store.setJSON(SUBMITTED_KEY, seed);
    log(`Bootstrap: seeded ${live.size} URLs, submitted none. Real diffs start next run.`);
    return jsonResponse(200, { ok: true, bootstrap: true, seeded: live.size, submitted: 0 });
  }

  const changed: Array<{ url: string; lastmod: string }> = [];
  for (const [url, lastmod] of live) {
    if (force || submitted[url] !== lastmod) changed.push({ url, lastmod });
  }

  if (!changed.length) {
    log("No changed URLs since last run.");
    return jsonResponse(200, { ok: true, changed: 0, submitted: 0 });
  }

  // Oldest first, so a URL that lost a cap race last run wins the next one
  // instead of starving behind fresher pages forever.
  changed.sort((a, b) => (a.lastmod < b.lastmod ? -1 : a.lastmod > b.lastmod ? 1 : 0));
  const batch = changed.slice(0, MAX_URLS_PER_RUN);

  log(`${changed.length} changed URL(s); submitting ${batch.length}${dryRun ? " (DRY RUN)" : ""}.`);
  if (dryRun) {
    return jsonResponse(200, {
      ok: true, dryRun: true, changed: changed.length,
      wouldSubmit: batch.length, sample: batch.slice(0, 10).map((e) => e.url),
    });
  }

  // 4. Submit. One request covers every participating engine.
  let status: number;
  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: "blitz-odds.com",
        key,
        keyLocation: `${SITE_BASE}/${key}.txt`,
        urlList: batch.map((e) => e.url),
      }),
    });
    status = res.status;
  } catch (err) {
    const message = err instanceof Error ? err.message : "IndexNow request failed";
    log(`Submit failed: ${message} - ledger untouched, next run retries.`);
    return jsonResponse(502, { ok: false, error: message });
  }

  // 200 = accepted. 202 = accepted, key validation still pending. Anything
  // else (403 bad key, 422 host mismatch, 429 throttled) must leave the
  // ledger alone so the next run retries these same URLs.
  if (status !== 200 && status !== 202) {
    log(`IndexNow returned ${status} - ledger untouched, next run retries.`);
    return jsonResponse(502, { ok: false, indexNowStatus: status, submitted: 0 });
  }

  // 5. Advance the ledger only for what was actually accepted. Prune URLs
  // that have dropped out of the sitemap in the same pass, so the blob
  // tracks the live site instead of growing forever.
  const next: SubmittedMap = {};
  for (const [url, lastmod] of live) next[url] = submitted[url] ?? lastmod;
  for (const entry of batch) next[entry.url] = entry.lastmod;
  await store.setJSON(SUBMITTED_KEY, next);

  const remaining = changed.length - batch.length;
  log(`Submitted ${batch.length} URL(s), IndexNow ${status}. ${remaining} queued for the next run.`);
  return jsonResponse(200, {
    ok: true, indexNowStatus: status,
    changed: changed.length, submitted: batch.length, remaining,
  });
};

export const config: Config = {
  path: "/.netlify/functions/indexnow-submit-background",
};

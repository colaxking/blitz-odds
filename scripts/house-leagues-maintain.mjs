/**
 * house-leagues-maintain.mjs
 *
 * Calls the house-leagues-maintain Netlify function, which seeds, recounts,
 * rolls over and closes the official public leagues. All the logic lives in
 * the function (it needs the blob store); this is just the scheduled caller,
 * so it exists mainly to turn a non-ok response into a failed Actions run
 * instead of a silent 200-shaped nothing.
 *
 * Env:
 *   HOUSE_LEAGUES_SECRET - shared secret, must match the function's
 *   SITE_BASE_URL        - optional, defaults to https://blitz-odds.com
 *   HOUSE_LEAGUES_DRY_RUN - "1" to report what would change without writing
 *
 * Unlike most jobs in this repo there's no git commit step: house leagues
 * live only in Netlify Blobs (the live source of truth for league data),
 * with no data/*.json mirror to keep in step.
 */

const SECRET = process.env.HOUSE_LEAGUES_SECRET;
const BASE_URL = process.env.SITE_BASE_URL || "https://blitz-odds.com";
const DRY_RUN = process.env.HOUSE_LEAGUES_DRY_RUN === "1";

if (!SECRET) {
  console.error("HOUSE_LEAGUES_SECRET is required");
  process.exit(1);
}

const url = `${BASE_URL}/.netlify/functions/house-leagues-maintain`;

async function main() {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-house-leagues-secret": SECRET,
    },
    body: JSON.stringify(DRY_RUN ? { dryRun: true } : {}),
  });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error(`Non-JSON response (HTTP ${res.status}):`, text.slice(0, 500));
    process.exit(1);
  }

  if (!res.ok || !payload.ok) {
    console.error(`House league maintenance failed (HTTP ${res.status}):`, payload.error || text);
    process.exit(1);
  }

  console.log(`Season ${payload.season}${payload.dryRun ? " (dry run)" : ""}, opener passed: ${payload.seasonStarted}`);
  if (!payload.actions.length) {
    console.log("No changes - all house leagues already in the right state.");
  } else {
    console.log(`${payload.changed} change(s):`);
    for (const a of payload.actions) console.log(`  - ${a}`);
  }
}

main().catch((err) => {
  console.error("House league maintenance threw:", err);
  process.exit(1);
});

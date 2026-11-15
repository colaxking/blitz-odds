import type { Context, Config } from "@netlify/functions";

// Same-origin proxy for ESPN's team depth-chart endpoint.
//
// In November 2026 ESPN stopped sending Access-Control-Allow-Origin on
// site.api.espn.com/.../teams/{slug}/depthcharts (the sibling /roster endpoint
// still sends it), so the browser blocks the direct fetch and the team page's
// Roster & Depth Chart tab went blank. This relays the request server-side.
//
// Only the 32 team slugs the app uses are accepted, so this can't be turned
// into a general-purpose open proxy.

const TEAM_SLUGS = new Set([
  "ari", "atl", "bal", "buf", "car", "chi", "cin", "cle",
  "dal", "den", "det", "gb", "hou", "ind", "jax", "kc",
  "lv", "lac", "lar", "mia", "min", "ne", "no", "nyg",
  "nyj", "phi", "pit", "sf", "sea", "tb", "ten", "wsh",
]);

const ESPN_HEADERS = {
  // ESPN rejects some server-IP requests without a familiar UA.
  "User-Agent": "curl/8.4.0",
  Accept: "application/json",
};

function json(status: number, body: string, cacheSeconds: number) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      // Depth charts change a few times a week at most; let the CDN absorb
      // repeat views of the same team.
      "Cache-Control": cacheSeconds > 0 ? "public, max-age=300" : "no-store",
      "Netlify-CDN-Cache-Control": cacheSeconds > 0 ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=3600` : "no-store",
    },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "GET") return json(405, JSON.stringify({ ok: false, error: "Method not allowed" }), 0);

  const team = (new URL(req.url).searchParams.get("team") || "").toLowerCase();
  if (!TEAM_SLUGS.has(team)) return json(400, JSON.stringify({ ok: false, error: "Unknown team" }), 0);

  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${team}/depthcharts`,
      { headers: ESPN_HEADERS },
    );
    if (!res.ok) return json(502, JSON.stringify({ ok: false, error: "ESPN responded " + res.status }), 0);
    return json(200, await res.text(), 900);
  } catch (err) {
    return json(502, JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "Upstream error" }), 0);
  }
};

export const config: Config = {
  path: "/.netlify/functions/espn-depthchart",
};

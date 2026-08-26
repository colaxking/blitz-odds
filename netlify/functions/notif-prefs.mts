import type { Context, Config } from "@netlify/functions";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import { getPrefs, setPrefs, isValidTimezone } from "./lib/notif.mts";
import { listDevices } from "./lib/push.mts";

// The signed-in read/write path for notification preferences. The signed-out
// path is unsubscribe.mts, which is HMAC-authenticated instead - a reader
// clicking Unsubscribe from their mail client isn't signed in and may never
// have been on that device.
//
// GET  /.netlify/functions/notif-prefs -> { ok, prefs }
// POST /.netlify/functions/notif-prefs
//   Body: { emailPickReminders?, emailWeeklyRecap?, timezone? } -> { ok, prefs }
//
// Timezone is written by the client on load rather than being chosen in the
// UI: the dispatcher needs to know when it's 7pm where the reader is, and
// Intl.DateTimeFormat().resolvedOptions().timeZone is the only reliable
// source for that. The Settings tab shows the detected value rather than
// asking, since almost nobody wants to pick a zone from a list.

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) {
    return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  }
  const userId = claims.id;

  try {
    if (req.method === "GET") {
      // The client needs the public VAPID key to call PushManager.subscribe,
      // and the device list to show what's already registered. Both belong
      // to the same screen, so they ride along rather than costing a second
      // round trip on every Settings open.
      //
      // The two reads touch different keys and neither depends on the
      // other, so they go out together - chaining them made the panel wait
      // for a full extra origin round trip for no reason.
      const [prefs, deviceRows] = await Promise.all([getPrefs(userId), listDevices(userId)]);
      const devices = deviceRows.map(({ id, device }) => ({
        id,
        platform: device.platform,
        label: device.label || null,
        createdAt: device.createdAt,
      }));
      return jsonResponse(200, {
        ok: true,
        prefs,
        devices,
        vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
      }, CORS_HEADERS);
    }

    if (req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { ok: false, error: "Invalid JSON body" }, CORS_HEADERS);
      }

      // A bad timezone is rejected loudly here rather than silently dropped,
      // so a client bug surfaces at the write instead of quietly stranding
      // someone in the wrong send window forever.
      if (body.timezone !== undefined && !isValidTimezone(String(body.timezone))) {
        return jsonResponse(400, { ok: false, error: "Unrecognized timezone" }, CORS_HEADERS);
      }

      const prefs = await setPrefs(userId, {
        emailPickReminders: body.emailPickReminders,
        emailWeeklyRecap: body.emailWeeklyRecap,
        emailRecapTeamNews: body.emailRecapTeamNews,
        timezone: body.timezone,
        push: body.push,
      });
      return jsonResponse(200, { ok: true, prefs }, CORS_HEADERS);
    }

    return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/notif-prefs",
};

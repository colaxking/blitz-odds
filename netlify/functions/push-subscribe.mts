import type { Context, Config } from "@netlify/functions";
import { getAuthenticatedUser, jsonResponse, CORS_HEADERS_BASE } from "./lib/auth.mts";
import {
  deviceIdFor, saveDevice, deleteDevice, listDevices, sendPush, vapidConfigured,
  type PushDevice,
} from "./lib/push.mts";

// Registers, removes, and test-fires a push device for the signed-in user.
//
// POST   /.netlify/functions/push-subscribe
//   { action: "subscribe", subscription: {endpoint, keys:{p256dh, auth}}, label? }
//   { action: "unsubscribe", endpoint }            - or { deviceId }
//   { action: "test" }                             - fires a real push to every
//                                                    device on the account
//   -> { ok, deviceId?, devices?, result? }
//
// Auth is required for all of it: a device row is meaningless without a user
// to attach it to, and an unauthenticated "test" would be an open relay for
// pushing arbitrary notifications at anyone whose endpoint you could guess.
//
// The subscription object is passed through from PushManager.subscribe()
// almost verbatim, which is deliberate - it's the browser's own shape, and
// re-modelling it here would only create a translation layer to get wrong.
// It's stored inside a `web` sub-object rather than at the top level so the
// same row can hold an APNs/FCM token later without a migration.

const CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS_BASE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function validSubscription(sub: any): boolean {
  return !!(
    sub &&
    typeof sub.endpoint === "string" &&
    /^https:\/\//.test(sub.endpoint) &&
    sub.endpoint.length < 2048 &&
    sub.keys &&
    typeof sub.keys.p256dh === "string" &&
    typeof sub.keys.auth === "string"
  );
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" }, CORS_HEADERS);

  const claims = await getAuthenticatedUser(req);
  if (!claims || !claims.id) {
    return jsonResponse(401, { ok: false, error: "Unauthorized - sign in required" }, CORS_HEADERS);
  }
  const userId = claims.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" }, CORS_HEADERS);
  }

  try {
    if (body.action === "subscribe") {
      if (!validSubscription(body.subscription)) {
        return jsonResponse(400, { ok: false, error: "Malformed push subscription" }, CORS_HEADERS);
      }
      const endpoint: string = body.subscription.endpoint;
      const deviceId = await deviceIdFor(endpoint);

      // Keyed on the endpoint hash, so a browser that silently rotates its
      // subscription and re-registers overwrites its own row rather than
      // leaving a dead one behind to be pushed at until it 410s.
      const existing = (await listDevices(userId)).find((d) => d.id === deviceId);
      const device: PushDevice = {
        platform: "web",
        web: { endpoint, keys: { p256dh: body.subscription.keys.p256dh, auth: body.subscription.keys.auth } },
        ua: String(req.headers.get("user-agent") || "").slice(0, 200),
        label: typeof body.label === "string" ? body.label.slice(0, 60) : existing?.device.label,
        createdAt: existing?.device.createdAt || new Date().toISOString(),
        failCount: 0,
      };
      await saveDevice(userId, deviceId, device);
      return jsonResponse(200, { ok: true, deviceId }, CORS_HEADERS);
    }

    if (body.action === "unsubscribe") {
      const deviceId = body.deviceId
        ? String(body.deviceId)
        : typeof body.endpoint === "string"
          ? await deviceIdFor(body.endpoint)
          : null;
      if (!deviceId) return jsonResponse(400, { ok: false, error: "endpoint or deviceId required" }, CORS_HEADERS);
      await deleteDevice(userId, deviceId);
      return jsonResponse(200, { ok: true, deviceId }, CORS_HEADERS);
    }

    if (body.action === "test") {
      if (!vapidConfigured()) {
        return jsonResponse(500, {
          ok: false,
          error: "Push isn't configured on this site yet - VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are missing.",
        }, CORS_HEADERS);
      }
      const result = await sendPush(userId, {
        title: "Blitz Odds alerts are on",
        body: "That's what an alert looks like. You can change what you get in Settings.",
        url: "/",
        collapseKey: "test",
        data: { kind: "test" },
      });
      if (result.noDevices) {
        return jsonResponse(400, { ok: false, error: "No devices registered for this account." }, CORS_HEADERS);
      }
      return jsonResponse(200, { ok: true, result }, CORS_HEADERS);
    }

    return jsonResponse(400, { ok: false, error: "Unknown action" }, CORS_HEADERS);
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" }, CORS_HEADERS);
  }
};

export const config: Config = {
  path: "/.netlify/functions/push-subscribe",
};

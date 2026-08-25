import webpush from "web-push";
import { notifStore } from "./notif.mts";
import { SITE_URL } from "./email-shell.mts";

// Everything that decides *how* a notification physically reaches a device.
// Nothing above this file knows the difference between a browser push
// subscription and a native device token, and that separation is the point:
// when there's an iOS or Android app, this gains an adapter and no dispatcher
// changes at all.
//
// Storage (blitz-notif store):
//   push:{userId}:{deviceId} -> PushDevice
//
// deviceId is a hash of the endpoint (web) or the token (native), so a device
// that re-subscribes - which browsers do on their own schedule - replaces its
// own row instead of accumulating duplicates that all deliver to the same
// phone.

export type PushPlatform = "web" | "ios" | "android";

export interface PushDevice {
  platform: PushPlatform;
  /** Web push only: the endpoint plus the two client keys from PushManager. */
  web?: { endpoint: string; keys: { p256dh: string; auth: string } };
  /** Native only: the opaque APNs/FCM device token. */
  token?: string;
  ua?: string;
  label?: string;
  createdAt: string;
  lastOkAt?: string;
  failCount?: number;
}

/**
 * The message, in terms every platform can express. Deliberately not the
 * shape of any one transport's API.
 *
 * `collapseKey` is the important one. Web calls it `tag`, FCM calls it
 * `collapse_key`, APNs calls it `apns-collapse-id` - all the same idea, that
 * a newer message for the same subject should REPLACE the one already on the
 * lock screen rather than stack under it. Scoring alerts are unusable
 * without it: six score changes in one game would otherwise be six
 * notifications. Naming it once, here, is what stops every payload from
 * having to be rewritten when a native adapter lands.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap goes. Always a path, never a hash - see claude_url-scheme.md. */
  url: string;
  collapseKey?: string;
  data?: Record<string, unknown>;
}

export interface SendResult {
  sent: number;
  failed: number;
  pruned: number;
  noDevices: boolean;
}

export function deviceKey(userId: string, deviceId: string): string {
  return `push:${userId}:${deviceId}`;
}

/** Stable per-device id. sha256 over the endpoint/token, truncated - long
 *  enough that a collision isn't a practical concern, short enough to keep
 *  the blob key readable. */
export async function deviceIdFor(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function listDevices(userId: string): Promise<Array<{ id: string; device: PushDevice }>> {
  const store = notifStore();
  const out: Array<{ id: string; device: PushDevice }> = [];
  const prefix = `push:${userId}:`;
  for await (const page of store.list({ prefix, paginate: true })) {
    for (const blob of page.blobs) {
      try {
        const device = (await store.get(blob.key, { type: "json" })) as PushDevice | null;
        if (device) out.push({ id: blob.key.slice(prefix.length), device });
      } catch {
        // One unreadable row shouldn't cost the user every other device.
      }
    }
  }
  return out;
}

export async function saveDevice(userId: string, deviceId: string, device: PushDevice): Promise<void> {
  await notifStore().setJSON(deviceKey(userId, deviceId), device);
}

export async function deleteDevice(userId: string, deviceId: string): Promise<void> {
  await notifStore().delete(deviceKey(userId, deviceId));
}

function vapidConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function configureVapid(): void {
  if (!vapidConfigured()) throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not configured on this site");
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || SITE_URL,
    process.env.VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string
  );
}

/** 404 and 410 are the push service saying the subscription is dead - the
 *  user cleared site data, uninstalled, or the browser rotated it. That's not
 *  a transient failure to retry; the row should go. Anything else (a 5xx, a
 *  timeout) is worth keeping and counting. */
function isGone(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

async function sendWeb(userId: string, id: string, device: PushDevice, payload: PushPayload): Promise<"ok" | "gone" | "failed"> {
  if (!device.web?.endpoint) return "failed";
  try {
    await webpush.sendNotification(
      { endpoint: device.web.endpoint, keys: device.web.keys },
      JSON.stringify(payload),
      { TTL: 60 * 60, urgency: "normal", topic: undefined }
    );
    await saveDevice(userId, id, { ...device, lastOkAt: new Date().toISOString(), failCount: 0 });
    return "ok";
  } catch (err: any) {
    if (isGone(err?.statusCode)) return "gone";
    const failCount = (device.failCount || 0) + 1;
    try {
      await saveDevice(userId, id, { ...device, failCount });
    } catch { /* best effort */ }
    // A device that has failed this many times in a row isn't coming back,
    // and each attempt costs a request on every tick it's due for one.
    return failCount >= 10 ? "gone" : "failed";
  }
}

/**
 * The only function a dispatcher should call. Loads the user's devices,
 * routes each to its platform's adapter, prunes the dead ones.
 *
 * Never throws for a delivery failure - one unreachable phone must not take
 * down a batch that's mid-way through a few hundred users. Missing VAPID
 * config does throw, because that's a deployment problem the caller should
 * surface loudly rather than quietly deliver nothing.
 */
export async function sendPush(userId: string, payload: PushPayload): Promise<SendResult> {
  const devices = await listDevices(userId);
  if (!devices.length) return { sent: 0, failed: 0, pruned: 0, noDevices: true };

  configureVapid();
  const result: SendResult = { sent: 0, failed: 0, pruned: 0, noDevices: false };

  for (const { id, device } of devices) {
    let outcome: "ok" | "gone" | "failed";
    switch (device.platform) {
      case "web":
        outcome = await sendWeb(userId, id, device, payload);
        break;
      // ios / android land here when there's an app. Adding them is a case
      // and an adapter - no dispatcher, no payload, and no storage change.
      default:
        outcome = "failed";
        break;
    }

    if (outcome === "ok") result.sent++;
    else if (outcome === "gone") {
      result.pruned++;
      try { await deleteDevice(userId, id); } catch { /* best effort */ }
    } else result.failed++;
  }

  return result;
}

export { vapidConfigured };

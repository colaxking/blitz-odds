import type { Context, Config } from "@netlify/functions";
import { requireAdmin, adminJson, forbidden, ADMIN_CORS } from "./lib/admin.mts";
import { readAlertLog } from "./lib/alertlog.mts";
import { listDevices } from "./lib/push.mts";
import { getPrefs } from "./lib/notif.mts";

// GET /.netlify/functions/admin-alertlog?limit=50[&userId=][&source=][&type=]
//   -> { ok, entries }
//
// GET /.netlify/functions/admin-alertlog?userId=...&devices=1
//   -> { ok, entries, devices, prefs }
//
// Answers "why didn't that alert arrive?" without replaying a dispatch pass.
// The three facts that question always needs are the delivery outcomes, the
// reader's preferences, and whether they have a registered device at all -
// so with a userId all three come back together rather than costing three
// admin round trips and a guess about which to check first.
//
// Read-only, like admin-log.mts. There is no delete verb: the log prunes
// itself on a fixed retention rule (see lib/alertlog.mts), and an operator
// who can quietly drop rows can't answer the question the log exists for.

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: ADMIN_CORS });
  if (req.method !== "GET") return adminJson(405, { ok: false, error: "Method not allowed" });

  const actor = await requireAdmin(req);
  if (!actor) return forbidden();

  try {
    const params = new URL(req.url).searchParams;
    const raw = Number(params.get("limit"));
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 50;
    const userId = (params.get("userId") || "").trim();
    const source = (params.get("source") || "").trim();
    const type = (params.get("type") || "").trim();

    const entries = await readAlertLog({
      limit,
      userId: userId || undefined,
      source: source || undefined,
      type: type || undefined,
    });

    if (!userId || params.get("devices") === "0") {
      return adminJson(200, { ok: true, entries });
    }

    // Settled individually: a reader whose prefs blob is unreadable should
    // still get their device list back, and vice versa. Either one alone
    // often answers the question.
    const [deviceRows, prefs] = await Promise.all([
      listDevices(userId).catch(() => []),
      getPrefs(userId).catch(() => null),
    ]);

    return adminJson(200, {
      ok: true,
      entries,
      devices: deviceRows.map(({ id, device }) => ({
        id,
        platform: device.platform,
        label: device.label || null,
        createdAt: device.createdAt,
        lastOkAt: device.lastOkAt || null,
        failCount: device.failCount || 0,
      })),
      prefs,
      // Said plainly rather than left to be inferred from an empty array:
      // no devices is the single most common reason a push never lands, and
      // it looks identical to "nothing has happened yet" otherwise.
      noDevices: deviceRows.length === 0,
    });
  } catch (err) {
    return adminJson(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/admin-alertlog",
};

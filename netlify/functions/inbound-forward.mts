import type { Context, Config } from "@netlify/functions";

// Forwards inbound email received by Resend to a real mailbox.
//
// Resend has no "forward to address X" setting - Inbound is webhook-only.
// It receives mail for the domain, parses it, stores it, and POSTs an
// `email.received` event here. This function turns that event back into a
// normal outbound send addressed to FORWARD_TO.
//
// POST /.netlify/functions/inbound-forward   (called by Resend, not the app)
// Body: svix-signed webhook payload -> { ok: true, forwarded?: string }
//
// Required env vars (Netlify site settings -> Environment variables, NOT
// secret-flagged - the secret flag blocks runtime access, same as the other
// job secrets in this project):
//   RESEND_API_KEY          - needs Full Access: the receiving endpoints are
//                             not covered by a sending-only key
//   RESEND_WEBHOOK_SECRET   - "whsec_..." from the webhook's detail page
//   INBOUND_FORWARD_TO      - the mailbox to forward to
//
// Wiring, once deployed: Resend dashboard -> Webhooks -> Add Webhook ->
// https://blitz-odds.com/.netlify/functions/inbound-forward, event
// `email.received`, then copy the signing secret into RESEND_WEBHOOK_SECRET.
//
// Inbound is on the root domain (blitz-odds.com), not a subdomain. Resend
// recommends a subdomain because enabling inbound routes ALL mail for the
// domain to Resend, so the domain can't also host a normal mailbox. That's
// a deliberate trade here: it keeps the published contact address
// support@blitz-odds.com rather than support@inbound.blitz-odds.com, which
// reads badly on a privacy policy. The cost is that adding Google Workspace
// (or any other mailbox provider) on blitz-odds.com later would mean
// reworking the MX record and this setup.

const RESEND_API = "https://api.resend.com";
// Must be on a verified sending domain. We cannot send *as* the original
// sender - that would fail SPF/DMARC for their domain - so the original
// address goes in reply_to instead and the body carries a header line.
const FROM_EMAIL = "Blitz Odds <invites@blitz-odds.com>";
// Any inbound message from one of these is dropped rather than forwarded.
// Without this, a forward that ends up back at an address Resend receives
// for re-triggers the webhook and the two bounce off each other forever.
const LOOP_GUARD_DOMAINS = ["blitz-odds.com"];
// Svix rejects timestamps outside a tolerance window to blunt replay
// attacks. Five minutes is Svix's own default.
const TIMESTAMP_TOLERANCE_SEC = 5 * 60;
// Resend's send endpoint caps total request size. Attachments are inlined as
// base64 (~33% overhead), so anything near the cap is dropped from the
// forward and named in the body instead - better than the whole forward
// failing and the mail silently going nowhere.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Verifies a Svix-signed webhook (the scheme Resend uses).
 *
 * Signed content is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256'd with the
 * base64 secret that follows the "whsec_" prefix. The svix-signature header
 * can carry several space-separated `v1,<sig>` entries during a secret
 * rotation, so any match counts.
 *
 * The raw request text must be used, never a re-serialized JSON object:
 * re-stringifying changes key order and whitespace and the signature no
 * longer matches.
 */
async function verifySignature(
  rawBody: string,
  headers: Headers,
  secret: string
): Promise<boolean> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatureHeader = headers.get("svix-signature");
  if (!id || !timestamp || !signatureHeader) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > TIMESTAMP_TOLERANCE_SEC) return false;

  const secretBytes = Uint8Array.from(
    atob(secret.startsWith("whsec_") ? secret.slice(6) : secret),
    (c) => c.charCodeAt(0)
  );

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  const expected = base64FromBytes(mac);

  for (const part of signatureHeader.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    // Length check first so the comparison below only ever runs on equal
    // lengths; the loop itself is constant-time over that length.
    if (value.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < value.length; i++) diff |= value.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff === 0) return true;
  }
  return false;
}

async function resendGet(path: string, apiKey: string) {
  const res = await fetch(`${RESEND_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Resend GET ${path} returned ${res.status}`);
  return res.json() as Promise<any>;
}

function addressOf(value: unknown): string {
  // Addresses arrive either bare ("a@b.com") or display-name wrapped
  // ("Name <a@b.com>"), depending on how the sender formatted the header.
  const raw = typeof value === "string" ? value : "";
  const angle = raw.match(/<([^>]+)>/);
  return (angle ? angle[1] : raw).trim().toLowerCase();
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const apiKey = process.env.RESEND_API_KEY;
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  const forwardTo = process.env.INBOUND_FORWARD_TO;
  if (!apiKey || !webhookSecret || !forwardTo) {
    // 500 rather than a quiet 200: a misconfigured forwarder should show up
    // as failed deliveries in Resend's webhook log, not look healthy while
    // dropping every message.
    return json(500, {
      ok: false,
      error: "RESEND_API_KEY, RESEND_WEBHOOK_SECRET and INBOUND_FORWARD_TO must all be set",
    });
  }

  const rawBody = await req.text();
  if (!(await verifySignature(rawBody, req.headers, webhookSecret))) {
    return json(401, { ok: false, error: "Invalid webhook signature" });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  // 200, not 4xx: other event types are legitimate deliveries this endpoint
  // simply doesn't handle, and a non-2xx would make Resend retry them.
  if (event?.type !== "email.received") return json(200, { ok: true, skipped: event?.type || "unknown" });

  const emailId = event?.data?.email_id;
  if (!emailId) return json(200, { ok: true, skipped: "no email_id" });

  try {
    // The webhook payload is metadata only - body, headers and attachment
    // content all have to be fetched. Deliberate on Resend's part, so large
    // attachments don't blow past serverless request-size limits.
    const email = await resendGet(`/emails/receiving/${emailId}`, apiKey);

    const sender = addressOf(email?.from);
    const senderDomain = sender.split("@")[1] || "";
    if (LOOP_GUARD_DOMAINS.includes(senderDomain)) {
      return json(200, { ok: true, skipped: "loop guard - sender is one of our own domains" });
    }
    if (sender === addressOf(forwardTo)) {
      return json(200, { ok: true, skipped: "loop guard - sender is the forward target" });
    }

    const attachments: { filename: string; content: string }[] = [];
    const skippedAttachments: string[] = [];
    if (Array.isArray(email?.attachments) && email.attachments.length) {
      const list = await resendGet(`/emails/receiving/${emailId}/attachments`, apiKey);
      for (const att of list?.data || []) {
        if (!att?.download_url || !att?.filename) continue;
        if (typeof att.size === "number" && att.size > MAX_ATTACHMENT_BYTES) {
          skippedAttachments.push(att.filename);
          continue;
        }
        const res = await fetch(att.download_url);
        if (!res.ok) {
          skippedAttachments.push(att.filename);
          continue;
        }
        attachments.push({
          filename: att.filename,
          content: base64FromBytes(new Uint8Array(await res.arrayBuffer())),
        });
      }
    }

    // Who the message was actually addressed to. A single inbound domain can
    // take mail for support@, hello@, whatever - and once forwarded they all
    // land in one mailbox, so the original recipient has to be stated or it
    // is lost.
    const originalTo = Array.isArray(email?.to) ? email.to.join(", ") : String(email?.to || "");
    const noteLines = [`From: ${email?.from || "(unknown)"}`, `To: ${originalTo}`];
    if (skippedAttachments.length) {
      noteLines.push(`Attachments not forwarded (too large): ${skippedAttachments.join(", ")}`);
    }

    const headerHtml =
      `<div style="font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
      `color:#5b6b80;border-bottom:1px solid #c3cedd;padding-bottom:8px;margin-bottom:14px;">` +
      noteLines.map((l) => escapeHtml(l)).join("<br />") +
      `</div>`;

    // A plain-text-only message (phones, plain-text clients, most automated
    // senders) arrives with html === null and the content in text. Mail
    // clients render the HTML part whenever both are present, so putting a
    // placeholder here and the real content in the text part means the
    // recipient sees an apparently empty email. Promote the text into HTML
    // instead - pre-wrap keeps the original line breaks without needing the
    // text converted to markup.
    let bodyHtml: string;
    if (email?.html) {
      bodyHtml = email.html;
    } else if (email?.text) {
      bodyHtml =
        `<div style="white-space:pre-wrap;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
        escapeHtml(email.text) +
        `</div>`;
    } else {
      // Genuinely empty - the sender's whole message may be in an attachment.
      bodyHtml = `<p style="color:#5b6b80;">(This message had no text body.)</p>`;
    }

    const sendRes = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [forwardTo],
        // Replying goes to whoever actually wrote in, not back into the
        // inbound domain - which would re-trigger this webhook.
        reply_to: email?.from || undefined,
        subject: email?.subject || "(no subject)",
        html: headerHtml + bodyHtml,
        text: `${noteLines.join("\n")}\n\n${email?.text || email?.html || "(This message had no text body.)"}`,
        ...(attachments.length ? { attachments } : {}),
      }),
    });

    if (!sendRes.ok) {
      let detail = "";
      try {
        detail = ((await sendRes.json()) as any)?.message || "";
      } catch {
        // fall through to the status-code message
      }
      throw new Error(detail || `Resend send returned ${sendRes.status}`);
    }

    return json(200, { ok: true, forwarded: forwardTo });
  } catch (err) {
    // Non-2xx makes Resend retry, which is what we want for a transient
    // failure - the mail is still stored on their side either way.
    return json(500, { ok: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
};

export const config: Config = {
  path: "/.netlify/functions/inbound-forward",
};

// The one place the Blitz Odds transactional-email look lives. Extracted
// verbatim from league-invite.mts's buildInviteEmail so that function's
// output is byte-identical after adopting this - every new email type
// (pick reminder, weekly recap) is built from these same pieces rather than
// a fresh copy that drifts.
//
// Email HTML constraints baked in here, so callers don't have to remember:
//   - Table layout + fully inline styles. No <style> block, no classes:
//     Gmail strips <head>, and Outlook's Word renderer ignores most of what
//     survives.
//   - Raster PNG only for images. Outlook desktop doesn't render SVG in
//     HTML email at all, which is why branding/*-email.png exist alongside
//     the site's .svg wordmarks.
//   - Absolute https:// URLs everywhere. There is no document base.
//   - Every image carries alt text that reads sensibly with images blocked,
//     since Outlook blocks by default.
//
// Colors are the invite's existing palette. They are deliberately NOT the
// app's CSS custom properties: the app themes light/dark at runtime, an
// email can't, and this shell is always the light treatment with a dark
// header bar. Win/loss colors are the only addition (the invite has no
// pass/fail state to color); they're the light-theme --win/--out/--warn/
// --blitz-orange values from index.html, already tuned for AA on white.

export const EMAIL_COLORS = {
  shellBg: "#ffffff",
  shellBorder: "#e5e9ef",
  headerBg: "#0a1420",
  teal: "#02a4a4",
  heading: "#111111",
  body: "#333333",
  muted: "#57606a",
  foot: "#8b949e",
  fine: "#b1bac4",
  panelBg: "#f6f8fa",
  panelBorder: "#d8dee4",
  win: "#1f9d54",
  out: "#d33a3a",
  warn: "#b5720a",
  orange: "#b35900",
  tealTint: "#e6f5f4",
  outTint: "#fdeeec",
} as const;

export const EMAIL_FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
export const EMAIL_MONO = `ui-monospace,SFMono-Regular,Menlo,monospace`;
/* The canonical production origin. Use this for anything that has to keep
   working long after the deploy that produced it is gone: image sources,
   the visible "blitz-odds.com" in body copy, the VAPID subject. An email
   sits in an inbox for months, so a branch-deploy URL baked into an <img>
   would render as a broken image the moment that deploy is deleted. */
export const SITE_URL = "https://blitz-odds.com";

/* The origin of the deploy that is actually running. Use this for every
   link or redirect that sends someone back INTO the app - verify, reset,
   unsubscribe, league invites, "make my picks".

   Netlify sets DEPLOY_PRIME_URL to the branch or preview address on a
   non-production deploy, and to the primary domain on production, so this
   resolves to SITE_URL in production and to the preview origin on a branch.
   Without it, a signup on a preview deploy mails a verification link that
   runs the PRODUCTION function and lands on production - the preview
   account never gets confirmed on the deploy being tested, which makes the
   whole auth flow impossible to check before merging.

   Falls back through URL (set on production even when DEPLOY_PRIME_URL is
   not, e.g. under some CLI contexts) to the canonical origin, so a missing
   env var degrades to today's behaviour rather than to a broken link. */
export const APP_URL = (
  process.env.DEPLOY_PRIME_URL ||
  process.env.URL ||
  SITE_URL
).replace(/\/+$/, "");

/**
 * Sender's physical mailing address, printed in every footer.
 *
 * CAN-SPAM (15 U.S.C. 7704(a)(5)) requires a valid physical postal address
 * on commercial email - here, the pick reminder and the weekly recap, i.e.
 * anything `emailShell` is given an `unsubType` for. A PO box or a
 * registered agent's address both satisfy it; a bare domain does not.
 *
 * STILL UNDECIDED, so this is empty and the footer simply omits the line
 * rather than shipping a placeholder into somebody's inbox. Filling this
 * one string in is the entire remaining change - `emailShell` starts
 * rendering it everywhere the moment it's non-empty, and the warning it
 * logs on every commercial send goes quiet.
 *
 * Format it as a single line, comma-separated:
 *   "Blitz Odds, PO Box 1234, Springfield, IL 62701"
 */
export const MAILING_ADDRESS = "";

const C = EMAIL_COLORS;

// Cropped/downscaled copy of the site's dark-background wordmark
// (branding/blitz-odds-wordmark-dark.svg), sized for an email header - see
// branding/README.txt for the original artwork.
export const WORDMARK_URL = `${SITE_URL}/branding/blitz-odds-wordmark-dark-email.png`;

export const FORMAT_LABELS: Record<string, string> = {
  straight_up: "Straight-Up",
  confidence: "Confidence",
  survivor: "Survivor",
  ats: "Against The Spread (ATS)",
};

// Icon+wordmark lockup per format (branding/format-badge-*.png). ~420px
// wide source, shown at 84px in the email.
export const FORMAT_BADGE_URLS: Record<string, string> = {
  straight_up: `${SITE_URL}/branding/format-badge-straight-up.png`,
  confidence: `${SITE_URL}/branding/format-badge-confidence.png`,
  survivor: `${SITE_URL}/branding/format-badge-survivor.png`,
  ats: `${SITE_URL}/branding/format-badge-ats.png`,
};

export function escapeHtml(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

/** Team crest, same /team-badges/{ABBR}.png the app renders from. */
export function teamBadgeUrl(abbr: string): string {
  return `${SITE_URL}/team-badges/${String(abbr || "").toUpperCase()}.png`;
}

/** The dark header bar. Unchanged from league-invite.mts. */
export function emailHeader(): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:24px;background:${C.headerBg};border-radius:12px 12px 0 0;">
          <img src="${WORDMARK_URL}" width="200" alt="Blitz Odds" style="display:block;max-width:200px;height:auto;">
        </td>
      </tr>
    </table>`;
}

export interface FooterOptions {
  /** Plain-language "you're getting this because ..." line. */
  reason: string;
  /**
   * Unsubscribe scope. "reminders" and "weekly" turn off just that email;
   * "all" turns off everything. Omit entirely for a transactional email
   * that has no unsubscribe (a league invite is solicited by a human, not
   * a subscription).
   */
  unsubType?: "reminders" | "weekly" | "all";
  /** Signed unsubscribe URL from lib/notif.mts. Required if unsubType set. */
  unsubUrl?: string;
}

/**
 * Wraps body HTML in the 480px card. `preheader` is the hidden line inboxes
 * show next to the subject - if it's omitted the client scrapes the first
 * visible text instead, which for these emails is a date or an eyebrow and
 * reads as noise.
 */
export function emailShell(bodyHtml: string, footer: FooterOptions, preheader?: string): string {
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#ffffff;">${escapeHtml(preheader)}</div>`
    : "";

  // A commercial send with no address configured is the compliance gap, so
  // it gets a log line at the moment it happens. Transactional mail (no
  // unsubType) is exempt from the requirement and stays quiet.
  if (footer.unsubType && !MAILING_ADDRESS) {
    console.warn(
      "[email-shell] commercial email sent with no MAILING_ADDRESS - CAN-SPAM requires a physical postal address",
      { unsubType: footer.unsubType }
    );
  }

  // Printed on every email, not just the commercial ones: it identifies the
  // sender, it costs one line, and the "primary purpose" test that decides
  // which mail is commercial is fuzzy enough that opting out of the
  // distinction is safer than getting it wrong per-email-type.
  const addressHtml = MAILING_ADDRESS
    ? `
        <p style="margin:8px 0 0;font-size:11px;line-height:1.6;color:${C.fine};">
          ${escapeHtml(MAILING_ADDRESS)}
        </p>`
    : "";

  const unsubHtml = footer.unsubType && footer.unsubUrl
    ? `
        <p style="margin:8px 0 0;font-size:11px;line-height:1.6;color:${C.fine};">
          <a href="${APP_URL}/?settings=notifications" style="color:${C.muted};text-decoration:underline;">Manage notifications</a>
          &middot;
          <a href="${escapeHtml(footer.unsubUrl)}" style="color:${C.muted};text-decoration:underline;">Unsubscribe</a>
          &middot;
          <a href="${SITE_URL}" style="color:${C.muted};text-decoration:underline;">blitz-odds.com</a>
        </p>`
    : "";

  return `
    ${preheaderHtml}
    <div style="max-width:480px;margin:0 auto;background:${C.shellBg};border:1px solid ${C.shellBorder};border-radius:12px;overflow:hidden;">
      ${emailHeader()}
      <div style="font-family:${EMAIL_FONT};padding:28px 24px;">
        ${bodyHtml}
        <p style="margin:24px 0 0;padding-top:18px;border-top:1px solid ${C.panelBorder};font-size:12px;color:${C.foot};">
          Blitz Odds - free NFL pick'em confidence tool and odds analyzer.
        </p>
        <p style="margin:8px 0 0;font-size:11px;line-height:1.6;color:${C.fine};">
          ${escapeHtml(footer.reason)}
        </p>
        ${unsubHtml}
        ${addressHtml}
      </div>
    </div>`;
}

/** Primary action button. Same shape/color as the invite's Join League. */
export function emailButton(label: string, href: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;">
      <tr>
        <td style="border-radius:8px;background:${C.teal};">
          <a href="${href}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

/**
 * Format badge lockup + two lines of label. Falls back to a plain-text pill
 * for a format with no artwork yet, rather than rendering a broken image.
 */
export function emailFormatBadge(format: string, line1: string, line2: string): string {
  const badgeUrl = FORMAT_BADGE_URLS[format];
  if (!badgeUrl) {
    return `
    <p style="margin:0 0 16px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${C.teal};">
      ${escapeHtml(line1)} &middot; ${escapeHtml(line2)}
    </p>`;
  }
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
      <tr>
        <td style="vertical-align:middle;padding-right:10px;">
          <img src="${badgeUrl}" width="84" alt="${escapeHtml(FORMAT_LABELS[format] || format)}" style="display:block;width:84px;height:auto;">
        </td>
        <td style="vertical-align:middle;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${C.teal};">
          ${escapeHtml(line1)}<br>${escapeHtml(line2)}
        </td>
      </tr>
    </table>`;
}

/** Bordered grey panel. `accentColor` adds a colored left rule. */
export function emailPanel(innerHtml: string, accentColor?: string): string {
  const left = accentColor ? `border-left:4px solid ${accentColor};` : "";
  return `<div style="margin:0 0 20px;padding:16px;border:1px solid ${C.panelBorder};${left}border-radius:8px;background:${C.panelBg};">${innerHtml}</div>`;
}

/** Small uppercase section label. */
export function emailEyebrow(text: string, color?: string): string {
  return `<p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:${color || C.muted};font-weight:700;">${escapeHtml(text)}</p>`;
}

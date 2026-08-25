import {
  EMAIL_COLORS as C,
  SITE_URL,
  escapeHtml,
  emailShell,
  emailButton,
  emailFormatBadge,
  emailPanel,
  emailEyebrow,
  teamBadgeUrl,
  FORMAT_BADGE_URLS,
  FORMAT_LABELS,
} from "./email-shell.mts";

// The two scheduled emails. Both are pure functions of already-gathered
// data - all the Blobs reading and scoring lives in notif-dispatch.mts, so
// these can be rendered and eyeballed without touching storage.
//
// Every email also ships a plain-text part. Not decoration: a message with
// no text/plain alternative is scored worse by spam filters, and it's what
// a watch or a screen reader in text mode actually reads.

// ---------------------------------------------------------------------------
// Pick reminder
// ---------------------------------------------------------------------------

export interface ReminderLeague {
  format: string;
  name: string;
  missing: number;
  total: number;
}

export interface ReminderData {
  season: number;
  week: number;
  /** Human kickoff label for the week's earliest game, e.g. "Thursday 8:15 PM ET". */
  kickLabel: string;
  leagues: ReminderLeague[];
  firstGame?: {
    away: string;
    home: string;
    awayName: string;
    homeName: string;
    awayRecord?: string;
    homeRecord?: string;
    line?: string;
    edgePick?: string;
    edgePct?: string;
  };
  unsubUrl: string;
}

export function buildReminderEmail(d: ReminderData): { subject: string; html: string; text: string } {
  const totalMissing = d.leagues.reduce((n, l) => n + l.missing, 0);

  const lockPanel = emailPanel(
    `
      ${emailEyebrow("Picks lock at kickoff", C.warn)}
      <p style="margin:0;font-size:20px;font-weight:800;color:${C.heading};line-height:1.25;">${escapeHtml(d.kickLabel)}</p>
      ${d.firstGame
        ? `<p style="margin:8px 0 0;font-size:13px;color:${C.body};line-height:1.5;">
             Week ${d.week} opens with ${escapeHtml(d.firstGame.awayName)} at ${escapeHtml(d.firstGame.homeName)}. Get your full slate in before it starts.
           </p>`
        : `<p style="margin:8px 0 0;font-size:13px;color:${C.body};line-height:1.5;">
             Get your Week ${d.week} slate in before it starts.
           </p>`}`,
    C.warn
  );

  const leagueRows = d.leagues
    .map((l) => {
      const badge = FORMAT_BADGE_URLS[l.format];
      const badgeCell = badge
        ? `<img src="${badge}" width="44" alt="${escapeHtml(FORMAT_LABELS[l.format] || l.format)}" style="display:block;width:44px;height:auto;">`
        : "";
      return `
      <tr>
        <td style="padding:10px 0;border-top:1px solid ${C.panelBorder};vertical-align:middle;width:52px;">${badgeCell}</td>
        <td style="padding:10px 0 10px 8px;vertical-align:middle;font-size:14px;font-weight:700;color:${C.heading};">${escapeHtml(l.name)}</td>
        <td align="right" style="padding:10px 0;vertical-align:middle;font-size:13px;font-weight:700;color:${C.out};white-space:nowrap;">${l.missing} of ${l.total} left</td>
      </tr>`;
    })
    .join("");

  // "No picks in yet" vs "you're partway" are genuinely different messages -
  // someone who's done 12 of 16 needs a nudge, not an accusation.
  const anyStarted = d.leagues.some((l) => l.missing < l.total);
  const leaguesNote = anyStarted
    ? `You've started, but you're not done.`
    : `No picks in for any of your leagues yet.`;

  const leaguesBlock = `
      ${emailEyebrow("Still open")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;">
        ${leagueRows}
      </table>
      <p style="margin:0 0 20px;font-size:12px;color:${C.muted};line-height:1.5;">${leaguesNote}</p>`;

  const g = d.firstGame;
  const teaser = g
    ? emailPanel(`
      ${emailEyebrow("First up")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td align="center" width="40%" style="vertical-align:middle;">
            <img src="${teamBadgeUrl(g.away)}" width="38" height="38" alt="" style="display:block;margin:0 auto 6px;width:38px;height:38px;">
            <div style="font-size:13px;font-weight:700;color:${C.heading};">${escapeHtml(g.awayName)}</div>
            ${g.awayRecord ? `<div style="font-size:12px;color:${C.muted};margin-top:2px;">${escapeHtml(g.awayRecord)}</div>` : ""}
          </td>
          <td align="center" width="20%" style="vertical-align:middle;font-size:14px;font-weight:700;color:${C.muted};">@</td>
          <td align="center" width="40%" style="vertical-align:middle;">
            <img src="${teamBadgeUrl(g.home)}" width="38" height="38" alt="" style="display:block;margin:0 auto 6px;width:38px;height:38px;">
            <div style="font-size:13px;font-weight:700;color:${C.heading};">${escapeHtml(g.homeName)}</div>
            ${g.homeRecord ? `<div style="font-size:12px;color:${C.muted};margin-top:2px;">${escapeHtml(g.homeRecord)}</div>` : ""}
          </td>
        </tr>
      </table>
      ${(g.edgePick || g.line)
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:14px;border-top:1px solid ${C.panelBorder};">
             <tr>
               <td style="vertical-align:middle;padding-top:12px;">
                 ${g.edgePick
                   ? `<img src="${SITE_URL}/branding/blitz-edge-icon.png" width="18" alt="Blitz Edge" style="display:inline-block;vertical-align:middle;width:18px;height:auto;">
                      <span style="font-size:12.5px;font-weight:700;color:${C.heading};vertical-align:middle;padding-left:6px;">${escapeHtml(g.edgePick)}${g.edgePct ? " " + escapeHtml(g.edgePct) : ""}</span>`
                   : ""}
               </td>
               <td align="right" style="vertical-align:middle;font-size:12.5px;color:${C.muted};padding-top:12px;">${escapeHtml(g.line || "")}</td>
             </tr>
           </table>`
        : ""}`)
    : "";

  const body = `
      <p style="margin:0 0 6px;font-size:13px;color:${C.muted};">Week ${d.week} picks</p>
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;color:${C.heading};">${anyStarted ? "Your picks aren't finished" : "You haven't picked yet"}</h1>
      ${lockPanel}
      ${leaguesBlock}
      ${teaser}
      ${emailButton("Make my picks", `${SITE_URL}/#league`)}`;

  const html = emailShell(
    body,
    {
      reason:
        "You're receiving this because pick reminders are on for your account. We only send it when you still have games open, and never more than once a week.",
      unsubType: "reminders",
      unsubUrl: d.unsubUrl,
    },
    `Week ${d.week} picks lock ${d.kickLabel}. ${totalMissing} game${totalMissing === 1 ? "" : "s"} still open.`
  );

  const text = [
    `Week ${d.week} picks lock ${d.kickLabel}.`,
    "",
    ...d.leagues.map((l) => `- ${l.name}: ${l.missing} of ${l.total} still open`),
    "",
    `Make your picks: ${SITE_URL}/#league`,
    "",
    "You're receiving this because pick reminders are on for your account.",
    `Unsubscribe: ${d.unsubUrl}`,
  ].join("\n");

  return {
    subject: `Week ${d.week} picks lock ${d.kickLabel}`,
    html,
    text,
  };
}

// ---------------------------------------------------------------------------
// Weekly recap
// ---------------------------------------------------------------------------

export interface RecapStandingRow {
  rank: number | string;
  name: string;
  value: string;
  isMe?: boolean;
}

export interface RecapPickRow {
  teamAbbr: string;
  teamName: string;
  result: string;
  /** "alive" tints teal, "out" tints red. */
  tone: "alive" | "out";
}

export interface RecapLeague {
  format: string;
  name: string;
  seasonLabel: string;
  /** Right-aligned headline, e.g. "11-5 - 84 pts" or "Eliminated in Week 11". */
  headline: string;
  headlineTone: "neutral" | "win" | "loss";
  /** Big figure. For an eliminated survivor this is "Out" with no total. */
  rank: number | string;
  total: number | null;
  /** Places gained (+) or lost (-) versus last week. */
  delta: number;
  standings?: RecapStandingRow[];
  pick?: RecapPickRow;
  stripLabel?: string;
  foot: string;
}

export interface RecapHighlight {
  label: string;
  headline: string;
  detail: string;
  tone: "win" | "loss";
}

export interface RecapData {
  season: number;
  week: number;
  intro: string;
  leagues: RecapLeague[];
  highlights: RecapHighlight[];
  model?: { straightUp: string; ats: string; upset?: string };
  unsubUrl: string;
}

function deltaHtml(n: number): string {
  if (!n) return `<span style="font-size:12px;font-weight:700;color:${C.muted};">&mdash;</span>`;
  const color = n > 0 ? C.win : C.out;
  const glyph = n > 0 ? "&#9650;" : "&#9660;";
  return `<span style="font-size:12px;font-weight:700;color:${color};">${glyph} ${Math.abs(n)}</span>`;
}

function standingRowHtml(r: RecapStandingRow): string {
  const bg = r.isMe ? C.tealTint : "transparent";
  const edge = r.isMe ? C.teal : "transparent";
  const color = r.isMe ? C.heading : C.muted;
  const weight = r.isMe ? 800 : 600;
  return `
      <tr>
        <td style="padding:7px 10px;background:${bg};border-left:3px solid ${edge};font-size:13px;font-weight:${weight};color:${color};width:34px;">${escapeHtml(r.rank)}</td>
        <td style="padding:7px 6px;background:${bg};font-size:13px;font-weight:${weight};color:${color};">${escapeHtml(r.name)}</td>
        <td align="right" style="padding:7px 12px 7px 6px;background:${bg};font-size:13px;font-weight:${weight};color:${color};">${escapeHtml(r.value)}</td>
      </tr>`;
}

/**
 * Survivor has no leaderboard worth showing - everyone alive is tied - so
 * its strip carries the pick itself instead, crest included.
 */
function pickRowHtml(p: RecapPickRow): string {
  const out = p.tone === "out";
  const bg = out ? C.outTint : C.tealTint;
  const edge = out ? C.out : C.teal;
  const col = out ? C.out : C.win;
  return `
      <tr>
        <td style="padding:9px 8px 9px 10px;background:${bg};border-left:3px solid ${edge};width:34px;">
          <img src="${teamBadgeUrl(p.teamAbbr)}" width="26" alt="" style="display:block;width:26px;height:auto;">
        </td>
        <td style="padding:9px 6px;background:${bg};font-size:13px;font-weight:800;color:${C.heading};">${escapeHtml(p.teamName)}</td>
        <td align="right" style="padding:9px 12px 9px 6px;background:${bg};font-size:13px;font-weight:800;color:${col};">${escapeHtml(p.result)}</td>
      </tr>`;
}

function leagueBlockHtml(l: RecapLeague): string {
  const headlineColor =
    l.headlineTone === "win" ? C.win : l.headlineTone === "loss" ? C.out : C.heading;

  const rows = l.pick
    ? pickRowHtml(l.pick)
    : (l.standings || []).map(standingRowHtml).join("");

  return `
      <div style="margin:0 0 22px;padding:0 0 20px;border-bottom:1px solid ${C.panelBorder};">
        ${emailFormatBadge(l.format, l.name, l.seasonLabel)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 12px;">
          <tr>
            <td style="font-size:24px;font-weight:800;color:${C.heading};line-height:1;white-space:nowrap;">
              ${escapeHtml(l.rank)}${l.total ? `<span style="font-size:14px;font-weight:600;color:${C.muted};"> / ${l.total}</span>` : ""}
            </td>
            <td style="padding-left:9px;vertical-align:bottom;padding-bottom:2px;">${deltaHtml(l.delta)}</td>
            <td align="right" style="vertical-align:bottom;padding-bottom:2px;font-size:13px;font-weight:800;color:${headlineColor};">${escapeHtml(l.headline)}</td>
          </tr>
        </table>
        ${l.stripLabel ? emailEyebrow(l.stripLabel) : ""}
        ${rows
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${C.panelBg};border:1px solid ${C.panelBorder};border-radius:8px;">${rows}</table>`
          : ""}
        <p style="margin:8px 0 0;font-size:12px;color:${C.muted};">${escapeHtml(l.foot)}</p>
      </div>`;
}

export function buildRecapEmail(d: RecapData): { subject: string; html: string; text: string } {
  const highlightsHtml = d.highlights.length
    ? `
      ${emailEyebrow("Your week")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;">
        ${d.highlights
          .map(
            (h, i) => `
        ${i > 0 ? `<tr><td colspan="2" style="height:16px;"></td></tr>` : ""}
        <tr>
          <td width="4" style="background:${h.tone === "win" ? C.win : C.out};border-radius:2px;"></td>
          <td style="padding:2px 0 2px 11px;">
            <div style="font-size:12px;color:${C.muted};">${escapeHtml(h.label)}</div>
            <div style="font-size:14px;font-weight:700;color:${C.heading};margin-top:2px;">${escapeHtml(h.headline)}</div>
            <div style="font-size:12px;color:${C.muted};margin-top:2px;line-height:1.5;">${escapeHtml(h.detail)}</div>
          </td>
        </tr>`
          )
          .join("")}
      </table>`
    : "";

  const modelHtml = d.model
    ? emailPanel(`
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="vertical-align:middle;">
            <img src="${SITE_URL}/branding/blitz-edge-logo.png" width="104" alt="Blitz Edge" style="display:block;width:104px;height:auto;">
          </td>
          <td align="right" style="vertical-align:middle;font-size:12px;color:${C.muted};">Week ${d.week} model</td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:14px;">
        <tr>
          <td width="33%"><div style="font-size:18px;font-weight:800;color:${C.heading};">${escapeHtml(d.model.straightUp)}</div>
            <div style="font-size:11px;color:${C.muted};margin-top:2px;">Straight up</div></td>
          <td width="33%"><div style="font-size:18px;font-weight:800;color:${C.heading};">${escapeHtml(d.model.ats)}</div>
            <div style="font-size:11px;color:${C.muted};margin-top:2px;">Against the spread</div></td>
          ${d.model.upset
            ? `<td width="33%"><div style="font-size:18px;font-weight:800;color:${C.orange};">${escapeHtml(d.model.upset)}</div>
                 <div style="font-size:11px;color:${C.muted};margin-top:2px;">Upset of the week</div></td>`
            : `<td width="33%"></td>`}
        </tr>
      </table>`)
    : "";

  const body = `
      <p style="margin:0 0 6px;font-size:13px;color:${C.muted};">Tuesday recap</p>
      <h1 style="margin:0 0 10px;font-size:22px;line-height:1.25;color:${C.heading};">Week ${d.week} is in the books</h1>
      <p style="margin:0 0 22px;font-size:14px;color:${C.body};line-height:1.5;">${escapeHtml(d.intro)}</p>
      ${d.leagues.map(leagueBlockHtml).join("")}
      ${highlightsHtml}
      ${modelHtml}
      ${emailButton("See full standings", `${SITE_URL}/#league`)}`;

  const html = emailShell(
    body,
    {
      reason: "You're receiving this because the weekly recap is on for your account.",
      unsubType: "weekly",
      unsubUrl: d.unsubUrl,
    },
    d.intro
  );

  const text = [
    `Week ${d.week} recap`,
    "",
    d.intro,
    "",
    ...d.leagues.map((l) => `- ${l.name}: ${l.headline} (${l.rank}${l.total ? ` of ${l.total}` : ""}) - ${l.foot}`),
    "",
    `Full standings: ${SITE_URL}/#league`,
    "",
    "You're receiving this because the weekly recap is on for your account.",
    `Unsubscribe: ${d.unsubUrl}`,
  ].join("\n");

  return { subject: `Week ${d.week} recap`, html, text };
}

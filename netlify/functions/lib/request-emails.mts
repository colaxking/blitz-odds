import {
  EMAIL_COLORS as C,
  EMAIL_FONT,
  SITE_URL,
  FORMAT_LABELS,
  escapeHtml,
  emailShell,
  emailButton,
  emailFormatBadge,
  emailPanel,
  emailEyebrow,
} from "./email-shell.mts";

// Emails for the private-league join-request flow. Built from the shared
// shell in email-shell.mts so they match league-invite.mts and the
// scheduled reminders rather than drifting into their own look.
//
// Three of them, and the split matters:
//   - buildJoinRequestEmail    -> the owner, when someone asks
//   - buildRequestApprovedEmail -> the requester, when they're let in
//   - buildRequestDeclinedEmail -> the requester, when they aren't
//
// The decline email exists because the alternative is silence: someone who
// asked and heard nothing has no way to tell "declined" from "the owner
// hasn't looked yet", and will keep checking. It gives no reason - the owner
// isn't asked for one and shouldn't have to justify who's in their pool -
// and it says plainly that the decision is final so nobody waits on a
// reversal that isn't coming. It also points out that an invite code still
// works, because a decline doesn't block one: an owner who changes their
// mind, or who declined the wrong row, can just send the code.
//
// None of these are marketing, so none carry an unsubscribe footer - they're
// transactional responses to something the recipient or their league did.

const REQUESTS_URL = (leagueId: string) => `${SITE_URL}/leagues/${leagueId}?panel=requests`;
const LEAGUE_URL = (leagueId: string) => `${SITE_URL}/leagues/${leagueId}`;

export interface JoinRequestEmailInput {
  leagueId: string;
  leagueName: string;
  format: string;
  requesterName: string;
  memberCount: number;
  maxMembers: number | null;
  pendingCount: number;
}

/** To the league owner: someone has asked to join. */
export function buildJoinRequestEmail(input: JoinRequestEmailInput) {
  const {
    leagueId, leagueName, format, requesterName,
    memberCount, maxMembers, pendingCount,
  } = input;

  const capacity = maxMembers ? `${memberCount} of ${maxMembers} spots taken` : `${memberCount} members`;
  const others = pendingCount > 1
    ? `<p style="margin:0;font-size:14px;line-height:1.6;color:${C.muted};">${pendingCount - 1} other request${pendingCount - 1 === 1 ? "" : "s"} ${pendingCount - 1 === 1 ? "is" : "are"} also waiting.</p>`
    : "";

  const body = `
    ${emailFormatBadge(format, FORMAT_LABELS[format] || format, leagueName)}
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${C.heading};font-weight:700;">
      ${escapeHtml(requesterName)} asked to join ${escapeHtml(leagueName)}
    </h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${C.body};">
      They found your league in search. Nobody is added until you approve them.
    </p>
    ${emailPanel(`
      ${emailEyebrow("Waiting on you")}
      <p style="margin:0 0 4px;font-size:16px;font-weight:700;color:${C.heading};">${escapeHtml(requesterName)}</p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:${C.muted};">${escapeHtml(capacity)}</p>
      ${others}
    `, C.teal)}
    ${emailButton("Review request", REQUESTS_URL(leagueId))}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${C.muted};">
      Prefer to skip the queue? Send someone your invite code and they join straight away.
    </p>`;

  return {
    subject: `${requesterName} asked to join ${leagueName}`,
    html: emailShell(body, {
      reason: `You're receiving this because you run ${leagueName} on Blitz Odds.`,
    }, `${requesterName} wants a spot in ${leagueName}.`),
  };
}

export interface RequestOutcomeEmailInput {
  leagueId: string;
  leagueName: string;
  format: string;
  ownerName: string | null;
  memberCount?: number;
}

/** To the requester: you're in. */
export function buildRequestApprovedEmail(input: RequestOutcomeEmailInput) {
  const { leagueId, leagueName, format, memberCount } = input;

  const body = `
    ${emailFormatBadge(format, FORMAT_LABELS[format] || format, leagueName)}
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${C.heading};font-weight:700;">
      You're in ${escapeHtml(leagueName)}
    </h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${C.body};">
      Your request was approved${memberCount ? `, and you're one of ${memberCount} members` : ""}.
      Make this week's picks before kickoff - each game locks at its own start time.
    </p>
    ${emailButton("Make your picks", LEAGUE_URL(leagueId))}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${C.muted};">
      Every game carries a Blitz Edge win probability, so you can see where the model
      disagrees with the sportsbook before you commit a pick.
    </p>`;

  return {
    subject: `You're in - ${leagueName}`,
    html: emailShell(body, {
      reason: `You're receiving this because you asked to join ${leagueName} on Blitz Odds.`,
    }, `Your request to join ${leagueName} was approved.`),
  };
}

/** To the requester: you aren't. Deliberately short and reasonless. */
export function buildRequestDeclinedEmail(input: RequestOutcomeEmailInput) {
  const { leagueName, ownerName } = input;

  const body = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${C.heading};font-weight:700;">
      Your request to join ${escapeHtml(leagueName)} wasn't accepted
    </h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${C.body};">
      ${ownerName ? `${escapeHtml(ownerName)}, who runs the league,` : "The league owner"}
      decided not to add you this time. It isn't something you can request again.
    </p>
    ${emailPanel(`
      <p style="margin:0;font-size:14px;line-height:1.6;color:${C.muted};">
        If they change their mind, an invite code from them will still get you in.
      </p>
    `)}
    ${emailButton("Find another league", `${SITE_URL}/leagues`)}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${C.muted};">
      Plenty of public leagues take anyone instantly - or start your own in about a minute.
    </p>`;

  return {
    subject: `About your request to join ${leagueName}`,
    html: emailShell(body, {
      reason: `You're receiving this because you asked to join ${leagueName} on Blitz Odds.`,
    }, `Your request to join ${leagueName} wasn't accepted.`),
  };
}

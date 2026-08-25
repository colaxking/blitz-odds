# Notification system

Two scheduled emails per subscribed user per week, and nothing else:

| Email | When | Sent only if |
|---|---|---|
| Pick reminder | 7:00 PM local, the calendar day before the week's first kickoff | they still have games open in at least one league |
| Weekly recap | 9:00 AM local, Tuesday | at least one of their leagues has a scored result for that week |

Both are opt-out per type, from Settings → Alerts or from the unsubscribe
link in the footer.

## Before this can send anything

Three env vars in Netlify (Site settings → Environment variables):

| Var | Purpose |
|---|---|
| `RESEND_API_KEY` | already set — shared with `league-invite.mts` |
| `NOTIF_UNSUB_SECRET` | signs unsubscribe links. Any long random string; **changing it invalidates every unsubscribe link already sitting in someone's inbox**, so set it once and leave it |
| `NOTIF_DISPATCH_SECRET` | gates the dispatcher. Also needs to exist as a GitHub repository secret of the same name for the workflow |

The dispatcher refuses to run if either notif secret is missing, rather than
sending mail with unsigned unsubscribe links.

Sending addresses are `alerts@blitz-odds.com` (reminder) and
`recap@blitz-odds.com` (recap). Both are on the already-verified
`blitz-odds.com` domain, so no new Resend setup is needed — but see
"Deliverability" below for why a separate subdomain may be worth it later.

## Wiring the schedule

`.github/workflows/notif-dispatch.yml` is `workflow_dispatch`-only, like
every other job in this repo (GitHub's own `schedule:` cron is unreliable
here). Add a cron-job.org job:

```
POST https://api.github.com/repos/colaxking/blitz-odds/actions/workflows/notif-dispatch.yml/dispatches
Headers: Authorization: Bearer <PAT with 'workflow' scope>
         Accept: application/vnd.github+json
         Content-Type: application/json
Body:    {"ref":"main"}
Cadence: every 15 minutes, year round
```

Every 15 minutes because send times are local to each reader and readers
span timezones — there is no single UTC moment that serves everyone. Almost
every tick decides nobody is due and returns. Off-season, it finds no
upcoming week and costs one schedule read.

Double-firing is safe: every send writes an idempotency ledger key
(`sent:{type}:{season}:{week}:{userId}`) **before** calling Resend and checks
it first. A crash between the ledger write and the send loses that one
email; that's the deliberate trade — dropping one beats sending two.

## Testing without sending

Actions tab → "Blitz Odds - notification dispatch" → Run workflow, with
**dry_run = true**. Optionally set `only` to `reminder`/`recap` and `user_id`
to a single Netlify Identity id.

The plan appears in the **Netlify** function log, not the workflow output —
background functions return 202 immediately and the workflow never sees the
result body.

Locally:

```bash
node scripts/preview-notif-emails.mjs /tmp/preview   # renders all 3 email states to HTML
node scripts/test-notif-timing.mjs                   # asserts send times across timezones + DST
```

## How the send time is derived

```
firstKickoff = earliest parseable kickoff in the week
sendAt       = 7:00 PM on the calendar day before firstKickoff,
               in the reader's own timezone
guard        = never send after (firstKickoff - 3h)
catch-up     = if the 7 PM slot was missed, send at the next tick,
               up to the guard
```

The catch-up clause covers the "or the morning of" case without spending a
second email: someone who joins a league the morning of a Thursday game, or
whose slot was skipped by a cron hiccup, still gets caught.

Timezone comes from the app's existing Time Zone setting (`resolvedTz`),
pushed to the server by the Alerts tab. One source of truth, and a reader
who deliberately set their zone gets mail on that zone rather than on
whatever device they last opened.

Verified against the real 2026 schedule in six timezones including the
November DST fall-back. Sample output:

```
Week 1  - opens NE @ SEA, Wednesday 8:20 PM ET
    America/New_York      Tue Sep 8, 7:00 PM   (25.3h lead)
    Europe/London         Wed Sep 9, 7:00 PM   ( 6.3h lead)
    Asia/Tokyo            Wed Sep 9, 7:00 PM   (14.3h lead)
```

London's shorter lead is correct, not a bug: an 8:20 PM ET Wednesday
kickoff is 1:20 AM Thursday in London, so "the evening before" is Wednesday
there.

## Known gaps

- **Week 18 gets no reminder.** Its games carry placeholder times pending
  flex scheduling, so `parseKickoffUTC` returns null and the week has no
  computable first kickoff. Resolves itself once real times land in the
  schedule blob.
- **Tuesday double-header.** In weeks with a Wednesday opener (Weeks 1 and
  12 in 2026), the recap fires 9 AM Tuesday and the reminder 7 PM the same
  Tuesday. Ten hours apart and still within the two-a-week cap, so no hold
  was implemented — adding one risks a recap that never sends.
- **No Blitz Edge model block in the recap.** `RecapData.model` exists and
  the builder renders it, but the dispatcher doesn't populate it: there's no
  verified server-side source for the model's weekly straight-up/ATS record.
  Wire that up and the block appears.
- **Highlights are confidence-only.** In straight-up and ATS every pick is
  worth the same, so "best call" would just be an arbitrary correct pick.
  Omitted rather than faked.
- **Web push not built.** Needs a VAPID keypair, a manifest, and a
  **push-only** service worker. Note for whoever builds it: this app is a
  single `index.html` transpiled in-browser with no cache-busting, so a
  service worker with a `fetch` handler will serve a stale *entire
  application*. Handle `push` and `notificationclick` only — no `fetch`, no
  caching. Also, iOS Safari only allows push once the site is installed to
  the Home Screen, which caps reachable coverage.

## Deliverability notes

- `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  ship on every send. Gmail and Yahoo both require a working one-click
  unsubscribe from bulk senders, and its absence measurably pushes mail to
  spam. `unsubscribe.mts` handles both the POST (RFC 8058) and the GET.
- **Unsubscribe GET must stay idempotent** — mail clients and security
  scanners prefetch links in messages. Unsubscribing twice changes nothing,
  but a prefetch *can* unsubscribe someone who never clicked, which is why
  the confirmation page leads with resubscribe.
- **Image weight.** Recap pulls three format badges (~50 KB each at 420px
  source, shown at 84px), the wordmark, the Blitz Edge logo, and a team
  crest (~59 KB) — roughly 700 KB to render maybe 60 KB of visible pixels.
  Nothing breaks (Gmail's 102 KB clipping limit is HTML only; the recap is
  ~12 KB), but a `-email` derivative set at display size would cut it ~90%.
- **Teal button contrast.** White on `#02a4a4` is 3.07:1, under the 4.5:1
  AA threshold for normal text. Inherited from the invite, unchanged here so
  all three emails match. `#017a7a` clears it without visibly changing the
  brand.
- **Sending subdomain.** If recap volume ever hurts domain reputation, move
  these two to `mail.blitz-odds.com` so invite deliverability doesn't go
  down with them.

## Files

```
netlify/functions/
  lib/email-shell.mts              house style: header, shell, button, badge, panel
  lib/notif.mts                    prefs, HMAC unsub tokens, Resend send, ledger, local-time
  lib/notif-emails.mts             both email builders (HTML + text)
  notif-prefs.mts                  GET/POST prefs (authenticated)
  unsubscribe.mts                  signed GET page + one-click POST
  notif-dispatch-background.mts    the 15-minute tick
  league-invite.mts                refactored onto email-shell
index.html                         Settings -> Alerts tab (NotificationsTab)
scripts/test-notif-timing.mjs      send-time assertions
scripts/preview-notif-emails.mjs   render emails to HTML without sending
.github/workflows/notif-dispatch.yml
```

`email-shell.mts` is the only place the email look lives. Adding a third
email type means writing a builder, not another copy of the chrome.

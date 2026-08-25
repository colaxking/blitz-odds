# Notification system

Two scheduled emails per subscribed user per week, and nothing else:

| Email | When | Sent only if |
|---|---|---|
| Pick reminder | 7:00 PM local, the calendar day before the week's first kickoff | they still have games open in at least one league |
| Weekly recap | 9:00 AM local, Tuesday | at least one of their leagues has a scored result for that week |

Both are opt-out per type, from Settings → Alerts or from the unsubscribe
link in the footer.

## Before this can send anything

Env vars in Netlify (Site settings → Environment variables):

| Var | Purpose |
|---|---|
| `RESEND_API_KEY` | already set — shared with `league-invite.mts` |
| `NOTIF_UNSUB_SECRET` | signs unsubscribe links. Any long random string; **changing it invalidates every unsubscribe link already sitting in someone's inbox**, so set it once and leave it |
| `NOTIF_DISPATCH_SECRET` | gates the dispatcher. Also needs to exist as a GitHub repository secret of the same name for the workflow |
| `VAPID_PUBLIC_KEY` | web push. Also served to the client by `notif-prefs` — it's a public key, safe to expose |
| `VAPID_PRIVATE_KEY` | web push signing key. Never leaves the server |
| `VAPID_SUBJECT` | optional; `mailto:` or a URL identifying the sender to the push service. Defaults to `SITE_URL` |

**Changing the VAPID keypair invalidates every push subscription already
registered** — every browser subscribed under the old public key silently
stops receiving, and there's no error to notice. Set it once, like
`NOTIF_UNSUB_SECRET`. A fresh pair can be generated with:

```bash
node -e "const{generateKeyPairSync}=require('node:crypto');const{publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const b=x=>Buffer.from(x).toString('base64url');console.log('public ',b(publicKey.export({type:'spki',format:'der'}).subarray(-65)));console.log('private',privateKey.export({format:'jwk'}).d)"
```

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

**Post to `/.netlify/functions/notif-dispatch`, not the `-background` one.**
Netlify answers a background function with 202 the instant the request
arrives, *before the handler runs* — so a wrong secret would return 202 and
the cron would silently do nothing forever. `notif-dispatch` is a small
synchronous front door that validates the secret and the required env vars,
returns a real status code (401 / 500), and only then hands off.

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
- **Web push is built (Phase 0), but nothing sends over it yet.** The
  channel works end to end — subscribe, store, send, prune — and the only
  thing that currently pushes is the "Send a test" button in Settings →
  Alerts. Alert types land in Phase 1.

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
  notif-dispatch.mts               synchronous front door: validates, then hands off
  notif-dispatch-background.mts    the 15-minute tick (does the actual work)
  league-invite.mts                refactored onto email-shell
index.html                         Settings -> Alerts tab (NotificationsTab)
scripts/test-notif-timing.mjs      send-time assertions
scripts/preview-notif-emails.mjs   render emails to HTML without sending
.github/workflows/notif-dispatch.yml
```

`email-shell.mts` is the only place the email look lives. Adding a third
email type means writing a builder, not another copy of the chrome.


---

# Web push (Phase 0)

The channel, with no alert types on it yet. Two scheduled emails a week is
still the whole of what this system *sends*; everything below is the
plumbing that lets Phase 1 add kickoff, final score, and last-call alerts
without touching any of it again.

## The service worker constraint

`sw.js` handles `push` and `notificationclick`. It must never gain a
`fetch` handler, a cache, or Workbox.

`index.html` is the entire application — one file, Babel-transpiled in the
browser, no build step, no cache-busting on the URL. A worker intercepting
`fetch` would be caching *the whole app* under a URL that never changes,
and would keep serving a stale copy long after a deploy. There is no
version to bust and no filename to hash, so there is no safe way to do it.
A worker with no `fetch` handler doesn't sit between the app and the
network at all, which is the point. There's a comment saying so at the top
of the file; leave it there.

## Payload shape

`lib/push.mts` defines `PushPayload` — `{ title, body, url, collapseKey,
data }` — deliberately not the shape of any one transport's API.

`collapseKey` is the one that matters. Web calls it `tag`, FCM calls it
`collapse_key`, APNs calls it `apns-collapse-id`; all three mean "a newer
message about the same subject replaces the one already on the lock
screen." Scoring alerts are unusable without it — six score changes in one
game would otherwise be six notifications. Naming it once here is what
stops every payload from needing a rewrite when a native adapter lands.

`url` is always a path, never a hash. See `claude_url-scheme.md`: Universal
Links and App Links match on path and can't see a fragment.

## Storage

```
push:{userId}:{deviceId} -> {
  platform: "web" | "ios" | "android",
  web?:   { endpoint, keys: { p256dh, auth } },
  token?: string,
  ua, label, createdAt, lastOkAt, failCount
}
```

`deviceId` is a truncated sha256 of the endpoint (web) or token (native),
so a browser that silently rotates its subscription and re-registers
overwrites its own row instead of leaving a dead one to be pushed at until
it 410s. One row per device, several per user, is the normal case.

The `web` sub-object exists so the same row can hold an APNs/FCM token
later without a migration — web push needs an endpoint plus two keys,
native needs one opaque token, and flattening either into the top level
would mean rewriting every stored row when the second one arrives.

## Pruning

404 and 410 from a push service mean the subscription is dead — cleared
site data, uninstall, browser rotation. That's not transient, so the row is
deleted rather than retried. Anything else increments `failCount`, and ten
consecutive failures is also treated as gone: each attempt costs a request
on every tick the device is due for one.

## Entitlements

`lib/entitlements.mts` exists and gates nothing — `has()` returns true for
everything. It's there because the expensive version of a paywall is the
one retrofitted through a dozen call sites later.

Capability strings (`"alerts.scoring"`), not a tier enum, because the tier
model hasn't been designed and `tier >= PRO` would force that decision now.
`PLANNED_PRO_CAPABILITIES` lists what's expected to become paid, so usage
can be filtered to "who would this affect" before anything is switched on.

Pro badging in the Alerts tab is written but hidden behind
`SHOW_PRO_BADGES = false` in `index.html`. The label is meant to land with
real runway *ahead* of any gating — a free beta people know is premium
reads as a trial ending; a label and a paywall arriving together reads as
something being taken away.

## Permission, and why it's never requested on load

`Notification.requestPermission()` fires once per site. A denial is close
to permanent — the browser will not re-prompt, and the app cannot undo it.
So it's only ever called from a deliberate tap on "Turn on push alerts" in
Settings → Alerts. `pushEnvironment()` in `index.html` reports which of the
five states applies (`unsupported`, `ios-not-installed`, `blocked`,
`prompt`, `granted`) and the tab renders a different panel for each.

iOS/iPadOS only delivers push to a site added to the Home Screen, and won't
offer that without a manifest declaring `display: standalone` — hence
`manifest.webmanifest` and the square `branding/app-icon-*.png` set. (The
existing `blitz-edge-icon.png` is 555×415; manifest icons have to be
square, so they're generated from it rather than referencing it.) There is
no way around the Home Screen requirement, and it caps reachable iOS
coverage.

## Three bugs fixed alongside this

1. **`if (!leagues.length) continue;`** in the dispatcher dropped every
   user with no league before any alert type got to decide. Correct while
   pick reminders and the recap were all that existed — both are about
   leagues — and wrong the moment alerts started keying off favourite
   teams. Someone with three starred teams and no pool would have been
   excluded from the whole pass with no error and no log line. The user
   list is now built once and each type applies its own filter.
2. **Week-scoped ledger keys** couldn't express per-event alerts. Added
   `eventLedgerKey` → `evt:{season}:{week}:{type}:{event}:{userId}`.
   Season and week lead the key, unlike the weekly `sent:` keys, because a
   sweep wants "everything from week 6" rather than "every scoring alert
   ever" — Blobs has no TTL, and one alert per scoring play per user is
   tens of thousands of keys a season. `sweepEventLedger()` deletes a week
   by prefix; whichever alert type first writes event keys should schedule
   it a few weeks behind the current one.
3. **Recap eligibility** was "has a scored league result", full stop. With
   favourite-team news riding the recap, someone with favourites and no
   league would opt in and receive nothing, forever, silently.

## Testing

```bash
node /tmp/sw-unit.mjs        # sw.js push/notificationclick in a fake worker scope
```

The service worker's handlers are plain functions on a `self` object, so
they can be exercised in `vm.runInNewContext` with a stubbed scope — worth
keeping, since the one assertion that matters (`'fetch' in handlers ===
false`) is exactly the thing a well-meaning future change would break.

Preference merging is also worth checking directly after any change to the
prefs shape: bundle `lib/notif.mts` with `@netlify/blobs` left external and
resolved to an in-memory stub, then assert that a record written before
`push` existed still comes back with its stored email settings intact and a
fully populated `push` block.

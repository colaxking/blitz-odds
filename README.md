# Blitz Odds

A responsive web app that predicts weekly NFL winners from team offense/defense
rankings, adjusted for injured impact players, with real sportsbook odds shown
alongside every call. (The project folder is still named `nfl-matchup-analyzer`
so the scheduled update task and existing shortcuts keep working — only the
app's on-page branding changed.)

## Live site

**https://blitz-odds.netlify.app**

This folder is a git repo pushed to [github.com/colaxking/blitz-odds](https://github.com/colaxking/blitz-odds),
which is linked to Netlify for continuous deployment — any push to `main` triggers
an automatic rebuild and goes live within about a minute (Netlify uses atomic
deploys, so there's no downtime during the swap).

Netlify's free plan is credit-metered (300 credits/month, 15 credits per production
deploy — about 20 deploys/month, hard capped). Only one scheduled task pushes to git:
`nfl-matchup-analyzer-weekly-update`, once a week. Betting odds change far more often
than that (every 15 minutes in season), so `blitz-odds-odds-refresh` publishes those
through a Netlify Function backed by Netlify Blobs (`netlify/functions/odds-update.mts`
/ `odds-current.mts`) instead of git — the live site fetches current odds at runtime,
the same way it already polls ESPN for live scores. That keeps odds near-real-time
without ever touching the deploy budget, and keeps only one task writing to the git
repo (two tasks racing on the same repo was leaving stale lock files behind).

## Open it locally

Double-click `index.html` (or open it in any browser). No install, no build
step, no server required — works on desktop and on a phone browser.

## What's inside

```
nfl-matchup-analyzer/
├── index.html                       # the app (self-contained, data embedded)
├── js/predictionEngine.js           # portable prediction logic (no React/DOM dependency)
├── netlify/functions/
│   ├── track.mts                    # first-party analytics ingest (Blobs-backed)
│   ├── analytics-summary.mts        # first-party analytics summary (Blobs-backed)
│   ├── odds-update.mts              # secret-authed write endpoint for the odds-refresh task (Blobs-backed)
│   └── odds-current.mts             # public read endpoint the live site polls for current odds (Blobs-backed)
└── data/
    ├── teams.json                   # 2025 season final offense/defense stats + ranks, all 32 teams
    ├── impact-players.json          # sample injury/impact-player data (see disclaimer below)
    ├── schedule-week1-2026.json     # real 2026 Week 1 schedule (kept for reference)
    ├── schedule-preseason-2026.json # Hall of Fame Game + Preseason Weeks 1-3 (fixed, weeks -4 to -1)
    ├── schedule-full-2026.json      # full 18-week 2026 regular season schedule
    ├── schedule-playoffs-2026.json  # postseason bracket, filled in round-by-round once seeding is known
    ├── odds-2026.json               # on-disk mirror of live odds (weeks -4..-1 preseason, 1-18 regular, 19-22 playoffs) — the live site actually reads from the odds-current function, not this file
    ├── odds-history.json            # on-disk mirror of line-movement history, same caveat
    └── history.json                 # weekly archive: frozen stats + predictions + final scores
```

## Features

- **Week selector** — a dropdown switches between all 18 weeks of the 2026 season.
- **Team logos** — each matchup card shows real team logos (hotlinked from NFL.com's
  public logo CDN), with a colored fallback badge if a logo fails to load.
- **Team view** — click any team's logo or name to see that team's full 18-week
  schedule in one place, with a predicted result and confidence for every game and a
  bye week clearly marked.
- **Roster & depth chart, team news** — the team view is now tabbed: "Schedule"
  (the original full-season table) and "Roster & Depth Chart", which pulls that
  team's live depth chart and full roster (position, jersey number, size,
  experience) straight from ESPN's public API in the browser, same as live
  scores. A "Team News" panel with recent headlines sits in a column to the
  right of the tabs. On narrow/mobile screens there's no room for a side
  column, so News becomes a third tab instead and everything stacks in one
  column.
- **Favorites** — click the star on any team to favorite it. Favorited teams appear
  in a bar under the header for one-click access to their full schedule. Favorites
  are saved in the browser (via localStorage) so they persist next time you open the
  app on the same computer.
- **Rank-gap rows** — every matchup card shows the numeric gap between the two teams'
  ranks in each of the 6 categories (e.g. "Total offense rank gap: KC by 12"), not just
  each team's individual rank.
- **Predicted vs. actual (history)** — any week that has a `data/history.json` snapshot
  shows the team stats and prediction *as they were that week*, plus the real final
  score and a ✓/✗ on whether the model called it right — both on the week view and on
  a team's full-season schedule. Weeks without a snapshot just show today's live
  prediction (there's nothing to compare yet). Right now only Week 1 has a snapshot,
  and it's clearly marked as a **sample** (fictional scores) since the real 2026 season
  hasn't been played yet.
- **Preseason** — the week dropdown also lists the Hall of Fame Game and Preseason
  Weeks 1-3 ahead of Week 1, with real matchups (`data/schedule-preseason-2026.json`),
  predictions, and odds just like the regular season. Preseason predictions use the
  same team stats as the rest of the app (2025 season final ranks) since real 2026
  stats don't exist yet.
- **Playoffs** — the week dropdown only lists a playoff round (Wild Card, Divisional,
  Conference Championships, Super Bowl) once its matchups are actually known. Playoff
  seeding depends on how the regular season finishes, so `data/schedule-playoffs-2026.json`
  starts with all four rounds empty; the weekly scheduled task fills each one in, round by
  round, as the real bracket is announced. A team's schedule view only gets a playoff row
  once that team is actually in an announced round - no "TBD" placeholders.
- **Live scores** — while a game is in progress, its card polls ESPN's free public
  scoreboard endpoint every 30 seconds and shows a live score, quarter, and clock with a
  red LIVE badge. This overrides whatever the historical snapshot says (a live/final
  score is always fresher than an archived one). If a game is over but hasn't been
  archived into history.json yet, the live final score still shows automatically. This
  fetch runs from your browser - if you open index.html straight from disk, some
  browsers block that cross-origin request from a file:// page. If live scores never
  appear, try serving the folder locally instead (`python3 -m http.server` from inside
  `nfl-matchup-analyzer/`, then open `http://localhost:8000`) and it'll work normally.
- **Betting odds** — each card shows the real sportsbook spread, moneyline (both teams),
  and over/under when a line has been posted, plus a quick note on whether the model's
  own pick agrees or disagrees with the market favorite. Sportsbooks usually don't post
  lines until about 6-10 days before kickoff, so most future weeks will read "Odds not
  yet posted" until the weekly task refreshes them closer to game time. Week 1 currently
  shows a labeled **illustrative sample** (realistic-looking but made-up numbers) so you
  can see the feature before real lines exist.

`index.html` embeds copies of seven of the JSON files directly in the page
(teams, players, schedule, history, preseason, playoffs, odds) so it can be
opened straight from disk without hitting browser file:// security
restrictions. The `data/` files are the source of truth for everything except
odds — edit them, then re-run the same templating step to refresh
`index.html` (or ask me to do it). Odds are the one exception: the live page
fetches current odds at runtime from the `odds-current` function rather than
relying solely on the embedded blob, so odds can update without a redeploy;
the embedded copy and `data/odds-2026.json` are just a periodic mirror.

## How the prediction works

Each team gets an **offense rating** and a **defense rating**, built from its
rank (1 = best in the league) in three categories: total yards/game, rush
yards/game, and pass yards/game. Total is weighted 50%, rush and pass 25% each.

A matchup compares the home team's combined rating (offense + defense + a
small home-field bonus) against the away team's combined rating. The gap is
run through a logistic curve to produce a win probability.

**Impact players:** if a player is marked `"out"`, their impact score (1–10)
docks their team's offense rating (if they're offense) or defense rating (if
they're defense) before the matchup is scored. `"questionable"` applies a
lighter version of the same penalty. You can see this in action in the Week 1
Vikings/Packers card — marking Justin Jefferson out swings Minnesota's win
probability from 32% down to 12%.

All of the weighting constants (home field bonus, injury multipliers, rank
weights) live at the top of `js/predictionEngine.js` if you want to tune them.

## Data sources & honesty check

- **Team stats**: 2025 NFL regular season final offense/defense totals from
  [The Football Database](https://www.footballdb.com/statistics/nfl/team-stats/total-offense).
  This is real data — verified against the source.
- **Schedule**: the full 2026 regular season (all 18 weeks) compiled from
  [Pro-Football-Reference](https://www.pro-football-reference.com/years/2026/games.htm)
  (weeks 1-13) and [NFL.com](https://www.nfl.com/schedules/2026/by-week/week-1) by-week
  pages (weeks 14-18). Weeks 16-18 have some flexed/TBD dates and times that the NFL
  finalizes as the season progresses. Each of the 32 teams has exactly one bye week,
  which checks out against real NFL scheduling rules.
- **Playoffs**: `data/schedule-playoffs-2026.json` starts as an empty skeleton (Wild
  Card/Divisional/Conference/Super Bowl) since seeding isn't determined until Week 18
  ends. The weekly scheduled task researches and fills in each round's real matchups as
  the bracket is announced.
- **Live scores**: [ESPN's public scoreboard API](https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard),
  no key required. Used only for in-progress/just-finished scores; it doesn't affect the
  stats or predictions.
- **Betting odds**: real sportsbook lines pulled every 15 minutes (8am-11pm local, in-season,
  including August for preseason) from the [SportsGameOdds](https://sportsgameodds.com) API
  (free "Amateur" tier), covering DraftKings, FanDuel, BetMGM, Caesars, and BetRivers — the
  sportsbook picker in the header lets you choose which one's line to see, falling back to
  DraftKings' line when your pick hasn't posted a number yet. They're shown purely as an
  independent reference point next to the model's own prediction — the model doesn't use odds
  as an input, so a "model disagrees with the market" note just means the two takes differ.
  Every time a line actually moves, the change is appended to `data/odds-history.json` so
  there's a running record of how each game's spread/moneyline/total shifted over time. Week 1's
  current lines are a clearly-marked sample, same as the Week 1 history entry, since real books
  haven't posted 2026 lines this far out. Unlike every other data file, odds are published live
  through a Netlify Function + Blobs store rather than a git commit — see "Keeping it current"
  below.
- **Impact players / injury statuses**: **illustrative placeholder data**,
  not a real injury report. Built in July 2026, about 7 weeks before Week 1 —
  real injury designations aren't published until practice reports come out
  during game week. Statuses like Justin Herbert "out" or Joe Burrow
  "questionable" are staged examples to demonstrate the feature, not actual
  news.

## Keeping it current

This is automated across two scheduled tasks, which deliberately use two different
publishing paths so they don't collide with each other or with Netlify's deploy budget.

`nfl-matchup-analyzer-weekly-update` runs every Tuesday at 9am and is the **only** task
that touches git. It archives completed preseason rounds (Hall of Fame Game, Preseason
Weeks 1-3) as soon as they finish, and once the regular season starts (Sept 9, 2026),
each run checks whether a new week has finished, and if so: pulls that week's final
scores and updated team stats/injury report from public sources, archives a
`data/history.json` snapshot for that week (replacing the Week 1 sample once real Week 1
is played), refreshes `data/teams.json` and `data/impact-players.json` with current
numbers, and rebuilds `index.html` in place. Once Week 18 wraps up, the same task also
researches and fills in each playoff round as it's announced, and continues archiving
results for weeks 19-22 (Wild Card through Super Bowl). It commits and pushes to GitHub
whenever it changes something — roughly weekly, well inside Netlify's ~20 free
deploys/month.

`blitz-odds-odds-refresh` runs every 15 minutes, 8am-11pm local, Aug through Feb
(preseason through the playoffs), and pulls real lines from the SportsGameOdds API's
free tier, self-throttling against its 2,500-objects/month cap. Instead of committing
to git, it `POST`s updates to `netlify/functions/odds-update.mts`, which writes to a
Netlify Blobs store; the live site's `odds-current` function serves that store to the
page at runtime. This means odds can refresh as often as every 15 minutes without ever
costing a deploy credit or fighting the weekly task for the git repo. It also mirrors
`data/odds-2026.json` / `data/odds-history.json` on disk (without committing them) so
the weekly task's `index.html` rebuild always picks up current odds.

## Working conventions for Claude

Any push to `main` triggers a live Netlify deploy of this site, so for changes
made interactively in chat (not the automated weekly task above): show a
summary of what changed and get explicit approval from Dan before running
`git push`. The weekly scheduled task is exempt from this and keeps
auto-pushing on its own, as described above.

## Path to a native mobile app

You said you might want native iOS/Android apps later. `js/predictionEngine.js`
was written with that in mind: it's plain JS with zero DOM or React
dependency, wrapped so it works unmodified in a React Native project (or a
Node backend) — `require('./predictionEngine.js')` just works. When you're
ready, a React Native app would reuse this file as-is and rebuild only the UI
layer (View/Text components instead of div/span, a real navigator instead of
a CSS grid). I can't build/publish to the App Store or Play Store from here,
but I can write the React Native source for you to build with Xcode/Android
Studio.

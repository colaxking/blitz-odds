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
deploys, so there's no downtime during the swap). The weekly scheduled task
commits and pushes automatically after each data refresh.

## Open it locally

Double-click `index.html` (or open it in any browser). No install, no build
step, no server required — works on desktop and on a phone browser.

## What's inside

```
nfl-matchup-analyzer/
├── index.html                 # the app (self-contained, data embedded)
├── js/predictionEngine.js     # portable prediction logic (no React/DOM dependency)
└── data/
    ├── teams.json             # 2025 season final offense/defense stats + ranks, all 32 teams
    ├── impact-players.json    # sample injury/impact-player data (see disclaimer below)
    ├── schedule-week1-2026.json  # real 2026 Week 1 schedule (kept for reference)
    ├── schedule-full-2026.json   # full 18-week 2026 regular season schedule
    ├── schedule-playoffs-2026.json  # postseason bracket, filled in round-by-round once seeding is known
    ├── odds-2026.json         # real sportsbook lines by week (spread/moneyline/O-U), filled in as they post
    └── history.json           # weekly archive: frozen stats + predictions + final scores
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

`index.html` embeds copies of the six JSON files directly in the page so it
can be opened straight from disk without hitting browser file:// security
restrictions. The `data/` files are the source of truth — edit them, then
re-run the same templating step to refresh `index.html` (or ask me to do it).

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
- **Betting odds**: real sportsbook lines researched from public odds sources and refreshed
  weekly (and re-checked as kickoff approaches, since lines move). They're shown purely as
  an independent reference point next to the model's own prediction — the model doesn't use
  odds as an input, so a "model disagrees with the market" note just means the two takes
  differ. Week 1's current lines are a clearly-marked sample, same as the Week 1 history
  entry, since real books haven't posted 2026 lines this far out.
- **Impact players / injury statuses**: **illustrative placeholder data**,
  not a real injury report. Built in July 2026, about 7 weeks before Week 1 —
  real injury designations aren't published until practice reports come out
  during game week. Statuses like Justin Herbert "out" or Joe Burrow
  "questionable" are staged examples to demonstrate the feature, not actual
  news.

## Keeping it current

This is now automated: a scheduled task (`nfl-matchup-analyzer-weekly-update`) runs
every Tuesday at 9am. Once the season starts (Sept 9, 2026), each run checks whether
a new week has finished, and if so: pulls that week's final scores and updated team
stats/injury report from public sources, archives a `data/history.json` snapshot for
that week (replacing the Week 1 sample once real Week 1 is played), refreshes
`data/teams.json` and `data/impact-players.json` with current numbers, and rebuilds
`index.html` in place — all directly in this folder, since it's now connected. Before
the season starts, the weekly run just checks and exits without changing anything.
Once Week 18 wraps up, the same task also researches and fills in each playoff round
as it's announced, and continues archiving results for weeks 19-22 (Wild Card through
Super Bowl). Every run, it also checks for freshly posted betting lines on the next
week or two of games and updates `data/odds-2026.json` accordingly. Finally, if
anything changed, it commits and pushes to GitHub, which triggers Netlify to
rebuild and publish the live site automatically — no manual redeploy needed.

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

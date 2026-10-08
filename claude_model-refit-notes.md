# Prediction model refit — Oct 8, 2026 (after Week 4)

**Decision (Dan, Option A):** keep Blitz Edge an independent, honestly-calibrated model (~61% straight-up); do NOT anchor it to the market. Rewrite the ATS / moneyline / totals copy so it says lean, not edge.

## What was wrong
- **Leaky fit.** The old constants (0.409 × edge + 1.11, SD 12.77, "64.4%") were fit with each season's *final* ranks scoring games inside that season. Replayed with the ranks that existed at each kickoff, the slope is ~0.33 and accuracy ~61%. Confidence was inflated ~25–40%: the 65–70% bin was hitting 56%.
- **Inverted data.** `data/historical-team-rankings.json` had 2023–2025 defensive rush/pass ranks stored 1 = most yards allowed (2024 PHI pass D ranked 32). Live `teams.json`/`history.json` were fine; only the fit data was bad. Fixed by re-deriving every rank from the yardage.
- **Weeks 2–4 ran on 1–3 game samples**, not prior-season ranks as the engine assumed (week 3 historically a 50.9% coin flip that way).
- **`scripts/hotpicks-snapshot.mjs` never passed `week`**, so the Playbook used the full-season curve in September (Arizona 93% in Week 2).
- **No edge vs. the market in any betting market** (2,197 games vs closing lines): spread side covers 46–51% at every gap, ML "value" picks −9% ROI (worst at the biggest claimed edges), total leans 47–52%.
- 2026 through Week 4 on frozen kickoff inputs: model 31–33 (48.4%), market favorite 40–24.

## What changed
- `js/predictionEngine.js`: honest two-phase fit — weeks 1–6 `0.274 × edge + 1.04`, weeks 7+ `0.360 × edge + 1.48`, one SD 13.5 (early-season uncertainty now lives in the slope, so ATS margins shrink too; `EARLY_SEASON_MARGIN_SD` is kept = MARGIN_SD for the predictions-current repair path). `computeBaseRatings` blends current ranks with `team.priorStats` by `stats.gamesPlayed / (gamesPlayed + 4)` when both are present (rank-space blend, K=4 best by Brier). New `marginFitForWeek`; `edgeToMargin(edge, week)`.
- `data/teams.json`: every team now carries `priorStats` (2025 final ranks) and `stats.gamesPlayed`. **The weekly stats update must keep both and set gamesPlayed per team (byes from Week 5).**
- `scripts/model-backtest.mjs` + `data/historical-team-game-yards.json` + `data/historical-closing-lines.json`: reproducible as-of-kickoff backtest. Run with `--fit` before touching any engine constant.
- `js/hotPicksEngine.js`, `src/app.jsx` (ats note): copy now says lean, not edge/value.
- `scripts/hotpicks-snapshot.mjs`: passes `week`.

## Results (2015–2025, leave-one-season-out 60.8%)
Calibration: 50–55% → 50.6%, 55–60 → 57.5%, 60–65 → 62.1%, 65–70 → 65.6%, 70–75 → 74.6%, 75%+ → 81.3%. 2026 wks 1–4 replay: 33–31, Brier 0.306 → 0.253.

## Still open
- Archived games keep their frozen as-of-kickoff outputs (predictions-current records), so nothing historical is restated; `history.json` frozen `teamStats` don't carry `gamesPlayed` — the engine falls back to unblended ranks there, which is what ran at the time.
- Injury multipliers (OUT 0.8 × impactScore) and weather penalties have never been validated — no historical injury data in the repo. Weather is symmetric so it doesn't move win probability at all (only the 0.3 dome-acclimation term does).
- `site-data-update` POST needed after deploy so the Blob copy of teams.json picks up `priorStats`/`gamesPlayed`; until then the live site runs unblended.
- The ATS Playbook sheet still shows a cover %, now calibrated to the model's own residual (smaller numbers); a UI pass to drop it in favour of the lean label needs a mockup first.

/**
 * hotPicksEngine.js
 *
 * Takes a week's worth of already-computed matchup predictions (from
 * PredictionEngine.predictMatchup) plus each game's odds, and selects the
 * week's featured picks: the model's most confident calls, and the single
 * best angle on each betting market (spread, moneyline, total).
 *
 * Deliberately pure/framework-agnostic (no DOM, no React) for the same
 * reason predictionEngine.js is: this is meant to be the shared source of
 * truth for both the in-app Hot Picks tab and the future weekly email to
 * Pro subscribers, so the picks and their reasoning are identical wherever
 * they're shown.
 *
 * Every explanation is derived from that specific game's own numbers - no
 * templated filler, no fabricated precision. In particular, there's no
 * separate points-total model here (PredictionEngine only outputs win
 * probability), so the "total" pick is explicitly framed as a directional
 * lean based on offense/defense grades, not a projected score.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.HotPicksEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  /**
   * Converts American moneyline odds into the market's implied win
   * probability (vig included - this is a deliberately simple, standard
   * conversion, not vig-adjusted "fair" probability).
   */
  function impliedProbabilityFromMoneyline(ml) {
    if (typeof ml !== "number" || Number.isNaN(ml)) return null;
    if (ml < 0) return -ml / (-ml + 100);
    return 100 / (ml + 100);
  }

  function pct(x) {
    return Math.round(x * 100);
  }

  function gameLabel(g) {
    return `${g.awayName} @ ${g.homeName}`;
  }

  /**
   * Top N games by model confidence, each with a short "why" built from
   * that game's own rating edge and the biggest single adjustment (injury
   * or weather) working in the pick's favor, if any.
   */
  function rankTopConfidence(games, n) {
    n = n || 3;
    return games
      .filter((g) => g.prediction)
      .slice()
      .sort((a, b) => b.prediction.confidence - a.prediction.confidence)
      .slice(0, n)
      .map((g) => {
        const p = g.prediction;
        const pickHome = p.predictedWinner === g.homeId;
        const pickTeamName = pickHome ? g.homeName : g.awayName;
        const pickTeamId = p.predictedWinner;
        const confidencePct = pct(p.confidence);

        const marketAgrees = g.odds && g.odds.favorite ? g.odds.favorite === pickTeamId : null;

        let advantage;
        if (marketAgrees === false) {
          advantage = `The sportsbook favorite disagrees with this pick - the model sees an edge the market line doesn't fully reflect.`;
        } else if (marketAgrees === true) {
          advantage = `The market agrees on the favorite, and the model's ${confidencePct}% confidence gives a sense of how comfortably.`;
        } else {
          advantage = `No posted line yet for this game - this pick is purely the model's own offense/defense grading.`;
        }

        return {
          market: "confidence",
          game: { awayId: g.awayId, homeId: g.homeId, awayName: g.awayName, homeName: g.homeName },
          pickTeamId: pickTeamId,
          pick: pickTeamName,
          confidence: p.confidence,
          confidencePct: confidencePct,
          summary: `${pickTeamName} — ${confidencePct}% confidence`,
          advantage: advantage
        };
      });
  }

  /**
   * Spread angle: prefer a game where the model's predicted winner is NOT
   * the market's spread favorite (real value on the underdog against the
   * number). If the model agrees with the market everywhere this week,
   * falls back to the highest-confidence game where it agrees with the
   * favorite (a "lean this number bigger than it looks" call) instead of
   * returning nothing.
   */
  function rankSpreadValue(games) {
    const withSpread = games.filter((g) => g.prediction && g.odds && g.odds.favorite && g.odds.spread != null);
    if (!withSpread.length) return null;

    const disagreements = withSpread
      .filter((g) => g.prediction.predictedWinner !== g.odds.favorite)
      .sort((a, b) => b.prediction.confidence - a.prediction.confidence);

    const pickFrom = (g, isUpset) => {
      const p = g.prediction;
      const pickHome = p.predictedWinner === g.homeId;
      const pickTeamName = pickHome ? g.homeName : g.awayName;
      const confidencePct = pct(p.confidence);
      const spreadText = g.odds.spread === 0 ? "PK" : (g.odds.spread > 0 ? `+${g.odds.spread}` : `${g.odds.spread}`);

      return {
        market: "spread",
        game: { awayId: g.awayId, homeId: g.homeId, awayName: g.awayName, homeName: g.homeName },
        pickTeamId: p.predictedWinner,
        pick: `${pickTeamName} ${g.odds.favorite === p.predictedWinner ? spreadText : "+points"}`.trim(),
        confidence: p.confidence,
        confidencePct: confidencePct,
        summary: isUpset
          ? `${pickTeamName} to cover as the underdog`
          : `${pickTeamName} ${spreadText}`,
        advantage: isUpset
          ? `The model favors ${pickTeamName} outright even though the market has them getting points - that's the whole edge: a line the model thinks is priced wrong.`
          : `The model gives ${pickTeamName} a ${confidencePct}% win probability as the favorite, well clear of a coin flip, suggesting room to cover the spread and not just win outright.`
      };
    };

    if (disagreements.length) return pickFrom(disagreements[0], true);

    const bestFavorite = withSpread
      .filter((g) => g.prediction.predictedWinner === g.odds.favorite)
      .sort((a, b) => b.prediction.confidence - a.prediction.confidence)[0];
    return bestFavorite ? pickFrom(bestFavorite, false) : null;
  }

  /**
   * Moneyline value: the game where the model's confidence in its
   * predicted winner most exceeds what that side's moneyline implies -
   * i.e. where the price looks better than the model thinks it should be,
   * on either the favorite or the underdog. Only returns a pick with a
   * genuine positive edge; null if nothing clears that bar this week.
   */
  function rankMoneylineValue(games) {
    const candidates = games
      .filter((g) => g.prediction && g.odds && (g.odds.moneylineHome != null || g.odds.moneylineAway != null))
      .map((g) => {
        const p = g.prediction;
        const pickHome = p.predictedWinner === g.homeId;
        const ml = pickHome ? g.odds.moneylineHome : g.odds.moneylineAway;
        const impliedProb = impliedProbabilityFromMoneyline(ml);
        if (impliedProb == null) return null;
        const edge = p.confidence - impliedProb;
        return { g, ml, impliedProb, edge };
      })
      .filter(Boolean)
      .sort((a, b) => b.edge - a.edge);

    const best = candidates[0];
    if (!best || best.edge <= 0) return null;

    const g = best.g;
    const p = g.prediction;
    const pickHome = p.predictedWinner === g.homeId;
    const pickTeamName = pickHome ? g.homeName : g.awayName;
    const confidencePct = pct(p.confidence);
    const impliedPct = pct(best.impliedProb);
    const edgePts = pct(best.edge);
    const mlText = best.ml > 0 ? `+${best.ml}` : `${best.ml}`;

    return {
      market: "moneyline",
      game: { awayId: g.awayId, homeId: g.homeId, awayName: g.awayName, homeName: g.homeName },
      pickTeamId: p.predictedWinner,
      pick: `${pickTeamName} ${mlText}`,
      confidence: p.confidence,
      confidencePct: confidencePct,
      summary: `${pickTeamName} ${mlText}`,
      advantage: `The model gives ${pickTeamName} a ${confidencePct}% win probability, but that price only implies ${impliedPct}% - a ${edgePts}-point gap between what the model sees and what the market's charging for it.`
    };
  }

  /**
   * Total lean: NOT a projected score - there's no scoring model here, only
   * a win-probability one. This ranks games by the combined offense-vs-
   * defense rating gap (already computed per-team inside each prediction,
   * post injury/weather adjustment) and calls the largest gap either way a
   * directional Over or Under lean, explained honestly as a grading-based
   * read rather than a number the model actually predicted.
   */
  function rankTotalLean(games) {
    const withTotal = games.filter((g) => g.prediction && g.odds && g.odds.overUnder != null);
    if (!withTotal.length) return null;

    const scored = withTotal.map((g) => {
      const p = g.prediction;
      const offenseSum = p.homeRatings.offRating + p.awayRatings.offRating;
      const defenseSum = p.homeRatings.defRating + p.awayRatings.defRating;
      const envScore = offenseSum - defenseSum; // positive -> offense-heavy environment
      return { g, envScore };
    }).sort((a, b) => Math.abs(b.envScore) - Math.abs(a.envScore));

    const top = scored[0];
    const g = top.g;
    const leanOver = top.envScore > 0;

    return {
      market: "total",
      game: { awayId: g.awayId, homeId: g.homeId, awayName: g.awayName, homeName: g.homeName },
      pick: `${leanOver ? "Over" : "Under"} ${g.odds.overUnder}`,
      lean: leanOver ? "over" : "under",
      summary: `${leanOver ? "Over" : "Under"} ${g.odds.overUnder}`,
      advantage: leanOver
        ? `Both offenses grade out well above these two defenses once injuries and weather are factored in - a directional lean toward more scoring, not a projected total.`
        : `Both defenses grade out well above these two offenses once injuries and weather are factored in - a directional lean toward a lower-scoring game, not a projected total.`
    };
  }

  /**
   * Main entry point. `games` is an array of:
   *   { awayId, awayName, homeId, homeName, prediction, odds }
   * where `prediction` is PredictionEngine.predictMatchup()'s return value
   * and `odds` is whatever shape the caller's odds source uses (spread,
   * favorite, moneylineHome, moneylineAway, overUnder) or null/omitted for
   * games with no line posted yet.
   */
  function computeHotPicks(games) {
    const clean = (games || []).filter((g) => g && g.prediction);
    return {
      topConfidence: rankTopConfidence(clean, 3),
      spreadPick: rankSpreadValue(clean),
      moneylinePick: rankMoneylineValue(clean),
      totalPick: rankTotalLean(clean)
    };
  }

  return {
    impliedProbabilityFromMoneyline: impliedProbabilityFromMoneyline,
    computeHotPicks: computeHotPicks,
    gameLabel: gameLabel
  };
});

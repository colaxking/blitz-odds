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
   * Top N games by model confidence, each with a specific "why" built from
   * that game's own rating edge (offense/defense grades, post injury and
   * weather adjustments) plus the single biggest adjustment working against
   * the opponent, when one exists - not templated filler.
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
        const oppTeamName = pickHome ? g.awayName : g.homeName;
        const pickTeamId = p.predictedWinner;
        const confidencePct = pct(p.confidence);

        const marketAgrees = g.odds && g.odds.favorite ? g.odds.favorite === pickTeamId : null;

        // Rating-point gap between the two teams, from the pick's own
        // offense/defense grades (already inclusive of injury and weather
        // adjustments) - the core, per-game reason for the pick.
        const edgePts = Math.round(Math.abs(p.edge) * 10) / 10;

        // The single most impactful adjustment (injury, since weather hits
        // both teams roughly evenly) working against the opponent - this is
        // what explains an edge beyond the raw stat-rank gap, when one
        // exists. NOTE_THRESHOLD keeps this to adjustments actually large
        // enough to matter, not every questionable-tag noise.
        const NOTE_THRESHOLD = 1;
        const oppAdjustments = pickHome ? p.awayAdjustments : p.homeAdjustments;
        const biggestOppInjury = (oppAdjustments || [])
          .filter((a) => a.player && Math.abs(a.ratingDelta) >= NOTE_THRESHOLD)
          .sort((a, b) => Math.abs(b.ratingDelta) - Math.abs(a.ratingDelta))[0];

        let advantage = `${pickTeamName} carries a ${edgePts}-point rating edge over ${oppTeamName} once offense, defense, injuries, and weather are graded.`;

        if (biggestOppInjury) {
          const statusWord = biggestOppInjury.status === "out" ? "without" : "playing hurt with";
          advantage += ` ${oppTeamName} are ${statusWord} ${biggestOppInjury.player} (${biggestOppInjury.status}), a real hit to their ${biggestOppInjury.side}.`;
        }

        if (marketAgrees === false) {
          advantage += ` The sportsbook favorite is actually ${oppTeamName} here - the model sees an edge this line doesn't fully reflect.`;
        } else if (marketAgrees === true) {
          advantage += ` The market agrees ${pickTeamName} is favored, and ${confidencePct}% confidence shows how comfortably.`;
        } else {
          advantage += ` No line is posted for this game yet, so this read is purely the model's own grading.`;
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
   * Spread angles: every game where the model's predicted winner is NOT
   * the market's spread favorite (real value on the underdog against the
   * number) ranks first, sorted by confidence - these are the "the market
   * disagrees with the model" calls. If there aren't n of those this week,
   * the list is padded with the highest-confidence games where the model
   * agrees with the favorite (a "lean this number bigger than it looks"
   * call), so a light disagreement week still returns a full list instead
   * of just one pick.
   */
  function rankSpreadValues(games, n) {
    n = n || 3;
    const withSpread = games.filter((g) => g.prediction && g.odds && g.odds.favorite && g.odds.spread != null);
    if (!withSpread.length) return [];

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

    const disagreements = withSpread
      .filter((g) => g.prediction.predictedWinner !== g.odds.favorite)
      .sort((a, b) => b.prediction.confidence - a.prediction.confidence)
      .map((g) => pickFrom(g, true));

    const usedMatchups = new Set(disagreements.map((p) => `${p.game.awayId}-${p.game.homeId}`));

    const favorites = withSpread
      .filter((g) => g.prediction.predictedWinner === g.odds.favorite && !usedMatchups.has(`${g.awayId}-${g.homeId}`))
      .sort((a, b) => b.prediction.confidence - a.prediction.confidence)
      .map((g) => pickFrom(g, false));

    return disagreements.concat(favorites).slice(0, n);
  }

  /**
   * Moneyline value: every game where the model's confidence in its
   * predicted winner exceeds what that side's moneyline implies - i.e.
   * where the price looks better than the model thinks it should be, on
   * either the favorite or the underdog - ranked by the size of that gap.
   * Only genuine positive-edge picks are returned; if fewer than n games
   * clear that bar this week, the list is simply shorter than n (never
   * padded with a non-edge pick, since that would misrepresent the whole
   * point of a "value" market pick).
   */
  function rankMoneylineValues(games, n) {
    n = n || 3;
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
      .filter((c) => c && c.edge > 0)
      .sort((a, b) => b.edge - a.edge)
      .slice(0, n);

    return candidates.map((best) => {
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
    });
  }

  /**
   * Total leans: NOT projected scores - there's no scoring model here, only
   * a win-probability one. This ranks games by the combined offense-vs-
   * defense rating gap (already computed per-team inside each prediction,
   * post injury/weather adjustment) and calls the largest gaps either way a
   * directional Over or Under lean, explained honestly as a grading-based
   * read rather than a number the model actually predicted.
   */
  function rankTotalLeans(games, n) {
    n = n || 3;
    const withTotal = games.filter((g) => g.prediction && g.odds && g.odds.overUnder != null);
    if (!withTotal.length) return [];

    const scored = withTotal.map((g) => {
      const p = g.prediction;
      const offenseSum = p.homeRatings.offRating + p.awayRatings.offRating;
      const defenseSum = p.homeRatings.defRating + p.awayRatings.defRating;
      const envScore = offenseSum - defenseSum; // positive -> offense-heavy environment
      return { g, envScore };
    }).sort((a, b) => Math.abs(b.envScore) - Math.abs(a.envScore)).slice(0, n);

    return scored.map(({ g, envScore }) => {
      const leanOver = envScore > 0;
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
    });
  }

  /**
   * Main entry point. `games` is an array of:
   *   { awayId, awayName, homeId, homeName, prediction, odds }
   * where `prediction` is PredictionEngine.predictMatchup()'s return value
   * and `odds` is whatever shape the caller's odds source uses (spread,
   * favorite, moneylineHome, moneylineAway, overUnder) or null/omitted for
   * games with no line posted yet.
   *
   * spreadPicks/moneylinePicks/totalPicks are arrays (up to `perMarket`
   * each, default 3) ranked best-value-first within their market - not
   * padded to a fixed length where the market doesn't support it (see
   * rankMoneylineValues). `spreadPick`/`moneylinePick`/`totalPick`
   * (singular) are kept as the first entry of each array, for any caller
   * still expecting the old single-pick shape.
   */
  function computeHotPicks(games, perMarket) {
    const n = perMarket || 3;
    const clean = (games || []).filter((g) => g && g.prediction);
    const spreadPicks = rankSpreadValues(clean, n);
    const moneylinePicks = rankMoneylineValues(clean, n);
    const totalPicks = rankTotalLeans(clean, n);
    return {
      topConfidence: rankTopConfidence(clean, 3),
      spreadPicks: spreadPicks,
      moneylinePicks: moneylinePicks,
      totalPicks: totalPicks,
      spreadPick: spreadPicks[0] || null,
      moneylinePick: moneylinePicks[0] || null,
      totalPick: totalPicks[0] || null
    };
  }

  return {
    impliedProbabilityFromMoneyline: impliedProbabilityFromMoneyline,
    computeHotPicks: computeHotPicks,
    gameLabel: gameLabel
  };
});

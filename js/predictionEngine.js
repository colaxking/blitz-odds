/**
 * predictionEngine.js
 *
 * Pure, framework-agnostic logic for the NFL Matchup Analyzer.
 * No DOM or React dependency here on purpose: this file can be copied as-is
 * into a React Native app (or a Node backend) later without changes.
 *
 * Exposed as `window.PredictionEngine` for the browser build, and via
 * `module.exports` for Node/RN environments.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PredictionEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  var NUM_TEAMS = 32;

  // Weighting for each rank category when rolling up into one offense/defense
  // rating. Total yardage counts most since it already captures run+pass,
  // run/pass individually add texture (e.g. a run-funnel matchup).
  var WEIGHTS = {
    total: 0.5,
    run: 0.25,
    pass: 0.25
  };

  // Home field advantage, expressed in the same 0-32 rating-point scale.
  var HOME_FIELD_BONUS = 1.5;

  // Injury impact: an "out" player subtracts (impactScore * OUT_MULTIPLIER)
  // rating points from their side of the ball (offense if the player is
  // offensive, defense if defensive). "questionable" applies a half-weight
  // version of the same adjustment, since the player may still play limited
  // snaps.
  var OUT_MULTIPLIER = 0.8;
  var QUESTIONABLE_MULTIPLIER = 0.35;

  var DEFENSIVE_POSITIONS = { "Edge": 1, "DE": 1, "DT": 1, "LB": 1, "OLB": 1, "ILB": 1, "MLB": 1, "CB": 1, "S": 1, "DL": 1 };
  
  /** Convert a 1..32 rank (1 = best) into a 1..32 score (32 = best). */
  function rankToScore(rank) {
    return (NUM_TEAMS + 1) - rank;
  }

  /**
   * Roll a team's raw rank data into single offense/defense ratings.
   * @param {Object} team - entry from teams.json (has .stats.offense / .stats.defense with rankRush/rankPass/rankTotal)
   * @returns {{offRating:number, defRating:number}}
   */
  function computeBaseRatings(team) {
    var off = team.stats.offense;
    var def = team.stats.defense;

    var offRating =
      rankToScore(off.rankTotal) * WEIGHTS.total +
      rankToScore(off.rankRush) * WEIGHTS.run +
      rankToScore(off.rankPass) * WEIGHTS.pass;

    var defRating =
      rankToScore(def.rankTotal) * WEIGHTS.total +
      rankToScore(def.rankRush) * WEIGHTS.run +
      rankToScore(def.rankPass) * WEIGHTS.pass;

    return { offRating: offRating, defRating: defRating };
  }

  /**
   * Apply injury adjustments for a team's list of impact players.
   * @param {{offRating:number, defRating:number}} ratings
   * @param {Array<{name:string,position:string,impactScore:number,status:string,espnId?:string}>} impactPlayers
   * @returns {{offRating:number, defRating:number, adjustments:Array}}
   */
  function applyInjuryAdjustments(ratings, impactPlayers) {
    var offRating = ratings.offRating;
    var defRating = ratings.defRating;
    var adjustments = [];

    (impactPlayers || []).forEach(function (p) {
      var multiplier = 0;
      if (p.status === "out") multiplier = OUT_MULTIPLIER;
      else if (p.status === "questionable") multiplier = QUESTIONABLE_MULTIPLIER;
      if (multiplier === 0) return;

      var delta = p.impactScore * multiplier;
      var isDefensive = !!DEFENSIVE_POSITIONS[p.position];

      if (isDefensive) {
        defRating -= delta;
      } else {
        offRating -= delta;
      }

      adjustments.push({
        player: p.name,
        position: p.position,
        // Carried through so the card can join this adjustment to ESPN's
        // injury feed. Joining on name would silently drop players - two
        // different NFL players share a name often enough that it matters.
        espnId: p.espnId || null,
        status: p.status,
        side: isDefensive ? "defense" : "offense",
        ratingDelta: -delta,
        injury: p.injury || null
      });
    });

    return { offRating: offRating, defRating: defRating, adjustments: adjustments };
  }

  // Weather adjustment thresholds, in the same 0-32 rating-point scale used
  // everywhere else in this file. These apply to BOTH teams' offense equally
  // (weather doesn't pick sides) except the dome-acclimation penalty, which
  // only hits whichever team's home stadium is a dome (they're less used to
  // playing in the elements).
  var COLD_TEMP_F = 32;
  var EXTREME_COLD_TEMP_F = 20;
  var COLD_OFFENSE_PENALTY = 0.4;
  var EXTREME_COLD_OFFENSE_PENALTY = 0.8;

  var WIND_MPH_THRESHOLD = 15;
  var WIND_MPH_SEVERE = 25;
  var WIND_OFFENSE_PENALTY = 0.6;
  var WIND_OFFENSE_PENALTY_SEVERE = 1.2;

  var PRECIP_CHANCE_THRESHOLD = 50; // percent
  var PRECIP_OFFENSE_PENALTY = 0.5;
  var PRECIP_DEFENSE_BONUS = 0.2; // league-wide: turnovers rise in bad weather

  var DOME_ACCLIMATION_PENALTY = 0.3;

  /**
   * Apply weather adjustments for an outdoor game. No-op if weather is
   * missing or the game is at a dome (isDome true means no weather effect
   * at all, since the roof is closed).
   * @param {{offRating:number, defRating:number}} ratings
   * @param {Object} [weather] - { tempF, windMph, precipChance }
   * @param {boolean} [isTeamDomeTeam] - true if this team's own home stadium is a dome
   * @returns {{offRating:number, defRating:number, adjustments:Array}}
   */
  function applyWeatherAdjustments(ratings, weather, isTeamDomeTeam) {
    var offRating = ratings.offRating;
    var defRating = ratings.defRating;
    var adjustments = [];

    if (!weather || weather.isDome) {
      return { offRating: offRating, defRating: defRating, adjustments: adjustments };
    }

    if (typeof weather.tempF === "number") {
      if (weather.tempF < EXTREME_COLD_TEMP_F) {
        offRating -= EXTREME_COLD_OFFENSE_PENALTY;
        adjustments.push({ factor: "extreme-cold", tempF: weather.tempF, ratingDelta: -EXTREME_COLD_OFFENSE_PENALTY });
      } else if (weather.tempF < COLD_TEMP_F) {
        offRating -= COLD_OFFENSE_PENALTY;
        adjustments.push({ factor: "cold", tempF: weather.tempF, ratingDelta: -COLD_OFFENSE_PENALTY });
      }
    }

    if (typeof weather.windMph === "number") {
      if (weather.windMph >= WIND_MPH_SEVERE) {
        offRating -= WIND_OFFENSE_PENALTY_SEVERE;
        adjustments.push({ factor: "severe-wind", windMph: weather.windMph, ratingDelta: -WIND_OFFENSE_PENALTY_SEVERE });
      } else if (weather.windMph >= WIND_MPH_THRESHOLD) {
        offRating -= WIND_OFFENSE_PENALTY;
        adjustments.push({ factor: "wind", windMph: weather.windMph, ratingDelta: -WIND_OFFENSE_PENALTY });
      }
    }

    if (typeof weather.precipChance === "number" && weather.precipChance >= PRECIP_CHANCE_THRESHOLD) {
      offRating -= PRECIP_OFFENSE_PENALTY;
      defRating += PRECIP_DEFENSE_BONUS;
      adjustments.push({ factor: "precipitation", precipChance: weather.precipChance, ratingDelta: -PRECIP_OFFENSE_PENALTY });
    }

    if (isTeamDomeTeam) {
      offRating -= DOME_ACCLIMATION_PENALTY;
      adjustments.push({ factor: "dome-team-acclimation", ratingDelta: -DOME_ACCLIMATION_PENALTY });
    }

    return { offRating: offRating, defRating: defRating, adjustments: adjustments };
  }

  /**
   * Win probability for the home team, derived from the predicted margin.
   *
   * This used to be a separate logistic on edge (scale 36). That left the
   * engine with two different curves from the same `edge` to a probability -
   * this one, and the margin fit below that the ats cover numbers use - and
   * they disagreed: the logistic read ~3.5 points low at edge 0 and ~2 points
   * high at edge 30, so the same game could be described two ways depending
   * on which sheet you were looking at.
   *
   * Scoring both against the 2,761 regular-season games in
   * data/historical-games-index.json (2015 onward, each scored with that
   * season's rankings from data/historical-team-rankings.json):
   *
   *   logistic scale 36   Brier 0.2184   logloss 0.6261   64.2% accurate
   *   margin fit          Brier 0.2167   logloss 0.6220   64.4% accurate
   *
   * The margin route wins on all three, and re-fitting it against the same
   * games lands on 0.405 * edge + 1.11 - within rounding of the 0.409 already
   * shipped, i.e. it's already at its optimum. (The logistic, for what it's
   * worth, wasn't even the best logistic: its own best-fit scale is 44, not
   * 36.) So there is now one curve, and predictedMargin and confidence are
   * the same number expressed two ways rather than two estimates that have
   * to be kept in step by hand.
   *
   * Note this shifts which team is favored in the narrow band where the
   * predicted margin crosses zero (edge between about -2.7 and 0 now favors
   * the home team, on the residual home-field the intercept carries). That's
   * the change that moves accuracy 64.2% -> 64.4%. Ranking by confidence is
   * unaffected: both curves are monotonic in edge, so the confidence ladder
   * hands out the same points in the same order.
   */
  function marginToWinProbability(predictedHomeMargin, week) {
    return normalCdf(predictedHomeMargin / marginSdForWeek(week));
  }

  // ---- Margin / cover model -------------------------------------------------
  // A win probability is the wrong currency for an against-the-spread pool:
  // a team can be a heavy favorite to win and still a bad bet to cover. What
  // an ats pick needs is a *margin* in points, which can be compared against
  // the market's line.
  //
  // These three numbers come from an ordinary least-squares fit over the
  // 2,772 regular-season games in data/historical-games-index.json (2015
  // onward), scoring each with that season's team rankings from
  // data/historical-team-rankings.json:
  //
  //   actual home margin ~= 0.409 * edge + 1.11   (residual SD 12.77 pts)
  //
  // The intercept is small residual home-field the rating bonus doesn't
  // already capture. The SD is close to the ~13.5 the market itself prices
  // NFL margins at, which is the sanity check that the fit isn't overfit.
  //
  // Caveat for whoever revisits this: the *margin* fit is validated, but the
  // resulting cover percentages are NOT backtested against real closing
  // lines - data/odds-history.json only covers the current season, so there
  // are no historical spreads to score against. Treat the cover number as
  // calibrated-by-construction, not proven.
  var MARGIN_PER_EDGE = 0.409;
  var MARGIN_INTERCEPT = 1.11;
  var MARGIN_SD = 12.77;

  // Early-season residual spread. MARGIN_SD above was fit on games where the
  // offense/defense ranks come from the season being played. In weeks 1-4 the
  // ranks are still last season's finals (teams.json only rolls over once
  // there are enough games to rank), so the same predicted margin carries
  // less information than the fitted SD implies and the CDF turns it into far
  // too much confidence.
  //
  // Backtest over 3,534 games in data/historical-games-index.json, scoring
  // each season's weeks 1-4 using the PRIOR season's final ranks from
  // data/historical-team-rankings.json (n=667):
  //
  //   residual SD, wk1-4 prior-season ranks .... 13.73  (bias -0.29)
  //   residual SD, wk1-4 same-season ranks ..... 12.56  (bias -0.29)
  //   residual SD, wk5+  same-season ranks ..... 12.84  (bias +0.08)
  //   Brier-optimal SD, wk1-4 prior ranks ...... 18.75
  //   Brier-optimal SD, wk5+  same ranks ....... 13.00  (MARGIN_SD is right)
  //
  // Calibration by confidence bin, wk1-4 on prior-season ranks:
  //
  //           SD=12.77            SD=18.75
  //   bin     pred    actual      pred    actual
  //   50-60%  54.8%   53.0%       54.8%   55.2%
  //   60-70%  64.7%   61.7%       64.3%   65.6%
  //   70-80%  74.4%   66.4%       74.1%   71.3%
  //   80%+    85.4%   76.7%       (bin empties out)
  //
  // The margins themselves are near-unbiased either way - this only widens
  // the win-probability curve, so predictedMargin, the confidence ORDER, and
  // coverProbability are all unchanged. Caveat: the backtest ran with empty
  // impact-player lists (no historical injury data in the repo), so both arms
  // are apples-to-apples but the absolute SDs are mildly optimistic.
  var EARLY_SEASON_MARGIN_SD = 18.75;
  var EARLY_SEASON_LAST_WEEK = 4;

  /**
   * Residual SD to use for a given week. Weeks <= 4 of the regular season run
   * on prior-season ranks and need the wider curve; anything else (including
   * an unknown/omitted week) gets the fitted MARGIN_SD, so a missed call site
   * degrades to exactly today's behaviour rather than throwing.
   */
  function marginSdForWeek(week) {
    // Guard null explicitly: Number(null) is 0, which would otherwise slip
    // through the <= 4 test and hand the wide curve to a call site that
    // simply didn't pass a week. 0 isn't a real week either (preseason is
    // -4..-1, regular season 1..18), so both fall back to MARGIN_SD.
    if (week === null || week === undefined || week === "") return MARGIN_SD;
    var w = Number(week);
    if (!isFinite(w) || w === 0) return MARGIN_SD;
    // Preseason weeks are negative (-4..-1) and also run on prior-season
    // ranks, so they take the wide curve too.
    if (w <= EARLY_SEASON_LAST_WEEK) return EARLY_SEASON_MARGIN_SD;
    return MARGIN_SD;
  }

  /** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation). */
  function normalCdf(z) {
    var sign = z < 0 ? -1 : 1;
    var x = Math.abs(z) / Math.SQRT2;
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
  }

  /** Rating-point edge -> expected home margin in points. */
  function edgeToMargin(edge) {
    return MARGIN_PER_EDGE * edge + MARGIN_INTERCEPT;
  }

  /**
   * Probability that `teamId` covers its side of the posted line.
   * @param {number} predictedHomeMargin - from predictMatchup().predictedMargin
   * @param {string} homeTeamId
   * @param {string} favorite - team the line favors
   * @param {number} spreadForFavorite - stored relative to the favorite (negative), same as odds data
   * @param {string} teamId - side being evaluated
   */
  function coverProbability(predictedHomeMargin, homeTeamId, favorite, spreadForFavorite, teamId) {
    var marketHomeMargin = favorite === homeTeamId ? -spreadForFavorite : spreadForFavorite;
    var isHome = teamId === homeTeamId;
    var modelMargin = isHome ? predictedHomeMargin : -predictedHomeMargin;
    var marketMargin = isHome ? marketHomeMargin : -marketHomeMargin;
    return normalCdf((modelMargin - marketMargin) / MARGIN_SD);
  }

  /**
   * Predict a single matchup.
   * @param {Object} params
   * @param {Object} params.homeTeam - teams.json entry
   * @param {Object} params.awayTeam - teams.json entry
   * @param {Array} [params.homeImpactPlayers]
   * @param {Array} [params.awayImpactPlayers]
   */
  function predictMatchup(params) {
    var homeTeam = params.homeTeam;
    var awayTeam = params.awayTeam;

    var homeBase = computeBaseRatings(homeTeam);
    var awayBase = computeBaseRatings(awayTeam);

    var homeInjuryAdj = applyInjuryAdjustments(homeBase, params.homeImpactPlayers);
    var awayInjuryAdj = applyInjuryAdjustments(awayBase, params.awayImpactPlayers);

    // Weather affects both teams (it's the same game/stadium) but the
    // dome-acclimation penalty is team-specific, so pass each team's own
    // isDomeTeam flag separately.
    var homeAdj = applyWeatherAdjustments(homeInjuryAdj, params.weather, params.homeIsDomeTeam);
    var awayAdj = applyWeatherAdjustments(awayInjuryAdj, params.weather, params.awayIsDomeTeam);
    homeAdj.adjustments = homeInjuryAdj.adjustments.concat(homeAdj.adjustments);
    awayAdj.adjustments = awayInjuryAdj.adjustments.concat(awayAdj.adjustments);

    // Team overall = its offense rating + its defense rating, plus home field.
    var homeOverall = homeAdj.offRating + homeAdj.defRating + HOME_FIELD_BONUS;
    var awayOverall = awayAdj.offRating + awayAdj.defRating;

    var edge = homeOverall - awayOverall; // positive favors home team
    // One curve: the margin model, then the probability that margin implies.
    // Deriving one from the other is what stops them contradicting.
    var predictedMargin = edgeToMargin(edge);
    var homeWinProb = marginToWinProbability(predictedMargin, params.week);

    var winner = homeWinProb >= 0.5 ? homeTeam.id : awayTeam.id;
    var confidence = homeWinProb >= 0.5 ? homeWinProb : 1 - homeWinProb;

    return {
      homeTeamId: homeTeam.id,
      awayTeamId: awayTeam.id,
      homeWinProbability: homeWinProb,
      awayWinProbability: 1 - homeWinProb,
      predictedWinner: winner,
      confidence: confidence,
      edge: edge,
      predictedMargin: predictedMargin,
      homeRatings: homeAdj,
      awayRatings: awayAdj,
      homeAdjustments: homeAdj.adjustments,
      awayAdjustments: awayAdj.adjustments
    };
  }

  return {
    rankToScore: rankToScore,
    computeBaseRatings: computeBaseRatings,
    applyInjuryAdjustments: applyInjuryAdjustments,
    applyWeatherAdjustments: applyWeatherAdjustments,
    marginToWinProbability: marginToWinProbability,
    marginSdForWeek: marginSdForWeek,
    edgeToMargin: edgeToMargin,
    coverProbability: coverProbability,
    normalCdf: normalCdf,
    predictMatchup: predictMatchup,
    constants: {
      NUM_TEAMS: NUM_TEAMS,
      WEIGHTS: WEIGHTS,
      HOME_FIELD_BONUS: HOME_FIELD_BONUS,
      OUT_MULTIPLIER: OUT_MULTIPLIER,
      QUESTIONABLE_MULTIPLIER: QUESTIONABLE_MULTIPLIER,
      COLD_TEMP_F: COLD_TEMP_F,
      EXTREME_COLD_TEMP_F: EXTREME_COLD_TEMP_F,
      WIND_MPH_THRESHOLD: WIND_MPH_THRESHOLD,
      WIND_MPH_SEVERE: WIND_MPH_SEVERE,
      PRECIP_CHANCE_THRESHOLD: PRECIP_CHANCE_THRESHOLD,
      DOME_ACCLIMATION_PENALTY: DOME_ACCLIMATION_PENALTY,
      MARGIN_PER_EDGE: MARGIN_PER_EDGE,
      MARGIN_INTERCEPT: MARGIN_INTERCEPT,
      MARGIN_SD: MARGIN_SD,
      EARLY_SEASON_MARGIN_SD: EARLY_SEASON_MARGIN_SD,
      EARLY_SEASON_LAST_WEEK: EARLY_SEASON_LAST_WEEK
    }
  };
});

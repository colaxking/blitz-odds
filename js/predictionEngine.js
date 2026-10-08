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

  function ratingsFromRanks(stats) {
    var off = stats.offense;
    var def = stats.defense;
    return {
      offRating:
        rankToScore(off.rankTotal) * WEIGHTS.total +
        rankToScore(off.rankRush) * WEIGHTS.run +
        rankToScore(off.rankPass) * WEIGHTS.pass,
      defRating:
        rankToScore(def.rankTotal) * WEIGHTS.total +
        rankToScore(def.rankRush) * WEIGHTS.run +
        rankToScore(def.rankPass) * WEIGHTS.pass
    };
  }

  // Prior-season blend. A yards-per-game rank built on one or two games is
  // mostly noise: scored honestly (ranks as of each kickoff, 2015-2025, see
  // scripts/model-backtest.mjs) the current-season ranks alone pick Week 3
  // at 50.9% - a coin flip - and Week 2 at 57.7%. Shrinking each team's
  // rating toward its prior-season rating with weight n / (n + K), n = games
  // played this season, lifts those to 62.9% / 57.7% -> 59.4% and costs
  // nothing from Week 7 on (61.2% vs 61.5% unblended). K = 4 was the best
  // of 2, 3, 4, 6, 8 by Brier score. The blend is done in rating space, not
  // on the yardage, so it needs only the two teams in hand and no re-rank
  // of the league. Week 1 (n = 0) is pure prior, which is what the app ran
  // on anyway before teams.json rolled over.
  var SEASON_BLEND_K = 4;

  /**
   * Roll a team's raw rank data into single offense/defense ratings.
   * @param {Object} team - entry from teams.json (has .stats.offense / .stats.defense with rankRush/rankPass/rankTotal).
   *   If the entry also carries .priorStats (last season's final ranks, same
   *   shape) and .stats.gamesPlayed, the two are blended as described above;
   *   without either, the current ranks are used as-is.
   * @returns {{offRating:number, defRating:number, blendWeight:(number|null)}}
   */
  function computeBaseRatings(team) {
    var cur = ratingsFromRanks(team.stats);
    var n = team.stats && typeof team.stats.gamesPlayed === "number" ? team.stats.gamesPlayed : null;
    var hasPrior = !!(team.priorStats && team.priorStats.offense && team.priorStats.defense);
    if (!hasPrior || n === null || !isFinite(n) || n < 0) {
      return { offRating: cur.offRating, defRating: cur.defRating, blendWeight: null };
    }
    var prior = ratingsFromRanks(team.priorStats);
    var w = n / (n + SEASON_BLEND_K);
    return {
      offRating: w * cur.offRating + (1 - w) * prior.offRating,
      defRating: w * cur.defRating + (1 - w) * prior.defRating,
      blendWeight: w
    };
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
   * One curve: predictedMargin and confidence are the same number expressed
   * two ways, so the straight-up, confidence, ats and survivor sheets can
   * never disagree about a game. `week` is accepted for call-site symmetry
   * with edgeToMargin; the residual SD is the same in every week (the
   * early-season uncertainty lives in the margin fit, see below).
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
  //   actual home margin ~= perEdge * edge + intercept   (residual SD 13.5)
  //
  // HOW THESE WERE FIT (and why the previous numbers were wrong). The earlier
  // constants - 0.409 * edge + 1.11, SD 12.77, "64.4% accurate" - came from
  // scoring every historical game with that season's FINAL rankings, i.e.
  // ranks that already included the game being predicted. That leak made
  // the edge look about 40% more predictive than it is live. Refit over the
  // 2,895 regular-season games of 2015-2025 using the ranks that existed at
  // each kickoff (per-game yardage in data/historical-team-game-yards.json,
  // identical to footballdb's numbers; prior-season blend above applied;
  // no injury/weather data in the backtest - see scripts/model-backtest.mjs
  // to reproduce):
  //
  //   weeks 1-6    0.274 * edge + 1.04   residual SD 13.25   (n = 1,045)
  //   weeks 7-18   0.360 * edge + 1.48   residual SD 13.58   (n = 1,850)
  //   all weeks    0.329 * edge + 1.33   residual SD 13.47
  //
  // Straight-up accuracy 60.8% with leave-one-season-out cross-validation
  // (the closing line is 66.2% on the same games). Calibration by confidence
  // bin, all weeks: 50-55% bin hits 51.3%, 55-60% -> 57.7%, 60-65% -> 61.9%,
  // 65-70% -> 68.9%, 70-75% -> 71.7%, 75%+ -> 79.9%. The old constants, on
  // the same honest replay, hit 56.1% in their 65-70% bin and 80.2% in
  // their 85%+ bin.
  //
  // Weeks 1-6 get a flatter slope rather than a wider SD: the SD is the
  // noise in NFL margins, which doesn't change with the calendar, while the
  // slope is how much a rank gap is worth, which does. Shrinking the slope
  // also shrinks predictedMargin itself, so the ats comparison against the
  // market line is no more aggressive in September than in December - the
  // old SD-widening left early-season margins at full size.
  //
  // What the model is NOT: an edge against the market. Scored against the
  // closing spread (weeks 5-18, 2015-2025) the model's side covers 46-51%
  // at every gap size; moneyline "value" picks at the posted price lose
  // about 9%; the offense-vs-defense total lean hits 47-52%. The cover
  // probability below is calibrated to the model's own residual, which is
  // the right number for "how sure is the model" and the wrong number for
  // "will this cover" - copy that shows it should say lean, not edge.
  var MARGIN_SD = 13.5;
  var EARLY_SEASON_LAST_WEEK = 6;
  var MARGIN_FIT_EARLY = { perEdge: 0.274, intercept: 1.04 };
  var MARGIN_FIT_REGULAR = { perEdge: 0.360, intercept: 1.48 };
  // Kept for the constants export and any caller that read the old names;
  // the regular-season pair is what runs from Week 7 on.
  var MARGIN_PER_EDGE = MARGIN_FIT_REGULAR.perEdge;
  var MARGIN_INTERCEPT = MARGIN_FIT_REGULAR.intercept;
  // The old separate early-season SD is gone (see above); exported as equal
  // to MARGIN_SD so predictions-current.mts's legacy repair path keeps
  // compiling and now simply re-projects through the one curve.
  var EARLY_SEASON_MARGIN_SD = MARGIN_SD;

  /**
   * Which margin fit a week runs on. Preseason weeks are negative (-4..-1)
   * and take the early curve; null/undefined/0/non-numeric fall back to the
   * regular fit so a missed call site degrades to the main-season behaviour
   * rather than throwing.
   */
  function marginFitForWeek(week) {
    if (week === null || week === undefined || week === "") return MARGIN_FIT_REGULAR;
    var w = Number(week);
    if (!isFinite(w) || w === 0) return MARGIN_FIT_REGULAR;
    if (w <= EARLY_SEASON_LAST_WEEK) return MARGIN_FIT_EARLY;
    return MARGIN_FIT_REGULAR;
  }

  /**
   * Residual SD for a week. One value now (see the fit notes above), kept as
   * a function because winProbabilityToMargin and predictions-current.mts
   * call it with a week and the inverse must use the same SD the forward
   * projection did.
   */
  function marginSdForWeek(week) {
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

  /**
   * Inverse standard normal CDF (Acklam's rational approximation, |rel err|
   * < 1.15e-9 - comfortably tighter than normalCdf's own A&S error, so a
   * normalQuantile(normalCdf(z)) round trip is limited by the forward
   * approximation rather than this one).
   *
   * Exists for one job: recovering the predicted margin from a stored win
   * probability, for prediction snapshots frozen before predictedMargin was
   * part of the record (see predictions-current.mts). Nothing in the live
   * prediction path needs it - predictMatchup computes the margin first and
   * the probability from it, never the other way around.
   */
  function normalQuantile(p) {
    if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
    var pLow = 0.02425, pHigh = 1 - pLow, q, r;
    if (p < pLow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
             ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > pHigh) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
              ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /**
   * Home win probability -> the predicted home margin that produced it, the
   * exact inverse of marginToWinProbability for the same week. `week` must be
   * the week whose SD was used when the probability was computed, which is
   * not necessarily the week the game belongs to - see the repair path in
   * predictions-current.mts, where a probability computed with the wrong SD
   * is inverted with that wrong SD on purpose before being re-projected
   * through the right one.
   */
  function winProbabilityToMargin(homeWinProb, week) {
    return normalQuantile(homeWinProb) * marginSdForWeek(week);
  }

  /** Rating-point edge -> expected home margin in points, on the week's fit. */
  function edgeToMargin(edge, week) {
    var fit = marginFitForWeek(week);
    return fit.perEdge * edge + fit.intercept;
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
    var predictedMargin = edgeToMargin(edge, params.week);
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
    marginFitForWeek: marginFitForWeek,
    edgeToMargin: edgeToMargin,
    coverProbability: coverProbability,
    normalCdf: normalCdf,
    normalQuantile: normalQuantile,
    winProbabilityToMargin: winProbabilityToMargin,
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
      MARGIN_FIT_EARLY: MARGIN_FIT_EARLY,
      MARGIN_FIT_REGULAR: MARGIN_FIT_REGULAR,
      SEASON_BLEND_K: SEASON_BLEND_K,
      EARLY_SEASON_MARGIN_SD: EARLY_SEASON_MARGIN_SD,
      EARLY_SEASON_LAST_WEEK: EARLY_SEASON_LAST_WEEK
    }
  };
});

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

  var DEFENSIVE_POSITIONS = { "Edge": 1, "DE": 1, "DT": 1, "LB": 1, "CB": 1, "S": 1, "DL": 1 };

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
   * @param {Array<{name:string,position:string,impactScore:number,status:string}>} impactPlayers
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
        status: p.status,
        side: isDefensive ? "defense" : "offense",
        ratingDelta: -delta
      });
    });

    return { offRating: offRating, defRating: defRating, adjustments: adjustments };
  }

  /** Logistic curve turning a rating-point edge into a win probability. */
  function edgeToWinProbability(edge, scale) {
    scale = scale || 12;
    return 1 / (1 + Math.pow(10, -edge / scale));
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

    var homeAdj = applyInjuryAdjustments(homeBase, params.homeImpactPlayers);
    var awayAdj = applyInjuryAdjustments(awayBase, params.awayImpactPlayers);

    // Team overall = its offense rating + its defense rating, plus home field.
    var homeOverall = homeAdj.offRating + homeAdj.defRating + HOME_FIELD_BONUS;
    var awayOverall = awayAdj.offRating + awayAdj.defRating;

    var edge = homeOverall - awayOverall; // positive favors home team
    var homeWinProb = edgeToWinProbability(edge);

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
    edgeToWinProbability: edgeToWinProbability,
    predictMatchup: predictMatchup,
    constants: {
      NUM_TEAMS: NUM_TEAMS,
      WEIGHTS: WEIGHTS,
      HOME_FIELD_BONUS: HOME_FIELD_BONUS,
      OUT_MULTIPLIER: OUT_MULTIPLIER,
      QUESTIONABLE_MULTIPLIER: QUESTIONABLE_MULTIPLIER
    }
  };
});

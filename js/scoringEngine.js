/**
 * scoringEngine.js
 *
 * Pure, framework-agnostic scoring for NFL pick'em leagues. Mirrors the
 * pattern in predictionEngine.js / hotPicksEngine.js on purpose: no DOM, no
 * React, usable from a Netlify function (Node) or the browser unchanged.
 *
 * This is the ONLY place scoring math should live. netlify/functions/
 * results-process.mts (authoritative, server-side) and any in-app "live
 * preview of my points" UI both call into this file, so they can never
 * silently disagree with each other.
 *
 * Formats implemented: straight_up, confidence, survivor, ats.
 *
 * ats (against the spread) picks are graded using the point-spread snapshot
 * taken at pick time (pick.spread - see picks-submit.mts), not whatever the
 * spread happens to be now, so a pick's grade never moves after it's made.
 * pick.spread is always relative to pick.team (negative if pick.team was
 * favored, positive if pick.team was the underdog), independent of home/
 * away. Scoring needs the actual final score margin, not just a winner, so
 * ats grading only runs once result.homeScore/result.awayScore are present
 * (see results-process.mts) - a final result missing those is treated as
 * not-yet-gradable rather than incorrect.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ScoringEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  var SUPPORTED_FORMATS = ["straight_up", "confidence", "survivor", "ats"];

  /**
   * @param {"straight_up"|"confidence"|"survivor"|"ats"} format
   * @param {Object} scoringSettings - league.scoringSettings
   * @param {Object} pick - { team, confidence?, spread? }
   * @param {Object} result - { winner: string|null, tie?: boolean, final: boolean,
   *   home?: string, away?: string, homeScore?: number, awayScore?: number }
   * @returns {{correct: boolean|null, points: number}} correct is null when
   *   the pick doesn't count either way (unplayed game, void tie, or a not-
   *   yet-gradable ats pick).
   */
  function scorePick(format, scoringSettings, pick, result) {
    scoringSettings = scoringSettings || {};
    if (!result || !result.final) return { correct: null, points: 0 };
    if (!pick || !pick.team) return { correct: false, points: 0 };

    if (format === "ats") return scoreAtsPick(scoringSettings, pick, result);

    if (result.tie) {
      var tieHandling = scoringSettings.tieHandling || "void";
      if (tieHandling === "void") return { correct: null, points: 0 };
      if (tieHandling === "both_correct") {
        return { correct: true, points: pointsForCorrect(format, scoringSettings, pick) };
      }
      // tieHandling === "incorrect"
      return { correct: false, points: 0 };
    }

    var correct = pick.team === result.winner;
    if (!correct) return { correct: false, points: 0 };
    return { correct: true, points: pointsForCorrect(format, scoringSettings, pick) };
  }

  /** Grades one ats pick against the actual final score. A push (adjusted
   *  margin of exactly 0) is handled with the same scoringSettings.tieHandling
   *  knob straight_up/confidence use for game ties - "void" (default),
   *  "both_correct", or "incorrect". */
  function scoreAtsPick(scoringSettings, pick, result) {
    if (typeof pick.spread !== "number") return { correct: false, points: 0 };
    if (typeof result.homeScore !== "number" || typeof result.awayScore !== "number") {
      return { correct: null, points: 0 }; // final winner known, but no score margin to grade against yet
    }
    var pickIsHome = pick.team === result.home;
    var pickIsAway = pick.team === result.away;
    if (!pickIsHome && !pickIsAway) return { correct: false, points: 0 };

    var margin = pickIsHome
      ? (result.homeScore - result.awayScore)
      : (result.awayScore - result.homeScore);
    var adjusted = margin + pick.spread;

    if (adjusted > 0) return { correct: true, points: pointsForCorrect("ats", scoringSettings, pick) };
    if (adjusted === 0) {
      var pushHandling = scoringSettings.tieHandling || "void";
      if (pushHandling === "both_correct") return { correct: true, points: pointsForCorrect("ats", scoringSettings, pick) };
      if (pushHandling === "incorrect") return { correct: false, points: 0 };
      return { correct: null, points: 0 };
    }
    return { correct: false, points: 0 };
  }

  function pointsForCorrect(format, scoringSettings, pick) {
    if (format === "confidence") {
      var pts = Number(pick.confidence);
      return Number.isFinite(pts) ? pts : 0;
    }
    // straight_up and survivor: flat points per correct pick (default 1).
    // Survivor doesn't really use "points" for its win condition (alive/
    // eliminated is what matters - see applySurvivorWeek), but a points
    // value is still returned so Survivor leagues can optionally show a
    // secondary "weeks survived" style column without a separate code path.
    var flat = scoringSettings.pointsPerCorrect;
    return Number.isFinite(flat) ? flat : 1;
  }

  /**
   * Scores one user's full week of picks against that week's results.
   * @param {string} format
   * @param {Object} scoringSettings
   * @param {Object.<string,Object>} userPicks - { [gameId]: pick }
   * @param {Object.<string,Object>} weekResults - { [gameId]: result }
   * @returns {{points:number, correct:number, incorrect:number, voided:number, accuracy:number}}
   */
  function scoreUserWeek(format, scoringSettings, userPicks, weekResults) {
    if (SUPPORTED_FORMATS.indexOf(format) === -1) {
      throw new Error("scoreUserWeek: unsupported format \"" + format + "\"");
    }
    userPicks = userPicks || {};
    weekResults = weekResults || {};

    var points = 0, correct = 0, incorrect = 0, voided = 0;

    Object.keys(weekResults).forEach(function (gameId) {
      var result = weekResults[gameId];
      var pick = userPicks[gameId];
      var scored = scorePick(format, scoringSettings, pick, result);
      if (scored.correct === null) {
        voided++;
      } else if (scored.correct) {
        correct++;
        points += scored.points;
      } else {
        incorrect++;
      }
    });

    var decided = correct + incorrect;
    var accuracy = decided > 0 ? correct / decided : 0;

    return { points: points, correct: correct, incorrect: incorrect, voided: voided, accuracy: accuracy };
  }

  /**
   * Scores every league member for one week.
   * @param {string} format
   * @param {Object} scoringSettings
   * @param {Object.<string,Object.<string,Object>>} weekPicks - { [userId]: { [gameId]: pick } }
   * @param {Object.<string,Object>} weekResults - { [gameId]: result }
   * @returns {Object.<string,Object>} { [userId]: scoreUserWeek(...) }
   */
  function scoreWeek(format, scoringSettings, weekPicks, weekResults) {
    weekPicks = weekPicks || {};
    var out = {};
    Object.keys(weekPicks).forEach(function (userId) {
      out[userId] = scoreUserWeek(format, scoringSettings, weekPicks[userId], weekResults);
    });
    return out;
  }

  /**
   * Ranks a set of per-user week/season totals into { rank, ...totals }[],
   * sorted by points desc. Tie-breaking beyond points (mostCorrect,
   * fewestIncorrect) is applied when scores are exactly equal; anything
   * still tied after that shares a rank (standard "1,2,2,4" competition
   * ranking) rather than being arbitrarily ordered.
   * @param {Object.<string,{points:number,correct:number,incorrect:number}>} totals
   * @param {"most_correct"|"fewest_incorrect"|null} tieBreaker
   */
  function rankStandings(totals, tieBreaker) {
    var rows = Object.keys(totals).map(function (userId) {
      return Object.assign({ userId: userId }, totals[userId]);
    });

    rows.sort(function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      if (tieBreaker === "most_correct" && b.correct !== a.correct) return b.correct - a.correct;
      if (tieBreaker === "fewest_incorrect" && a.incorrect !== b.incorrect) return a.incorrect - b.incorrect;
      return 0;
    });

    var rank = 0, lastKey = null, seen = 0;
    rows.forEach(function (row) {
      seen++;
      var key = row.points + ":" + (tieBreaker === "most_correct" ? row.correct : row.incorrect);
      if (key !== lastKey) {
        rank = seen;
        lastKey = key;
      }
      row.rank = rank;
    });

    return rows;
  }

  /**
   * Applies one week's Survivor results on top of the running season state.
   * A user already eliminated in an earlier week is left untouched (they
   * don't get re-evaluated) so historical elimination weeks stay stable.
   *
   * @param {Object.<string,{alive:boolean, usedTeams:string[], eliminatedWeek:number|null}>} state
   * @param {Object.<string,Object>} weekPicks - { [userId]: { [gameId]: {team} } } (Survivor: one game/team per user per week)
   * @param {Object.<string,Object>} weekResults - { [gameId]: result }
   * @param {number} week
   * @param {"eliminate"|"survive"} tieHandling - Survivor's own tie rule,
   *   separate from scoringSettings.tieHandling used elsewhere, since a tied
   *   game is ambiguous for a knockout format specifically.
   * @returns {Object} updated state (new object; does not mutate input)
   */
  function applySurvivorWeek(state, weekPicks, weekResults, week, tieHandling) {
    tieHandling = tieHandling || "eliminate";
    weekPicks = weekPicks || {};
    var next = {};

    Object.keys(state).forEach(function (userId) {
      next[userId] = Object.assign({}, state[userId], { usedTeams: (state[userId].usedTeams || []).slice() });
    });

    Object.keys(weekPicks).forEach(function (userId) {
      var userState = next[userId] || { alive: true, usedTeams: [], eliminatedWeek: null };
      if (!next[userId]) next[userId] = userState;
      if (!userState.alive) return; // already out, no re-evaluation

      var gamePicks = weekPicks[userId];
      var gameIds = Object.keys(gamePicks);
      if (gameIds.length === 0) return; // no pick made this week - left alive/unresolved; the UI should have blocked this
      // Survivor is one pick per week, but if a mid-week switch's old key
      // hadn't finished being deleted when this ran, more than one could
      // show up here - the most recently updated one is the real pick.
      var gameId = gameIds.length === 1
        ? gameIds[0]
        : gameIds.reduce(function (a, b) {
            return (gamePicks[a].updatedAt || "") >= (gamePicks[b].updatedAt || "") ? a : b;
          });
      var pick = gamePicks[gameId];
      var result = weekResults[gameId];
      if (!result || !result.final) return; // not decided yet

      if (userState.usedTeams.indexOf(pick.team) === -1) {
        userState.usedTeams.push(pick.team);
      }

      var survived;
      if (result.tie) {
        survived = tieHandling === "survive";
      } else {
        survived = pick.team === result.winner;
      }

      if (!survived) {
        userState.alive = false;
        userState.eliminatedWeek = week;
      }
    });

    return next;
  }

  return {
    SUPPORTED_FORMATS: SUPPORTED_FORMATS,
    scorePick: scorePick,
    scoreUserWeek: scoreUserWeek,
    scoreWeek: scoreWeek,
    rankStandings: rankStandings,
    applySurvivorWeek: applySurvivorWeek,
  };
});

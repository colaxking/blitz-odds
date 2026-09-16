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
    // A game the member never picked is ungradable, not a loss. scoreUserWeek
    // iterates every game with a result (not the member's picks), so grading
    // an absent pick as incorrect charged a member one loss for every game
    // they skipped that week - which also made the behavior incoherent:
    // results-process drops members with *zero* picks from weekPicksDoc
    // entirely, so a fully-absent week cost nothing while a partially-picked
    // one was punished. If "no pick counts as a loss" is ever wanted, it
    // belongs in scoringSettings as a league option, not hardcoded here.
    if (!pick || !pick.team) return { correct: null, points: 0 };

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
    // Both of these are "we can't grade this", not "the member was wrong":
    // a pick stored without a spread snapshot (e.g. written before
    // picks-submit started requiring one) and a pick whose team doesn't
    // appear in the result row at all (a data mismatch on our side) were
    // both being recorded as losses against the member. Void them instead,
    // consistent with the missing-score case just below - a scoring bug
    // should show up as an ungraded game, not as a fabricated loss.
    if (typeof pick.spread !== "number") return { correct: null, points: 0 };
    if (typeof result.homeScore !== "number" || typeof result.awayScore !== "number") {
      return { correct: null, points: 0 }; // final winner known, but no score margin to grade against yet
    }
    var pickIsHome = pick.team === result.home;
    var pickIsAway = pick.team === result.away;
    if (!pickIsHome && !pickIsAway) return { correct: null, points: 0 };

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
   * Normalizes a user's strike record to the per-week list this engine now
   * keeps, migrating the older running-counter shape in place.
   *
   * Legacy docs carry a `strikes` number and no `strikeWeeks`, and that
   * number can't be trusted - it was incremented on every re-processing pass
   * of an already-final week, not once per week (see applySurvivorWeek). So
   * the count itself is discarded. What IS trustworthy is that a doc marked
   * `alive: false` with an `eliminatedWeek` did lose in that week, so that
   * one week seeds the list: a genuinely eliminated one-strike member stays
   * eliminated immediately rather than flickering back to Alive for the
   * minutes before their week is re-posted, while an over-counted member in
   * a multi-strike league drops straight back to the single real strike.
   * Every other week rebuilds itself as results-process replays it.
   */
  function normalizeStrikeWeeks(entry) {
    if (entry && Array.isArray(entry.strikeWeeks)) {
      var seen = {};
      var weeks = [];
      entry.strikeWeeks.forEach(function (w) {
        var n = Number(w);
        if (!Number.isFinite(n) || seen[n]) return;
        seen[n] = true;
        weeks.push(n);
      });
      return weeks.sort(function (a, b) { return a - b; });
    }
    if (entry && entry.alive === false && entry.eliminatedWeek != null) {
      return [Number(entry.eliminatedWeek)];
    }
    return [];
  }

  /** Derives alive/strikes/eliminatedWeek from the strike weeks. The week a
   *  member went out is the one that produced their LAST allowed strike, so
   *  it stays put no matter how many later weeks are replayed. */
  function resolveSurvivorState(entry, strikesAllowed) {
    var weeks = entry.strikeWeeks;
    entry.strikes = weeks.length;
    if (weeks.length >= strikesAllowed) {
      entry.alive = false;
      entry.eliminatedWeek = weeks[strikesAllowed - 1];
    } else {
      entry.alive = true;
      entry.eliminatedWeek = null;
    }
    return entry;
  }

  /**
   * Applies one week's Survivor results on top of the running season state.
   *
   * IDEMPOTENT PER WEEK, which is load-bearing rather than a nicety:
   * scripts/results-process-trigger.mjs re-posts every already-final week on
   * every run (hourly through the game window), so this function is called
   * with the same week and the same results dozens of times. It used to
   * increment a running `strikes` counter on each of those calls, which
   * turned one Week 1 loss into an elimination a few hours later in any
   * league allowing more than one strike. Classic one-strike leagues hid the
   * bug, since the "already out" guard stopped the re-entry after the first
   * pass.
   *
   * So a strike is now recorded as membership of `strikeWeeks`, not a count:
   * re-running a week sets the same entry again, and a corrected result that
   * flips a loss to a win removes it. alive/strikes/eliminatedWeek are
   * derived from that list every time, which also means a late correction can
   * un-eliminate someone instead of leaving them wrongly out.
   *
   * @param {Object.<string,{alive:boolean, usedTeams:string[], eliminatedWeek:number|null, strikes:number, strikeWeeks:number[]}>} state
   * @param {Object.<string,Object>} weekPicks - { [userId]: { [gameId]: {team} } } (Survivor: one game/team per user per week)
   * @param {Object.<string,Object>} weekResults - { [gameId]: result }
   * @param {number} week
   * @param {"eliminate"|"survive"} tieHandling - Survivor's own tie rule,
   *   separate from scoringSettings.tieHandling used elsewhere, since a tied
   *   game is ambiguous for a knockout format specifically.
   * @param {number} [strikesAllowed=1] - How many losing picks it takes to
   *   eliminate a member. 1 is classic Survivor (first miss is fatal);
   *   higher values give a cushion. Leagues created before this setting
   *   existed have no value stored and read as 1, which is the rule they were
   *   actually played under.
   * @returns {Object} updated state (new object; does not mutate input)
   */
  function applySurvivorWeek(state, weekPicks, weekResults, week, tieHandling, strikesAllowed) {
    tieHandling = tieHandling || "eliminate";
    strikesAllowed = Number.isFinite(strikesAllowed) && strikesAllowed >= 1
      ? Math.floor(strikesAllowed)
      : 1;
    weekPicks = weekPicks || {};
    week = Number(week);
    var next = {};

    Object.keys(state).forEach(function (userId) {
      next[userId] = Object.assign({}, state[userId], {
        usedTeams: (state[userId].usedTeams || []).slice(),
        strikeWeeks: normalizeStrikeWeeks(state[userId]),
      });
    });

    Object.keys(weekPicks).forEach(function (userId) {
      var userState = next[userId] || { alive: true, usedTeams: [], eliminatedWeek: null, strikes: 0, strikeWeeks: [] };
      if (!next[userId]) next[userId] = userState;

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

      // Set membership for THIS week only. Both directions matter: a rerun
      // of a loss is a no-op, and a rerun where the stored result has since
      // been corrected clears the strike it previously earned.
      var at = userState.strikeWeeks.indexOf(week);
      if (!survived && at === -1) {
        userState.strikeWeeks.push(week);
        userState.strikeWeeks.sort(function (a, b) { return a - b; });
      } else if (survived && at !== -1) {
        userState.strikeWeeks.splice(at, 1);
      }
    });

    // Re-derive for everyone, not just members with a pick this week, so a
    // migrated legacy doc settles onto the new shape on the first pass.
    Object.keys(next).forEach(function (userId) {
      resolveSurvivorState(next[userId], strikesAllowed);
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

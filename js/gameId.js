/**
 * gameId.js
 *
 * Mirrors netlify/functions/lib/gameId.mts exactly - the schedule data has
 * no stable per-game ID, so this is the one place the frontend derives it.
 * If the format ever changes, both files must change together.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameId = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  function makeGameId(season, week, away, home) {
    return season + "-w" + week + "-" + away + "-" + home;
  }

  function findGameById(games, season, week, gameId) {
    for (var i = 0; i < games.length; i++) {
      var g = games[i];
      if (makeGameId(season, week, g.away, g.home) === gameId) return g;
    }
    return null;
  }

  return { makeGameId: makeGameId, findGameById: findGameById };
});

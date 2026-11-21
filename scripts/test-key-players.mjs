// node scripts/test-key-players.mjs
// Pins the key-player rules against the shapes ESPN actually returns.
import assert from "node:assert/strict";
import { firstString, leadersByCategory, keyPlayersForTeam } from "./key-players.mjs";

const ref = (id) => ({ $ref: `http://x/v2/sports/football/leagues/nfl/seasons/2026/athletes/${id}?lang=en` });
const pos = (list) => ({ athletes: list.map(([slot, rank, id]) => ({ slot, rank, athlete: ref(id) })) });
const depth = { items: [
  { name: "3WR 1TE", positions: {
    // three WR slots (1, 2, 8), each with a starter and a backup
    wr: pos([[1, 1, 101], [1, 4, 104], [2, 2, 102], [2, 5, 105], [8, 3, 103], [8, 6, 106]]),
    lt: pos([[3, 1, 201], [3, 2, 202]]), lg: pos([[4, 1, 203]]), c: pos([[5, 1, 204]]),
    rg: pos([[6, 1, 205]]), rt: pos([[7, 1, 206]]),
    qb: pos([[9, 1, 301], [9, 2, 302]]), te: pos([[10, 1, 401], [10, 2, 402]]),
    rb: pos([[11, 1, 501], [11, 2, 502]]),
  } },
  { name: "Base 4-3 D", positions: { lde: pos([[1, 1, 601], [1, 2, 602]]) } },
] };
const cat = (name, rows) => ({ name, leaders: rows.map(([id, value]) => ({ value, athlete: ref(id) })) });
const leaders = { categories: [
  cat("rushingYards", [[301, 400], [502, 350], [501, 90]]),      // the QB leads; RB2 out-produces RB1
  cat("receivingYards", [[104, 500], [401, 300], [102, 280], [402, 310], [101, 20]]),
  cat("totalTackles", [[701, 80], [702, 60], [703, 50]]),
  cat("sacks", [[601, 6], [704, 1]]),                            // one sack doesn't make a pass rusher
] };
const P = { 101: "WR", 102: "WR", 103: "WR", 104: "WR", 301: "QB", 401: "TE", 402: "TE", 501: "RB", 502: "RB" };

const fs = firstString(depth);
assert.deepEqual(fs.wr, ["101", "102", "103"], "first string is the lowest rank per slot, not slot 1");
assert.deepEqual(fs.lde, ["601"], "a backup sharing the starter's slot is not first-string");

const key = new Set(keyPlayersForTeam(fs, leadersByCategory(leaders), (id) => P[id] || null));
const yes = (id, why) => assert.ok(key.has(String(id)), why);
const no = (id, why) => assert.ok(!key.has(String(id)), why);
yes(301, "QB1"); no(302, "backup QB");
yes(501, "depth-chart RB1 stays key even when out-produced"); yes(502, "leading rusher among RBs");
yes(101, "WR1 slot with no production - the injured star"); yes(104, "top WR by yards"); yes(102, "second WR by yards");
no(103, "WR3"); no(105, "backup WR");
yes(401, "TE1"); yes(402, "leading TE by yards");
for (const id of [201, 203, 204, 205, 206]) yes(id, "all five starting linemen"); no(202, "backup tackle");
yes(701, "top tackler"); yes(702, "second tackler"); no(703, "third tackler");
yes(601, "sack leader"); no(704, "one sack");

// Before any games: depth chart only, and WR falls back to the top two slots.
const pre = new Set(keyPlayersForTeam(fs, {}, () => null));
assert.ok(pre.has("101") && pre.has("102") && !pre.has("103"));
console.log(`key-players: ok (${key.size} key in fixture)`);

/**
 * Which players count as "key" for injury alerts.
 *
 * This is deliberately NOT impactScore. impactScore is a prediction-model
 * input: hand-tuned for some players and a deliberately low placeholder for
 * every auto-added one (position median minus one). Using it to gate alerts
 * meant a team's leading receiver could sit at a placeholder 6 and never
 * alert anyone on the default "Key players" setting - which is exactly what
 * happened with Jaylen Waddle on 2026-11-20.
 *
 * "Key" here means: a starter the team would visibly miss. It's worked out
 * per team from two ESPN feeds the sync job can already reach -
 *
 *   depth chart  -> who holds the first-string slot at each position
 *   team leaders -> who is actually producing this season
 *
 * - and a player is key if EITHER says so. The union matters in both
 * directions: production corrects a stale depth chart (the listed RB1 who
 * lost the job), and the depth chart covers the star who's been hurt since
 * Week 2 and has no numbers - the one whose return you most want to hear
 * about.
 *
 *   QB   first-string
 *   RB   first-string + the leading rusher among RBs
 *   WR   the WR1 slot + the top two WRs by receiving yards
 *   TE   first-string + the leading TE by receiving yards
 *   OL   all five first-string linemen (no usage stats exist for linemen,
 *        so the depth chart is the only signal)
 *   DEF  the top two tacklers and the top two in sacks
 *
 * A defensive star who doesn't lead in either (a shutdown corner) is still
 * key through the dispatcher's other two routes: a curated impactScore of 7+
 * or an explicit `key: true` on his player record.
 */

const OL_SLOTS = ["lt", "lg", "c", "rg", "rt"];
const RULES = { rbByYards: 1, wrByYards: 2, teByYards: 1, tacklers: 2, sackers: 2, minSacks: 2 };

const idOf = (ref) => { const m = /\/athletes\/(\d+)/.exec(ref || ""); return m ? m[1] : null; };

/**
 * ESPN depth chart -> { posKey: [athleteId, ...] } holding first-string ids.
 *
 * `slot` is NOT depth. It numbers the position's place in the formation
 * (every LDE is slot 1, every NT slot 2), and a position with several
 * starters spans several slots: the three WRs are slots 1, 2 and 8, each
 * with its own starter and backup. `rank` is the depth order. So the
 * first-string player is the lowest rank within each slot.
 */
export function firstString(depthDoc) {
  const out = {};
  for (const formation of depthDoc?.items || []) {
    for (const [key, pos] of Object.entries(formation.positions || {})) {
      const bySlot = new Map();
      for (const a of pos.athletes || []) {
        const id = idOf(a.athlete?.$ref);
        if (!id) continue;
        const cur = bySlot.get(a.slot);
        if (!cur || a.rank < cur.rank) bySlot.set(a.slot, { id, rank: a.rank });
      }
      const ids = [...bySlot.values()].sort((x, y) => x.rank - y.rank).map((x) => x.id);
      if (ids.length) out[key.toLowerCase()] = ids;
    }
  }
  return out;
}

/** ESPN team leaders -> { categoryName: [{ id, value }, ...] }, best first. */
export function leadersByCategory(leadersDoc) {
  const out = {};
  for (const c of leadersDoc?.categories || []) {
    out[c.name] = (c.leaders || [])
      .map((l) => ({ id: idOf(l.athlete?.$ref), value: Number(l.value) || 0 }))
      .filter((l) => l.id && l.value > 0)
      .sort((a, b) => b.value - a.value);
  }
  return out;
}

/**
 * @param starters  from firstString()
 * @param leaders   from leadersByCategory(); {} before any games are played
 * @param positionOf  athleteId -> roster position abbreviation ("WR"), so a
 *                    QB's scrambles don't make him the "leading rusher"
 * @returns sorted athlete ids
 */
export function keyPlayersForTeam(starters, leaders, positionOf) {
  const key = new Set();
  const add = (ids) => { for (const id of ids || []) if (id) key.add(id); };
  const top = (category, positions, n, min = 0) => (leaders[category] || [])
    .filter((l) => l.value >= min && (!positions || positions.includes(positionOf(l.id))))
    .slice(0, n).map((l) => l.id);

  add((starters.qb || []).slice(0, 1));
  add((starters.rb || []).slice(0, 1));
  add(top("rushingYards", ["RB"], RULES.rbByYards));
  add((starters.wr || []).slice(0, 1));
  add(top("receivingYards", ["WR"], RULES.wrByYards));
  add((starters.te || []).slice(0, 1));
  add(top("receivingYards", ["TE"], RULES.teByYards));
  for (const slot of OL_SLOTS) add((starters[slot] || []).slice(0, 1));
  add(top("totalTackles", null, RULES.tacklers));
  add(top("sacks", null, RULES.sackers, RULES.minSacks));

  // Before the leaders feed has anything (preseason, Week 1) the receiving
  // rule finds nobody, so fall back to the depth chart's top two WR slots.
  if (!(leaders.receivingYards || []).length) add((starters.wr || []).slice(0, 2));

  return [...key].sort();
}

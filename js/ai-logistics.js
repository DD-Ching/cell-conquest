// =====================================================
// AI logistics — anti-saturation + road-clearing passes. Both run once per
// aiTick (NOT part of the one-action-per-tick decision budget), because keeping
// supply flowing is maintenance that must happen reliably no matter what the
// tactical phase decides this tick.
//
// NO per-tick action caps. These passes used to bound how many nodes/roads they
// acted on per tick "for perf", but that silently throttled a large empire's
// economy + supply — a performance bound changing the GAME RESULT, which we
// don't allow. Both now act on EVERY qualifying node/road each tick; the work
// stays cheap because relief sends are 1-hop (trivial pathfind) and clogged
// roads are few + self-limited by engineer affordability.
//
// relieveSaturation — a city sitting at capacity is wasted production every
// second: regen caps at 1.0× capacity (see world.catchUpRegen), so a full node
// throws away its ENTIRE regen rate until something drains it. The player's
// rule: almost ZERO tolerance for an idle-full city. For each FULL node
// (fullest first) we take the single most productive action:
//   1. EXPAND — if it borders an enemy/neutral it can afford alone, capture it.
//      This is what pours a saturated empire into the empty neutral field and
//      rolls the frontier toward the enemy (the one-action coordinated assault
//      can't drain a 170-node perimeter — 1 attack / 0.7 s is glacial).
//   2. FEED  — otherwise, if it's an interior node, ship one hop toward the
//      front (BFS distance-to-front gradient) so its surplus reaches a node
//      that CAN spend it. Front nodes never ship backward; they expand.
//
// clearBlockedRoads — wrecks pile up where vehicles die on a road, forcing
// every fleet onto a slow off-centre detour. The build phase's tryBuildNet
// only touches FRONT edges below max net level, so it leaves INTERIOR supply
// roads (a former front the empire pushed past) and maxed-net edges to silt
// up. This pass closes that gap: dispatch an engineer to EVERY worst-clogged
// allied-anchored road (placeNetOnEdge → engineerArrivedAtNetEdge clears
// wrecks FIRST), de-duped against engineers already en route.
//
// Both use ctx effects (sendFleet / placeNetOnEdge) so they replay in Worker
// mode.
// =====================================================
import { state } from './state.js';
import { isAlly } from './alliance.js';
import { dist } from './util.js';
import { FLEET_SPEED, ENG_COST } from './config.js';
import { ekey } from './engineering.js';

// No per-tick action cap. A saturated node throws away its entire regen every
// second, so EVERY full node acts this tick — leaving a real one idle would be
// a perf bound silently changing the game's economy, which we don't allow.
// (Was MAX_RELIEF_PER_TICK=30.) Cheap to uncap: relief sends are all 1-hop to
// an ADJACENT node, so each sendFleet's pathfind is trivial even at full scale.

export function relieveSaturation(ctx) {
  const { owner, myNodes, attackerAvail, turretThreatTo, fleetsByTarget, sendFleet } = ctx;
  if (myNodes.length < 2) return;

  // Collect full nodes first; bail cheaply if nothing is saturated (the common
  // case once expansion keeps things flowing — keeps this pass near-free then).
  const full = [];
  for (const my of myNodes) if (my.units >= my.capacity * 0.85) full.push(my);
  if (full.length === 0) return;
  full.sort((a, b) => (b.units / b.capacity) - (a.units / a.capacity));

  // BFS distance-to-front over OWN territory (front = own node touching an
  // enemy/neutral). Only needed for the FEED fallback.
  const distToFront = new Map();
  const queue = [];
  for (const n of myNodes) {
    for (const nbId of state.adj.get(n.id)) {
      if (!isAlly(state.nodes[nbId].owner, owner)) { distToFront.set(n.id, 0); queue.push(n.id); break; }
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi], d = distToFront.get(id);
    for (const nbId of state.adj.get(id)) {
      if (state.nodes[nbId].owner !== owner || distToFront.has(nbId)) continue;
      distToFront.set(nbId, d + 1); queue.push(nbId);
    }
  }

  for (const my of full) {
    const avail = attackerAvail(my);
    if (avail < 6) continue;

    // 1) EXPAND — best affordable adjacent enemy/neutral this node can take alone.
    let capTarget = null, capNeed = 0, capScore = 0;
    for (const nbId of state.adj.get(my.id)) {
      const tgt = state.nodes[nbId];
      if (isAlly(tgt.owner, owner)) continue;
      const minTime = dist(my, tgt) / FLEET_SPEED;
      let need = tgt.units + 4 + tgt.size * 0.2;
      if (tgt.owner !== 'neutral') need += tgt.regenRate * minTime + turretThreatTo(tgt);
      const inbound = fleetsByTarget.get(nbId);
      if (inbound) for (const f of inbound) if (isAlly(f.owner, owner)) need -= f.units;
      need = Math.max(0, need);
      if (avail < need + 3) continue;          // can't take alone — leave to the coordinated assault
      const sat = tgt.units / Math.max(1, tgt.capacity);
      const score = (tgt.owner === 'neutral' ? 1.5 : 1.0) * (1.3 - sat);  // prefer cheap / empty land
      if (score > capScore) { capScore = score; capTarget = tgt; capNeed = need; }
    }
    if (capTarget) {
      const send = Math.min(Math.floor(avail), Math.ceil(capNeed * 1.3 + 6));
      if (send >= 5) { sendFleet(my, capTarget, send); continue; }
    }

    // 2) FRONT PUSH — a full node touching the enemy must NEVER sit idle. EXPAND
    // above bailed (its `need` is inflated by the enemy's tank-tax / regen), but
    // that's exactly the case the player flagged: drones are holding this border
    // hub suppressed, so beating its CURRENT garrison CAPTURES it. We deliberately
    // ignore the tank-tax here (drones + the assault phase clear the screen) and
    // only refuse a genuinely lethal tank zone — a wasted-full border base turns
    // into forward progress. This is the ground half of the combined arms:
    // drones suppress the edge, full bases pour through and take it.
    let weakest = null, weakestU = Infinity;
    for (const nbId of state.adj.get(my.id)) {
      const tgt = state.nodes[nbId];
      if (isAlly(tgt.owner, owner)) continue;
      if (tgt.units < weakestU) { weakestU = tgt.units; weakest = tgt; }
    }
    if (weakest) {
      const minTime = dist(my, weakest) / FLEET_SPEED;
      let need = weakestU + 4;
      if (weakest.owner !== 'neutral') need += weakest.regenRate * minTime;  // regen during travel
      const inbound = fleetsByTarget.get(weakest.id);
      if (inbound) for (const f of inbound) if (isAlly(f.owner, owner)) need -= f.units;
      need = Math.max(0, need);
      const lethalTank = turretThreatTo(weakest) > avail * 0.8;   // only cower from a meat-grinder
      if (!lethalTank && avail >= need) {
        const send = Math.min(Math.floor(avail), Math.ceil(need * 1.25 + 6));
        if (send >= 5) { sendFleet(my, weakest, send); continue; }
      }
    }

    // 3) FEED — interior node with no affordable target: ship one hop forward.
    const myD = distToFront.get(my.id);
    if (!myD) continue;                        // undefined (no front) or 0 (it IS the front)
    let best = null, bestD = myD;
    for (const nbId of state.adj.get(my.id)) {
      const nb = state.nodes[nbId];
      if (nb.owner !== owner || nb.units >= nb.capacity * 1.45) continue;
      const d = distToFront.get(nbId);
      if (d !== undefined && d < bestD) { bestD = d; best = nb; }
    }
    if (best) {
      const send = Math.floor(my.units - my.capacity * 0.6);
      if (send >= 5) { sendFleet(my, best, send); }
    }
  }
}

const ROAD_BLOCK_THRESHOLD = 3;   // a road earns an engineer only once it's
                                  // genuinely clogged (one engineer removes
                                  // NET_ENG_WRECK_CLEAR=2 piles on arrival, so a
                                  // 3-pile road drops below threshold in one go)

/** Dispatch engineers to clear wreck-clogged roads in our territory. See the
 *  file header for why this is needed (tryBuildNet leaves interior + maxed-net
 *  roads to silt up). Worker-safe: reads the live wrecks array when present,
 *  else the wreckCount shipped in the 'ai' edge slice; dispatches via
 *  ctx.placeNetOnEdge (effects bundle) so the clear replays main-thread. */
export function clearBlockedRoads(ctx) {
  const { owner, placeNetOnEdge, isExposedToEnemyTank } = ctx;

  // Cheap affordability pre-check. placeNetOnEdge does an O(N) regen walk every
  // call, so if NOBODY can pay for an engineer, bail before the per-road loop
  // calls it (and fails) repeatedly.
  let canAfford = false;
  for (const n of state.nodes) {
    if (isAlly(n.owner, owner) && n.units >= ENG_COST + 5) { canAfford = true; break; }
  }
  if (!canAfford) return;

  // Edges already being cleared — an engineer's finalX/finalY is the edge
  // midpoint (placeNetOnEdge sets it), and that field IS shipped to the worker,
  // so this de-dup works in both contexts. Skips piling redundant engineers
  // onto a road during the multi-second walk to it.
  const inbound = [];
  for (const f of state.fleets) {
    if (f.kind === 'deploy' && f.finalX != null) inbound.push(f);
  }
  const beingCleared = (mx, my) => {
    for (const f of inbound) {
      const dx = f.finalX - mx, dy = f.finalY - my;
      if (dx * dx + dy * dy < 900) return true;   // within 30px of this midpoint
    }
    return false;
  };

  // Rank blocked, allied-anchored, safe-to-approach roads worst-first.
  let cands = null;
  for (const r of state.roads) {
    const e = state.edgeData.get(ekey(r.a, r.b));
    if (!e) continue;
    const wc = e.wrecks ? e.wrecks.length : (e.wreckCount || 0);
    if (wc < ROAD_BLOCK_THRESHOLD) continue;
    const aN = state.nodes[r.a], bN = state.nodes[r.b];
    // placeNetOnEdge needs an allied endpoint to anchor the off-road final leg.
    if (!isAlly(aN.owner, owner) && !isAlly(bN.owner, owner)) continue;
    const mx = (aN.x + bN.x) / 2, my = (aN.y + bN.y) / 2;
    if (beingCleared(mx, my)) continue;
    if (isExposedToEnemyTank(mx, my)) continue;   // don't feed an engineer to a tank
    (cands || (cands = [])).push({ a: r.a, b: r.b, wc });
  }
  if (!cands) return;
  cands.sort((p, q) => q.wc - p.wc);

  // No per-tick dispatch cap — clear EVERY clogged allied road this tick.
  // placeNetOnEdge self-limits by affordability (it needs a source with units
  // ≥ ENG_COST+5 and bails otherwise), so a poor empire still won't over-spend
  // while a rich one restores its whole supply net at once. (Was capped at
  // MAX_CLEAR_PER_TICK=2 — a perf bound that left roads silted for extra ticks;
  // removed so perf never gates the game state.)
  for (const c of cands) {
    placeNetOnEdge(c.a, c.b, owner);
  }
}

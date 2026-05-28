// =====================================================
// AI logistics — bounded anti-saturation pass. Runs once per aiTick (NOT part
// of the one-action-per-tick decision budget), because a city sitting at
// capacity is wasted production every second: regen caps at 1.0× capacity (see
// world.catchUpRegen), so a full node throws away its ENTIRE regen rate until
// something drains it. The player's rule: almost ZERO tolerance for an
// idle-full city.
//
// For each FULL node (fullest first, capped per tick so it can't spawn a fleet
// storm at 150-node scale) we take the single most productive action:
//   1. EXPAND — if it borders an enemy/neutral it can afford alone, capture it.
//      This is what pours a saturated empire into the empty neutral field and
//      rolls the frontier toward the enemy (the one-action coordinated assault
//      can't drain a 170-node perimeter — 1 attack / 0.7 s is glacial).
//   2. FEED  — otherwise, if it's an interior node, ship one hop toward the
//      front (BFS distance-to-front gradient) so its surplus reaches a node
//      that CAN spend it. Front nodes never ship backward; they expand.
//
// CAP (MAX_RELIEF_PER_TICK) bounds fleet creation regardless of empire size —
// the previous unbounded version was a perf regression at scale. Uses
// ctx.sendFleet (effects bundle) so it replays in Worker mode.
// =====================================================
import { state } from './state.js';
import { isAlly } from './alliance.js';
import { dist } from './util.js';
import { FLEET_SPEED } from './config.js';

const MAX_RELIEF_PER_TICK = 10;   // bound fleet spawn → no churn at 150+ nodes

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

  let acted = 0;
  for (const my of full) {
    if (acted >= MAX_RELIEF_PER_TICK) break;
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
      if (send >= 5) { sendFleet(my, capTarget, send); acted++; continue; }
    }

    // 2) FEED — interior node with no affordable target: ship one hop forward.
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
      if (send >= 5) { sendFleet(my, best, send); acted++; }
    }
  }
}

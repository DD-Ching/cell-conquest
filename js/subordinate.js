// =====================================================
// Subordinate AI — the player's lieutenant. Manages bases the player has
// tagged with `n.delegated = true` (via the G key). Treats the player as
// its own faction (sends to / receives from any player node, attacks any
// non-player node), but only INITIATES actions from delegated bases.
//
// Behavior priority (one action per tick):
//   1. Build defensive AA / factory at unit-rich delegated bases
//   2. Attack neutral or weakly-defended enemy neighbours
//   3. Reinforce delegated siblings under threat
//   4. Dump overflow forward when saturated
//
// All decisions go through the existing sendFleet / placeTurretAt paths
// — no new game APIs — so the subordinate plays by the same rules the
// player would clicking manually.
// =====================================================
import { state } from './state.js';
import { AA_RADIUS, ENG_COST, FLEET_SPEED } from './config.js';
import { sendFleet } from './fleets.js';
import { placeTurretAt } from './engineering.js';
import { catchUpAllNodes, catchUpRegen } from './world.js';

let _timer = 0;

export function subordinateTick(dt) {
  _timer -= dt;
  if (_timer > 0) return;
  _timer = 0.7 + Math.random() * 0.3;

  catchUpAllNodes();
  const myBases = [];
  for (const n of state.nodes) {
    if (n.owner === 'player' && n.delegated) myBases.push(n);
  }
  if (myBases.length === 0) return;

  const myTurrets = state.turretsByOwner.get('player') || [];

  // ---- 1. Build defenses at delegated bases ----
  // Bias toward AA first (anti-drone), then factory (drone production).
  for (const base of myBases) {
    if (base.units < ENG_COST + 12) continue;        // need slack to dispatch + garrison
    let nearAA = 0, nearFactory = 0;
    for (const t of myTurrets) {
      const dx = t.x - base.x, dy = t.y - base.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 220 * 220) {
        if (t.type === 'antiair') nearAA++;
        else if (t.type === 'factory') nearFactory++;
      }
    }
    const enemy = findNearestEnemyNode(base);
    if (!enemy) continue;
    const dx = enemy.x - base.x, dy = enemy.y - base.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    // 4-AA defensive wall first, then a couple of factories behind hub
    if (nearAA < 4 && Math.random() < 0.4) {
      const spot = { x: base.x + ux * 70, y: base.y + uy * 70 };
      if (placeTurretAt(spot.x, spot.y, 'antiair', 'player')) return;
    }
    if (nearAA >= 2 && nearFactory < 3 && Math.random() < 0.25) {
      const spot = { x: base.x - ux * 50, y: base.y - uy * 50 };
      if (placeTurretAt(spot.x, spot.y, 'factory', 'player')) return;
    }
  }

  // ---- 2. Attack weak enemy / neutral neighbours ----
  // Prefer targets we can beat with surplus units (defenders × 1.5 margin).
  let bestAttack = null, bestScore = 0;
  for (const base of myBases) {
    const surplus = attackerAvail(base);
    if (surplus < 8) continue;
    for (const nbId of state.adj.get(base.id) || []) {
      const nb = state.nodes[nbId];
      if (nb.owner === 'player') continue;
      catchUpRegen(nb);
      const required = (nb.owner === 'neutral' ? nb.units : nb.units * 1.5) + 4;
      if (surplus < required) continue;
      // Score: prefer easier captures, closer targets, more valuable nodes
      const value = nb.size + (nb.owner === 'neutral' ? 8 : 0);
      const score = value / (required + 4);
      if (score > bestScore) {
        bestScore = score;
        bestAttack = { from: base, to: nb, amount: Math.ceil(required * 1.25) };
      }
    }
  }
  if (bestAttack && sendFleet(bestAttack.from, bestAttack.to, bestAttack.amount)) return;

  // ---- 3. Reinforce delegated siblings under threat ----
  // Detect hostile adjacency: any non-player neighbour with units > our defender count.
  for (const base of myBases) {
    let threat = 0;
    for (const nbId of state.adj.get(base.id) || []) {
      const nb = state.nodes[nbId];
      if (nb.owner !== 'player' && nb.owner !== 'neutral') threat += nb.units;
    }
    if (threat < base.units * 1.4) continue;
    // Find a sibling delegated base that can spare units
    let donor = null, donorSurplus = 0;
    for (const sib of myBases) {
      if (sib === base) continue;
      const surplus = attackerAvail(sib);
      if (surplus > donorSurplus) { donorSurplus = surplus; donor = sib; }
    }
    if (donor && donorSurplus >= 8) {
      const send = Math.min(donorSurplus, Math.ceil(threat * 0.5));
      if (send >= 5 && sendFleet(donor, base, send)) return;
    }
  }

  // ---- 4. Dump overflow forward (saturated bases → adjacent player frontline) ----
  for (const base of myBases) {
    if (base.units < base.capacity * 0.85) continue;
    let target = null, bestFront = -1;
    for (const nbId of state.adj.get(base.id) || []) {
      const nb = state.nodes[nbId];
      if (nb.owner !== 'player') continue;
      let front = 0;
      for (const nbnbId of state.adj.get(nb.id) || []) {
        const nnb = state.nodes[nbnbId];
        if (nnb.owner !== 'player' && nnb.owner !== 'neutral') front += 2;
      }
      if (front > bestFront) { bestFront = front; target = nb; }
    }
    if (target) {
      const send = Math.floor((base.units - 8) * 0.55);
      if (send >= 5 && sendFleet(base, target, send)) return;
    }
  }
}

// ---- Helpers ----

function attackerAvail(node) {
  let enemyNeighbors = 0;
  for (const nbId of state.adj.get(node.id) || []) {
    const nb = state.nodes[nbId];
    if (nb.owner !== 'player' && nb.owner !== 'neutral') enemyNeighbors++;
  }
  // Keep a defensive floor — more if exposed, less if interior.
  const reserve = 5 + enemyNeighbors * 8 + Math.floor(node.capacity * 0.18);
  return Math.max(0, node.units - reserve);
}

function findNearestEnemyNode(from) {
  let best = null, bestD2 = Infinity;
  for (const n of state.nodes) {
    if (n.owner === 'player' || n.owner === 'neutral') continue;
    const dx = n.x - from.x, dy = n.y - from.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = n; }
  }
  return best;
}

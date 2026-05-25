// =====================================================
// Per-tick AI: heuristic v3 (defense / attack / reinforce)
// with engineering build decisions, plus NN dispatch for
// faction ids listed in config.NN_OWNERS.
// =====================================================
import { state } from './state.js';
import { FLEET_SPEED, NN_OWNERS } from './config.js';
import { dist } from './util.js';
import { sendFleet } from './fleets.js';
import { orderBuild } from './engineering.js';
import { nnDecide, nnActionFor, isNNReady } from './nn.js';

export function aiTick(owner, dt) {
  state.aiTimers[owner] -= dt;
  if (state.aiTimers[owner] > 0) return;
  // NN player decides every ~0.3s (matches training cadence); heuristic stays slower
  state.aiTimers[owner] = NN_OWNERS.has(owner)
    ? (0.25 + Math.random() * 0.15)
    : (1.2 + Math.random() * 0.7);

  // ---- NN-controlled faction: apply cached action, dispatch async inference for next tick
  if (NN_OWNERS.has(owner) && isNNReady()) {
    const a = nnActionFor(owner);
    nnDecide(owner);            // async; fills nnLastAction for the next tick
    if (a) {
      const from = state.nodes[a.src], to = state.nodes[a.dst];
      if (from && to && from.owner === owner && from.units >= 2 && from.id !== to.id) {
        sendFleet(from, to, Math.floor(from.units / 2));
      }
    }
    return;
  }

  const myNodes = state.nodes.filter(n => n.owner === owner);
  if (myNodes.length === 0) return;

  // ---- Engineering: occasional build orders on hub nodes ----
  if (Math.random() < 0.12 && myNodes.length >= 3) {
    const byHub = [...myNodes].sort((a, b) => state.adj.get(b.id).size - state.adj.get(a.id).size);
    for (const n of byHub) {
      if (n.units < 30) continue;
      const has = (t) => n.buildings.some(b => b.type === t);
      if (!has('antiair')) { if (orderBuild(n, 'antiair', owner)) return; }
      else if (!has('factory')) { if (orderBuild(n, 'factory', owner)) return; }
      else if (!has('net')) { if (orderBuild(n, 'net', owner)) return; }
    }
  }

  // ---- Heuristic v3 — game-state-aware aggression ----
  const totalOwned = state.nodes.filter(n => n.owner !== 'neutral').length || 1;
  const myShare = myNodes.length / totalOwned;
  const counts = {};
  for (const n of state.nodes) {
    if (n.owner === 'neutral') continue;
    counts[n.owner] = (counts[n.owner] || 0) + 1;
  }
  const leaderEntry = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const iAmLeader = leaderEntry && leaderEntry[0] === owner;
  let aggression = 1.0 + Math.min(state.elapsed / 180, 2.0);
  if (iAmLeader && myShare > 0.40) aggression *= 1.4;
  else if (myShare < 0.20) aggression *= 1.3;

  function incomingTo(nodeId) {
    let friendly = 0, hostile = 0, hostileSrc = null;
    const targetOwner = state.nodes[nodeId].owner;
    for (const f of state.fleets) {
      let finalId;
      if (f.kind === 'drone') finalId = f.targetNodeId;
      else if (f.path) finalId = f.path[f.path.length - 1];
      else continue;
      if (finalId !== nodeId) continue;
      if (f.owner === targetOwner) friendly += f.units;
      else { hostile += f.units; if (!hostileSrc && f.path) hostileSrc = f.path[0]; }
    }
    return { friendly, hostile, hostileSrc };
  }

  function attackerAvail(node) {
    let enemyNeighbors = 0;
    for (const nbId of state.adj.get(node.id)) {
      const nb = state.nodes[nbId];
      if (nb.owner !== owner && nb.owner !== 'neutral') enemyNeighbors++;
    }
    const reserveRatio = 0.15 + enemyNeighbors * 0.18;
    const reserveAbs = 5 + enemyNeighbors * 9;
    return Math.max(0, node.units * (1 - reserveRatio) - reserveAbs);
  }

  // Phase 1: proactive defense
  for (const my of myNodes) {
    const inc = incomingTo(my.id);
    if (inc.hostile <= 5) continue;
    const projected = my.units + inc.friendly + my.regenRate * 5 - inc.hostile;
    const dangerThresh = Math.max(5, my.capacity * 0.20);
    if (projected < dangerThresh) {
      let donor = null, donorScore = 0;
      for (const nbId of state.adj.get(my.id)) {
        const nb = state.nodes[nbId];
        if (nb.owner !== owner) continue;
        const surplus = attackerAvail(nb);
        if (surplus < 10) continue;
        if (surplus > donorScore) { donorScore = surplus; donor = nb; }
      }
      if (donor) {
        const need = Math.ceil(inc.hostile - projected + 8);
        const send = Math.min(Math.floor(donorScore), need);
        if (send >= 5) { sendFleet(donor, my, send); return; }
      }
    }
  }

  // Phase 2: coordinated attack
  const targetMap = new Map();
  for (const my of myNodes) {
    if (attackerAvail(my) < 5) continue;
    for (const nbId of state.adj.get(my.id)) {
      const target = state.nodes[nbId];
      if (target.owner === owner) continue;
      if (!targetMap.has(nbId)) targetMap.set(nbId, []);
      targetMap.get(nbId).push(my);
    }
  }

  let bestAtt = null, bestScore = 0;
  for (const [tId, attackers] of targetMap) {
    const target = state.nodes[tId];
    const minTime = Math.min(...attackers.map(a => dist(a, target) / FLEET_SPEED));
    let trueDefenders = target.units;
    if (target.owner !== 'neutral') trueDefenders += target.regenRate * minTime;
    for (const f of state.fleets) {
      let finalId;
      if (f.kind === 'drone') finalId = f.targetNodeId;
      else if (f.path) finalId = f.path[f.path.length - 1];
      else continue;
      if (finalId !== tId) continue;
      if (f.owner === target.owner) trueDefenders += f.units;
      else if (f.owner === owner) trueDefenders -= f.units;
    }
    trueDefenders = Math.max(0, trueDefenders);

    const required = trueDefenders + 5 + target.size * 0.3;
    const minThreshold = required / aggression;
    const availForce = attackers.reduce((s, a) => s + attackerAvail(a), 0);
    if (availForce < minThreshold) continue;

    const adjCount = state.adj.get(tId).size;
    const sat = target.units / Math.max(1, target.capacity);
    const value = adjCount * 2.8 + target.regenRate * 9 + target.size * 0.5;
    let score = value / (required + 8);
    if (target.owner === 'neutral') score *= 1.5;
    score *= aggression;
    score *= (1.0 + 0.6 * (1.0 - sat));         // opportunism: emptier targets first
    const avgDist = attackers.reduce((s, a) => s + dist(a, target), 0) / attackers.length;
    score *= 1.0 / (1.0 + avgDist / 600);

    if (score > bestScore) {
      bestScore = score;
      bestAtt = { attackers: [...attackers], target, required };
    }
  }

  if (bestAtt) {
    bestAtt.attackers.sort((a, b) => dist(a, bestAtt.target) - dist(b, bestAtt.target));
    let toSend = bestAtt.required + 6;
    for (const a of bestAtt.attackers) {
      if (toSend <= 0) break;
      const max = Math.floor(attackerAvail(a));
      if (max < 3) continue;
      const send = Math.min(max, Math.ceil(toSend));
      if (send >= 3) { sendFleet(a, bestAtt.target, send); toSend -= send; }
    }
    return;
  }

  // Phase 3: cap-aware reinforce frontline
  for (const my of myNodes) {
    if (my.units < my.capacity * 0.85) continue;
    let bestRecip = null, bestRecipScore = 0;
    for (const nbId of state.adj.get(my.id)) {
      const nb = state.nodes[nbId];
      if (nb.owner !== owner) continue;
      if (nb.units >= nb.capacity * 0.85) continue;
      let frontness = 0;
      for (const nbnbId of state.adj.get(nb.id)) {
        const nnb = state.nodes[nbnbId];
        if (nnb.owner !== owner && nnb.owner !== 'neutral') frontness += 3;
        else if (nnb.owner === 'neutral') frontness += 1;
      }
      frontness += state.adj.get(nb.id).size * 0.5;
      if (frontness > bestRecipScore) { bestRecipScore = frontness; bestRecip = nb; }
    }
    if (bestRecip && bestRecipScore > 0) {
      const room = Math.max(0, bestRecip.capacity * 1.4 - bestRecip.units);
      const send = Math.min(Math.floor(my.units * 0.5), Math.floor(room));
      if (send >= 5) { sendFleet(my, bestRecip, send); return; }
    }
  }
}

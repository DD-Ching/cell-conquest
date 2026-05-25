// =====================================================
// Per-tick AI: heuristic v3 (defense / attack / reinforce)
// with engineering build decisions, plus NN dispatch for
// faction ids listed in config.NN_OWNERS.
// =====================================================
import { state } from './state.js';
import {
  FLEET_SPEED, NN_OWNERS, NET_LEVEL_MAX,
  AA_RADIUS, TANK_RADIUS, TANK_DPS,
} from './config.js';
import { dist } from './util.js';
import { sendFleet } from './fleets.js';
import { placeTurretAt, placeNetOnEdge, ekey } from './engineering.js';
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

  // ---- Saturation: how much of my regen is being wasted because nodes are full ----
  // Full nodes (>= 95% cap) gain nothing from sitting still. The more of my empire
  // is saturated, the more I should be spending units (turrets, attacks, reinforces).
  let saturatedCount = 0;
  for (const n of myNodes) if (n.units >= n.capacity * 0.95) saturatedCount++;
  const saturationRatio = saturatedCount / myNodes.length;

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
  // Wasted-regen drive: when ≥30% of my nodes are full, I push harder
  if (saturationRatio > 0.5) aggression *= 1.55;
  else if (saturationRatio > 0.3) aggression *= 1.25;

  // ---- Anti-turtle detection ----
  // If my node count hasn't grown for a while AND opponents are stacking turrets,
  // the player is walling up. Switch to factory-rush + heavier commitments to crack it.
  state.aiMetrics ||= {};
  const m = state.aiMetrics[owner] ||= { lastNodeCount: myNodes.length, lastChangeT: state.elapsed };
  if (myNodes.length !== m.lastNodeCount) {
    m.lastNodeCount = myNodes.length;
    m.lastChangeT = state.elapsed;
  }
  const stagnantSec = state.elapsed - m.lastChangeT;
  const enemyTurrets = state.turrets.filter(t => t.owner !== owner && t.owner !== 'neutral' && t.active).length;
  const enemyAA = state.turrets.filter(t => t.owner !== owner && t.type === 'antiair' && t.active).length;
  const antiTurtle = stagnantSec > 18 && enemyTurrets >= 3;
  // Far-behind: someone clearly ahead and I'm small
  const sharesByOwner = {};
  for (const n of state.nodes) {
    if (n.owner === 'neutral' || n.owner === owner) continue;
    sharesByOwner[n.owner] = (sharesByOwner[n.owner] || 0) + 1;
  }
  const topEnemyShare = Math.max(0, ...Object.values(sharesByOwner)) / state.nodes.length;
  const farBehind = myShare < 0.18 && topEnemyShare > 0.40;
  // Anti-turtle: MIRROR the enemy's defensive posture. Throwing waves into
  // a wall just feeds tanks. Stay normal-aggression so Phase 2 naturally
  // skips fortified targets (turret threat is now part of `required`), and
  // pour the spare capacity into our own turrets + factories below.
  // (Drones bypass tanks; that's the actual wall-breaker.)
  if (farBehind) aggression *= 1.3;
  // Opening burst — grab the map before the player turtles up
  if (state.elapsed < 35) aggression *= 1.3;

  // ---- Hostile turret threat to ground attacks targeting a given node ----
  // Tank turrets within ~range of the target node will chew up our attackers en route.
  // Counts expected casualties so Phase 2's `required` reflects reality.
  function turretThreatTo(targetNode) {
    let threat = 0;
    for (const t of state.turrets) {
      if (!t.active) continue;
      if (t.owner === owner) continue;
      if (t.type !== 'tank') continue;
      const d = Math.hypot(t.x - targetNode.x, t.y - targetNode.y);
      if (d < TANK_RADIUS + 60) threat += TANK_DPS * 0.6 * 3.5;  // ~3.5s exposure
    }
    return threat;
  }

  // ---- Engineering: smart turret placement ----
  // Build chance scales with saturation — full coffers should be spent on infrastructure.
  const buildChance = 0.12 + saturationRatio * 0.40 + (antiTurtle ? 0.15 : 0);
  const buildMinUnits = saturationRatio > 0.4 ? 18 : 30;

  // Helper: count enemy neighbors of a node (frontness)
  function frontness(n) {
    let count = 0;
    for (const nb of state.adj.get(n.id)) {
      const o = state.nodes[nb].owner;
      if (o !== owner && o !== 'neutral') count++;
    }
    return count;
  }
  // Helper: refuse to send engineers into enemy tank kill zones
  function isExposedToEnemyTank(x, y) {
    for (const t of state.turrets) {
      if (!t.active || t.owner === owner || t.type !== 'tank') continue;
      if (Math.hypot(t.x - x, t.y - y) < TANK_RADIUS - 20) return true;
    }
    return false;
  }

  if (Math.random() < buildChance && myNodes.length >= 2) {
    const byHub = [...myNodes].sort((a, b) => state.adj.get(b.id).size - state.adj.get(a.id).size);

    for (const n of byHub) {
      if (n.units < buildMinUnits) continue;

      // Direction toward the nearest enemy (defines "front" vs "back")
      let toward = null, towardDist = Infinity;
      for (const en of state.nodes) {
        if (en.owner === owner || en.owner === 'neutral') continue;
        const d = dist(n, en);
        if (d < towardDist) { towardDist = d; toward = en; }
      }
      if (!toward) continue;          // no enemies anywhere — nothing to defend against
      const ddx = toward.x - n.x, ddy = toward.y - n.y;
      const dlen = Math.hypot(ddx, ddy) || 1;
      const dirX = ddx / dlen, dirY = ddy / dlen;
      const off = { dx: dirX * 70, dy: dirY * 70 };

      const isFront = frontness(n) > 0;

      // Survey friendly infrastructure NEAR this hub
      const ownAAsNear = state.turrets.filter(t =>
        t.owner === owner && t.type === 'antiair' &&
        Math.hypot(t.x - n.x, t.y - n.y) < 160);
      const ownTanksNear = state.turrets.filter(t =>
        t.owner === owner && t.type === 'tank' &&
        Math.hypot(t.x - n.x, t.y - n.y) < 160);
      const ownFactoriesNear = state.turrets.filter(t =>
        t.owner === owner && t.type === 'factory' &&
        Math.hypot(t.x - n.x, t.y - n.y) < 100);
      // Is THIS hub within range of ANY friendly AA (umbrella coverage)?
      const aaCoversThisHub = state.turrets.some(t =>
        t.owner === owner && t.type === 'antiair' &&
        Math.hypot(t.x - n.x, t.y - n.y) < AA_RADIUS * 0.8);

      // Enemy pressure near this hub
      const enemyTurretsNear = state.turrets.filter(t =>
        t.owner !== owner && t.active &&
        Math.hypot(t.x - n.x, t.y - n.y) < 280).length;

      // ---- 1) First AA on a front hub ----
      if (isFront && ownAAsNear.length === 0) {
        const tx = n.x + off.dx, ty = n.y + off.dy;
        if (!isExposedToEnemyTank(tx, ty) && placeTurretAt(tx, ty, 'antiair', owner)) return;
      }

      // ---- 2) First Tank on a front hub (after AA is in place) ----
      if (isFront && ownAAsNear.length >= 1 && ownTanksNear.length === 0) {
        const tx = n.x + off.dx * 1.4, ty = n.y + off.dy * 1.4;
        if (!isExposedToEnemyTank(tx, ty) && placeTurretAt(tx, ty, 'tank', owner)) return;
      }

      // ---- 3) Stack additional AAs with OVERLAPPING coverage ----
      // 2nd / 3rd AA placed on perpendicular flanks so their ranges intersect
      // the first AA — drones flying through the gap get hit by multiple AAs.
      const stackThresh = antiTurtle ? 1 : 2;
      if (isFront && ownAAsNear.length >= 1 && ownAAsNear.length < 3 && enemyTurretsNear >= stackThresh) {
        const px = -dirY, py = dirX;          // perpendicular unit vector
        const side = (ownAAsNear.length % 2 === 0) ? 1 : -1;
        const tx = n.x + off.dx * 0.5 + px * side * 90;
        const ty = n.y + off.dy * 0.5 + py * side * 90;
        if (!isExposedToEnemyTank(tx, ty) && placeTurretAt(tx, ty, 'antiair', owner)) return;
      }

      // ---- 4) Factory — only at hubs already under our AA umbrella, placed BEHIND the hub ----
      const factoryLimit = antiTurtle ? 2 : 1;
      if (aaCoversThisHub && ownFactoriesNear.length < factoryLimit) {
        const stackOff = 35 + ownFactoriesNear.length * 30;
        const fx = n.x - dirX * stackOff;
        const fy = n.y - dirY * stackOff;
        if (!isExposedToEnemyTank(fx, fy) && placeTurretAt(fx, fy, 'factory', owner)) return;
      }

      // ---- 5) Second Tank on flank if heavy enemy turret pressure ----
      if (isFront && ownTanksNear.length === 1 && enemyTurretsNear >= 3) {
        const px = -dirY, py = dirX;
        const tx = n.x + off.dx * 1.4 + px * 70;
        const ty = n.y + off.dy * 1.4 + py * 70;
        if (!isExposedToEnemyTank(tx, ty) && placeTurretAt(tx, ty, 'tank', owner)) return;
      }
    }
  }

  // ---- Net building: upgrade drone-nets on front-line edges ----
  // Front edges = at least one endpoint is mine AND that endpoint touches an enemy.
  // Nets only matter where troops actually march, so we score by exposure.
  if (Math.random() < 0.10 + saturationRatio * 0.20) {
    let cand = null, bestScore = -1;
    for (const r of state.roads) {
      const e = state.edgeData.get(ekey(r.a, r.b));
      if (!e) continue;
      if (e.netLevel >= NET_LEVEL_MAX) continue;
      const aN = state.nodes[r.a], bN = state.nodes[r.b];
      const aMine = aN.owner === owner, bMine = bN.owner === owner;
      if (!aMine && !bMine) continue;
      let exposure = 0;
      for (const endpoint of [aN, bN]) {
        if (endpoint.owner !== owner) continue;
        for (const nb of state.adj.get(endpoint.id)) {
          const o = state.nodes[nb].owner;
          if (o !== owner && o !== 'neutral') exposure += 1;
        }
      }
      if (exposure === 0) continue;
      // Don't send a net engineer into an enemy tank's kill zone — they'll die on approach.
      const mx = (aN.x + bN.x) / 2, my = (aN.y + bN.y) / 2;
      if (isExposedToEnemyTank(mx, my)) continue;
      // Concentration bias: prefer maxing an existing partial net to L3 before
      // starting a brand-new one. Spread-thin L1s don't stop drone swarms.
      let score = exposure * (NET_LEVEL_MAX + 1 - e.netLevel);
      score += e.netLevel * exposure * 1.8;
      if (score > bestScore) { bestScore = score; cand = r; }
    }
    if (cand && placeNetOnEdge(cand.a, cand.b, owner)) return;
  }

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
    // Saturated node — sitting on units is wasted regen, so dump most of them.
    if (node.units >= node.capacity * 0.95) {
      const garrison = 6 + enemyNeighbors * 4;
      return Math.max(0, node.units - garrison);
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

    const tankThreat = turretThreatTo(target);
    const required = trueDefenders + 5 + target.size * 0.3 + tankThreat;
    const minThreshold = required / aggression;
    const availForce = attackers.reduce((s, a) => s + attackerAvail(a), 0);
    if (availForce < minThreshold) continue;
    // Hard skip: if the target is heavily protected by tanks (the wall trap),
    // don't feed the meat grinder. Wait for drones to chip the wall down.
    if (tankThreat > 0 && tankThreat > availForce * 0.45) continue;

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

  // Phase 3: cap-aware reinforce frontline — lower threshold when empire is saturated
  const dumpThresh = saturationRatio > 0.4 ? 0.70 : 0.85;
  for (const my of myNodes) {
    if (my.units < my.capacity * dumpThresh) continue;
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

  // Phase 4: emergency overflow — if any node is FULL and nothing above fired,
  // ship surplus to the most-front friendly neighbor regardless of its fill.
  // Pure regen waste is worse than slight overflow, and a thicker hub can absorb a strike.
  for (const my of myNodes) {
    if (my.units < my.capacity * 0.95) continue;
    let target = null, bestFront = -1;
    for (const nbId of state.adj.get(my.id)) {
      const nb = state.nodes[nbId];
      if (nb.owner !== owner) continue;
      let frontness = 0;
      for (const nbnbId of state.adj.get(nb.id)) {
        const nnb = state.nodes[nbnbId];
        if (nnb.owner !== owner && nnb.owner !== 'neutral') frontness += 3;
        else if (nnb.owner === 'neutral') frontness += 1;
      }
      if (frontness > bestFront) { bestFront = frontness; target = nb; }
    }
    if (target) {
      const send = Math.floor((my.units - 8) * 0.6);
      if (send >= 5) { sendFleet(my, target, send); return; }
    }
  }
}

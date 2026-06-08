// =====================================================
// AI tactical phases — moment-to-moment fleet decisions.
//
// Phase order (caller stops at first true return):
//   1. tryDefend(ctx)           — react to incoming + adjacent stockpiles
//   1.5 tryAssaultTurrets(ctx)  — suicide infantry on enemy turrets
//   2. tryCoordinatedAttack(ctx) — capture enemy/neutral nodes; also dispatches
//                                  a combined-arms tank-killer assault on the
//                                  same target in the same beat
//   3. tryReinforceFrontline(ctx) — pour rear-hub regen toward front nodes
//   4. tryOverflowDump(ctx)     — emergency: any FULL node dumps to most-front
//                                  friendly neighbour, even if neighbour is fullish
//
// Each phase returns true if it fired an action this tick. ctx is built once
// in ai.js and carries: { owner, myNodes, saturationRatio, aggression,
// fleetsByTarget, incomingTo, attackerAvail, turretThreatTo }.
// =====================================================
import { state } from './state.js';
import { dist } from './util.js';
import { isAlly } from './alliance.js';
import { FLEET_SPEED, TANK_RADIUS } from './config.js';
// Side effects (sendFleet, assaultTurret) come through ctx — see ai-effects.js.

/** Phase 1: defensive reinforcement.
 *  Reacts to active incoming hostile fleets AND to adjacent-enemy STOCKPILES
 *  (the wave that's about to be launched). Reinforcing AFTER the wave hits
 *  loses the node — we need to thicken garrisons BEFORE the punch. */
export function tryDefend(ctx) {
  const { owner, myNodes, incomingTo, attackerAvail, sendFleet } = ctx;
  for (const my of myNodes) {
    const degree = state.adj.get(my.id).size;
    const isCentral = degree >= 3;
    const inc = incomingTo(my.id);

    // Sum of units in adjacent enemy hubs (the wave that's *about* to be launched).
    let adjEnemyStockpile = 0;
    for (const nbId of state.adj.get(my.id)) {
      const nb = state.nodes[nbId];
      if (!isAlly(nb.owner, owner) && nb.owner !== 'neutral') adjEnemyStockpile += nb.units;
    }

    const projected = my.units + inc.friendly + my.regenRate * 5 - inc.hostile;
    // Central hubs need a beefy garrison; outposts can run leaner.
    const minGarrison = isCentral ? my.capacity * 0.50 : Math.max(5, my.capacity * 0.25);
    const beingStockpiledAgainst = adjEnemyStockpile > my.units * 1.5 && adjEnemyStockpile > 30;

    const needs = projected < minGarrison || beingStockpiledAgainst || inc.hostile > 5;
    if (!needs) continue;

    let donor = null, donorScore = 0;
    for (const nbId of state.adj.get(my.id)) {
      const nb = state.nodes[nbId];
      if (nb.owner !== owner) continue;
      const surplus = attackerAvail(nb);
      if (surplus < 10) continue;
      if (surplus > donorScore) { donorScore = surplus; donor = nb; }
    }
    if (!donor) continue;
    const need = Math.max(
      inc.hostile > 0 ? Math.ceil(inc.hostile - projected + 8) : 0,
      Math.ceil(minGarrison - my.units),
      Math.ceil(adjEnemyStockpile * 0.45 - my.units),
    );
    const send = Math.min(Math.floor(donorScore), Math.max(5, need));
    if (send >= 5) { sendFleet(donor, my, send); return true; }
  }
  return false;
}

/** Phase 1.5: dismantle the enemy's defensive wall with suicide infantry.
 *  Frontal attacks against tank-guarded hubs get shredded — break the screen
 *  first. Each infantry unit absorbs 8 HP off the turret. */
export function tryAssaultTurrets(ctx) {
  const { owner, myNodes, saturationRatio, attackerAvail, assaultTurret } = ctx;
  if (Math.random() >= 0.25 + saturationRatio * 0.20) return false;

  let pick = null, pickScore = 0;
  for (const t of state.turrets) {
    if (!t.active) continue;
    if (isAlly(t.owner, owner) || t.owner === 'neutral') continue;
    // Closest own node to this turret — assault path starts there.
    let near = null, nearD2 = Infinity;
    for (const n of myNodes) {
      const dx = n.x - t.x, dy = n.y - t.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearD2) { nearD2 = d2; near = n; }
    }
    if (!near || nearD2 > 480 * 480) continue;
    const nearD = Math.sqrt(nearD2);
    const cost = Math.ceil(t.hp / 8) + 6;       // HP/8 damage per troop, +safety
    if (attackerAvail(near) < cost) continue;
    // Value by type: tanks block our attacks (highest priority), then
    // factories (drone-spam source), then artillery (cluster-busters), then AA.
    let typeVal = 1.0;
    if (t.type === 'tank')           typeVal = 3.5;
    else if (t.type === 'factory')   typeVal = 2.5;
    else if (t.type === 'artillery') typeVal = 2.2;
    else if (t.type === 'antiair')   typeVal = 1.8;
    const score = (typeVal / (cost + 5)) * (1 / (1 + nearD / 200));
    if (score > pickScore) { pickScore = score; pick = { from: near, t, cost }; }
  }
  return !!(pick && assaultTurret(pick.from, pick.t, pick.cost));
}

/** Phase 2: coordinated ground attack on an enemy / neutral node.
 *  Scores every reachable target by value / required-force, weighted by
 *  aggression, emptier-first opportunism, distance, and stickiness on the
 *  current focus. If a target is picked, ALSO dispatches a combined-arms
 *  assault on a tank specifically covering that target (one per tick).
 *  Updates state.aiFocus for the drone-salvo phase to converge on the same
 *  hub next tick. */
export function tryCoordinatedAttack(ctx) {
  const { owner, myNodes, aggression, fleetsByTarget, attackerAvail, turretThreatTo,
          eliminationOwners, sendFleet, assaultTurret } = ctx;

  const targetMap = new Map();
  for (const my of myNodes) {
    if (attackerAvail(my) < 5) continue;
    for (const nbId of state.adj.get(my.id)) {
      const target = state.nodes[nbId];
      if (isAlly(target.owner, owner)) continue;
      // Tutorial: the foe NEVER attacks the player's side — it defends + holds its
      // own ground so the lesson can't be overrun and the new player can't be
      // wiped. It still fights for its forward node + HQ, so the player gets real
      // resistance on offense (and the enemy can't advance into your territory).
      if (state.tutorial && isAlly(target.owner, 'player')) continue;
      if (!targetMap.has(nbId)) targetMap.set(nbId, []);
      targetMap.get(nbId).push(my);
    }
  }

  // Hunt mode: is a near-dead / suppressed enemy's node reachable THIS tick?
  // If so, CONCENTRATE — roll up that enemy's territory instead of wandering
  // off to paint neutral nodes. (Capture HIS land, not the whole map: the
  // attack is directional, aimed at finishing one weak enemy, not opportunistic
  // map-painting.) Neutrals get dampened below so the enemy's own nodes win.
  let huntMode = false;
  if (eliminationOwners && eliminationOwners.size) {
    for (const tId of targetMap.keys()) {
      if (eliminationOwners.has(state.nodes[tId].owner)) { huntMode = true; break; }
    }
  }

  let bestAtt = null, bestScore = 0;
  for (const [tId, attackers] of targetMap) {
    const target = state.nodes[tId];
    const minTime = Math.min(...attackers.map(a => dist(a, target) / FLEET_SPEED));
    let trueDefenders = target.units;
    if (target.owner !== 'neutral') trueDefenders += target.regenRate * minTime;
    const inbound = fleetsByTarget.get(tId);
    if (inbound) {
      for (const f of inbound) {
        if (f.owner === target.owner) trueDefenders += f.units;
        else if (isAlly(f.owner, owner)) trueDefenders -= f.units;
      }
    }
    trueDefenders = Math.max(0, trueDefenders);

    const tankThreat = turretThreatTo(target);
    const required = trueDefenders + 5 + target.size * 0.3 + tankThreat;
    const minThreshold = required / aggression;
    const availForce = attackers.reduce((s, a) => s + attackerAvail(a), 0);
    if (availForce < minThreshold) continue;
    // Hard skip only when tanks are overwhelmingly dominant. Phase 1.5 above
    // is now dismantling the wall via assault, so Phase 2 doesn't need to be
    // ultra-conservative — modest tank presence is just a price tag.
    if (tankThreat > 0 && tankThreat > availForce * 0.75) continue;

    const adjCount = state.adj.get(tId).size;
    const sat = target.units / Math.max(1, target.capacity);
    const value = adjCount * 2.8 + target.regenRate * 9 + target.size * 0.5;
    let score = value / (required + 8);
    // Neutral opportunism — but when we're hunting a weak enemy, DAMP neutrals
    // hard so the offensive stays pointed at the enemy's territory instead of
    // peeling off to grab empty land.
    if (target.owner === 'neutral') score *= huntMode ? 0.4 : 1.5;
    // ELIMINATION FOCUS — a node belonging to a near-dead enemy (its last
    // 1-2 bases) is the win-the-game move: capturing it shrinks/eliminates a
    // faction. Drones can only suppress; ground troops finish the job. Heavy
    // boost so the AI converges to KILL instead of drifting off grabbing
    // neutrals while a suppressed enemy sits there regenerating.
    if (eliminationOwners && eliminationOwners.has(target.owner)) score *= 5.0;
    score *= aggression;
    score *= (1.0 + 0.6 * (1.0 - sat));         // opportunism: emptier targets first
    const avgDist = attackers.reduce((s, a) => s + dist(a, target), 0) / attackers.length;
    score *= 1.0 / (1.0 + avgDist / 600);
    // Stickiness: heavy bonus for staying on the strategic focus (the node
    // we already committed forces to last tick). Stops the "1 wave per node
    // per tick" thrashing that lets defenders regen between hits.
    const focus = state.aiFocus[owner];
    if (focus && focus.targetId === tId && (state.elapsed - focus.since) < 20) {
      score *= 2.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestAtt = { attackers: [...attackers], target, required };
    }
  }

  if (!bestAtt) return false;

  bestAtt.attackers.sort((a, b) => dist(a, bestAtt.target) - dist(b, bestAtt.target));
  // Overcommit by 40% + 12 buffer so attacks roll through with mass, not
  // just barely-passing margin. Player tactic: send way more than needed,
  // captured node still has units to keep pressing the next target.
  let toSend = bestAtt.required * 1.4 + 12;
  for (const a of bestAtt.attackers) {
    if (toSend <= 0) break;
    const max = Math.floor(attackerAvail(a));
    if (max < 3) continue;
    const send = Math.min(max, Math.ceil(toSend));
    if (send >= 3) { sendFleet(a, bestAtt.target, send); toSend -= send; }
  }
  // Combined arms: if Phase 1.5 found a high-value turret near this target,
  // it would have fired earlier. But if there's a tank specifically covering
  // THIS target and we have spare assault capacity at a sibling node, also
  // dispatch an assault to that tank in the same beat — drone salvo plus
  // ground wave plus tank-killer all converge on the same hub.
  if (bestAtt.target) {
    const tgt = bestAtt.target;
    const tankCoverR2 = (TANK_RADIUS + 80) * (TANK_RADIUS + 80);
    const enemyTanks = state.turretsByType.get('tank') || [];
    for (const t of enemyTanks) {
      if (!t.active || t.pendingEngineer) continue;
      if (isAlly(t.owner, owner) || t.owner === 'neutral') continue;
      const tdx = t.x - tgt.x, tdy = t.y - tgt.y;
      if (tdx * tdx + tdy * tdy > tankCoverR2) continue;
      // Pick an own node not already attacking, with enough surplus
      let assaultFrom = null, fromD2 = Infinity;
      for (const n of myNodes) {
        if (bestAtt.attackers.includes(n)) continue;
        const dx = n.x - t.x, dy = n.y - t.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 460 * 460) continue;
        const cost = Math.ceil(t.hp / 8) + 6;
        if (attackerAvail(n) < cost) continue;
        if (d2 < fromD2) { fromD2 = d2; assaultFrom = n; }
      }
      if (assaultFrom) {
        assaultTurret(assaultFrom, t, Math.ceil(t.hp / 8) + 6);
        break;        // one combined-arms assault per tick is enough
      }
    }
  }
  // Remember this target for the salvo phase next tick (drones converge here).
  state.aiFocus[owner] = { targetId: bestAtt.target.id, since: state.elapsed };
  return true;
}

/** Phase 3: cap-aware reinforce frontline. Rear-hub regen flows to the
 *  front continuously so the front never runs dry mid-attack. */
export function tryReinforceFrontline(ctx) {
  const { owner, myNodes, saturationRatio, sendFleet } = ctx;
  const dumpThresh = saturationRatio > 0.4 ? 0.55 : 0.65;
  for (const my of myNodes) {
    if (my.units < my.capacity * dumpThresh) continue;
    let bestRecip = null, bestRecipScore = 0;
    for (const nbId of state.adj.get(my.id)) {
      const nb = state.nodes[nbId];
      if (nb.owner !== owner) continue;
      if (nb.units >= nb.capacity * 0.95) continue;     // only skip when nearly full
      let frontness = 0;
      for (const nbnbId of state.adj.get(nb.id)) {
        const nnb = state.nodes[nbnbId];
        if (!isAlly(nnb.owner, owner) && nnb.owner !== 'neutral') frontness += 3;
        else if (nnb.owner === 'neutral') frontness += 1;
      }
      frontness += state.adj.get(nb.id).size * 0.5;
      if (frontness > bestRecipScore) { bestRecipScore = frontness; bestRecip = nb; }
    }
    if (bestRecip && bestRecipScore > 0) {
      const room = Math.max(0, bestRecip.capacity * 1.4 - bestRecip.units);
      const send = Math.min(Math.floor(my.units * 0.7), Math.floor(room));
      if (send >= 5) { sendFleet(my, bestRecip, send); return true; }
    }
  }
  return false;
}

/** Phase 4: emergency overflow. Any FULL node ships surplus to the most-front
 *  friendly neighbour regardless of its fill — pure regen waste is worse
 *  than slight overflow, and a thicker hub can absorb a strike. */
export function tryOverflowDump(ctx) {
  const { owner, myNodes, sendFleet } = ctx;
  for (const my of myNodes) {
    if (my.units < my.capacity * 0.95) continue;
    let target = null, bestFront = -1;
    for (const nbId of state.adj.get(my.id)) {
      const nb = state.nodes[nbId];
      if (nb.owner !== owner) continue;
      let frontness = 0;
      for (const nbnbId of state.adj.get(nb.id)) {
        const nnb = state.nodes[nbnbId];
        if (!isAlly(nnb.owner, owner) && nnb.owner !== 'neutral') frontness += 3;
        else if (nnb.owner === 'neutral') frontness += 1;
      }
      if (frontness > bestFront) { bestFront = frontness; target = nb; }
    }
    if (target) {
      const send = Math.floor((my.units - 8) * 0.6);
      if (send >= 5) { sendFleet(my, target, send); return true; }
    }
  }
  return false;
}

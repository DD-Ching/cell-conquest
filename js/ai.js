// =====================================================
// Per-tick AI orchestrator. Heuristic v3.
//
// The aiTick body that used to be 670 lines now does three things:
//   1. NN dispatch (for owners listed in NN_OWNERS) — short-circuits early.
//   2. Builds `ctx` once: situation analysis (saturation, aggression,
//      anti-turtle, far-behind) plus a few helper closures shared by every
//      downstream phase (incomingTo, attackerAvail, turretThreatTo,
//      isExposedToEnemyTank).
//   3. Calls phase functions in priority order, stopping at the first one
//      that returns true (the one-action-per-tick budget the monolithic
//      version enforced via early `return` statements).
//
// Phase order is BEHAVIOURALLY IDENTICAL to the old monolithic code:
//   build turret → build net → defend → drone salvo → assault turret →
//   coordinated attack → reinforce frontline → overflow dump.
//
// Where each phase lives:
//   ai-build.js     — tryBuildTurret, tryBuildNet
//   ai-tactical.js  — tryDefend, tryAssaultTurrets, tryCoordinatedAttack,
//                     tryReinforceFrontline, tryOverflowDump
//   ai-strategic.js — tryDroneSalvo
//
// This shape is also the Worker-port form (see AI_WORKER_BLUEPRINT.md):
// every phase already takes a ctx object and returns true/false, so the
// Worker version just swaps direct sendFleet calls for action-queue pushes.
// =====================================================
import { state } from './state.js';
import { NN_OWNERS, TANK_RADIUS, TANK_DPS } from './config.js';
import { isAlly } from './alliance.js';
import { catchUpAllNodes } from './world.js';
import { sendFleet } from './fleets.js';
import { nnDecide, nnActionFor, isNNReady } from './nn.js';
import { factionStats } from './factions.js';
import { makeEffects } from './ai-effects.js';
import { tryBuildTurret, tryBuildNet } from './ai-build.js';
import {
  tryDefend, tryAssaultTurrets, tryCoordinatedAttack,
  tryReinforceFrontline, tryOverflowDump,
} from './ai-tactical.js';
import { tryDroneSalvo } from './ai-strategic.js';

/** Tick one AI. Returns the actions array (empty when nothing happened).
 *  In main-thread mode the actions array is harmlessly ignored — every
 *  effect already mutated live state. In Worker mode the bridge ships the
 *  array back so the main thread can re-apply the effects on its
 *  authoritative state. See AI_WORKER_BLUEPRINT.md. */
export function aiTick(owner, dt) {
  state.aiTimers[owner] -= dt;
  if (state.aiTimers[owner] > 0) return [];
  // NN player decides every ~0.3s (matches training cadence); heuristic is
  // ~0.5–0.9s so the AI stays responsive in tempo with the player's clicks.
  state.aiTimers[owner] = NN_OWNERS.has(owner)
    ? (0.25 + Math.random() * 0.15)
    : (0.5 + Math.random() * 0.4);

  // ---- NN-controlled faction: apply cached action, dispatch async inference for next tick ----
  // NN dispatch always runs main-thread (the Worker doesn't load onnxruntime).
  // This branch's sendFleet call is direct (not via ctx) — fine, since the
  // Worker bridge skips NN owners and delegates them to the main-thread aiTick.
  if (NN_OWNERS.has(owner) && isNNReady()) {
    const a = nnActionFor(owner);
    nnDecide(owner);            // async; fills nnLastAction for the next tick
    if (a) {
      const from = state.nodes[a.src], to = state.nodes[a.dst];
      if (from && to && from.owner === owner && from.units >= 2 && from.id !== to.id) {
        sendFleet(from, to, Math.floor(from.units / 2));
      }
    }
    return [];
  }

  const myNodes = state.nodes.filter(n => n.owner === owner);
  if (myNodes.length === 0) return [];
  // Lazy regen: bring every node up to date once so subsequent reads of
  // n.units / n.capacity see fresh values. One pass beats sprinkling
  // catchUp around the dozen places below that read units.
  catchUpAllNodes();

  // ===== Situation analysis (cheap, shared by all phases below) =====

  // Saturation: how much of my regen is being wasted because nodes are full.
  // The more of my empire is saturated, the more I should be spending units.
  let saturatedCount = 0;
  for (const n of myNodes) if (n.units >= n.capacity * 0.95) saturatedCount++;
  const saturationRatio = saturatedCount / myNodes.length;

  // Aggression: game-state-aware baseline that ramps with time and is scaled
  // by per-faction strength + leader / behind status + saturation drive.
  const totalOwned = state.nodes.filter(n => n.owner !== 'neutral').length || 1;
  const myShare = myNodes.length / totalOwned;
  const counts = {};
  for (const n of state.nodes) {
    if (n.owner === 'neutral') continue;
    counts[n.owner] = (counts[n.owner] || 0) + 1;
  }
  const leaderEntry = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

  // ===== Elimination focus =====
  // The win condition is wiping factions out, not painting the map. Drones
  // only SUPPRESS (chip units) — they can't capture. Two kinds of enemy are
  // worth CONVERGING ground troops on (tryCoordinatedAttack ×5-boosts the
  // capture score for their nodes so the AI rolls them up rather than drifting
  // off to grab neutrals):
  //   (a) near-dead — down to its last 1-2 bases; finish it off.
  //   (b) SUPPRESSED — it may still hold a lot of ground, but those nodes are
  //       pinned near-empty: drones bomb it faster than it can rebuild, so its
  //       garrisons stay tiny and it can't make anything. A suppressed enemy's
  //       land is CHEAP to take, so the right move is to pour ground troops in
  //       and roll up its territory WHILE the drones keep it down — suppress +
  //       capture in the same beat (exactly the "20 bases, all bombed flat,
  //       just sitting there" case the player flagged).
  // Case (b) is deliberately SEPARATE from state.strippedOwners (the near-dead
  // drone-skip set): a suppressed-but-large enemy should KEEP getting bombed,
  // so it must NOT land in strippedOwners — only here, where GROUND attack
  // converges on it. Gated on the AI being established (>=3 nodes); case (b)
  // also waits out the opening (>60s) so early land-grab thinness isn't
  // misread as suppression.
  const eliminationOwners = new Set();
  if (myNodes.length >= 3) {
    const enemyUnits = {}, enemyCap = {};
    for (const n of state.nodes) {
      if (n.owner === 'neutral' || isAlly(n.owner, owner)) continue;
      enemyUnits[n.owner] = (enemyUnits[n.owner] || 0) + n.units;
      enemyCap[n.owner]   = (enemyCap[n.owner]   || 0) + n.capacity;
    }
    for (const o in counts) {
      if (isAlly(o, owner) || o === 'neutral') continue;
      if (counts[o] <= 2) { eliminationOwners.add(o); continue; }   // (a) near-dead
      // (b) suppressed: still holds ground (>=4 nodes) but the empire is pinned
      // near-empty (fill < 28%) AND its average garrison is tiny (< 14) — it
      // can neither defend nor rebuild. Roll it up.
      if (state.elapsed > 60 && counts[o] >= 4) {
        const fill = (enemyUnits[o] || 0) / Math.max(1, enemyCap[o] || 1);
        const avgGarrison = (enemyUnits[o] || 0) / counts[o];
        if (fill < 0.28 && avgGarrison < 14) eliminationOwners.add(o);
      }
    }
  }
  const iAmLeader = leaderEntry && leaderEntry[0] === owner;
  let aggression = 1.3 + Math.min(state.elapsed / 180, 2.0);
  if (iAmLeader && myShare > 0.40) aggression *= 1.4;
  else if (myShare < 0.20) aggression *= 1.3;
  const fstats = factionStats[owner] || { aggressionMul: 1.0, buildChanceMul: 1.0 };
  aggression *= fstats.aggressionMul;
  // Saturation drive: units sitting at cap are regen thrown away. The deeper
  // we're drowning in surplus, the harder we push attacks — spending units on
  // an attack that chips the enemy beats wasting them against the cap. (The
  // tank-wall hard-skip in tryCoordinatedAttack still prevents pure suicide.)
  if (saturationRatio > 0.7) aggression *= 2.1;
  else if (saturationRatio > 0.5) aggression *= 1.6;
  else if (saturationRatio > 0.3) aggression *= 1.25;

  // Anti-turtle: my growth stalled AND opponents are stacking turrets → wall up.
  state.aiMetrics ||= {};
  const m = state.aiMetrics[owner] ||= { lastNodeCount: myNodes.length, lastChangeT: state.elapsed };
  if (myNodes.length !== m.lastNodeCount) {
    m.lastNodeCount = myNodes.length;
    m.lastChangeT = state.elapsed;
  }
  const stagnantSec = state.elapsed - m.lastChangeT;
  let enemyTurrets = 0;
  for (const t of state.turrets) {
    if (!t.active) continue;
    if (isAlly(t.owner, owner) || t.owner === 'neutral') continue;
    enemyTurrets++;
  }
  const antiTurtle = stagnantSec > 18 && enemyTurrets >= 3;

  // Far-behind: someone clearly ahead and I'm small. Still ramp aggression a
  // bit (1.3×) but DO NOT mirror their wall — pour spare capacity into our
  // own turrets/factories so we can dig out. Phase 2 naturally avoids fortified
  // targets because turret threat is part of `required`.
  const sharesByOwner = {};
  for (const n of state.nodes) {
    if (n.owner === 'neutral' || isAlly(n.owner, owner)) continue;
    sharesByOwner[n.owner] = (sharesByOwner[n.owner] || 0) + 1;
  }
  const topEnemyShare = Math.max(0, ...Object.values(sharesByOwner)) / state.nodes.length;
  const farBehind = myShare < 0.18 && topEnemyShare > 0.40;
  if (farBehind) aggression *= 1.3;
  // Opening burst — grab the map before the player turtles up.
  if (state.elapsed < 35) aggression *= 1.3;

  // ===== Helper closures (shared across phases) =====

  // Hostile turret threat to ground attacks targeting a given node.
  // Tank turrets within ~range chew up our attackers en route. Counts
  // expected casualties so Phase 2's `required` reflects reality.
  const TANK_THREAT_R2 = (TANK_RADIUS + 60) * (TANK_RADIUS + 60);
  function turretThreatTo(targetNode) {
    let threat = 0;
    const tanks = state.turretsByType.get('tank');
    if (!tanks) return 0;
    for (const t of tanks) {
      if (!t.active || isAlly(t.owner, owner)) continue;
      const dx = t.x - targetNode.x, dy = t.y - targetNode.y;
      if (dx * dx + dy * dy < TANK_THREAT_R2) threat += TANK_DPS * 0.6 * 3.5;  // ~3.5s exposure
    }
    return threat;
  }
  // Refuse to send engineers into enemy tank kill zones.
  const TANK_DANGER_R2 = (TANK_RADIUS - 20) * (TANK_RADIUS - 20);
  function isExposedToEnemyTank(x, y) {
    const tanks = state.turretsByType.get('tank');
    if (!tanks) return false;
    for (const t of tanks) {
      if (!t.active || isAlly(t.owner, owner)) continue;
      const dx = t.x - x, dy = t.y - y;
      if (dx * dx + dy * dy < TANK_DANGER_R2) return true;
    }
    return false;
  }

  // Pre-bucket all fleets by their final-target node id. Phase 1 calls
  // incomingTo(nodeId) once per my node and Phase 2 does the same per
  // candidate target — both used to do a full state.fleets scan per call.
  // With 30 nodes × 50 fleets that's 1500 ops; at 200/200 scale it's 40k
  // per AI tick. Bucket once, look up in O(1).
  const fleetsByTarget = new Map();
  for (const f of state.fleets) {
    let finalId;
    if (f.kind === 'drone') finalId = f.targetNodeId;
    else if (f.path) finalId = f.path[f.path.length - 1];
    else continue;
    if (finalId === undefined) continue;
    let bucket = fleetsByTarget.get(finalId);
    if (!bucket) { bucket = []; fleetsByTarget.set(finalId, bucket); }
    bucket.push(f);
  }
  function incomingTo(nodeId) {
    let friendly = 0, hostile = 0, hostileSrc = null;
    const targetOwner = state.nodes[nodeId].owner;
    const inbound = fleetsByTarget.get(nodeId);
    if (!inbound) return { friendly, hostile, hostileSrc };
    for (const f of inbound) {
      if (f.owner === targetOwner) friendly += f.units;
      else { hostile += f.units; if (!hostileSrc && f.path) hostileSrc = f.path[0]; }
    }
    return { friendly, hostile, hostileSrc };
  }
  function attackerAvail(node) {
    let enemyNeighbors = 0;
    for (const nbId of state.adj.get(node.id)) {
      const nb = state.nodes[nbId];
      if (!isAlly(nb.owner, owner) && nb.owner !== 'neutral') enemyNeighbors++;
    }
    const degree = state.adj.get(node.id).size;
    const isCentral = degree >= 3;
    // Central hubs (degree >= 3) keep a garrison — losing one splits our
    // territory. But when most of the empire is full, holding back is just
    // wasted regen; relax the floor sharply so the player can't out-mass us.
    const centralFloorBase = isCentral ? 0.40 : 0;
    const centralFloorRatio = saturationRatio > 0.5 ? centralFloorBase * 0.55
                            : saturationRatio > 0.3 ? centralFloorBase * 0.75
                            : centralFloorBase;
    const centralFloor = node.capacity * centralFloorRatio;
    // Saturated node — sitting on units is pure regen waste, so dump almost
    // everything. Only leave a thin skeleton in case a counter-wave hits.
    if (node.units >= node.capacity * 0.95) {
      const garrison = 4 + enemyNeighbors * 3 + (isCentral ? 10 : 0);
      return Math.max(0, node.units - Math.max(garrison, centralFloor));
    }
    // Non-saturated: scale reserves down when empire-wide saturation is high
    // (we're committing all-in, not playing safe).
    const reserveScale = saturationRatio > 0.5 ? 0.55
                       : saturationRatio > 0.3 ? 0.75
                       : 1.0;
    const reserveRatio = (0.15 + enemyNeighbors * 0.18) * reserveScale;
    const reserveAbs   = (5 + enemyNeighbors * 9) * reserveScale;
    const normalAvail  = node.units * (1 - reserveRatio) - reserveAbs;
    return Math.max(0, Math.min(normalAvail, node.units - centralFloor));
  }

  // ===== Effects bundle =====
  // makeEffects gives phases a `sendFleet` etc. that BOTH mutate live state
  // AND push an action descriptor. In main-thread mode the actions array is
  // harmlessly ignored; in worker mode it's shipped back to the main thread.
  // Same phase code, two execution contexts. See ai-effects.js.
  const actions = [];
  const effects = makeEffects(actions);

  // ===== Shared context object passed to every phase =====
  const ctx = {
    owner, myNodes,
    saturationRatio, aggression, antiTurtle, farBehind, fstats,
    eliminationOwners,
    fleetsByTarget,
    incomingTo, attackerAvail, turretThreatTo, isExposedToEnemyTank,
    // Side-effects (see ai-effects.js):
    sendFleet:          effects.sendFleet,
    assaultTurret:      effects.assaultTurret,
    placeTurretAt:      effects.placeTurretAt,
    placeNetOnEdge:     effects.placeNetOnEdge,
    releaseAIStockpile: effects.releaseAIStockpile,
    actions,
  };

  // ===== Phase dispatch — first true return is the action this tick =====
  // Order matches the old monolithic body's early-return sequence exactly.
  // Whichever phase returns true populated ctx.actions via the effects
  // bundle; we return that array regardless of which phase fired.
  if (tryBuildTurret(ctx))         return actions;
  if (tryBuildNet(ctx))            return actions;
  if (tryDefend(ctx))              return actions;
  if (tryDroneSalvo(ctx))          return actions;
  if (tryAssaultTurrets(ctx))      return actions;
  if (tryCoordinatedAttack(ctx))   return actions;
  if (tryReinforceFrontline(ctx))  return actions;
  if (tryOverflowDump(ctx))        return actions;
  return actions;
}

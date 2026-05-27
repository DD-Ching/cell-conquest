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
import { sendFleet, assaultTurret } from './fleets.js';
import { placeTurretAt, placeNetOnEdge, ekey } from './engineering.js';
import { releaseAIStockpile } from './drones.js';
import { nnDecide, nnActionFor, isNNReady } from './nn.js';
import { factionStats } from './factions.js';
import { FACTORY_MAX_STOCKPILE } from './config.js';

export function aiTick(owner, dt) {
  state.aiTimers[owner] -= dt;
  if (state.aiTimers[owner] > 0) return;
  // NN player decides every ~0.3s (matches training cadence); heuristic is
  // ~0.5–0.9s so the AI stays responsive in tempo with the player's clicks.
  state.aiTimers[owner] = NN_OWNERS.has(owner)
    ? (0.25 + Math.random() * 0.15)
    : (0.5 + Math.random() * 0.4);

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
  // Higher baseline so the AI commits to attacks from the start instead of
  // hoarding for the first few minutes (which lets the player turtle).
  let aggression = 1.3 + Math.min(state.elapsed / 180, 2.0);
  if (iAmLeader && myShare > 0.40) aggression *= 1.4;
  else if (myShare < 0.20) aggression *= 1.3;
  // Per-faction strength: aggression baseline scaled by the roll
  const fstats = factionStats[owner] || { aggressionMul: 1.0, buildChanceMul: 1.0 };
  aggression *= fstats.aggressionMul;
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
  // Single pass replaces two filter-then-length scans of the whole turret array.
  let enemyTurrets = 0, enemyAA = 0;
  for (const t of state.turrets) {
    if (!t.active) continue;
    if (t.owner === owner || t.owner === 'neutral') continue;
    enemyTurrets++;
    if (t.type === 'antiair') enemyAA++;
  }
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
  const TANK_THREAT_R2 = (TANK_RADIUS + 60) * (TANK_RADIUS + 60);
  function turretThreatTo(targetNode) {
    let threat = 0;
    for (const t of state.turrets) {
      if (!t.active) continue;
      if (t.owner === owner) continue;
      if (t.type !== 'tank') continue;
      const dx = t.x - targetNode.x, dy = t.y - targetNode.y;
      if (dx * dx + dy * dy < TANK_THREAT_R2) threat += TANK_DPS * 0.6 * 3.5;  // ~3.5s exposure
    }
    return threat;
  }

  // ---- Engineering: smart turret placement ----
  // Build chance scales with saturation + per-faction strength.
  const buildChance = (0.18 + saturationRatio * 0.40 + (antiTurtle ? 0.15 : 0)) * fstats.buildChanceMul;
  const buildMinUnits = saturationRatio > 0.4 ? 14 : 22;

  // Helper: refuse to send engineers into enemy tank kill zones
  const TANK_DANGER_R2 = (TANK_RADIUS - 20) * (TANK_RADIUS - 20);
  function isExposedToEnemyTank(x, y) {
    for (const t of state.turrets) {
      if (!t.active || t.owner === owner || t.type !== 'tank') continue;
      const dx = t.x - x, dy = t.y - y;
      if (dx * dx + dy * dy < TANK_DANGER_R2) return true;
    }
    return false;
  }

  // Targets per hub — the player's winning playbook is: AA wall → tanks → factory spam,
  // plus long-range artillery for AOE counter-pressure against enemy clusters.
  const AA_TARGET        = antiTurtle ? 9 : 7;    // thick AA wall with forward push
  const TANK_TARGET      = 2;                     // 2 tanks for siege + flank
  const FACTORY_TARGET   = antiTurtle ? 8 : 5;    // more drone throughput — was 6/4
  const ARTILLERY_TARGET = antiTurtle ? 3 : 2;    // more AOE counter-pressure — was 2/1

  // Position helpers — spread AAs across the front arc to form a WALL (not a circle).
  // Drones flying toward the hub get sieved by overlapping radars from multiple angles.
  function aaWallSpot(n, dirX, dirY, idx) {
    const px = -dirY, py = dirX;
    // Idx 0-4 = the original 5-AA defensive wall hugging the hub. Idx 5-8 =
    // forward-pushed positions that gradually extend the line toward the
    // enemy, so as the wall thickens the AA umbrella also creeps forward.
    const layout = [
      { fwd:  70, side:    0 },   // 0: center front
      { fwd:  55, side:   80 },   // 1: right flank
      { fwd:  55, side:  -80 },   // 2: left flank
      { fwd:  30, side:  130 },   // 3: far right
      { fwd:  30, side: -130 },   // 4: far left
      { fwd: 140, side:    0 },   // 5: forward push, center
      { fwd: 125, side:   70 },   // 6: forward right
      { fwd: 125, side:  -70 },   // 7: forward left
      { fwd: 200, side:    0 },   // 8: deep push (antiTurtle only)
    ][idx % 9];
    return { x: n.x + dirX * layout.fwd + px * layout.side,
             y: n.y + dirY * layout.fwd + py * layout.side };
  }
  function tankSpot(n, dirX, dirY, idx) {
    const px = -dirY, py = dirX;
    const layout = [
      { fwd: 100, side:  0 },     // 0: center forward (siege)
      { fwd:  80, side: 70 },     // 1: right flank
    ][idx % 2];
    return { x: n.x + dirX * layout.fwd + px * layout.side,
             y: n.y + dirY * layout.fwd + py * layout.side };
  }
  function factorySpot(n, dirX, dirY, idx) {
    // BEHIND the hub, fanned out in an arc deeper each step. Stays inside our AA umbrella.
    const px = -dirY, py = dirX;
    const back = 35 + Math.floor(idx / 2) * 30;
    const side = (idx % 2 === 0 ? 1 : -1) * Math.min(15 + idx * 12, 70);
    return { x: n.x - dirX * back + px * side,
             y: n.y - dirY * back + py * side };
  }
  function artillerySpot(n, dirX, dirY, idx) {
    // Deep rear — artillery's range is so long it can fire from way back behind the hub.
    const px = -dirY, py = dirX;
    const back = 120 + idx * 35;
    const side = (idx % 2 === 0 ? 1 : -1) * (idx * 30);
    return { x: n.x - dirX * back + px * side,
             y: n.y - dirY * back + py * side };
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

      // Survey friendly infrastructure NEAR this hub. Single pass over my own
      // turrets (via turretsByOwner) instead of 5 separate .filter() calls;
      // squared distances skip the per-check sqrt.
      let ownAAsNear = 0, ownTanksNear = 0, ownFactoriesNear = 0, ownArtilleryNear = 0;
      let aaCoversThisHub = false;
      const aaUmbrella2 = (AA_RADIUS * 0.8) * (AA_RADIUS * 0.8);
      const myTurrets = state.turretsByOwner.get(owner) || [];
      for (const t of myTurrets) {
        const dx = t.x - n.x, dy = t.y - n.y;
        const d2 = dx * dx + dy * dy;
        if (t.type === 'antiair') {
          if (d2 < 220 * 220) ownAAsNear++;
          if (d2 < aaUmbrella2) aaCoversThisHub = true;
        } else if (t.type === 'tank') {
          if (d2 < 200 * 200) ownTanksNear++;
        } else if (t.type === 'factory') {
          if (d2 < 180 * 180) ownFactoriesNear++;
        } else if (t.type === 'artillery') {
          if (d2 < 250 * 250) ownArtilleryNear++;
        }
      }

      // Try a build at one of several layout positions — if the first is blocked
      // by enemy tank range, fall through to the next. Stops the AI from giving
      // up on AA construction the moment one spot is contested.
      // Note: overlapping turrets is fine — clustered AAs = overlapping kill
      // zones, which is exactly what a real AA doctrine wants.
      function tryBuild(type, makeSpot, baseIdx, maxAttempts = 6) {
        for (let a = 0; a < maxAttempts; a++) {
          const spot = makeSpot(n, dirX, dirY, baseIdx + a);
          if (isExposedToEnemyTank(spot.x, spot.y)) continue;
          if (placeTurretAt(spot.x, spot.y, type, owner)) return true;
        }
        return false;
      }

      // ---- 1) AA WALL — keep stacking until we hit AA_TARGET ----
      // Sweep all 9 layout positions (defensive 0-4 + forward 5-8) so a
      // single blocked spot doesn't stall the wall thickening.
      if (ownAAsNear < AA_TARGET) {
        if (tryBuild('antiair', aaWallSpot, ownAAsNear, 9)) return;
      }

      // ---- 2) Tanks — start as soon as we have at least 2 AAs ----
      if (ownAAsNear >= 2 && ownTanksNear < TANK_TARGET) {
        if (tryBuild('tank', tankSpot, ownTanksNear, 3)) return;
      }

      // ---- 3) FACTORY SPAM — once the wall is up, mass-produce drones ----
      // Wait until at least 2 AAs cover the hub before spending units on factories.
      if (aaCoversThisHub && ownAAsNear >= 2 && ownFactoriesNear < FACTORY_TARGET) {
        if (tryBuild('factory', factorySpot, ownFactoriesNear, 4)) return;
      }

      // ---- 4) ARTILLERY — deep rear AOE pressure ----
      // Long range so it can stay way back. Random AOE counters dense enemy clusters.
      if (aaCoversThisHub && ownAAsNear >= 2 && ownArtilleryNear < ARTILLERY_TARGET) {
        if (tryBuild('artillery', artillerySpot, ownArtilleryNear, 3)) return;
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

  // Phase 1: defensive — react to active incoming AND adjacent-enemy STOCKPILES.
  // The stockpile signal is critical: when the player is massing 100+ units in
  // a hub next to ours, we need to reinforce BEFORE the wave launches, not after.
  for (const my of myNodes) {
    const degree = state.adj.get(my.id).size;
    const isCentral = degree >= 3;
    const inc = incomingTo(my.id);

    // Sum of units in adjacent enemy hubs (the wave that's *about* to be launched).
    let adjEnemyStockpile = 0;
    for (const nbId of state.adj.get(my.id)) {
      const nb = state.nodes[nbId];
      if (nb.owner !== owner && nb.owner !== 'neutral') adjEnemyStockpile += nb.units;
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
    if (send >= 5) { sendFleet(donor, my, send); return; }
  }

  // Drone salvo: stockpile across all factories then release as a saturation
  // strike — mimics the player's Hold-Fire (H, click target, H again) trick.
  // Single trickling drones get sieved by AA walls; a 10–18 drone wave
  // overwhelms them. We never bother stockpiling when only one factory exists
  // or when we're behind on the map (need drones in the air NOW).
  // Pull from the owner-bucketed Map and filter by type/active inline instead
  // of scanning the entire turret array.
  const myFactories = [];
  const myTurretsAll = state.turretsByOwner.get(owner) || [];
  for (const t of myTurretsAll) {
    if (t.type === 'factory' && t.active) myFactories.push(t);
  }
  if (state.aiHoldFire[owner]) {
    // Once stockpiling, check release conditions every tick regardless of
    // current factory count — if a factory got blown up mid-stockpile we
    // still want to fire whatever we have rather than hoarding forever.
    const stocked    = myFactories.reduce((s, t) => s + (t.dronesReady || 0), 0);
    const fullCount  = myFactories.filter(t => (t.dronesReady || 0) >= FACTORY_MAX_STOCKPILE).length;
    const aged       = state.elapsed - (state.aiSalvoT0[owner] || 0);
    const lostMass   = myFactories.length < 2 && stocked > 0;
    // Release condition: enough mass to matter, aged-out, or lost factories.
    if (fullCount >= 2 || stocked >= 10 || aged > 35 || lostMass) {
      // First preference: aim at the strategic focus (the hub Phase 2 is
      // currently grinding into). Drone salvo + ground wave hit the same
      // point in the same beat → combined arms. Drop focus if stale/captured.
      let target = null, targetVal = 0;
      const focus = state.aiFocus[owner];
      if (focus) {
        const fNode = state.nodes[focus.targetId];
        const focusAge = state.elapsed - (focus.since || 0);
        if (fNode && fNode.owner !== owner && focusAge < 20) {
          target = { kind: 'node', id: fNode.id, x: fNode.x, y: fNode.y };
          targetVal = Infinity;       // lock — don't override below
        } else {
          state.aiFocus[owner] = null;
        }
      }
      const cx = myFactories.length
        ? myFactories.reduce((s, t) => s + t.x, 0) / myFactories.length
        : myNodes[0].x;
      const cy = myFactories.length
        ? myFactories.reduce((s, t) => s + t.y, 0) / myFactories.length
        : myNodes[0].y;
      for (const t of state.turrets) {
        if (!t.active) continue;
        if (t.owner === owner || t.owner === 'neutral') continue;
        const dx = t.x - cx, dy = t.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > 700 * 700) continue;       // gate before sqrt
        const d = Math.sqrt(d2);
        let v = 1.0;
        if (t.type === 'tank')           v = 3.0;
        else if (t.type === 'factory')   v = 2.8;
        else if (t.type === 'artillery') v = 2.2;
        else if (t.type === 'antiair')   v = 1.8;
        v *= 1 / (1 + d / 300);
        if (v > targetVal) {
          targetVal = v;
          target = { kind: 'turret', id: t.id, x: t.x, y: t.y };
        }
      }
      state.aiSalvoTarget[owner] = target;
      releaseAIStockpile(owner);
      state.aiHoldFire[owner] = false;
      return;
    }
  } else if (myFactories.length >= 2 && !farBehind) {
    // Not stockpiling yet — start now. (Skipping when behind keeps drone
    // pressure flowing instead of disappearing for 25s.)
    state.aiHoldFire[owner] = true;
    state.aiSalvoT0[owner] = state.elapsed;
  }

  // Phase 1.5: ASSAULT enemy turrets — break the player's defensive wall the
  // same way the player breaks ours. Frontal attacks against a tank-guarded
  // hub get shredded; the answer is to dismantle the screen first. Suicide
  // troops walk to the nearest own anchor then off-road to detonate on the
  // turret (each unit absorbs 8 HP).
  if (Math.random() < 0.25 + saturationRatio * 0.20) {
    let pick = null, pickScore = 0;
    for (const t of state.turrets) {
      if (!t.active) continue;
      if (t.owner === owner || t.owner === 'neutral') continue;
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
      if (t.type === 'tank')        typeVal = 3.5;
      else if (t.type === 'factory')   typeVal = 2.5;
      else if (t.type === 'artillery') typeVal = 2.2;
      else if (t.type === 'antiair')   typeVal = 1.8;
      const score = (typeVal / (cost + 5)) * (1 / (1 + nearD / 200));
      if (score > pickScore) { pickScore = score; pick = { from: near, t, cost }; }
    }
    if (pick && assaultTurret(pick.from, pick.t, pick.cost)) return;
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
    // Hard skip only when tanks are overwhelmingly dominant. Phase 1.5 above
    // is now dismantling the wall via assault, so Phase 2 doesn't need to be
    // ultra-conservative — modest tank presence is just a price tag.
    if (tankThreat > 0 && tankThreat > availForce * 0.75) continue;

    const adjCount = state.adj.get(tId).size;
    const sat = target.units / Math.max(1, target.capacity);
    const value = adjCount * 2.8 + target.regenRate * 9 + target.size * 0.5;
    let score = value / (required + 8);
    if (target.owner === 'neutral') score *= 1.5;
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

  if (bestAtt) {
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
      for (const t of state.turrets) {
        if (!t.active || t.pendingEngineer) continue;
        if (t.owner === owner || t.owner === 'neutral') continue;
        if (t.type !== 'tank') continue;
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
    return;
  }

  // Phase 3: cap-aware reinforce frontline. Goal: rear-hub regen flows to
  // the front continuously, so the front never runs dry mid-attack.
  // Lower threshold + bigger send fraction = faster funneling.
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
        if (nnb.owner !== owner && nnb.owner !== 'neutral') frontness += 3;
        else if (nnb.owner === 'neutral') frontness += 1;
      }
      frontness += state.adj.get(nb.id).size * 0.5;
      if (frontness > bestRecipScore) { bestRecipScore = frontness; bestRecip = nb; }
    }
    if (bestRecip && bestRecipScore > 0) {
      const room = Math.max(0, bestRecip.capacity * 1.4 - bestRecip.units);
      const send = Math.min(Math.floor(my.units * 0.7), Math.floor(room));
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

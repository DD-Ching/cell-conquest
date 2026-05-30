// =====================================================
// Drone behavior + factory production / stockpile.
//
// Drones are top-down delta-wing suicide UAVs. They:
//   - spawn from drone factories (or are released in salvos via Hold-Fire)
//   - hunt enemy turrets / nodes / ground fleets in transit
//   - detonate on impact, applying damage to the target type
//   - get intercepted by edge-mounted drone nets while attacking road
//     fleets (nets are faction-agnostic infrastructure)
//
// Carved out of engineering.js so that file stays focused on edges,
// turret-build lifecycle, and engineer behavior.
// =====================================================
import { state } from './state.js';
import {
  DRONE_HP_AIR, DRONE_SPEED, DRONE_DAMAGE, DRONE_MAX_LIFETIME,
  DRONE_DETECT_R, DRONE_HUNT_DMG, DRONE_HUNT_SWITCH_RATIO,
  DF_PRODUCTION_T, FACTORY_MAX_STOCKPILE, AA_RADIUS,
} from './config.js';
import { dist, inboundKey } from './util.js';
import { addWreckBlockage, spawnBigExplosion, spawnScorch, getEdge } from './engineering.js';

// Pre-squared distances — comparisons use dx²+dy² < r² to avoid sqrt in the
// hottest per-tick loops (drone hunt scan runs once per drone per sub-step).
const DRONE_DETECT_R2  = DRONE_DETECT_R * DRONE_DETECT_R;
const DRONE_SWITCH_R2  = DRONE_HUNT_SWITCH_RATIO * DRONE_HUNT_SWITCH_RATIO;
const HUNT_PROXIMITY2  = 50 * 50;     // huntD < 50 → huntD² < 2500

// ---- Spawn ----
// Internal helper — drones are only spawned via launchOneDroneFrom (factory tick)
// and releasePlayerStockpile (Hold-Fire flush). Both are in this file.
function spawnDrone(originX, originY, owner, target) {
  state.fleets.push({
    _id: state._nextFleetId++,
    kind: 'drone', owner, units: 1,
    x: originX, y: originY,
    tx: target.x, ty: target.y,
    targetKind: target.kind,            // 'turret' | 'node' | 'fleet'
    targetId:   target.id,
    hp: DRONE_HP_AIR, damage: DRONE_DAMAGE,
    spawnT: state.elapsed,              // for DRONE_MAX_LIFETIME timeout
  });
}

// ---- Target resolution ----
// ENGAGE / DISENGAGE bands for node targets — this two-band hysteresis IS the
// "damping" that stops drones flip-flopping while still refusing to waste the
// whole swarm on an empty city:
//   • A drone only LAUNCHES / RETARGETS at a node holding >= ENGAGE units
//     (something worth chipping).
//   • Once committed it stays until the node is bombed below ABANDON units —
//     then it peels off to a fresh target instead of finishing its run into a
//     husk. The gap (5..12) means a base oscillating around one threshold
//     can't cause the old u-turn churn.
const DRONE_ENGAGE_UNITS  = 12;
const DRONE_ABANDON_UNITS = 5;
// Max drones we'll commit to one node — a fat production core (200-300 units)
// is worth several; a small town only 1. Raised above the old flat 4 so the
// swarm can actually suppress the enemy's development hubs, not just chip them.
const NODE_DRONE_CAP = 8;

/** How heavily a point is screened by LIVE enemy anti-air. Drones flying into
 *  AA coverage get shot down, so a node still RINGED by AA is effectively
 *  inaccessible — its value is divided by this until the AA is cleared. That
 *  makes the swarm knock out the surrounding weapon screen FIRST, then pour
 *  into the now-open core (the "轟掉防空, 再往深部打" sequence). Gridded, so it
 *  only inspects turrets near the point — cheap even with a wall of AA. */
function aaScreenDivisor(x, y, owner) {
  const CELL = 250;
  const range = Math.ceil(AA_RADIUS / CELL);
  const cx0 = Math.floor(x / CELL), cy0 = Math.floor(y / CELL);
  const R2 = AA_RADIUS * AA_RADIUS;
  let guards = 0;
  for (let cx = cx0 - range; cx <= cx0 + range; cx++) {
    for (let cy = cy0 - range; cy <= cy0 + range; cy++) {
      const bucket = state.turretGrid.get(cx * 10000 + cy);
      if (!bucket) continue;
      for (const a of bucket) {
        if (a.type !== 'antiair' || !a.active || isAlly(a.owner, owner)) continue;
        const dx = a.x - x, dy = a.y - y;
        if (dx * dx + dy * dy < R2) guards++;
      }
    }
  }
  return 1 + guards;          // each guarding AA roughly halves the node's pull
}

// ---- Per-tick node-scan cache (kills the retarget-wave spike) ----------------
// retargetDrone scores every candidate node by min(units,160)/((1+dist/800)·
// aaScreenDivisor) ×1.8-if-frontier. aaScreenDivisor is a spatial-grid scan and
// the frontier check walks adjacency — and BOTH were recomputed for every node
// FOR EVERY retargeting drone (drones × ~830 nodes × a grid scan when a wave
// needs targets). But aaScreenDivisor (AA turret positions) and the frontier
// flag (node ownership) DON'T change during a single updateDrones pass — node
// captures happen in simulateFleets, turret removal in updateBuildings — so we
// compute them ONCE per faction per tick and reuse. Live units / inbound /
// distance still read per-drone, and the score arithmetic is byte-for-byte the
// original, so target picks are identical. Cleared at the top of updateDrones.
const _nodeScan = new Map();   // owner -> { aa: Float64Array, fr: Uint8Array }; aa[i]<0 = ally/neutral skip
function nodeScanFor(owner) {
  let c = _nodeScan.get(owner);
  if (c) return c;
  const nodes = state.nodes, N = nodes.length;
  const aa = new Float64Array(N), fr = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const n = nodes[i];
    if (n.owner === 'neutral' || isAlly(n.owner, owner)) { aa[i] = -1; continue; }
    aa[i] = aaScreenDivisor(n.x, n.y, owner);
    for (const nbId of state.adj.get(n.id)) { if (isAlly(nodes[nbId].owner, owner)) { fr[i] = 1; break; } }
  }
  c = { aa, fr };
  _nodeScan.set(owner, c);
  return c;
}

/** Does the drone's stored target still WARRANT a strike?
 *
 *  IN-FLIGHT COMMITMENT with a release valve: a launched drone flies its run,
 *  but abandons a node that has flipped to its OWN side OR been bombed flat
 *  (< ABANDON units — drones only chip units, so a near-empty node is a dead
 *  end and a ground-troop job). Abandoning routes through retargetDrone, which
 *  picks a VALUE target and honours a cooldown, so there's no per-frame
 *  flip-flop — the swarm stops endlessly pounding zeroed-out front towns. */
function droneTargetExists(drone) {
  if (drone.targetKind === 'turret') return state.turretById.has(drone.targetId);
  if (drone.targetKind === 'node') {
    if (drone.targetId >= state.nodes.length) return false;
    const n = state.nodes[drone.targetId];
    if (isAlly(n.owner, drone.owner)) return false;     // captured by own side — stand down
    if (n.units < DRONE_ABANDON_UNITS) return false;    // bombed flat — peel off, find real work
    return true;                                        // otherwise commit to the run
  }
  if (drone.targetKind === 'fleet')  return state.fleetById.has(drone.targetId);
  return false;
}

/** Find the closest enemy entity for `drone` to switch to. Returns true if found. */
function retargetDrone(drone) {
  let best = null, bestD2 = Infinity;
  // Spiral outward via the grid: start with the drone's cell and expand until
  // we find a turret in a non-empty cell, then verify it's the closest within
  // that cell. For big maps this beats scanning every turret.
  // (Simpler implementation: just check progressively larger windows.)
  // range=6 covers a 13×13 cell window ≈ 1625 px each side — well past
  // DRONE_DETECT_R. Anything farther falls through to the state.nodes scan
  // below, which is the correct path for "no nearby turrets".
  const CELL = 250;
  const cx0 = Math.floor(drone.x / CELL);
  const cy0 = Math.floor(drone.y / CELL);
  for (let range = 0; range <= 6 && best === null; range++) {
    for (let cx = cx0 - range; cx <= cx0 + range; cx++) {
      for (let cy = cy0 - range; cy <= cy0 + range; cy++) {
        // Only check the ring at distance `range` (skip already-checked inner cells)
        if (range > 0 && Math.abs(cx - cx0) !== range && Math.abs(cy - cy0) !== range) continue;
        const bucket = state.turretGrid.get(cx * 10000 + cy);
        if (!bucket) continue;
        for (const t of bucket) {
          if (isAlly(t.owner, drone.owner)) continue;
          if (t.pendingEngineer) continue;
          const dx = t.x - drone.x, dy = t.y - drone.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; best = { kind: 'turret', id: t.id, x: t.x, y: t.y }; }
        }
      }
    }
    // Confirm: any turret in next ring could still be closer than `best`?
    // Closest possible point in next ring is `range*CELL` away. If best is
    // already closer than that, we're done.
    if (best && Math.sqrt(bestD2) < range * CELL) break;
  }
  if (!best) {
    // Value-first node pick (not nearest): a drone that lost its target should
    // reach for a node with units worth chipping, skipping bombed-flat husks
    // and dying factions. Distance is only a mild taper so it can push deep.
    // aaScreenDivisor + frontier are read from the per-tick cache (nodeScanFor);
    // units / inbound / distance stay live; the score arithmetic is unchanged.
    const { aa, fr } = nodeScanFor(drone.owner);
    const nodes = state.nodes;
    let bestNodeScore = 0;
    for (let i = 0; i < nodes.length; i++) {
      const aav = aa[i];
      if (aav < 0) continue;                              // ally / neutral (cached skip)
      const n = nodes[i];
      if (state.strippedOwners.has(n.owner)) continue;    // dying faction — ground troops' job
      if (n.units < DRONE_ENGAGE_UNITS) continue;         // bombed-flat — nothing to chip
      // Respect the value-aware inbound cap so a whole salvo that just peeled
      // off a dead node spreads across fresh targets instead of re-dogpiling one.
      const cap = Math.min(NODE_DRONE_CAP, Math.max(1, Math.ceil(n.units / 45)));
      if ((state.inboundDronesByTarget.get(inboundKey('node', n.id)) || 0) >= cap) continue;
      const dx = n.x - drone.x, dy = n.y - drone.y;
      // Same value model as the launch picker: fat core >> husk, screened-by-AA
      // cores wait their turn. Frontier boost leans onto the contested border.
      let score = Math.min(n.units, 160) / ((1 + Math.sqrt(dx * dx + dy * dy) / 800) * aav);
      if (fr[i]) score *= 1.8;
      if (score > bestNodeScore) {
        bestNodeScore = score;
        best = { kind: 'node', id: n.id, x: n.x, y: n.y };
      }
    }
  }
  if (!best) return false;
  drone.targetKind = best.kind;
  drone.targetId   = best.id;
  drone.tx = best.x; drone.ty = best.y;
  drone._lastRetargetT = state.elapsed;
  return true;
}

// Cooldown (seconds) between drone retargets. A drone that just picked a new
// target shouldn't burn a full grid sweep on the very next tick — by the time
// 0.5s has elapsed either the target's gone (re-evaluate) or it's still fine
// (no scan needed). Pure perf, no gameplay change.
const RETARGET_COOLDOWN_S = 0.5;
function retargetOnCooldown(drone) {
  return state.elapsed - (drone._lastRetargetT || 0) < RETARGET_COOLDOWN_S;
}

// ---- Loiter — shared "holding ring" (a conga line in the sky) ----
// A drone awaiting a target (its objective got captured by its own side, or
// the retarget scan is on cooldown / found nothing) used to FREEZE in place,
// which read as drones eerily pausing in mid-air. Instead, all of an owner's
// idle drones gather into ONE shared ring orbiting a rally point (the centre
// of that faction's drone factories) and circle it together — evenly spaced
// by the golden angle so they form a rotating "dragon", each chasing the slot
// ahead. A drone flies (at cruise speed) toward its rotating slot, so it eases
// INTO the ring rather than teleporting, then rides the rotation. The instant
// a real target appears it peels off. Orbiting (vs. coasting toward the stale
// target) is also safe — it never drifts onto a now-friendly node + detonates.
const LOITER_R = 900;                      // ring radius, world px — wide patrol loiter (10× the old 90)
const LOITER_ROT = 0.05;                   // ring angular velocity, rad/s — scaled ÷10 alongside the
                                           // 10× radius so tangential speed (R×ROT) stays ≈cruise;
                                           // otherwise the slot outruns the drone and the ring never forms
const GOLDEN = Math.PI * (3 - Math.sqrt(5));   // 2.39996… — even angular spread

// owner -> {cx,cy} rally centre. Rebuilt ONCE PER FRAME, not per sub-step:
// updateDrones runs up to 20× a frame at 40×, but state.elapsed is constant
// across a frame's sub-steps (it advances after the loop), so we key the cache
// on it. The forward-staging rally does an all-nodes scan per owner — doing
// that 20× a frame was a real chunk of the drone-update cost.
let _loiterCenters = new Map();
let _loiterStamp = -1;
function rebuildLoiterCenters() {
  if (_loiterStamp === state.elapsed && _loiterCenters.size) return;
  _loiterStamp = state.elapsed;
  _loiterCenters = new Map();
  for (const [o, turrets] of state.turretsByOwner) {
    let sx = 0, sy = 0, n = 0;
    for (const t of turrets) { if (t.type === 'factory') { sx += t.x; sy += t.y; n++; } }
    if (n === 0) continue;
    const fx = sx / n, fy = sy / n;            // factory centroid (home)
    // FORWARD STAGING ("聚合成圈圈"): idle / overkill drones don't fly home to
    // die — they mass into a holding ring just OUTSIDE the nearest worthwhile
    // enemy hub's AA umbrella, poised to strike the instant that hub regens
    // back above the engage threshold. So a salvo's leftovers keep the enemy
    // suppressed in waves instead of getting reaped at base (白累積).
    let best = null, bestD2 = Infinity;
    for (const en of state.nodes) {
      if (en.owner === 'neutral' || isAlly(en.owner, o)) continue;
      if (en.units < DRONE_ENGAGE_UNITS) continue;     // only stage toward a hub worth hitting
      if (state.strippedOwners.has(en.owner)) continue; // dying faction — ground troops' job
      const dx = en.x - fx, dy = en.y - fy, d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = en; }
    }
    if (!best) { _loiterCenters.set(o, { cx: fx, cy: fy }); continue; }
    const d = Math.sqrt(bestD2) || 1;
    const ux = (best.x - fx) / d, uy = (best.y - fy) / d;
    // Stand off far enough that the WHOLE ring (radius LOITER_R) sits outside
    // the hub's flak umbrella, so the swarm gathers safely before it strikes.
    const standoff = Math.max(0, d - (AA_RADIUS * 1.3 + LOITER_R));
    _loiterCenters.set(o, { cx: fx + ux * standoff, cy: fy + uy * standoff });
  }
}
function loiterDrone(drone, dt) {
  const c = _loiterCenters.get(drone.owner);
  if (!c) {                                 // no factory rally point — wide solo orbit (10× radius)
    if (drone._loiterCx === undefined) { drone._loiterCx = drone.x; drone._loiterCy = drone.y; drone._loiterA = Math.random() * Math.PI * 2; }
    drone._loiterA += (DRONE_SPEED / 300) * dt;   // ÷10 angular with 10× radius → same cruise tangential
    drone.x = drone._loiterCx + Math.cos(drone._loiterA) * 300;
    drone.y = drone._loiterCy + Math.sin(drone._loiterA) * 300;
    return;
  }
  // Shared ring slot: a stable golden-angle offset per drone id + a common
  // time rotation, so the whole formation turns as one and stays evenly spread
  // however many join or leave.
  const slot = state.elapsed * LOITER_ROT + drone._id * GOLDEN;
  const tx = c.cx + Math.cos(slot) * LOITER_R;
  const ty = c.cy + Math.sin(slot) * LOITER_R;
  // Fly toward the (moving) slot at cruise speed → eases in, then rides the
  // rotation around the ring.
  const dx = tx - drone.x, dy = ty - drone.y;
  const d = Math.hypot(dx, dy) || 1;
  const step = Math.min(d, DRONE_SPEED * dt);
  drone.x += (dx / d) * step;
  drone.y += (dy / d) * step;
}

// ---- Impact ----
/** Drone hitting a STATIC target (turret or node). No net protection here —
 *  nets only protect troops on roads (handled in droneHitFleet). */
function droneHit(drone) {
  let target;
  if (drone.targetKind === 'turret') target = state.turretById.get(drone.targetId);
  else                                target = state.nodes[drone.targetId];
  if (!target) return false;
  const dmg = drone.damage;
  if (drone.targetKind === 'turret') {
    target.hp -= dmg;
  } else {
    target.units = Math.max(0, target.units - dmg * 0.3);
    if (target.engineers > 0 && Math.random() < 0.3) target.engineers--;
  }
  return true;
}

/** Drone vs a moving ground fleet. The fleet's CURRENT edge may have an
 *  active drone net — if so, the net intercepts the drone instead of the
 *  fleet taking damage. Returns true if the fleet was hit (no net). */
function droneHitFleet(drone, fleet) {
  let edge = null;
  if (fleet.path && fleet.segIdx < fleet.path.length - 1) {
    edge = getEdge(fleet.path[fleet.segIdx], fleet.path[fleet.segIdx + 1]);
  }
  if (edge && edge.netLevel > 0 && edge.netCharges > 0) {
    edge.netCharges -= 1;
    if (edge.netCharges <= 0) { edge.netLevel = 0; edge.netCharges = 0; }
    const aN = state.nodes[fleet.path[fleet.segIdx]];
    const bN = state.nodes[fleet.path[fleet.segIdx + 1]];
    state.tracers.push({
      x1: (aN.x + bN.x) / 2, y1: (aN.y + bN.y) / 2, x2: drone.x, y2: drone.y,
      age: 0, maxAge: 0.22, color: '#e8d6a8',
    });
    return false;        // fleet untouched
  }
  fleet.units -= DRONE_HUNT_DMG;
  if (fleet.units < 0.5) {
    addWreckBlockage(fleet);
    spawnBigExplosion(fleet.x, fleet.y, '#ff8a3a', 10);
    spawnScorch(fleet.x, fleet.y, 'medium');
    fleet._dead = true;
  }
  return true;
}

// Lazy bridge import — keeps this file useful even if wasm-bridge throws.
import { isWasmReady, wasmDroneHuntTargets } from './wasm-bridge.js';
import { isAlly } from './alliance.js';

// ---- Per-tick ----
export function updateDrones(dt) {
  // state.fleetById is built once per tick in simulate() — reuse it for
  // O(1) "give me fleet X" lookups (the hottest part of this function).
  const fleetById = state.fleetById;
  const CELL = 250;
  const huntRange = Math.ceil(Math.sqrt(DRONE_DETECT_R2) / CELL);
  // Per-faction loiter rally centres (factory centroid) for the shared
  // holding-ring formation — rebuilt once per tick, read by loiterDrone.
  rebuildLoiterCenters();
  _nodeScan.clear();             // per-call cache of node aaScreen/frontier (retarget scan)

  // Anti-overkill bookkeeping. `inboundDronesByTarget` (built in simulate) is a
  // tick-TOP snapshot of how many drones are already committed to each target.
  // `pledged` accumulates commitments made DURING this tick's drone loop, so a
  // burst of idle drones near one convoy can't ALL dive it in the same tick
  // before the snapshot would catch up. Effective inbound = snapshot + pledged.
  const pledged = new Map();   // fleetId -> drones that committed this tick

  // ---- Batched wasm hunt scan (with JS fallback) ----
  // When wasm is loaded, gather all live drones + transit ground fleets
  // once and ship them to Rust in a single call. Rust returns an Int32
  // per drone: index into `huntGrounds[]` of the nearest enemy fleet, or
  // -1 if none in DRONE_DETECT_R. The per-drone loop below reads from
  // this table instead of doing its own grid sweep.
  let wasmHuntIdx = null;
  let huntDrones = null;
  let huntGrounds = null;
  if (isWasmReady()) {
    huntDrones = [];
    huntGrounds = [];
    for (const f of state.fleets) {
      // Stamp each drone's slot in huntDrones[] as we pack it, so the per-drone
      // loop below can index wasmHuntIdx directly — no per-tick id→slot Map.
      if (f.kind === 'drone' && f.hp > 0) { f._huntSlot = huntDrones.length; huntDrones.push(f); }
      else if (f.kind !== 'drone' && !f._dead && f.path && f.segIdx < f.path.length - 1) huntGrounds.push(f);
    }
    if (huntDrones.length && huntGrounds.length) {
      wasmHuntIdx = wasmDroneHuntTargets(huntDrones, huntGrounds, DRONE_DETECT_R2);
    }
  }

  for (let i = state.fleets.length - 1; i >= 0; i--) {
    const f = state.fleets[i];
    if (f.kind !== 'drone') continue;
    // Lifetime expiry — wandering drones that haven't found a target self-
    // destruct. Without this, late-game accumulates "lost" drones forever.
    if (state.elapsed - (f.spawnT || 0) > DRONE_MAX_LIFETIME) f.hp = 0;
    // Shot down by AA
    if (f.hp <= 0) {
      for (let k = 0; k < 6; k++) {
        const a = Math.random() * Math.PI * 2;
        state.particles.push({
          x: f.x, y: f.y, vx: Math.cos(a) * 50, vy: Math.sin(a) * 50,
          life: 0.3, maxLife: 0.3, color: '#aaa', kind: 'impact',
        });
      }
      spawnScorch(f.x, f.y, 'small');
      state.fleets.splice(i, 1); continue;
    }

    // Hunt scan: nearest enemy ground fleet in transit, within detection radius.
    // When wasm is loaded the batched pre-computed table answers in O(1);
    // otherwise fall back to the JS grid sweep that was the hot path before.
    let huntFleet = null, huntD2 = DRONE_DETECT_R2;
    if (wasmHuntIdx !== null) {
      // _huntSlot was stamped during the pack loop above; every drone reaching
      // here (hp>0, not yet spliced) is in huntDrones, so the index is valid.
      const gIdx = wasmHuntIdx[f._huntSlot];
      if (gIdx >= 0) {
        const g = huntGrounds[gIdx];
        if (g && !g._dead) {
          const dx = g.x - f.x, dy = g.y - f.y;
          huntD2 = dx * dx + dy * dy;
          huntFleet = g;
        }
      }
    } else {
      const cx0 = Math.floor(f.x / CELL);
      const cy0 = Math.floor(f.y / CELL);
      for (let cx = cx0 - huntRange; cx <= cx0 + huntRange; cx++) {
        for (let cy = cy0 - huntRange; cy <= cy0 + huntRange; cy++) {
          const bucket = state.groundFleetGrid.get(cx * 10000 + cy);
          if (!bucket) continue;
          for (const g of bucket) {
            if (isAlly(g.owner, f.owner)) continue;
            if (g._dead) continue;          // killed earlier this tick
            if (!g.path || g.segIdx >= g.path.length - 1) continue;
            const dx = g.x - f.x, dy = g.y - f.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < huntD2) { huntD2 = d2; huntFleet = g; }
          }
        }
      }
    }

    // Anti-overkill: don't pile onto a ground fleet that already has enough
    // drones inbound to destroy it. `need` = impacts to drop it (DRONE_HUNT_DMG
    // each); `inb` = drones committed in prior ticks (snapshot) + this tick
    // (pledged). A drone ALREADY locked on this fleet is exempt — it's one of
    // the needed attackers, not an extra. Saturated → drop the hunt pick so the
    // drone keeps its current job / loiters and finds other work instead of
    // wasting itself on a corpse-in-progress. (Node targets are already capped
    // in retargetDrone; this brings ground-fleet hunting to parity.)
    if (huntFleet && huntFleet._id !== f.targetId) {
      // need = impacts to drop units below the 0.5 kill threshold (exact, so we
      // don't send a spare drone at near-multiples of the damage).
      const need = Math.max(1, Math.ceil((huntFleet.units - 0.5) / DRONE_HUNT_DMG));
      const inb = (state.inboundDronesByTarget.get(inboundKey('fleet', huntFleet._id)) || 0)
                + (pledged.get(huntFleet._id) || 0);
      if (inb >= need) huntFleet = null;
    }
    const _prevKind = f.targetKind, _prevTid = f.targetId;

    // Target maintenance
    if (f.targetKind === 'fleet') {
      const locked = fleetById.get(f.targetId);
      if (locked) {
        f.tx = locked.x; f.ty = locked.y;
        if (huntFleet && huntFleet._id !== f.targetId) {
          const cx = locked.x - f.x, cy = locked.y - f.y;
          const curD2 = cx * cx + cy * cy;
          if (huntD2 < curD2 * DRONE_SWITCH_R2) {
            f.targetId = huntFleet._id;
            f.tx = huntFleet.x; f.ty = huntFleet.y;
          }
        }
      } else {
        if (huntFleet) {
          f.targetId = huntFleet._id;
          f.tx = huntFleet.x; f.ty = huntFleet.y;
        } else if (retargetOnCooldown(f)) {
          loiterDrone(f, dt); continue;   // orbit while the scan is on cooldown
        } else {
          f.targetKind = 'turret';
          if (!retargetDrone(f)) {
            for (let k = 0; k < 4; k++) {
              const a = Math.random() * Math.PI * 2;
              state.particles.push({
                x: f.x, y: f.y, vx: Math.cos(a) * 20, vy: Math.sin(a) * 20 - 15,
                life: 0.4, maxLife: 0.4, color: '#888', kind: 'impact',
              });
            }
            state.fleets.splice(i, 1); continue;
          }
        }
      }
    } else {
      if (!droneTargetExists(f)) {
        if (retargetOnCooldown(f)) {
          loiterDrone(f, dt); continue;       // orbit while throttled
        } else if (!retargetDrone(f)) {
          // No valid target anywhere right now — orbit and await one instead
          // of self-destructing. Stamp the cooldown so we re-scan at most
          // every RETARGET_COOLDOWN_S; DRONE_MAX_LIFETIME eventually reaps a
          // drone that never finds work.
          f._lastRetargetT = state.elapsed;
          loiterDrone(f, dt); continue;
        }
      }
      if (huntFleet) {
        const px = f.tx - f.x, py = f.ty - f.y;
        const primD2 = px * px + py * py;
        if (huntD2 < primD2 * DRONE_SWITCH_R2 || huntD2 < HUNT_PROXIMITY2) {
          f.targetKind = 'fleet';
          f.targetId = huntFleet._id;
          f.tx = huntFleet.x; f.ty = huntFleet.y;
        }
      }
    }

    // Record a fresh fleet commitment so later drones THIS tick see it (closes
    // the same-tick stampede the snapshot count alone can't catch). Only counts
    // a NEW lock — a drone that was already on this fleet is in the snapshot.
    if (f.targetKind === 'fleet' && (_prevKind !== 'fleet' || _prevTid !== f.targetId)) {
      pledged.set(f.targetId, (pledged.get(f.targetId) || 0) + 1);
    }

    // Reaching here means the drone has a live target and resumes its run —
    // drop any loiter anchor so the next time it needs to wait it re-circles
    // from wherever it then is.
    f._loiterCx = undefined;

    // Approach / impact — still need real `d` here because we normalize by it
    // for the movement step (dx/d, dy/d). The arrival check stays scalar.
    const dx = f.tx - f.x, dy = f.ty - f.y;
    const d = Math.hypot(dx, dy);
    if (d < 12) {
      if (f.targetKind === 'fleet') {
        const fleet = fleetById.get(f.targetId);
        if (fleet) {
          const hit = droneHitFleet(f, fleet);
          if (hit) {
            for (let k = 0; k < 10; k++) {
              const a = Math.random() * Math.PI * 2;
              const sp = 50 + Math.random() * 60;
              state.particles.push({
                x: f.x, y: f.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                life: 0.4, maxLife: 0.4, color: '#ff8a3a', kind: 'explosion',
              });
            }
          } else {
            // Net intercept — light blue net spark, just a hit feel
            for (let k = 0; k < 5; k++) {
              const a = Math.random() * Math.PI * 2;
              state.particles.push({
                x: f.x, y: f.y, vx: Math.cos(a) * 30, vy: Math.sin(a) * 30,
                life: 0.3, maxLife: 0.3, color: '#a4d8ff', kind: 'impact',
              });
            }
          }
        }
        state.fleets.splice(i, 1); continue;
      }
      const hit = droneHit(f);
      if (hit) {
        for (let k = 0; k < 12; k++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 60 + Math.random() * 60;
          state.particles.push({
            x: f.x, y: f.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            life: 0.45, maxLife: 0.45, color: '#ff8a3a', kind: 'explosion',
          });
        }
      } else {
        for (let k = 0; k < 4; k++) {
          const a = Math.random() * Math.PI * 2;
          state.particles.push({
            x: f.x, y: f.y, vx: Math.cos(a) * 25, vy: Math.sin(a) * 25 - 10,
            life: 0.35, maxLife: 0.35, color: '#888', kind: 'impact',
          });
        }
      }
      state.fleets.splice(i, 1); continue;
    }
    const step = DRONE_SPEED * dt;
    f.x += (dx / d) * step;
    f.y += (dy / d) * step;
  }
  // Cleanup pass: remove fleets killed mid-loop by drone hunts
  for (let i = state.fleets.length - 1; i >= 0; i--) {
    if (state.fleets[i]._dead) state.fleets.splice(i, 1);
  }
}

// ---- Factory production & stockpile release ----
/** Pick a list of candidate targets for a drone leaving factory `t`.
 *  Sorted by score (highest first). Caller picks among top-K. */
function pickDroneTargetsFor(t) {
  const cands = [];
  const CELL = 250;
  const range = Math.ceil(1500 / CELL);
  const cx0 = Math.floor(t.x / CELL);
  const cy0 = Math.floor(t.y / CELL);
  // Per-target inbound-drone budget. Each drone does DRONE_DAMAGE=50. Capping
  // how many drones are already committed to one target makes the swarm SPREAD
  // instead of dogpiling — and for nodes the cap is VALUE-AWARE (a 20-unit town
  // needs ~1 drone, a 90-unit hub a few). Freeing the surplus is precisely what
  // lets drones reach DEEPER, higher-value targets instead of overkilling the
  // bombed-flat outer ring. Also stops the old "drone black hole": A and B
  // dumping their whole stockpile on a dying C's leftovers.
  const TARGET_DRONE_CAP = 4;
  const inbound = state.inboundDronesByTarget;

  // ---- Turrets: the enemy's AA wall + drone economy. High intrinsic value,
  // and thinning them opens a lane for follow-up drones to push deeper. The
  // score is value-by-type with only a MILD distance taper, so a juicy turret
  // deep in enemy territory still gets picked (penetration, not nearest-first). ----
  for (let cx = cx0 - range; cx <= cx0 + range; cx++) {
    for (let cy = cy0 - range; cy <= cy0 + range; cy++) {
      const bucket = state.turretGrid.get(cx * 10000 + cy);
      if (!bucket) continue;
      for (const et of bucket) {
        if (isAlly(et.owner, t.owner)) continue;
        if (et.pendingEngineer) continue;     // dirt placeholder, not a real target
        if ((inbound.get(inboundKey('turret', et.id)) || 0) >= TARGET_DRONE_CAP) continue;
        const dx = et.x - t.x, dy = et.y - t.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1500 * 1500) continue;
        const d = Math.sqrt(d2);
        let v = et.type === 'factory'   ? 7.5   // their drone source — kill it
              : et.type === 'antiair'   ? 6.0   // the wall — thin it to open a lane
              : et.type === 'tank'      ? 5.0
              : et.type === 'artillery' ? 4.5
              : 3.0;
        if (!et.active) v *= 1.6;               // half-built — cheap, high-value kill
        v *= 1 / (1 + d / 700);                 // distance: mild taper only
        cands.push({ score: v, target: { kind: 'turret', id: et.id, x: et.x, y: et.y } });
      }
    }
  }

  // ---- Nodes: drones only CHIP UNITS (they never capture), so a node is worth
  // a strike only for the units sitting on it. A node already bombed near-flat
  // is a DEAD END — skip it so the swarm stops hammering the spent outer ring
  // and reaches for the stocked-up nodes behind it. Because the enemy's core
  // holds the most units, value-first scoring naturally drives drones DEEP
  // (the penetration the outer-ring dogpile never achieved). Production hubs
  // (high road degree) are worth proportionally more. ----
  for (const en of state.nodes) {
    if (isAlly(en.owner, t.owner) || en.owner === 'neutral') continue;
    if (state.strippedOwners.has(en.owner)) continue;   // near-dead faction — ground troops' job
    if (en.units < DRONE_ENGAGE_UNITS) continue;         // bombed-flat — nothing meaningful to chip
    // Value-aware cap: ~1 drone per 45 units of garrison (each does 50 dmg), so
    // a small town isn't overkilled while a fat core can draw a proper share.
    const nodeCap = Math.min(NODE_DRONE_CAP, Math.max(1, Math.ceil(en.units / 45)));
    if ((inbound.get(inboundKey('node', en.id)) || 0) >= nodeCap) continue;
    const dx = en.x - t.x, dy = en.y - t.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 1700 * 1700) continue;
    const d = Math.sqrt(d2);
    const degree = state.adj.get(en.id).size;
    // Value rises with garrison up to a HIGH ceiling so the enemy's stocked-up
    // development CORE (200-300 units) far outweighs a chipped-down outpost —
    // drones drive for the heart, not the husk. Production hubs (degree) count
    // extra; distance is a mild taper; and a core still behind an AA screen is
    // divided down so the weapon screen is knocked out FIRST.
    const valueUnits = Math.min(en.units, 160);
    let score = valueUnits * 0.11 * (1 + degree * 0.12);
    score *= 1 / (1 + d / 800);
    score /= aaScreenDivisor(en.x, en.y, t.owner);
    // FRONTIER BOOST: an enemy node touching our own territory is the contested
    // border. Suppressing it to the bone lets ground troops sweep in and CAPTURE
    // (combined arms) — so when we're trading territory, lean drones onto the
    // front we can actually take, not only the deep husk-vs-core value race.
    for (const nbId of state.adj.get(en.id)) {
      if (isAlly(state.nodes[nbId].owner, t.owner)) { score *= 1.8; break; }
    }
    cands.push({ score, target: { kind: 'node', id: en.id, x: en.x, y: en.y } });
  }

  cands.sort((a, b) => b.score - a.score);
  return cands;
}

/** Launch a single drone from factory `t` toward a randomly chosen top-3 target.
 *  Returns true if a drone actually launched (so the caller can drain a held
 *  stockpile). Called from engineering.js updateBuildings during factory ticks. */
export function launchOneDroneFrom(t) {
  const cands = pickDroneTargetsFor(t);
  let target;
  if (cands.length) {
    const top = cands.slice(0, Math.min(3, cands.length));
    target = top[Math.floor(Math.random() * top.length)].target;
  } else {
    // Nothing in scoring range — fall back to the NEAREST enemy node with units
    // anywhere on the map, so drones never pile up unable to fire just because
    // the enemy is across the no-man's gap. They'll cross to reach it. (Only
    // genuinely no enemy-with-units left → hold.)
    let best = null, bestD2 = Infinity;
    for (const en of state.nodes) {
      if (isAlly(en.owner, t.owner) || en.owner === 'neutral') continue;
      if (state.strippedOwners.has(en.owner) || en.units < DRONE_ENGAGE_UNITS) continue;
      const dx = en.x - t.x, dy = en.y - t.y, d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = en; }
    }
    if (!best) return false;
    target = { kind: 'node', id: best.id, x: best.x, y: best.y };
  }
  spawnDrone(t.x, t.y, t.owner, target);
  return true;
}

/** Resolve a stored salvo target (player or AI) against current state.
 *  Drops it if the entity died / was captured by the salvo owner / belongs
 *  to a stripped faction (would just funnel into the regen-and-die black
 *  hole — let the salvo re-pick a real threat). */
function resolveSalvoTarget(s, salvoOwner, respectValue = true) {
  if (!s) return null;
  // respectValue=false → the PLAYER explicitly clicked this target, so honour
  // it even if it's bombed-flat / stripped. The value gates below are an AI
  // anti-waste heuristic; a human's deliberate alpha-strike isn't second-guessed.
  if (s.kind === 'turret') {
    const t = state.turretById.get(s.id);
    if (t && !isAlly(t.owner, salvoOwner) && (!respectValue || !state.strippedOwners.has(t.owner))) {
      return { kind: 'turret', id: t.id, x: t.x, y: t.y };
    }
  } else if (s.kind === 'node') {
    const n = state.nodes[s.id];
    if (n && !isAlly(n.owner, salvoOwner) &&
        (!respectValue || (!state.strippedOwners.has(n.owner) && n.units >= DRONE_ENGAGE_UNITS))) {
      return { kind: 'node', id: n.id, x: n.x, y: n.y };
    }
  }
  return null;
}

/** Per-target salvo budget so a small node isn't dogpiled — drones only chip
 *  units, so a node needs ~1 round per 45 garrison (cap 4); a bombed-flat node
 *  (< ENGAGE) gets 0 and is skipped entirely. */
function nodeBudget(id) {
  const fn = state.nodes[id];
  if (!fn || fn.units < DRONE_ENGAGE_UNITS) return 0;
  return Math.min(NODE_DRONE_CAP, Math.ceil(fn.units / 45) + 1);
}

/** Build a salvo plan: spread `n` drones across the best VALUE targets, each
 *  capped by its budget so nothing is overkilled. A fixed target (player click
 *  / AI focus) goes first (a TURRET soaks more; a dead node is dropped). This
 *  is the SAME evaluator launch + retarget use — one consistent system, so a
 *  salvo never again dumps the whole stockpile onto one near-empty city. */
function buildSalvoPlan(t, fixedTarget, n) {
  const budgeted = [];
  if (fixedTarget) {
    const b = fixedTarget.kind === 'turret' ? 8 : nodeBudget(fixedTarget.id);
    if (b > 0) budgeted.push({ target: fixedTarget, budget: b });
  }
  for (const c of pickDroneTargetsFor(t)) {
    if (fixedTarget && c.target.kind === fixedTarget.kind && c.target.id === fixedTarget.id) continue;
    const b = c.target.kind === 'turret' ? 4 : nodeBudget(c.target.id);
    if (b > 0) budgeted.push({ target: c.target, budget: b });
  }
  const plan = [];
  let progressed = true;
  while (plan.length < n && progressed) {
    progressed = false;
    for (const e of budgeted) {
      if (e.budget <= 0) continue;
      plan.push(e.target); e.budget--; progressed = true;
      if (plan.length >= n) break;
    }
  }
  return plan;                      // length ≤ n; shortfall = drones with no worthwhile target
}

/** Generic stockpile flush for any owner. Distributes the stockpile across the
 *  budgeted value plan; drones with no worthwhile target STAY stockpiled
 *  (aggregate, don't vaporise onto a dead front). Internal — both
 *  releasePlayerStockpile and releaseAIStockpile delegate here. */
function releaseStockpileFor(owner, fixedTarget, fullDump = false) {
  let launched = 0;
  for (const t of state.turrets) {
    if (t.owner !== owner || t.type !== 'factory' || !t.dronesReady) continue;
    const n = t.dronesReady;

    // PLAYER ALPHA-STRIKE (fullDump): launch the ENTIRE stockpile at once — no
    // anti-waste value budget, no per-node cap. The player held fire to amass
    // a wall of drones and pressed launch; they want ALL of them in the air.
    // Every drone aims at the clicked target (overkill drones auto-abandon a
    // flattened node and re-pick the next enemy in flight); with no clicked
    // target each self-picks its nearest worthwhile/closest enemy.
    if (fullDump) {
      for (let k = 0; k < n; k++) {
        const jx = (Math.random() - 0.5) * 18;
        const jy = (Math.random() - 0.5) * 18;
        if (fixedTarget) { spawnDrone(t.x + jx, t.y + jy, t.owner, fixedTarget); launched++; }
        else if (launchOneDroneFrom(t)) launched++;
      }
      t.dronesReady = 0; t.prodCooldown = DF_PRODUCTION_T;
      continue;
    }

    // AI release: spread across the value-budgeted plan; un-budgeted drones
    // STAY stockpiled (don't vaporise onto a dead front).
    const plan = buildSalvoPlan(t, fixedTarget, n);
    for (let k = 0; k < plan.length; k++) {
      const jx = (Math.random() - 0.5) * 14;
      const jy = (Math.random() - 0.5) * 14;
      spawnDrone(t.x + jx, t.y + jy, t.owner, plan[k]);
      launched++;
    }
    t.dronesReady = n - plan.length;                 // keep the unspent remainder
    if (t.dronesReady <= 0) { t.dronesReady = 0; t.prodCooldown = DF_PRODUCTION_T; }
  }
  return launched;
}

/** Player-facing release — driven by the second H press. */
export function releasePlayerStockpile() {
  // respectValue=false: honour the player's explicit click even on a suppressed
  // target. fullDump=true: launch every stockpiled drone, no value budget.
  const fixedTarget = resolveSalvoTarget(state.salvoTarget, 'player', false);
  const launched = releaseStockpileFor('player', fixedTarget, true);
  state.salvoTarget = null;
  return launched;
}

/** AI-facing release — fired from aiTick when stockpile is large enough or
 *  has aged out. The AI may have pre-picked a focus target during Phase 1.5;
 *  if not, drones auto-diversify. */
export function releaseAIStockpile(owner) {
  const fixedTarget = resolveSalvoTarget(state.aiSalvoTarget[owner], owner);
  const launched = releaseStockpileFor(owner, fixedTarget);
  state.aiSalvoTarget[owner] = null;
  return launched;
}

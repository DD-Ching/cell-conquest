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
  DF_PRODUCTION_T, FACTORY_MAX_STOCKPILE,
} from './config.js';
import { dist } from './util.js';
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
/** Does the drone's stored target still WARRANT a strike?
 *
 *  IN-FLIGHT COMMITMENT: a launched suicide drone flies its run to the end.
 *  It only abandons a target that has flipped to its OWN side (no point
 *  bombing a base your faction just captured) or a turret that's been
 *  destroyed. It does NOT u-turn just because the target's unit count
 *  dipped or the faction got weak — re-evaluating those mid-flight made a
 *  whole salvo flip-flop as a dying base oscillated around a threshold
 *  (drones turning around again and again, never finishing). "Should I
 *  send drones at this weak faction at all" is decided ONCE at launch
 *  (pickDroneTargetsFor / the salvo picker skip stripped owners + honour
 *  the per-target inbound cap), not re-litigated every frame in transit. */
function droneTargetExists(drone) {
  if (drone.targetKind === 'turret') return state.turretById.has(drone.targetId);
  if (drone.targetKind === 'node') {
    if (drone.targetId >= state.nodes.length) return false;
    const n = state.nodes[drone.targetId];
    if (isAlly(n.owner, drone.owner)) return false; // captured by own side — stand down
    return true;                                    // otherwise commit to the run
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
    for (const n of state.nodes) {
      if (isAlly(n.owner, drone.owner) || n.owner === 'neutral') continue;
      if (state.strippedOwners.has(n.owner)) continue;  // skip dying-faction nodes
      const dx = n.x - drone.x, dy = n.y - drone.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = { kind: 'node', id: n.id, x: n.x, y: n.y }; }
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
      if (f.kind === 'drone' && f.hp > 0) huntDrones.push(f);
      else if (f.kind !== 'drone' && !f._dead && f.path && f.segIdx < f.path.length - 1) huntGrounds.push(f);
    }
    if (huntDrones.length && huntGrounds.length) {
      wasmHuntIdx = wasmDroneHuntTargets(huntDrones, huntGrounds, DRONE_DETECT_R2);
    }
  }
  // droneIdxById gives O(1) lookup from a drone fleet to its slot in huntDrones[].
  const droneIdxById = new Map();
  if (huntDrones) {
    for (let i = 0; i < huntDrones.length; i++) droneIdxById.set(huntDrones[i]._id, i);
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
      const dIdx = droneIdxById.get(f._id);
      if (dIdx !== undefined) {
        const gIdx = wasmHuntIdx[dIdx];
        if (gIdx >= 0) {
          const g = huntGrounds[gIdx];
          if (g && !g._dead) {
            const dx = g.x - f.x, dy = g.y - f.y;
            huntD2 = dx * dx + dy * dy;
            huntFleet = g;
          }
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
          // Skip both the scan AND this tick's movement/arrival. Coasting on
          // stale tx/ty risks the drone arriving at a now-friendly node before
          // the next retarget — droneHit doesn't check ownership. Pausing for
          // one tick is the safe behavior-preserving choice.
          continue;
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
          // Same throttle / same safety: pause one tick instead of coasting
          // toward a stale (possibly now-friendly) target. See note above.
          continue;
        } else if (!retargetDrone(f)) {
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
  // Drones fly far but score drops sharply with distance — 1500/(d+200) is
  // already negligible past ~1200 px. Cap the grid query at 1500 px so we
  // skip turrets across the map that wouldn't be picked anyway.
  const CELL = 250;
  const range = Math.ceil(1500 / CELL);
  const cx0 = Math.floor(t.x / CELL);
  const cy0 = Math.floor(t.y / CELL);
  // Per-target inbound-drone budget. Each drone does DRONE_DAMAGE=50; even
  // an L1 net intercepts only ~20 drones per kill. 4 drones in flight =
  // 200 incoming damage, enough to wipe any node or every turret type.
  // Beyond that we're feeding a "drone black hole": when faction C is
  // dying, A and B keep dumping drones on C's leftover targets instead
  // of attacking each other. Cap stops it.
  const TARGET_DRONE_CAP = 4;
  const inbound = state.inboundDronesByTarget;

  for (let cx = cx0 - range; cx <= cx0 + range; cx++) {
    for (let cy = cy0 - range; cy <= cy0 + range; cy++) {
      const bucket = state.turretGrid.get(cx * 10000 + cy);
      if (!bucket) continue;
      for (const et of bucket) {
        if (isAlly(et.owner, t.owner)) continue;
        if (et.pendingEngineer) continue;     // dirt placeholder, not a real target
        if ((inbound.get('turret:' + et.id) || 0) >= TARGET_DRONE_CAP) continue;
        const dx = et.x - t.x, dy = et.y - t.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1500 * 1500) continue;
        const d = Math.sqrt(d2);
        let score = 1500 / (d + 200);
        if (et.type === 'antiair') score *= 1.5;
        if (et.type === 'factory') score *= 1.8;
        if (!et.active) score *= 2.0;
        cands.push({ score, target: { kind: 'turret', id: et.id, x: et.x, y: et.y } });
      }
    }
  }
  if (cands.length === 0) {
    for (const en of state.nodes) {
      if (isAlly(en.owner, t.owner) || en.owner === 'neutral') continue;
      // Stripped faction (no production, tiny total units) — the 10↔10 regen
      // oscillation that ate every drone last build. Ground troops handle it.
      if (state.strippedOwners.has(en.owner)) continue;
      if ((inbound.get('node:' + en.id) || 0) >= TARGET_DRONE_CAP) continue;
      const d = dist(t, en);
      const score = 800 / (d + 200);
      cands.push({ score, target: { kind: 'node', id: en.id, x: en.x, y: en.y } });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands;
}

/** Launch a single drone from factory `t` toward a randomly chosen top-3 target.
 *  Called from engineering.js updateBuildings during normal factory ticks. */
export function launchOneDroneFrom(t) {
  const cands = pickDroneTargetsFor(t);
  if (cands.length === 0) return;
  const top = cands.slice(0, Math.min(3, cands.length));
  const pick = top[Math.floor(Math.random() * top.length)];
  spawnDrone(t.x, t.y, t.owner, pick.target);
}

/** Resolve a stored salvo target (player or AI) against current state.
 *  Drops it if the entity died / was captured by the salvo owner / belongs
 *  to a stripped faction (would just funnel into the regen-and-die black
 *  hole — let the salvo re-pick a real threat). */
function resolveSalvoTarget(s, salvoOwner) {
  if (!s) return null;
  if (s.kind === 'turret') {
    const t = state.turretById.get(s.id);
    if (t && !isAlly(t.owner, salvoOwner) && !state.strippedOwners.has(t.owner)) {
      return { kind: 'turret', id: t.id, x: t.x, y: t.y };
    }
  } else if (s.kind === 'node') {
    const n = state.nodes[s.id];
    if (n && !isAlly(n.owner, salvoOwner) && !state.strippedOwners.has(n.owner)) {
      return { kind: 'node', id: n.id, x: n.x, y: n.y };
    }
  }
  return null;
}

/** Generic stockpile flush for any owner. If a fixed salvo target was set
 *  (player clicked a turret/node during Hold-Fire, AI picked a focus point),
 *  every drone goes there. Otherwise drones diversify across the top auto-
 *  scored targets. Internal — both releasePlayerStockpile and
 *  releaseAIStockpile delegate here. */
function releaseStockpileFor(owner, fixedTarget) {
  let launched = 0;
  for (const t of state.turrets) {
    if (t.owner !== owner || t.type !== 'factory') continue;
    if (!t.dronesReady) continue;

    let pool;
    if (fixedTarget) {
      pool = [{ target: fixedTarget }];
    } else {
      const cands = pickDroneTargetsFor(t);
      if (cands.length === 0) { t.dronesReady = 0; continue; }
      pool = cands.slice(0, Math.min(5, cands.length));
    }

    for (let k = 0; k < t.dronesReady; k++) {
      const pick = pool[k % pool.length];
      const jx = (Math.random() - 0.5) * 14;
      const jy = (Math.random() - 0.5) * 14;
      spawnDrone(t.x + jx, t.y + jy, t.owner, pick.target);
      launched++;
    }
    t.dronesReady = 0;
    t.prodCooldown = DF_PRODUCTION_T;
  }
  return launched;
}

/** Player-facing release — driven by the second H press. */
export function releasePlayerStockpile() {
  const fixedTarget = resolveSalvoTarget(state.salvoTarget, 'player');
  const launched = releaseStockpileFor('player', fixedTarget);
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

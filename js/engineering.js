// =====================================================
// Battle engineering — Mars tower-defense flavour.
//
// Buildings ("turrets") live at WORLD coordinates, not on nodes.
// Engineer fleets are dispatched from an owned node, travel by road
// to the closest road anchor, then walk off-road straight to the
// turret's world point at reduced speed. Construction proceeds while
// an engineer is on-site. Drones target enemy turrets first.
// =====================================================
import { state } from './state.js';
import { dist } from './util.js';
import { findPath } from './world.js';
import { COLOR } from './factions.js';
import {
  ENG_HP, ENG_BUILD_RATE, ENG_CLEAR_RATE, ENG_COST,
  AA_BUILD_TIME, AA_HP, AA_RADIUS, AA_DPS,
  DF_BUILD_TIME, DF_HP, DF_PRODUCTION_T,
  TANK_BUILD_TIME, TANK_HP, TANK_RADIUS, TANK_DPS,
  DRONE_HP_AIR, DRONE_SPEED, DRONE_DAMAGE,
  DRONE_DETECT_R, DRONE_HUNT_DMG, DRONE_HUNT_SWITCH_RATIO,
  NET_LEVEL_MAX, NET_CHARGES_LEVEL, WRECK_CLEAR_PER_ENG,
  BLOCKAGE_DECAY, BLOCKAGE_PER_WRECK,
} from './config.js';

export { ENG_SPEED } from './config.js';

// ---- Edges ----
export function ekey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
export function getEdge(a, b) { return state.edgeData.get(ekey(a, b)); }
export function edgeSpeedMul(a, b) {
  const e = getEdge(a, b);
  if (!e) return 1.0;
  return Math.max(0.2, 1.0 - e.blockage);
}

// ---- Reset ----
export function resetEngineering() {
  state.edgeData.clear();
  for (const r of state.roads) {
    state.edgeData.set(ekey(r.a, r.b), {
      blockage: 0,
      netLevel: 0, netCharges: 0, netOwner: null,
    });
  }
  state.turrets = [];
  state.placeMode = null;
  state._nextFleetId = 1;
  for (const n of state.nodes) {
    n.engineers = 0;
    n.flashBuild = 0;
  }
}

// ---- Build specs (world-coord turrets only; nets are on edges, see placeNetOnEdge) ----
const BUILD_SPECS = {
  antiair: { time: AA_BUILD_TIME,   hp: AA_HP },
  factory: { time: DF_BUILD_TIME,   hp: DF_HP },
  tank:    { time: TANK_BUILD_TIME, hp: TANK_HP },
};

/** Visible turret range — used for AA and tank rings. */
export const TURRET_RANGES = {
  antiair: AA_RADIUS,
  tank:    TANK_RADIUS,
};

let nextTurretId = 1;

/** Place a turret at world point (x,y). Finds nearest own road anchor and
 *  dispatches an engineer that walks the roads then off-roads to (x,y). */
export function placeTurretAt(x, y, type, byOwner) {
  const spec = BUILD_SPECS[type];
  if (!spec) return false;
  // Find nearest own node with enough units (engineer source)
  let source = null, srcDist = Infinity;
  for (const n of state.nodes) {
    if (n.owner !== byOwner) continue;
    if (n.units < ENG_COST + 5) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < srcDist) { srcDist = d; source = n; }
  }
  if (!source) return false;
  // Anchor: nearest OWN node to the target world point — engineer walks roads to here, then off-road.
  let anchor = source, anchorDist = Math.hypot(source.x - x, source.y - y);
  for (const n of state.nodes) {
    if (n.owner !== byOwner) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < anchorDist) { anchorDist = d; anchor = n; }
  }
  const path = (source.id === anchor.id) ? [source.id] : findPath(source.id, anchor.id, byOwner);
  if (!path || path.length < 1) return false;
  // Create turret site (inactive, progress 0)
  const turret = {
    id: nextTurretId++,
    owner: byOwner, type, x, y,
    hp: spec.hp, hpMax: spec.hp,
    progress: 0, active: false,
    total: spec.time, prodCooldown: 0,
    engineers: 0,
  };
  state.turrets.push(turret);
  source.units -= ENG_COST;
  state.fleets.push({
    _id: state._nextFleetId++,
    kind: 'deploy', owner: byOwner, units: 1, path,
    segIdx: 0, segTraveled: 0,
    x: source.x, y: source.y,
    hp: ENG_HP,
    finalX: x, finalY: y,
    targetTurretId: turret.id,
    offroad: false,
  });
  return true;
}

/** Place a drone-net engineer on a specific road segment. The net mechanic is
 *  per-edge: arriving engineers either clear wreckage on that segment OR
 *  upgrade the net level (capped at NET_LEVEL_MAX). Each level grants
 *  NET_CHARGES_LEVEL[level] drone interceptions. */
export function placeNetOnEdge(roadA, roadB, byOwner) {
  const edge = getEdge(roadA, roadB);
  if (!edge) return false;
  // Source: nearest own node with enough units to fund an engineer.
  let source = null, srcD = Infinity;
  for (const n of state.nodes) {
    if (n.owner !== byOwner) continue;
    if (n.units < ENG_COST + 5) continue;
    const d = Math.hypot(n.x - state.nodes[roadA].x, n.y - state.nodes[roadA].y) +
              Math.hypot(n.x - state.nodes[roadB].x, n.y - state.nodes[roadB].y);
    if (d < srcD) { srcD = d; source = n; }
  }
  if (!source) return false;
  // Anchor: closer endpoint of the edge that's our own (so engineer can road there).
  // If neither endpoint is ours, abort — we can't path safely.
  const aN = state.nodes[roadA], bN = state.nodes[roadB];
  let anchor = null;
  if (aN.owner === byOwner && bN.owner === byOwner) {
    anchor = (Math.hypot(source.x - aN.x, source.y - aN.y) <
              Math.hypot(source.x - bN.x, source.y - bN.y)) ? aN : bN;
  } else if (aN.owner === byOwner) anchor = aN;
  else if (bN.owner === byOwner) anchor = bN;
  if (!anchor) return false;
  const path = (source.id === anchor.id) ? [source.id] : findPath(source.id, anchor.id, byOwner);
  if (!path || path.length < 1) return false;
  // Off-road target = midpoint of the edge (where the net physically sits)
  const mx = (aN.x + bN.x) / 2, my = (aN.y + bN.y) / 2;
  source.units -= ENG_COST;
  state.fleets.push({
    _id: state._nextFleetId++,
    kind: 'deploy', owner: byOwner, units: 1, path,
    segIdx: 0, segTraveled: 0,
    x: source.x, y: source.y,
    hp: ENG_HP,
    finalX: mx, finalY: my,
    targetEdgeA: roadA, targetEdgeB: roadB,
    offroad: false,
  });
  return true;
}

/** Find a nearby road that still needs work (blockage to clear or net to upgrade)
 *  for an engineer whose original target is already maxed. Returns {a, b} or null. */
export function findNetWorkRedirect(byOwner, fromX, fromY) {
  let best = null, bestD = Infinity;
  for (const r of state.roads) {
    const e = state.edgeData.get(ekey(r.a, r.b));
    if (!e) continue;
    if (e.blockage < 0.15 && e.netLevel >= NET_LEVEL_MAX) continue;     // nothing to do
    // Only redirect to edges where at least one endpoint is ours
    const aN = state.nodes[r.a], bN = state.nodes[r.b];
    if (aN.owner !== byOwner && bN.owner !== byOwner) continue;
    const mx = (aN.x + bN.x) / 2, my = (aN.y + bN.y) / 2;
    const d = Math.hypot(fromX - mx, fromY - my);
    if (d < bestD) { bestD = d; best = { a: r.a, b: r.b }; }
  }
  return best;
}

/** Called by fleet sim when an engineer finishes its road path and starts the off-road leg. */
export function engineerEnterOffroad(f) {
  f.offroad = true;
}

/** Called by fleet sim when an engineer arrives at its turret site. */
export function engineerArrivedAtTurret(f) {
  const t = state.turrets.find(t => t.id === f.targetTurretId);
  if (!t || t.owner !== f.owner) return;
  t.engineers += 1;
}

/** Called when an engineer arrives at a net edge site. Performs ONE action:
 *  - If the edge has heavy wreckage (blockage >= 0.15), clear it by WRECK_CLEAR_PER_ENG.
 *  - Else if net not maxed, raise net level by 1 and refill charges to that level's max.
 *  - Else (nothing to do here): redirect engineer toward the nearest road that needs work. */
export function engineerArrivedAtNetEdge(f) {
  const edge = getEdge(f.targetEdgeA, f.targetEdgeB);
  if (!edge) return { consumed: true };
  // 1) Heavy wreckage — clear it first
  if (edge.blockage >= 0.15) {
    edge.blockage = Math.max(0, edge.blockage - WRECK_CLEAR_PER_ENG);
    flashEdgeWork(f.targetEdgeA, f.targetEdgeB, '#ffd066');
    return { consumed: true };
  }
  // 2) Net not yet maxed (and not owned by an opposing faction) — upgrade
  const canUpgrade = edge.netLevel < NET_LEVEL_MAX
                  && (edge.netOwner === null || edge.netOwner === f.owner);
  if (canUpgrade) {
    edge.netLevel += 1;
    edge.netCharges = NET_CHARGES_LEVEL[edge.netLevel];
    edge.netOwner = f.owner;
    flashEdgeWork(f.targetEdgeA, f.targetEdgeB, '#5cb3ff');
    return { consumed: true };
  }
  // 3) Maxed or opposing-faction net — redirect to nearest road that needs work
  const redirect = findNetWorkRedirect(f.owner, f.x, f.y);
  if (!redirect) return { consumed: true };
  return { consumed: false, redirect };
}

/** Visual flash on an edge when an engineer finishes a piece of work there. */
function flashEdgeWork(a, b, color) {
  const aN = state.nodes[a], bN = state.nodes[b];
  const mx = (aN.x + bN.x) / 2, my = (aN.y + bN.y) / 2;
  for (let k = 0; k < 10; k++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 30 + Math.random() * 60;
    state.particles.push({
      x: mx, y: my, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      life: 0.5, maxLife: 0.5, color,
    });
  }
}

// ---- Drone ----
export function spawnDrone(originX, originY, owner, target) {
  state.fleets.push({
    _id: state._nextFleetId++,
    kind: 'drone', owner, units: 1,
    x: originX, y: originY,
    tx: target.x, ty: target.y,
    targetKind: target.kind,            // 'turret' | 'node' | 'fleet'
    targetId:   target.id,
    hp: DRONE_HP_AIR, damage: DRONE_DAMAGE,
  });
}

/** Does the drone's stored target still WARRANT a strike?
 *  A "gone" target is one that's: removed (turret destroyed, fleet wiped),
 *  no longer hostile (node captured by an ally of the drone),
 *  or already worthless (node bombed down to ~0 units — another drone got it). */
function droneTargetExists(drone) {
  if (drone.targetKind === 'turret') return state.turrets.some(t => t.id === drone.targetId);
  if (drone.targetKind === 'node') {
    if (drone.targetId >= state.nodes.length) return false;
    const n = state.nodes[drone.targetId];
    if (n.owner === drone.owner) return false;     // we already own it
    if (n.units < 1) return false;                  // someone else cleaned it out
    return true;
  }
  if (drone.targetKind === 'fleet')  return state.fleets.some(f => f._id === drone.targetId);
  return false;
}

/** Find the closest enemy entity for `drone` to switch to. Returns true if found. */
function retargetDrone(drone) {
  let best = null, bestD = Infinity;
  for (const t of state.turrets) {
    if (t.owner === drone.owner) continue;
    const d = Math.hypot(t.x - drone.x, t.y - drone.y);
    if (d < bestD) { bestD = d; best = { kind: 'turret', id: t.id, x: t.x, y: t.y }; }
  }
  if (!best) {
    for (const n of state.nodes) {
      if (n.owner === drone.owner || n.owner === 'neutral') continue;
      const d = Math.hypot(n.x - drone.x, n.y - drone.y);
      if (d < bestD) { bestD = d; best = { kind: 'node', id: n.id, x: n.x, y: n.y }; }
    }
  }
  if (!best) return false;
  drone.targetKind = best.kind;
  drone.targetId   = best.id;
  drone.tx = best.x; drone.ty = best.y;
  return true;
}

/** A drone impacting a STATIC target (turret or node). Damage applied directly,
 *  no net protection here — nets only protect troops on roads (handled in updateDrones). */
function droneHit(drone) {
  let target;
  if (drone.targetKind === 'turret') target = state.turrets.find(t => t.id === drone.targetId);
  else                                target = state.nodes[drone.targetId];
  if (!target) return false;             // already gone — no damage, no boom
  const dmg = drone.damage;
  if (drone.targetKind === 'turret') {
    target.hp -= dmg;
  } else {
    target.units = Math.max(0, target.units - dmg * 0.3);
    if (target.engineers > 0 && Math.random() < 0.3) target.engineers--;
  }
  return true;
}

/** A drone is colliding with a moving ground fleet. The fleet's CURRENT edge
 *  may have an active drone net — if so, the net intercepts the drone instead
 *  of the fleet taking damage. Returns true if the fleet was hit (no net). */
function droneHitFleet(drone, fleet) {
  // Find the edge the fleet is currently traversing
  let edge = null;
  if (fleet.path && fleet.segIdx < fleet.path.length - 1) {
    edge = getEdge(fleet.path[fleet.segIdx], fleet.path[fleet.segIdx + 1]);
  }
  // Net intercepts: must be active (charges > 0) and protect the fleet's owner
  if (edge && edge.netLevel > 0 && edge.netCharges > 0 && edge.netOwner === fleet.owner) {
    edge.netCharges -= 1;
    if (edge.netCharges <= 0) { edge.netLevel = 0; edge.netCharges = 0; edge.netOwner = null; }
    // Visual: short tracer beam from net midpoint to drone
    const aN = state.nodes[fleet.path[fleet.segIdx]];
    const bN = state.nodes[fleet.path[fleet.segIdx + 1]];
    state.tracers.push({
      x1: (aN.x + bN.x) / 2, y1: (aN.y + bN.y) / 2, x2: drone.x, y2: drone.y,
      age: 0, maxAge: 0.22, color: '#a4d8ff',
    });
    return false;        // fleet untouched
  }
  // No protection — drone damages the fleet
  fleet.units -= DRONE_HUNT_DMG;
  if (fleet.units < 0.5) {
    addWreckBlockage(fleet);
    spawnBigExplosion(fleet.x, fleet.y, '#ff8a3a', 10);
    // Mark for cleanup — splicing here would corrupt the outer loop's index
    fleet._dead = true;
  }
  return true;
}

/** A vehicle (any non-drone fleet) dying on the road. Off-road / drone deaths
 *  produce nothing. If the segment has an active drone-net, the net "absorbs"
 *  the damage instead — one death = -20 charges, dropping the level as it
 *  drains. Only after the net is fully gone does wreckage start to pile up
 *  (death highway). This way you can't death-highway a netted road. */
export function addWreckBlockage(f) {
  if (f.kind === 'drone') return;
  if ((f.kind === 'deploy' || f.kind === 'assault') && f.offroad) return;
  if (!f.path || f.segIdx >= f.path.length - 1) return;
  const a = f.path[f.segIdx], b = f.path[f.segIdx + 1];
  const e = getEdge(a, b);
  if (!e) return;
  if (e.netLevel > 0) {
    // Net absorbs the death (one level worth of charges per casualty)
    e.netCharges -= NET_CHARGES_LEVEL[1];
    if (e.netCharges <= 0) {
      e.netLevel = 0; e.netCharges = 0; e.netOwner = null;
    } else if (e.netCharges <= NET_CHARGES_LEVEL[1]) e.netLevel = 1;
    else if (e.netCharges <= NET_CHARGES_LEVEL[2]) e.netLevel = 2;
    return;
  }
  e.blockage = Math.min(1, e.blockage + BLOCKAGE_PER_WRECK);
}

export function updateDrones(dt) {
  for (let i = state.fleets.length - 1; i >= 0; i--) {
    const f = state.fleets[i];
    if (f.kind !== 'drone') continue;
    // Shot down by AA
    if (f.hp <= 0) {
      for (let k = 0; k < 6; k++) {
        const a = Math.random() * Math.PI * 2;
        state.particles.push({
          x: f.x, y: f.y, vx: Math.cos(a) * 50, vy: Math.sin(a) * 50,
          life: 0.3, maxLife: 0.3, color: '#aaa',
        });
      }
      state.fleets.splice(i, 1); continue;
    }

    // Hunt scan: nearest enemy ground fleet in transit, within detection radius.
    let huntFleet = null, huntD = DRONE_DETECT_R;
    for (const g of state.fleets) {
      if (g.owner === f.owner) continue;
      if (g.kind === 'drone') continue;
      if (!g.path || g.segIdx >= g.path.length - 1) continue;
      const d = Math.hypot(g.x - f.x, g.y - f.y);
      if (d < huntD) { huntD = d; huntFleet = g; }
    }

    // Target maintenance
    if (f.targetKind === 'fleet') {
      // Track the fleet we locked onto. If it died, fall back to retarget.
      const locked = state.fleets.find(g => g._id === f.targetId);
      if (locked) {
        f.tx = locked.x; f.ty = locked.y;
        // Swap to a closer hunt fleet only if it's significantly closer
        if (huntFleet && huntFleet._id !== f.targetId) {
          const curD = Math.hypot(locked.x - f.x, locked.y - f.y);
          if (huntD < curD * DRONE_HUNT_SWITCH_RATIO) {
            f.targetId = huntFleet._id;
            f.tx = huntFleet.x; f.ty = huntFleet.y;
          }
        }
      } else {
        // Locked fleet died — prefer another hunt; else fall back to nearest enemy static
        if (huntFleet) {
          f.targetId = huntFleet._id;
          f.tx = huntFleet.x; f.ty = huntFleet.y;
        } else {
          f.targetKind = 'turret';            // reset; retargetDrone will pick the best
          if (!retargetDrone(f)) {
            for (let k = 0; k < 4; k++) {
              const a = Math.random() * Math.PI * 2;
              state.particles.push({
                x: f.x, y: f.y, vx: Math.cos(a) * 20, vy: Math.sin(a) * 20 - 15,
                life: 0.4, maxLife: 0.4, color: '#888',
              });
            }
            state.fleets.splice(i, 1); continue;
          }
        }
      }
    } else {
      // Primary target = turret/node. Re-target if it died.
      if (!droneTargetExists(f)) {
        if (!retargetDrone(f)) {
          for (let k = 0; k < 4; k++) {
            const a = Math.random() * Math.PI * 2;
            state.particles.push({
              x: f.x, y: f.y, vx: Math.cos(a) * 20, vy: Math.sin(a) * 20 - 15,
              life: 0.4, maxLife: 0.4, color: '#888',
            });
          }
          state.fleets.splice(i, 1); continue;
        }
      }
      // Switch to a ground hunt if a fleet is significantly closer than the static target.
      if (huntFleet) {
        const primD = Math.hypot(f.tx - f.x, f.ty - f.y);
        if (huntD < primD * DRONE_HUNT_SWITCH_RATIO || huntD < 50) {
          f.targetKind = 'fleet';
          f.targetId = huntFleet._id;
          f.tx = huntFleet.x; f.ty = huntFleet.y;
        }
      }
    }

    // Approach / impact
    const dx = f.tx - f.x, dy = f.ty - f.y;
    const d = Math.hypot(dx, dy);
    if (d < 12) {
      if (f.targetKind === 'fleet') {
        const fleet = state.fleets.find(g => g._id === f.targetId);
        if (fleet) {
          const hit = droneHitFleet(f, fleet);
          if (hit) {
            for (let k = 0; k < 10; k++) {
              const a = Math.random() * Math.PI * 2;
              const sp = 50 + Math.random() * 60;
              state.particles.push({
                x: f.x, y: f.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                life: 0.4, maxLife: 0.4, color: '#ff8a3a',
              });
            }
          } else {
            // Net caught us — silent fizzle (tracer already drawn in droneHitFleet)
            for (let k = 0; k < 5; k++) {
              const a = Math.random() * Math.PI * 2;
              state.particles.push({
                x: f.x, y: f.y, vx: Math.cos(a) * 30, vy: Math.sin(a) * 30,
                life: 0.3, maxLife: 0.3, color: '#a4d8ff',
              });
            }
          }
        }
        state.fleets.splice(i, 1); continue;
      }
      // Static target impact
      const hit = droneHit(f);
      if (hit) {
        for (let k = 0; k < 12; k++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 60 + Math.random() * 60;
          state.particles.push({
            x: f.x, y: f.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            life: 0.45, maxLife: 0.45, color: '#ff8a3a',
          });
        }
      } else {
        for (let k = 0; k < 4; k++) {
          const a = Math.random() * Math.PI * 2;
          state.particles.push({
            x: f.x, y: f.y, vx: Math.cos(a) * 25, vy: Math.sin(a) * 25 - 10,
            life: 0.35, maxLife: 0.35, color: '#888',
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

// ---- Anti-air (now world-coord turret-based) ----
export function updateAntiAir(dt) {
  const tracerRate = 5;        // beams/sec per AA when a drone is in its range
  for (const t of state.turrets) {
    if (t.type !== 'antiair' || !t.active) continue;
    for (const f of state.fleets) {
      if (f.kind !== 'drone' || f.owner === t.owner) continue;
      const d = Math.hypot(f.x - t.x, f.y - t.y);
      if (d > AA_RADIUS) continue;
      f.hp -= AA_DPS * dt;
      if (Math.random() < tracerRate * dt) {
        state.tracers.push({
          x1: t.x, y1: t.y, x2: f.x, y2: f.y,
          age: 0, maxAge: 0.18, color: COLOR[t.owner],
        });
      }
    }
  }
}

/** Tanks — anti-ground. Damage enemy GROUND fleets in range (creates the
 *  "death highway" effect on roads they cover) and slowly chip enemy turrets.
 *  Cannot target drones (that's AA's job). Lower DPS than AA, longer range. */
export function updateTanks(dt) {
  const tracerRate = 3;
  for (const t of state.turrets) {
    if (t.type !== 'tank' || !t.active) continue;
    // Damage enemy ground fleets in range — drones are skipped
    for (let i = state.fleets.length - 1; i >= 0; i--) {
      const f = state.fleets[i];
      if (f.owner === t.owner) continue;
      if (f.kind === 'drone') continue;        // tanks can't shoot air
      const d = Math.hypot(f.x - t.x, f.y - t.y);
      if (d > TANK_RADIUS) continue;
      f.units -= TANK_DPS * 0.6 * dt;
      if (f.units < 0.5) {
        addWreckBlockage(f);
        spawnBigExplosion(f.x, f.y, '#ff8a3a', 8);
        state.fleets.splice(i, 1);
        continue;
      }
      if (Math.random() < tracerRate * dt) {
        state.tracers.push({
          x1: t.x, y1: t.y, x2: f.x, y2: f.y,
          age: 0, maxAge: 0.22, color: COLOR[t.owner],
        });
      }
    }
    // Siege: chip enemy turrets within range (slow — primarily an anti-ground tool)
    for (const o of state.turrets) {
      if (o.owner === t.owner) continue;
      const d = Math.hypot(o.x - t.x, o.y - t.y);
      if (d > TANK_RADIUS) continue;
      o.hp -= TANK_DPS * 0.7 * dt;
      if (Math.random() < tracerRate * 0.4 * dt) {
        state.tracers.push({
          x1: t.x, y1: t.y, x2: o.x, y2: o.y,
          age: 0, maxAge: 0.22, color: COLOR[t.owner],
        });
      }
    }
  }
}

/** Cinematic "爆肥" explosion when a turret (esp. tank) dies. */
export function spawnBigExplosion(x, y, color = '#ff8a3a', n = 20) {
  for (let k = 0; k < n; k++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 80 + Math.random() * 160;
    state.particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.6 + Math.random() * 0.3, maxLife: 0.9,
      color: k % 3 === 0 ? '#ffe080' : color,
    });
  }
}

export function updateTracers(dt) {
  for (let i = state.tracers.length - 1; i >= 0; i--) {
    state.tracers[i].age += dt;
    if (state.tracers[i].age >= state.tracers[i].maxAge) state.tracers.splice(i, 1);
  }
}

// ---- Buildings tick: construction, factory production, decay, dead-turret cleanup ----
export function updateBuildings(dt) {
  // Per-turret update
  for (let i = state.turrets.length - 1; i >= 0; i--) {
    const t = state.turrets[i];
    if (t.hp <= 0) {
      spawnBigExplosion(t.x, t.y, t.type === 'tank' ? '#ffaa55' : '#ff8a3a',
                        t.type === 'tank' ? 32 : 18);
      state.turrets.splice(i, 1); continue;
    }
    // Construction
    if (!t.active) {
      if (t.engineers > 0) {
        t.progress += t.engineers * dt / t.total;
        if (t.progress >= 1.0) { t.progress = 1.0; t.active = true; }
      }
    } else {
      // Factory: produce drones, targeting enemy turrets first then nodes.
      // Picks RANDOMLY among the top-3 scoring targets so swarms split AA attention
      // instead of all dying to the same cluster.
      if (t.type === 'factory') {
        t.prodCooldown -= dt;
        if (t.prodCooldown <= 0) {
          t.prodCooldown = DF_PRODUCTION_T;
          const cands = [];
          // Enemy turrets first (high priority — they threaten our drones)
          for (const et of state.turrets) {
            if (et.owner === t.owner) continue;
            const d = Math.hypot(et.x - t.x, et.y - t.y);
            let score = 1500 / (d + 200);
            if (et.type === 'antiair') score *= 1.5;
            if (et.type === 'factory') score *= 1.8;  // kill the production source
            if (!et.active) score *= 2.0;
            cands.push({ score, target: { kind: 'turret', id: et.id, x: et.x, y: et.y } });
          }
          if (cands.length === 0) {
            // Fall back to enemy nodes
            for (const en of state.nodes) {
              if (en.owner === t.owner || en.owner === 'neutral') continue;
              const d = dist(t, en);
              const score = 800 / (d + 200);
              cands.push({ score, target: { kind: 'node', id: en.id, x: en.x, y: en.y } });
            }
          }
          if (cands.length) {
            cands.sort((a, b) => b.score - a.score);
            const top = cands.slice(0, Math.min(3, cands.length));
            const pick = top[Math.floor(Math.random() * top.length)];
            spawnDrone(t.x, t.y, t.owner, pick.target);
          }
        }
      }
    }
  }
  // Idle engineers (stationed at a node with no incomplete site nearby) clear blockage
  for (const n of state.nodes) {
    if (n.engineers > 0) {
      for (const j of state.adj.get(n.id) || []) {
        const e = getEdge(n.id, j);
        if (e && e.blockage > 0) {
          e.blockage = Math.max(0, e.blockage - ENG_CLEAR_RATE * dt * n.engineers);
        }
      }
    }
    if (n.flashBuild > 0) n.flashBuild -= dt * 1.5;
  }
  // Blockage natural decay
  for (const [, e] of state.edgeData) {
    e.blockage = Math.max(0, e.blockage - BLOCKAGE_DECAY * dt);
  }
}

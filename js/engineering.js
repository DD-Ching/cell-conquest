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
  NET_BUILD_TIME, NET_HP, NET_DAMAGE_MULT,
  TANK_BUILD_TIME, TANK_HP, TANK_RADIUS, TANK_DPS,
  DRONE_HP_AIR, DRONE_SPEED, DRONE_DAMAGE,
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
  for (const r of state.roads) state.edgeData.set(ekey(r.a, r.b), { blockage: 0 });
  state.turrets = [];
  state.placeMode = null;
  for (const n of state.nodes) {
    n.engineers = 0;
    n.flashBuild = 0;
  }
}

// ---- Build specs ----
const BUILD_SPECS = {
  antiair: { time: AA_BUILD_TIME,   hp: AA_HP },
  factory: { time: DF_BUILD_TIME,   hp: DF_HP },
  net:     { time: NET_BUILD_TIME,  hp: NET_HP },
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

// ---- Drone ----
export function spawnDrone(originX, originY, owner, target) {
  state.fleets.push({
    kind: 'drone', owner, units: 1,
    x: originX, y: originY,
    tx: target.x, ty: target.y,
    targetKind: target.kind,            // 'turret' | 'node'
    targetId:   target.id,
    hp: DRONE_HP_AIR, damage: DRONE_DAMAGE,
  });
}

/** Does the drone's stored target still exist? */
function droneTargetExists(drone) {
  if (drone.targetKind === 'turret') return state.turrets.some(t => t.id === drone.targetId);
  if (drone.targetKind === 'node')   return drone.targetId < state.nodes.length;
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

function droneHit(drone) {
  let target;
  if (drone.targetKind === 'turret') target = state.turrets.find(t => t.id === drone.targetId);
  else                                target = state.nodes[drone.targetId];
  if (!target) return false;             // already gone — no damage, no boom
  // Net protection
  let mult = 1.0;
  let netT = null;
  for (const t of state.turrets) {
    if (t.type !== 'net' || !t.active || t.owner !== target.owner) continue;
    const d = Math.hypot(t.x - drone.x, t.y - drone.y);
    if (d <= AA_RADIUS * 0.7) { netT = t; break; }
  }
  if (netT) {
    mult = NET_DAMAGE_MULT;
    netT.hp -= drone.damage * 0.4;
  }
  const dmg = drone.damage * mult;
  if (drone.targetKind === 'turret') {
    target.hp -= dmg;
  } else {
    target.units = Math.max(0, target.units - dmg * 0.3);
    if (target.engineers > 0 && Math.random() < 0.3) target.engineers--;
  }
  // No road wreckage from drone strikes — the wreck is at the node, not on a road.
  return true;
}

/** A vehicle (any non-drone fleet) dying on the road leaves a wreck on
 *  the segment it was traversing. Off-road / drone deaths produce nothing. */
export function addWreckBlockage(f) {
  if (f.kind === 'drone') return;
  if ((f.kind === 'deploy' || f.kind === 'assault') && f.offroad) return;
  if (!f.path || f.segIdx >= f.path.length - 1) return;
  const a = f.path[f.segIdx], b = f.path[f.segIdx + 1];
  const e = getEdge(a, b);
  if (e) e.blockage = Math.min(1, e.blockage + BLOCKAGE_PER_WRECK);
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
    // Target validation: drone shouldn't bomb empty space. If target died,
    // retarget to nearest enemy; if none, drone bails out silently.
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
    const dx = f.tx - f.x, dy = f.ty - f.y;
    const d = Math.hypot(dx, dy);
    if (d < 12) {
      // Last-chance check (target may have died this tick)
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
        // Target evaporated at the last moment — smoke puff, no boom
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
      // Factory: produce drones, targeting enemy turrets first then nodes
      if (t.type === 'factory') {
        t.prodCooldown -= dt;
        if (t.prodCooldown <= 0) {
          t.prodCooldown = DF_PRODUCTION_T;
          let best = null, bestScore = -Infinity;
          // Enemy turrets first (high priority — they threaten our drones)
          for (const et of state.turrets) {
            if (et.owner === t.owner) continue;
            const d = Math.hypot(et.x - t.x, et.y - t.y);
            let score = 1500 / (d + 200);
            if (et.type === 'antiair') score *= 1.5;
            if (!et.active) score *= 2.0;
            if (score > bestScore) { bestScore = score; best = { kind: 'turret', id: et.id, x: et.x, y: et.y }; }
          }
          // Otherwise nodes
          if (!best) {
            for (const en of state.nodes) {
              if (en.owner === t.owner || en.owner === 'neutral') continue;
              const d = dist(t, en);
              let score = 800 / (d + 200);
              if (score > bestScore) { bestScore = score; best = { kind: 'node', id: en.id, x: en.x, y: en.y }; }
            }
          }
          if (best) spawnDrone(t.x, t.y, t.owner, best);
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

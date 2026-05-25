// =====================================================
// Battle engineering — roads, blockage, engineers,
// buildings (anti-air, drone factory, drone net),
// drones (straight-line suicide attack).
//
// NB: this is a separate "subsystem" sitting alongside
// the existing fleet/node model — minimal coupling.
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
  DRONE_HP_AIR, DRONE_SPEED, DRONE_DAMAGE,
  BLOCKAGE_DECAY, BLOCKAGE_PER_WRECK,
} from './config.js';

// ---- Engineer speed re-exported so fleets.js can use it ----
export { ENG_SPEED } from './config.js';

// ---- Edge keys ----
export function ekey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
export function getEdge(a, b) { return state.edgeData.get(ekey(a, b)); }

/** Edge speed multiplier (0.2..1.0) based on blockage. */
export function edgeSpeedMul(a, b) {
  const e = getEdge(a, b);
  if (!e) return 1.0;
  return Math.max(0.2, 1.0 - e.blockage);
}

/** Reset engineering state for a new game. */
export function resetEngineering() {
  state.edgeData.clear();
  for (const r of state.roads) state.edgeData.set(ekey(r.a, r.b), { blockage: 0 });
  for (const n of state.nodes) {
    n.buildings = [];     // {type, progress(0..1), hp, hpMax, active, prodCooldown, total}
    n.engineers = 0;
    n.flashBuild = 0;
  }
}

const BUILD_SPECS = {
  antiair: { time: AA_BUILD_TIME, hp: AA_HP },
  factory: { time: DF_BUILD_TIME, hp: DF_HP },
  net:     { time: NET_BUILD_TIME, hp: NET_HP },
};

function nearestOwnSource(targetNode, owner, minUnits) {
  let best = null, bestDist = Infinity;
  for (const n of state.nodes) {
    if (n.owner !== owner || n.id === targetNode.id) continue;
    if (n.units < minUnits) continue;
    const d = dist(n, targetNode);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best;
}

/** Place a construction site on target and dispatch an engineer from nearest own node. */
export function orderBuild(targetNode, type, byOwner) {
  const spec = BUILD_SPECS[type];
  if (!spec) return false;
  if (targetNode.owner !== byOwner) return false;
  if (targetNode.buildings.some(b => b.type === type)) return false;
  const src = nearestOwnSource(targetNode, byOwner, ENG_COST + 5);
  if (!src) return false;
  targetNode.buildings.push({
    type, progress: 0, hp: spec.hp, hpMax: spec.hp,
    active: false, prodCooldown: 0, total: spec.time,
  });
  return dispatchEngineer(src, targetNode, byOwner);
}

export function dispatchEngineer(source, target, owner) {
  const path = findPath(source.id, target.id, owner);
  if (!path || path.length < 2) return false;
  source.units -= ENG_COST;
  state.fleets.push({
    kind: 'engineer', owner, units: 1, path,
    segIdx: 0, segTraveled: 0,
    x: source.x, y: source.y,
    hp: ENG_HP,
  });
  return true;
}

export function engineerArrived(f, target) {
  if (target.owner !== f.owner) return;        // wrong owner — engineer wasted
  target.engineers = (target.engineers || 0) + 1;
}

export function spawnDrone(factoryNode, targetNode) {
  state.fleets.push({
    kind: 'drone', owner: factoryNode.owner, units: 1,
    x: factoryNode.x, y: factoryNode.y,
    tx: targetNode.x, ty: targetNode.y,
    targetNodeId: targetNode.id,
    hp: DRONE_HP_AIR, damage: DRONE_DAMAGE,
  });
}

function droneHit(drone, target) {
  // Net protection on host node
  let mult = 1.0;
  const netB = target.buildings.find(b => b.type === 'net' && b.active);
  if (netB) {
    mult = NET_DAMAGE_MULT;
    netB.hp -= drone.damage * 0.4;
    if (netB.hp <= 0) target.buildings.splice(target.buildings.indexOf(netB), 1);
  }
  const dmg = drone.damage * mult;
  // Priority: damage a building (prefer in-progress site = high-value)
  const inProg = target.buildings.find(b => !b.active);
  const anyBld = inProg || target.buildings.find(b => b.type !== 'net');
  if (anyBld) {
    anyBld.hp -= dmg;
    if (anyBld.hp <= 0) {
      target.buildings.splice(target.buildings.indexOf(anyBld), 1);
      if (!anyBld.active) target.engineers = Math.max(0, (target.engineers || 0) - 1);
    }
  } else {
    target.units = Math.max(0, target.units - dmg * 0.3);
    if (target.engineers > 0 && Math.random() < 0.3) target.engineers--;
  }
  target.flash = Math.max(target.flash, 0.6);

  // Wreckage on a random adjacent road
  const nbrs = [...(state.adj.get(target.id) || [])];
  if (nbrs.length) {
    const j = nbrs[Math.floor(Math.random() * nbrs.length)];
    const e = getEdge(target.id, j);
    if (e) e.blockage = Math.min(1, e.blockage + BLOCKAGE_PER_WRECK);
  }
}

/** Update drone fleet straight-line motion, AA damage already pre-applied. */
export function updateDrones(dt) {
  for (let i = state.fleets.length - 1; i >= 0; i--) {
    const f = state.fleets[i];
    if (f.kind !== 'drone') continue;
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
    const dx = f.tx - f.x, dy = f.ty - f.y;
    const d = Math.hypot(dx, dy);
    if (d < 14) {
      const target = state.nodes[f.targetNodeId];
      if (target) droneHit(f, target);
      for (let k = 0; k < 12; k++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 60 + Math.random() * 60;
        state.particles.push({
          x: f.x, y: f.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 0.45, maxLife: 0.45, color: '#ff8a3a',
        });
      }
      state.fleets.splice(i, 1); continue;
    }
    const step = DRONE_SPEED * dt;
    f.x += (dx / d) * step;
    f.y += (dy / d) * step;
  }
}

/** Anti-air buildings fire at enemy drones in range. Damage stacks across overlapping
 *  AA — visualized as tracer beams. Multiple overlapping AAs → multiple beams per
 *  drone per second, making the saturation interception math visible to the player. */
export function updateAntiAir(dt) {
  const tracerRate = 5;        // beams/sec per AA when a drone is in its range
  for (const n of state.nodes) {
    for (const b of n.buildings) {
      if (b.type !== 'antiair' || !b.active) continue;
      for (const f of state.fleets) {
        if (f.kind !== 'drone' || f.owner === n.owner) continue;
        const d = Math.hypot(f.x - n.x, f.y - n.y);
        if (d > AA_RADIUS) continue;
        f.hp -= AA_DPS * dt;
        // Probabilistic tracer (independent per AA; overlapping → more beams)
        if (Math.random() < tracerRate * dt) {
          state.tracers.push({
            x1: n.x, y1: n.y, x2: f.x, y2: f.y,
            age: 0, maxAge: 0.18, color: COLOR[n.owner],
          });
        }
      }
    }
  }
}

/** Tracer fade. Called from main loop. */
export function updateTracers(dt) {
  for (let i = state.tracers.length - 1; i >= 0; i--) {
    state.tracers[i].age += dt;
    if (state.tracers[i].age >= state.tracers[i].maxAge) state.tracers.splice(i, 1);
  }
}

/** Construction progress, factory drone production, blockage decay. */
export function updateBuildings(dt) {
  for (const n of state.nodes) {
    // Engineers progress the first incomplete site at this node
    if (n.engineers > 0) {
      const site = n.buildings.find(b => !b.active);
      if (site) {
        site.progress += n.engineers * dt / site.total;
        if (site.progress >= 1.0) {
          site.progress = 1.0; site.active = true; n.flashBuild = 1;
        }
      } else {
        // Idle engineers clear adjacent blockage
        for (const j of state.adj.get(n.id) || []) {
          const e = getEdge(n.id, j);
          if (e && e.blockage > 0) {
            e.blockage = Math.max(0, e.blockage - ENG_CLEAR_RATE * dt * n.engineers);
          }
        }
      }
    }
    // Drone factory production
    for (const b of n.buildings) {
      if (b.type !== 'factory' || !b.active) continue;
      b.prodCooldown -= dt;
      if (b.prodCooldown > 0) continue;
      b.prodCooldown = DF_PRODUCTION_T;
      const targets = state.nodes.filter(en => en.owner !== n.owner && en.owner !== 'neutral');
      if (!targets.length) continue;
      let best = null, bestScore = -Infinity;
      for (const en of targets) {
        const d = dist(n, en);
        let score = 800 / (d + 200);
        if (en.buildings.some(b => !b.active)) score *= 3;
        if (en.buildings.some(b => b.type === 'antiair' && b.active)) score *= 0.3;
        if (score > bestScore) { bestScore = score; best = en; }
      }
      if (best) spawnDrone(n, best);
    }
    if (n.flashBuild > 0) n.flashBuild -= dt * 1.5;
  }
  // Blockage natural decay
  for (const [, e] of state.edgeData) {
    e.blockage = Math.max(0, e.blockage - BLOCKAGE_DECAY * dt);
  }
}

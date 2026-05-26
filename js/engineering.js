// =====================================================
// Engineering — buildings, edges, and engineer behavior.
//
//   • Edge data (road blockage, drone nets)
//   • Turret placement (AA / Tank / Factory / Artillery via engineer dispatch)
//   • Per-edge drone-net placement
//   • Engineer arrival callbacks (at a turret site / at a net edge)
//   • Wreckage + big-explosion VFX (shared utilities)
//   • Building tick (construction progress, factory production, decay, cleanup)
//
// Combat (AA / tank / artillery / shells) lives in `combat.js`.
// Drone behavior, factory drone production, and Hold-Fire stockpile
// release live in `drones.js`.
// =====================================================
import { state } from './state.js';
import { dist } from './util.js';
import { findPath } from './world.js';
import {
  WORLD_W, WORLD_H,
  ENG_HP, ENG_CLEAR_RATE, ENG_COST,
  AA_BUILD_TIME, AA_HP, AA_RADIUS,
  DF_BUILD_TIME, DF_HP, DF_PRODUCTION_T, FACTORY_MAX_STOCKPILE,
  TANK_BUILD_TIME, TANK_HP, TANK_RADIUS,
  ARTILLERY_BUILD_TIME, ARTILLERY_HP, ARTILLERY_RANGE,
  NET_LEVEL_MAX, NET_CHARGES_LEVEL, WRECK_CLEAR_PER_ENG,
  BLOCKAGE_DECAY, BLOCKAGE_PER_WRECK,
} from './config.js';
import { launchOneDroneFrom } from './drones.js';

export { ENG_SPEED } from './config.js';

// =====================================================
// Edges (road blockage + drone nets)
// =====================================================
export function ekey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
export function getEdge(a, b) { return state.edgeData.get(ekey(a, b)); }
export function edgeSpeedMul(a, b) {
  const e = getEdge(a, b);
  if (!e) return 1.0;
  return Math.max(0.2, 1.0 - e.blockage);
}

// =====================================================
// Reset
// =====================================================
export function resetEngineering() {
  state.edgeData.clear();
  for (const r of state.roads) {
    state.edgeData.set(ekey(r.a, r.b), {
      blockage: 0,
      netLevel: 0, netCharges: 0, netOwner: null,
    });
  }
  state.turrets = [];
  state.shells = [];
  state.scorches = [];
  // Wipe the permanent ground-scorch layer — fresh map for a new game.
  if (state.groundScorchCtx) {
    state.groundScorchCtx.clearRect(0, 0, state.groundScorch.width, state.groundScorch.height);
  }
  state.placeMode = null;
  state.holdFire = false;
  state.salvoTarget = null;
  state._nextFleetId = 1;
  for (const n of state.nodes) {
    n.engineers = 0;
    n.flashBuild = 0;
  }
}

// =====================================================
// Turret placement
// =====================================================
const BUILD_SPECS = {
  antiair:   { time: AA_BUILD_TIME,        hp: AA_HP },
  factory:   { time: DF_BUILD_TIME,        hp: DF_HP },
  tank:      { time: TANK_BUILD_TIME,      hp: TANK_HP },
  artillery: { time: ARTILLERY_BUILD_TIME, hp: ARTILLERY_HP },
};

/** Visible turret range — used for AA, tank, and artillery rings. */
export const TURRET_RANGES = {
  antiair:   AA_RADIUS,
  tank:      TANK_RADIUS,
  artillery: ARTILLERY_RANGE,
};

let nextTurretId = 1;

/** Place a turret at world point (x,y). Finds nearest own road anchor and
 *  dispatches an engineer that walks the roads then off-roads to (x,y). */
export function placeTurretAt(x, y, type, byOwner) {
  const spec = BUILD_SPECS[type];
  if (!spec) return false;
  let source = null, srcDist = Infinity;
  for (const n of state.nodes) {
    if (n.owner !== byOwner) continue;
    if (n.units < ENG_COST + 5) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < srcDist) { srcDist = d; source = n; }
  }
  if (!source) return false;
  let anchor = source, anchorDist = Math.hypot(source.x - x, source.y - y);
  for (const n of state.nodes) {
    if (n.owner !== byOwner) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < anchorDist) { anchorDist = d; anchor = n; }
  }
  const path = (source.id === anchor.id) ? [source.id] : findPath(source.id, anchor.id, byOwner);
  if (!path || path.length < 1) return false;
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

/** Place a drone-net engineer on a specific road segment. Nets are
 *  ownership-agnostic terrain infrastructure (like wreckage). */
export function placeNetOnEdge(roadA, roadB, byOwner) {
  const edge = getEdge(roadA, roadB);
  if (!edge) return false;
  let source = null, srcD = Infinity;
  for (const n of state.nodes) {
    if (n.owner !== byOwner) continue;
    if (n.units < ENG_COST + 5) continue;
    const d = Math.hypot(n.x - state.nodes[roadA].x, n.y - state.nodes[roadA].y) +
              Math.hypot(n.x - state.nodes[roadB].x, n.y - state.nodes[roadB].y);
    if (d < srcD) { srcD = d; source = n; }
  }
  if (!source) return false;
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
 *  for an engineer whose original target is already maxed. */
export function findNetWorkRedirect(byOwner, fromX, fromY) {
  let best = null, bestD = Infinity;
  for (const r of state.roads) {
    const e = state.edgeData.get(ekey(r.a, r.b));
    if (!e) continue;
    if (e.blockage < 0.15 && e.netLevel >= NET_LEVEL_MAX) continue;
    const aN = state.nodes[r.a], bN = state.nodes[r.b];
    if (aN.owner !== byOwner && bN.owner !== byOwner) continue;
    const mx = (aN.x + bN.x) / 2, my = (aN.y + bN.y) / 2;
    const d = Math.hypot(fromX - mx, fromY - my);
    if (d < bestD) { bestD = d; best = { a: r.a, b: r.b }; }
  }
  return best;
}

// =====================================================
// Engineer arrival callbacks (called from fleets.js)
// =====================================================
export function engineerEnterOffroad(f) {
  f.offroad = true;
}

export function engineerArrivedAtTurret(f) {
  const t = state.turrets.find(t => t.id === f.targetTurretId);
  if (!t || t.owner !== f.owner) return;
  t.engineers += 1;
}

/** Net engineer arrival. Performs ONE action:
 *  - If the edge has heavy wreckage (blockage >= 0.15), clear it.
 *  - Else if net not maxed, raise net level by 1 and refill charges.
 *  - Else (nothing to do here): redirect to nearest road that needs work.
 * Nets are faction-agnostic: any engineer can upgrade any net. */
export function engineerArrivedAtNetEdge(f) {
  const edge = getEdge(f.targetEdgeA, f.targetEdgeB);
  if (!edge) return { consumed: true };
  if (edge.blockage >= 0.15) {
    edge.blockage = Math.max(0, edge.blockage - WRECK_CLEAR_PER_ENG);
    flashEdgeWork(f.targetEdgeA, f.targetEdgeB, '#ffd066');
    return { consumed: true };
  }
  if (edge.netLevel < NET_LEVEL_MAX) {
    edge.netLevel += 1;
    edge.netCharges = NET_CHARGES_LEVEL[edge.netLevel];
    flashEdgeWork(f.targetEdgeA, f.targetEdgeB, '#e8d6a8');
    return { consumed: true };
  }
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

// =====================================================
// Wreckage + VFX (shared with combat.js / drones.js)
// =====================================================
/** A vehicle (any non-drone fleet) dying on the road. Off-road / drone deaths
 *  produce nothing. If the segment has an active drone-net, the net "absorbs"
 *  the damage instead — one death = -20 charges, dropping the level as it
 *  drains. Only after the net is fully gone does wreckage start to pile up. */
export function addWreckBlockage(f) {
  if (f.kind === 'drone') return;
  if ((f.kind === 'deploy' || f.kind === 'assault') && f.offroad) return;
  if (!f.path || f.segIdx >= f.path.length - 1) return;
  const a = f.path[f.segIdx], b = f.path[f.segIdx + 1];
  const e = getEdge(a, b);
  if (!e) return;
  if (e.netLevel > 0) {
    e.netCharges -= NET_CHARGES_LEVEL[1];
    if (e.netCharges <= 0) {
      e.netLevel = 0; e.netCharges = 0;
    } else if (e.netCharges <= NET_CHARGES_LEVEL[1]) e.netLevel = 1;
    else if (e.netCharges <= NET_CHARGES_LEVEL[2]) e.netLevel = 2;
    return;
  }
  e.blockage = Math.min(1, e.blockage + BLOCKAGE_PER_WRECK);
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

// =====================================================
// Scorch marks (殘骸 / 灰燼 / 燃燒) — cosmetic-only.
//
// Two layers, both rendered beneath roads / units:
//   • state.scorches[]          — ACTIVE marks, burning + emitting embers + glow.
//                                 Capped so explosive moments don't unbound the array.
//   • state.groundScorch        — OFFSCREEN canvas of "settled" marks that have
//                                 already finished burning. Memory is fixed
//                                 (≈ 4 MB at half-res) regardless of how many
//                                 burns happen — old marks bake into pixels,
//                                 not JS objects.
//
// Lifecycle: spawn → burn (with active smudge + flicker + embers) → at maxAge,
// the same smudge is painted onto groundScorch and the array entry is dropped.
// Since the active smudge alpha is constant (not faded toward 0), the handoff
// from "active layer" to "baked layer" is visually seamless.
//
// NEVER queried by AI, pathing, or collision: pure visual texture.
// =====================================================
const MAX_ACTIVE_SCORCHES = 80;
const GROUND_SCORCH_SCALE = 0.5;       // half-resolution offscreen → ~4 MB

function ensureGroundScorch() {
  if (state.groundScorch) return;
  const c = document.createElement('canvas');
  c.width  = Math.ceil(WORLD_W * GROUND_SCORCH_SCALE);
  c.height = Math.ceil(WORLD_H * GROUND_SCORCH_SCALE);
  state.groundScorch = c;
  state.groundScorchCtx = c.getContext('2d');
}

/** Paint `s` permanently onto the ground canvas. Same gradient as the active
 *  render so there's no visual pop when the active entry is removed. */
function bakeScorchToGround(s) {
  ensureGroundScorch();
  const gctx = state.groundScorchCtx;
  const k = GROUND_SCORCH_SCALE;
  gctx.save();
  gctx.translate(s.x * k, s.y * k);
  gctx.rotate(s.rot);
  const r = s.r * k;
  const g = gctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0,    'rgba(8, 4, 2, 0.78)');
  g.addColorStop(0.55, 'rgba(22, 11, 5, 0.48)');
  g.addColorStop(1,    'rgba(60, 30, 15, 0)');
  gctx.fillStyle = g;
  gctx.beginPath();
  gctx.ellipse(0, 0, r, r * 0.72, 0, 0, Math.PI * 2);
  gctx.fill();
  gctx.restore();
}

export function spawnScorch(x, y, kind = 'small') {
  let r, life;
  if (kind === 'big')         { r = 34 + Math.random() * 16; life = 18; }
  else if (kind === 'medium') { r = 18 + Math.random() *  8; life = 12; }
  else                        { r = 10 + Math.random() *  5; life =  8; }
  state.scorches.push({
    x, y, r,
    age: 0, maxAge: life,
    kind,
    sparkAcc: 0,
    rot: Math.random() * Math.PI,
  });
  // Active-array safety cap — bake any overflow straight to ground so we never
  // visually lose a burn mark even if a thousand things die in one frame.
  while (state.scorches.length > MAX_ACTIVE_SCORCHES) {
    bakeScorchToGround(state.scorches.shift());
  }
}

export function updateScorches(dt) {
  for (let i = state.scorches.length - 1; i >= 0; i--) {
    const s = state.scorches[i];
    s.age += dt;
    if (s.age >= s.maxAge) {
      // Burn phase over — settle the mark into the permanent ground layer
      // and drop the JS object so the active array stays small.
      bakeScorchToGround(s);
      state.scorches.splice(i, 1);
      continue;
    }
    // Embers + ash during the burning phase (first 65% of life)
    const burnFrac = 1 - s.age / (s.maxAge * 0.65);
    if (burnFrac <= 0) continue;
    const rate = (s.kind === 'big' ? 14 : s.kind === 'medium' ? 7 : 3) * burnFrac;
    s.sparkAcc += rate * dt;
    while (s.sparkAcc >= 1) {
      s.sparkAcc -= 1;
      const jx = (Math.random() - 0.5) * s.r * 1.3;
      const jy = (Math.random() - 0.5) * s.r * 0.7;
      if (Math.random() < 0.6) {
        // Ember — small orange/yellow spark drifting up
        state.particles.push({
          x: s.x + jx, y: s.y + jy,
          vx: (Math.random() - 0.5) * 14,
          vy: -22 - Math.random() * 26,
          life: 0.6 + Math.random() * 0.4, maxLife: 1.0,
          color: Math.random() < 0.3 ? '#ffe6a0' : '#ff8a3a',
        });
      } else {
        // Smoke / ash — dim gray, slower drift
        state.particles.push({
          x: s.x + jx, y: s.y + jy,
          vx: (Math.random() - 0.5) * 6,
          vy: -10 - Math.random() * 10,
          life: 1.0 + Math.random() * 0.7, maxLife: 1.7,
          color: '#8a7864',
        });
      }
    }
  }
}

// =====================================================
// Buildings tick — construction, factory production, decay, dead-turret cleanup
// =====================================================
export function updateBuildings(dt) {
  for (let i = state.turrets.length - 1; i >= 0; i--) {
    const t = state.turrets[i];
    if (t.hp <= 0) {
      spawnBigExplosion(t.x, t.y, t.type === 'tank' ? '#ffaa55' : '#ff8a3a',
                        t.type === 'tank' ? 32 : 18);
      spawnScorch(t.x, t.y, 'big');
      state.turrets.splice(i, 1); continue;
    }
    if (!t.active) {
      // Construction
      if (t.engineers > 0) {
        t.progress += t.engineers * dt / t.total;
        if (t.progress >= 1.0) { t.progress = 1.0; t.active = true; }
      }
    } else {
      // Factory: produce drones. Player factories accumulate while Hold-Fire
      // is on instead of launching; release happens via releasePlayerStockpile().
      if (t.type === 'factory') {
        if (t.dronesReady === undefined) t.dronesReady = 0;
        t.prodCooldown -= dt;
        if (t.prodCooldown <= 0) {
          t.prodCooldown = DF_PRODUCTION_T;
          if (t.owner === 'player' && state.holdFire && t.dronesReady < FACTORY_MAX_STOCKPILE) {
            t.dronesReady += 1;
          } else {
            launchOneDroneFrom(t);
          }
        }
      }
    }
  }
  // Idle engineers stationed at a node clear blockage on connected edges
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

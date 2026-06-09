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
import { findPath, catchUpAllNodes } from './world.js';
import {
  ENG_HP, ENG_CLEAR_RATE, ENG_COST,
  AA_BUILD_TIME, AA_HP, AA_RADIUS,
  DF_BUILD_TIME, DF_HP,
  TANK_BUILD_TIME, TANK_HP, TANK_RADIUS,
  ARTILLERY_BUILD_TIME, ARTILLERY_HP, ARTILLERY_RANGE,
  NET_LEVEL_MAX, NET_CHARGES_LEVEL, NET_ENG_WRECK_CLEAR,
  WRECK_PILE_HP_INIT, WRECK_MAX_PER_EDGE, TANK_WRECK_HP_MUL,
  TRACER_CAP,
} from './config.js';
import { sfxExplosion } from './audio.js';
import { isAlly } from './alliance.js';
// Cosmetic scorch-mark system lives in its own sibling now (this file defends
// the buildings/edges/engineer boundary). updateBuildings still spawns a big
// scorch when a turret dies, so we import it back; the public surface is kept
// intact via the re-export below so no importer of engineering.js changes.
import { spawnScorch } from './scorch.js';

export { ENG_SPEED } from './config.js';
export { spawnScorch, updateScorches } from './scorch.js';

// =====================================================
// Edges (wreck piles + drone nets)
// =====================================================
export function ekey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
export function getEdge(a, b) { return state.edgeData.get(ekey(a, b)); }
/** Visual "blockage" 0..1 for road-darkening purposes — derived from pile count.
 *  No longer affects movement speed (that's now physical: detour off centerline). */
export function edgeVisualBlockage(e) {
  if (!e || !e.wrecks) return 0;
  return Math.min(1, e.wrecks.length * 0.18);
}

// =====================================================
// Reset
// =====================================================
export function resetEngineering() {
  state.edgeData.clear();
  for (const r of state.roads) {
    state.edgeData.set(ekey(r.a, r.b), {
      wrecks: [],
      netLevel: 0, netCharges: 0, netOwner: null,
    });
  }
  state.turrets = [];
  state._turretCacheDirty = true;       // turret set reset → caches stale next tick
  state.shells = [];
  state.scorches = [];
  state.turretById.clear();
  state.turretsByOwner.clear();
  state.turretsByType.clear();
  state.turretGrid.clear();
  state.fleetById.clear();
  state.droneGrid.clear();
  state.groundFleetGrid.clear();
  state.droneCountByOwner.clear();
  // Wipe the permanent ground-scorch layer — fresh map for a new game.
  if (state.groundScorchCtx) {
    state.groundScorchCtx.clearRect(0, 0, state.groundScorch.width, state.groundScorch.height);
  }
  state.placeMode = null;
  state.holdFire = false;
  state.salvoTarget = null;
  state.aiHoldFire = {};
  state.aiSalvoT0 = {};
  state.aiSalvoTarget = {};
  state.aiFocus = {};
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

/** Visible turret range — used for AA and artillery rings. The 'tank' building
 *  is a FACTORY now (it rolls out mobile tanks, see tanks.js) and has no firing
 *  range of its own, so it gets no range ring. */
export const TURRET_RANGES = {
  antiair:   AA_RADIUS,
  artillery: ARTILLERY_RANGE,
};

let nextTurretId = 1;

/** Place a turret at world point (x,y). Finds nearest own road anchor and
 *  dispatches an engineer that walks the roads then off-roads to (x,y). */
export function placeTurretAt(x, y, type, byOwner) {
  const spec = BUILD_SPECS[type];
  if (!spec) return false;
  // Campaign gating: a level unlocks a specific toolset, and NO owner — player
  // OR DDCHING — may build a type outside it. The player is also blocked at the
  // input layer, but the AI calls placeTurretAt directly, so THIS is what stops
  // "the enemy has tanks on the air/flak level". Outside a campaign
  // state.tutorial is null → unrestricted normal play.
  if (state.tutorial && state.tutorial.allowedBuilds && !state.tutorial.allowedBuilds.has(type)) return false;
  // Lazy regen: walk the world fresh so the source-candidate test below
  // sees current unit counts. Cheap (O(N), called only on placement).
  catchUpAllNodes();
  // Single pass: track BOTH the nearest own node (anchor — start of the
  // off-road final leg) AND the nearest own node with enough units to pay
  // ENG_COST (source — where the engineer fleet is dispatched from). They
  // can be the same node but often aren't on contested fronts.
  // Source/anchor can be ANY allied node, not just byOwner's own — the player
  // and the Lieutenant (ally1) share one army, so a player-placed building
  // draws its engineer from the nearest ALLIED base (incl. the underlined
  // Lieutenant nodes) rather than insisting on a far-off purely-player node.
  // (For AI owners this is a no-op: they have no allies, so isAlly == own.)
  let source = null, srcD2 = Infinity;
  let anchor = null, anchorD2 = Infinity;
  for (const n of state.nodes) {
    if (!isAlly(n.owner, byOwner)) continue;
    const dx = n.x - x, dy = n.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < anchorD2) { anchorD2 = d2; anchor = n; }
    if (n.units >= ENG_COST + 5 && d2 < srcD2) { srcD2 = d2; source = n; }
  }
  if (!source || !anchor) return false;
  const path = (source.id === anchor.id) ? [source.id] : findPath(source.id, anchor.id, byOwner);
  if (!path || path.length < 1) return false;
  const turret = {
    id: nextTurretId++,
    owner: byOwner, type, x, y,
    hp: spec.hp, hpMax: spec.hp,
    progress: 0, active: false,
    total: spec.time, prodCooldown: 0,
    engineers: 0,
    // The site doesn't physically exist yet — it's just a marker on the
    // ground where the engineer is heading. Drones / assaults skip it until
    // the engineer arrives and construction actually begins. (Cleared in
    // engineerArrivedAtTurret.) Stops the "drones bomb empty dirt patch
    // before the engineer gets there" exploit.
    pendingEngineer: true,
  };
  state.turrets.push(turret);
  state._turretCacheDirty = true;       // turret added → rebuild caches next tick
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
  catchUpAllNodes();                         // fresh units count for source test
  // Allied sourcing (see placeTurretAt): player + Lieutenant share construction.
  let source = null, srcD = Infinity;
  for (const n of state.nodes) {
    if (!isAlly(n.owner, byOwner)) continue;
    if (n.units < ENG_COST + 5) continue;
    const d = Math.hypot(n.x - state.nodes[roadA].x, n.y - state.nodes[roadA].y) +
              Math.hypot(n.x - state.nodes[roadB].x, n.y - state.nodes[roadB].y);
    if (d < srcD) { srcD = d; source = n; }
  }
  if (!source) return false;
  const aN = state.nodes[roadA], bN = state.nodes[roadB];
  let anchor = null;
  if (isAlly(aN.owner, byOwner) && isAlly(bN.owner, byOwner)) {
    anchor = (Math.hypot(source.x - aN.x, source.y - aN.y) <
              Math.hypot(source.x - bN.x, source.y - bN.y)) ? aN : bN;
  } else if (isAlly(aN.owner, byOwner)) anchor = aN;
  else if (isAlly(bN.owner, byOwner)) anchor = bN;
  if (!anchor) return false;
  const path = (source.id === anchor.id) ? [source.id] : findPath(source.id, anchor.id, byOwner);
  if (!path || path.length < 1) return false;
  // The net engineer rides ROADS to an ENDPOINT of the target edge and deploys
  // there — the net covers the whole edge regardless of where on it the engineer
  // stands (engineerArrivedAtNetEdge keys on the edge, not the position). Aiming
  // the final leg at the anchor NODE (not the edge midpoint) means the off-road
  // dash is ~zero: no more "engineer drives across open dirt to the middle of the
  // map to plant a net". Any vehicle that CAN use roads now does.
  source.units -= ENG_COST;
  state.fleets.push({
    _id: state._nextFleetId++,
    kind: 'deploy', owner: byOwner, units: 1, path,
    segIdx: 0, segTraveled: 0,
    x: source.x, y: source.y,
    hp: ENG_HP,
    finalX: anchor.x, finalY: anchor.y,
    targetEdgeA: roadA, targetEdgeB: roadB,
    offroad: false,
  });
  return true;
}

/** Find a nearby road that still needs work (wreck piles to clear or net to upgrade)
 *  for an engineer whose original target is already done. Internal helper —
 *  only consumed by engineerArrivedAtNetEdge. */
function findNetWorkRedirect(byOwner, fromX, fromY) {
  let best = null, bestD = Infinity;
  for (const r of state.roads) {
    const e = state.edgeData.get(ekey(r.a, r.b));
    if (!e) continue;
    const hasWrecks = e.wrecks && e.wrecks.length > 0;
    if (!hasWrecks && e.netLevel >= NET_LEVEL_MAX) continue;
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
export function engineerArrivedAtTurret(f) {
  const t = state.turretById.get(f.targetTurretId);
  if (!t || t.owner !== f.owner) return;
  t.engineers += 1;
  // Engineer has physically arrived — site is now real and attackable.
  t.pendingEngineer = false;
}

/** Net engineer arrival. Performs ONE action:
 *  - If the edge has wreck piles, physically remove up to NET_ENG_WRECK_CLEAR
 *    of them (instantly — the engineer is here to do that job).
 *  - Else if net not maxed, raise net level by 1 and refill charges.
 *  - Else (nothing to do here): redirect to nearest road that needs work.
 *  Nets are faction-agnostic: any engineer can clear / upgrade any edge. */
export function engineerArrivedAtNetEdge(f) {
  const edge = getEdge(f.targetEdgeA, f.targetEdgeB);
  if (!edge) return { consumed: true };
  if (edge.wrecks && edge.wrecks.length > 0) {
    const n = Math.min(NET_ENG_WRECK_CLEAR, edge.wrecks.length);
    edge.wrecks.splice(0, n);    // shove the n oldest piles aside
    flashEdgeWork(f.targetEdgeA, f.targetEdgeB, '#ffd066');
    // The engineer SURVIVES — clearing pushes wreckage aside, it doesn't consume
    // the engineer. Keep working: stay on THIS edge while it's still clogged,
    // else move to the next road that needs it. Only vanish when nothing's left.
    const more = (edge.wrecks.length > 0)
      ? { a: f.targetEdgeA, b: f.targetEdgeB }
      : findNetWorkRedirect(f.owner, f.x, f.y);
    return more ? { consumed: false, redirect: more } : { consumed: true };
  }
  if (edge.netLevel < NET_LEVEL_MAX) {
    edge.netLevel += 1;
    edge.netCharges = NET_CHARGES_LEVEL[edge.netLevel];
    flashEdgeWork(f.targetEdgeA, f.targetEdgeB, '#e8d6a8');
    // Likewise survive a net-raise and roll on to the next job if there is one.
    const more = findNetWorkRedirect(f.owner, f.x, f.y);
    return more ? { consumed: false, redirect: more } : { consumed: true };
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
      life: 0.5, maxLife: 0.5, color, kind: 'impact',
    });
  }
}

// =====================================================
// Wreckage + VFX (shared with combat.js / drones.js)
// =====================================================
/** A vehicle (any non-drone fleet) dying on the road. Off-road / drone deaths
 *  produce nothing. If the segment has an active drone-net, the net "absorbs"
 *  the damage instead — one death = -20 charges, dropping the level as it
 *  drains. Only after the net is fully gone does an actual wreck pile spawn
 *  at the vehicle's exact death position.
 *
 *  (Kept exported as `addWreckBlockage` for back-compat with combat.js / drones.js
 *  call sites — internally creates a physical pile instead of bumping an
 *  abstract blockage counter.) */
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
  // Physical pile at the death position. f.x/f.y is already the fleet's current
  // world position on the road (or near it, if it was mid-detour).
  //
  // A TANK dying on the road is a heavy hulk ("死亡公路"): its pile spawns with
  // TANK_WRECK_HP_MUL× the HP of a normal vehicle wreck, so engineers need ~6×
  // the time to clear it and the road stays blocked far longer. The `heavy` flag
  // is carried so the renderer can draw a bigger hulk.
  const heavy = f.kind === 'tank';
  const hp0 = heavy ? WRECK_PILE_HP_INIT * TANK_WRECK_HP_MUL : WRECK_PILE_HP_INIT;
  if (e.wrecks.length >= WRECK_MAX_PER_EDGE) {
    // Edge is already saturated — coalesce this death into the nearest existing
    // pile instead of growing the array. Keeps the detour scan bounded even
    // on a road that gets pummeled in a long battle.
    let bestIdx = 0, bestD2 = Infinity;
    for (let k = 0; k < e.wrecks.length; k++) {
      const w = e.wrecks[k];
      const dx = w.x - f.x, dy = w.y - f.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = k; }
    }
    const w = e.wrecks[bestIdx];
    // Non-heavy keeps the original 2×-hpMax growth cap; a heavy hulk is allowed
    // to add its full pool so the roadblock genuinely persists.
    const cap = heavy ? w.hpMax + hp0 : w.hpMax * 2;
    w.hp    = Math.min(cap, w.hp + hp0);
    w.hpMax = Math.max(w.hpMax, w.hp);
    if (heavy) w.heavy = true;
    return;
  }
  e.wrecks.push({
    x: f.x, y: f.y,
    hp: hp0, hpMax: hp0,
    rot: Math.random() * Math.PI,
    heavy,
  });
}

/** Cinematic "爆肥" explosion when a turret (esp. tank) dies. */
export function spawnBigExplosion(x, y, color = '#ff8a3a', n = 20) {
  sfxExplosion(x, y, n / 20);            // spatialised boom (no-op if audio off/muted)
  for (let k = 0; k < n; k++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 80 + Math.random() * 160;
    state.particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.6 + Math.random() * 0.3, maxLife: 0.9,
      color: k % 3 === 0 ? '#ffe080' : color,
      kind: 'explosion',
    });
  }
}

export function updateTracers(dt) {
  // FIFO budget: AA / tank ticks emit a tracer per kill-chance roll, which
  // can spike high in a swarm fight. Cap here, not at spawn, so combat
  // tuning doesn't have to care. Front-trim is safe because the loop
  // iterates from the end — splicing index 0 doesn't move anything we
  // haven't visited yet. Oldest tracers are also the most faded, so they
  // are the least missed visually.
  if (state.tracers.length > TRACER_CAP) {
    state.tracers.splice(0, state.tracers.length - TRACER_CAP);
  }
  for (let i = state.tracers.length - 1; i >= 0; i--) {
    state.tracers[i].age += dt;
    if (state.tracers[i].age >= state.tracers[i].maxAge) state.tracers.splice(i, 1);
  }
}

// =====================================================
// Buildings tick — construction, factory production, decay, dead-turret cleanup
// =====================================================
export function updateBuildings(dt) {
  // NOTE: factory drone production moved OUT of this per-sub-step loop into
  // drones.runFactoryProduction (called once per frame from main.js). It's the
  // single authority for build/hold/launch across all owners — see the big
  // header comment there. This loop now only handles construction progress +
  // dead-turret cleanup, which DO belong per-sub-step.
  for (let i = state.turrets.length - 1; i >= 0; i--) {
    const t = state.turrets[i];
    if (t.hp <= 0) {
      spawnBigExplosion(t.x, t.y, t.type === 'tank' ? '#ffaa55' : '#ff8a3a',
                        t.type === 'tank' ? 32 : 18);
      spawnScorch(t.x, t.y, 'big');
      state.turrets.splice(i, 1); state._turretCacheDirty = true; continue;
    }
    if (!t.active) {
      // Construction
      if (t.engineers > 0) {
        t.progress += t.engineers * dt / t.total;
        if (t.progress >= 1.0) { t.progress = 1.0; t.active = true; }
      }
    }
  }
  // Idle engineers stationed at a node chip away at the nearest wreck pile on
  // each connected edge. When a pile's hp hits zero it physically disappears
  // (removed from the edge.wrecks array) so traffic flows freely past it again.
  for (const n of state.nodes) {
    if (n.engineers > 0) {
      const chip = ENG_CLEAR_RATE * dt * n.engineers;
      for (const j of state.adj.get(n.id) || []) {
        const e = getEdge(n.id, j);
        if (!e || !e.wrecks || e.wrecks.length === 0) continue;
        // Pick the pile closest to THIS node (engineers work outward from base)
        let bestIdx = -1, bestD2 = Infinity;
        for (let k = 0; k < e.wrecks.length; k++) {
          const w = e.wrecks[k];
          const dx = w.x - n.x, dy = w.y - n.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; bestIdx = k; }
        }
        if (bestIdx >= 0) {
          const w = e.wrecks[bestIdx];
          w.hp -= chip;
          if (w.hp <= 0) e.wrecks.splice(bestIdx, 1);
        }
      }
    }
    if (n.flashBuild > 0) n.flashBuild -= dt * 1.5;
  }
}

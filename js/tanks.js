// =====================================================
// Mobile tanks. The 'tank' BUILDING is now a tank FACTORY — a static depot that
// rolls out mobile tank UNITS (ground fleets, kind:'tank'). This module owns the
// tank's whole life:
//
//   • runTankProduction(dt)  — once per frame: each active tank factory emits a
//                              tank (under a per-owner cap) aimed at the nearest
//                              reachable non-allied node.
//   • updateGroundTanks(dt)  — per sub-step: en-route weapons (gun down enemy
//                              ground fleets, siege enemy turrets) + the arrival
//                              bombard-siege (chip a node's garrison, take
//                              retaliation, then — once the garrison is SUPPRESSED
//                              to TANK_SUPPRESS_UNITS — advance to the next
//                              frontier node). Tanks NEVER capture: flipping the
//                              node is infantry's job (send a troop column behind).
//   • beginTankSiege(f,node) — called from fleets.simulateFleets when a tank's
//                              road path completes (parks it for the siege).
//
// MOVEMENT is delegated to fleets.simulateFleets — tanks are ordinary path fleets,
// so they inherit wreck-detour + curved-road rendering for free; this module only
// special-cases their speed/arrival via the hook above. A tank's `units` field IS
// its HP pool, so every existing unit-damage path (drone hunt, artillery AOE,
// enemy-tank fire) chips it, and a tank that dies ON A ROAD leaves a 6×-HP
// "death-road" hulk (engineering.addWreckBlockage keys on kind:'tank').
//
// No import cycle: fleets.js → tanks.js (beginTankSiege only); tanks.js never
// imports fleets.js.
// =====================================================
import { state } from './state.js';
import {
  TANK_FACTORY_PRODUCTION_T, TANK_CAP_PER_FACTORY, TANK_UNIT_HP,
  TANK_UNIT_RANGE, TANK_UNIT_DPS_FLEET, TANK_UNIT_DPS_TURRET, TANK_UNIT_DPS_NODE,
  TANK_NODE_RETALIATE, TANK_SUPPRESS_UNITS, TANK_SIEGE_RECHECK_T,
} from './config.js';
import { findPath, catchUpRegen } from './world.js';
import { isAlly } from './alliance.js';
import { COLOR } from './factions.js';
import { addWreckBlockage, spawnBigExplosion, spawnScorch } from './engineering.js';
import { isWasmReady, wasmTankDamageFleets } from './wasm-bridge.js';

const GRID_CELL = 250;
const TANK_R2 = TANK_UNIT_RANGE * TANK_UNIT_RANGE;

/** Iterate every entity in `grid` within R of (x,y). Same 250-px uniform grid
 *  combat.js / main.js build, so a TANK_UNIT_RANGE query touches a 3×3 window. */
function forNear(grid, x, y, R, fn) {
  const range = Math.ceil(R / GRID_CELL);
  const cx0 = Math.floor(x / GRID_CELL), cy0 = Math.floor(y / GRID_CELL);
  for (let cx = cx0 - range; cx <= cx0 + range; cx++)
    for (let cy = cy0 - range; cy <= cy0 + range; cy++) {
      const b = grid.get(cx * 10000 + cy);
      if (b) for (const o of b) fn(o);
    }
}

// =====================================================
// Target acquisition + production
// =====================================================
/** Nearest allied node to a world point — where a freshly-built tank rolls out
 *  from (the factory sits at an arbitrary (x,y), but tanks travel the road graph,
 *  which connects NODES). */
function nearestAlliedNode(x, y, owner) {
  let best = null, bestD2 = Infinity;
  for (const n of state.nodes) {
    if (!isAlly(n.owner, owner)) continue;
    const dx = n.x - x, dy = n.y - y, d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = n; }
  }
  return best;
}

/** Pick the nearest reachable FRONTIER node (a non-allied node touching our
 *  territory) for a tank starting at `fromNode`. Enemies are preferred over
 *  neutral land (×1.5 distance penalty on neutral). Returns {node, path} or
 *  null when nothing is reachable.
 *
 *  Tanks SUPPRESS but never capture, so the frontier doesn't advance on its own
 *  — it advances when INFANTRY takes a suppressed node. Already-suppressed nodes
 *  (garrison ≤ TANK_SUPPRESS_UNITS) are skipped so tanks roll toward live
 *  resistance instead of re-hammering a husk and ping-ponging in place; if the
 *  whole front is suppressed and no infantry follows, the tank goes idle and
 *  re-checks (a garrison that regens back above the floor re-attracts it). */
function pickTankTarget(owner, fromNode) {
  let best = null, bestScore = Infinity;
  for (const n of state.nodes) {
    if (isAlly(n.owner, owner)) continue;
    if (n.units <= TANK_SUPPRESS_UNITS) continue;   // already suppressed/empty — infantry's job
    let frontier = false;
    for (const nb of state.adj.get(n.id)) {
      if (isAlly(state.nodes[nb].owner, owner)) { frontier = true; break; }
    }
    if (!frontier) continue;
    const dx = n.x - fromNode.x, dy = n.y - fromNode.y;
    let score = Math.hypot(dx, dy);
    if (n.owner === 'neutral') score *= 1.5;   // prefer enemy nodes over neutral land
    if (score < bestScore) { bestScore = score; best = n; }
  }
  if (!best) return null;
  const path = findPath(fromNode.id, best.id, owner);
  if (!path || path.length < 1) return null;
  return { node: best, path };
}

/** Launch a tank from `fromNode` toward the nearest frontier target. Returns
 *  true if it actually rolled out (a reachable target existed). */
function dispatchTank(owner, fromNode) {
  const tgt = pickTankTarget(owner, fromNode);
  if (!tgt) return false;
  state.fleets.push({
    _id: state._nextFleetId++,
    kind: 'tank', owner,
    units: TANK_UNIT_HP,           // units doubles as HP — every unit-damage path chips it
    hpMax: TANK_UNIT_HP,
    path: tgt.path, segIdx: 0, segTraveled: 0,
    x: fromNode.x, y: fromNode.y,
    heading: 0,
    targetNodeId: tgt.node.id,
    _homeNodeId: fromNode.id,
  });
  return true;
}

/** Per-frame: every active tank factory rolls out a tank when its cooldown is up
 *  and the owner is under the per-factory live-tank cap. Called once per frame
 *  from main.js (parallel to drones.runFactoryProduction). */
export function runTankProduction(dt) {
  const factoryCount = new Map();        // owner -> active tank-factory count
  for (const t of state.turrets) {
    if (t.type === 'tank' && t.active) {
      factoryCount.set(t.owner, (factoryCount.get(t.owner) || 0) + 1);
    }
  }
  if (factoryCount.size === 0) return;
  const liveByOwner = new Map();         // owner -> live tank fleets (the cap)
  for (const f of state.fleets) {
    if (f.kind === 'tank') liveByOwner.set(f.owner, (liveByOwner.get(f.owner) || 0) + 1);
  }
  for (const t of state.turrets) {
    if (t.type !== 'tank' || !t.active) continue;
    if (t.prodCooldown === undefined) t.prodCooldown = TANK_FACTORY_PRODUCTION_T;
    t.prodCooldown -= dt;
    if (t.prodCooldown > 0) continue;
    t.prodCooldown = TANK_FACTORY_PRODUCTION_T;
    const cap = TANK_CAP_PER_FACTORY * (factoryCount.get(t.owner) || 1);
    if ((liveByOwner.get(t.owner) || 0) >= cap) continue;     // at cap — hold this cycle
    const from = nearestAlliedNode(t.x, t.y, t.owner);
    if (from && dispatchTank(t.owner, from)) {
      liveByOwner.set(t.owner, (liveByOwner.get(t.owner) || 0) + 1);
    }
  }
}

// =====================================================
// Weapons + siege (per sub-step)
// =====================================================
/** Park a tank at its destination node and open the siege. Called from
 *  fleets.simulateFleets when the road path completes. */
export function beginTankSiege(f, node) {
  f.siegeNodeId = node.id;
  f._homeNodeId = node.id;
  f.x = node.x; f.y = node.y;
}

/** A ground target (troop column OR enemy tank) a tank gunned down. Off-road /
 *  road-position wreck rules live in engineering.addWreckBlockage, which keys on
 *  kind:'tank' for the 6× death-road hulk. Heavier boom for a tank vs a column. */
function killGroundTarget(g) {
  addWreckBlockage(g);                        // tank-kind targets leave a 6× hulk
  if (g.kind === 'tank') {
    spawnBigExplosion(g.x, g.y, '#ffaa55', 22);
    spawnScorch(g.x, g.y, 'big');
  } else {
    spawnBigExplosion(g.x, g.y, '#ff8a3a', 8);
    spawnScorch(g.x, g.y, 'medium');
  }
  g._dead = true;
}

/** Anti-fleet fire for ALL live tanks in one pass. Mobile tanks are BOTH the
 *  attackers and (being ground fleets themselves) the targets, so enemy tanks
 *  shoot each other and a tank guns down troop columns crossing its range.
 *
 *  WASM FAST PATH: this is the exact shape of the (now-retired static-turret)
 *  Rust `tank_damage_fleets` — attackers × ground-fleet targets, owner-skip,
 *  flat DPS, returns post-tick units. We reuse it verbatim (no Rust change, no
 *  wasm rebuild): owner-aliasing makes a tank skip itself + every ally, so the
 *  attacker-also-in-targets overlap is harmless. JS fallback mirrors it per-tank
 *  (and draws fire tracers — the wasm path skips them, exactly like AA/combat).
 *  Returns true if any target died (caller sweeps). */
function applyTankFleetDamage(tanks, dt) {
  let kill = false;
  const dmg = TANK_UNIT_DPS_FLEET * dt;

  if (isWasmReady()) {
    const targets = [];
    for (const g of state.fleets) if (g.kind !== 'drone' && !g._dead) targets.push(g);
    if (targets.length) {
      const newUnits = wasmTankDamageFleets(tanks, targets, TANK_R2, dmg);
      if (newUnits) {
        for (let i = 0; i < targets.length; i++) {
          const g = targets[i];
          if (g._dead) continue;
          const nu = newUnits[i];
          g.units = Number.isFinite(nu) ? nu : 0;   // firewall: non-finite → kill, never a NaN fleet
          if (g.units < 0.5) { killGroundTarget(g); kill = true; }
        }
        return kill;
      }
    }
  }

  // JS FALLBACK — per-tank gridded scan (also paints fire tracers).
  for (const f of tanks) {
    if (f._dead) continue;
    forNear(state.groundFleetGrid, f.x, f.y, TANK_UNIT_RANGE, (g) => {
      if (g === f || g._dead || isAlly(g.owner, f.owner)) return;
      const dx = g.x - f.x, dy = g.y - f.y;
      if (dx * dx + dy * dy > TANK_R2) return;
      g.units -= dmg;
      if (g.units < 0.5) { killGroundTarget(g); kill = true; return; }
      if (Math.random() < 3 * dt) {
        state.tracers.push({ x1: f.x, y1: f.y, x2: g.x, y2: g.y, age: 0, maxAge: 0.22, color: COLOR[f.owner] });
      }
    });
  }
  return kill;
}

/** Per-tank turret siege — chip enemy buildings in range. Small loop (few
 *  turrets near any one tank), stays in JS like the original static-tank siege. */
function applyTankTurretSiege(f, dt) {
  forNear(state.turretGrid, f.x, f.y, TANK_UNIT_RANGE, (o) => {
    if (isAlly(o.owner, f.owner) || o.pendingEngineer) return;
    const dx = o.x - f.x, dy = o.y - f.y;
    if (dx * dx + dy * dy > TANK_R2) return;
    o.hp -= TANK_UNIT_DPS_TURRET * dt;
    if (Math.random() < 1.2 * dt) {
      state.tracers.push({ x1: f.x, y1: f.y, x2: o.x, y2: o.y, age: 0, maxAge: 0.22, color: COLOR[f.owner] });
    }
  });
}

/** After a siege ends (garrison suppressed, or the node turned friendly because
 *  infantry took it), pick the next frontier target — or go idle and re-scan
 *  later. The tank is parked AT the suppressed node `f.siegeNodeId` (still
 *  enemy/neutral — tanks don't flip ownership), and that node IS a frontier (it
 *  has a friendly neighbour), so findPath from it reaches the rest of our road
 *  network without the tank teleporting. */
function advanceTank(f) {
  const home = state.nodes[f.siegeNodeId];
  f.siegeNodeId = undefined;
  if (home) f._homeNodeId = home.id;
  const tgt = home ? pickTankTarget(f.owner, home) : null;
  if (tgt) {
    f.path = tgt.path; f.segIdx = 0; f.segTraveled = 0;
    f.targetNodeId = tgt.node.id; f._idle = false;
  } else {
    f._idle = true;
    f._nextRecheckT = state.elapsed + TANK_SIEGE_RECHECK_T;
  }
}

/** Bombard the besieged node, take retaliation, then SUPPRESS-and-advance (never
 *  capture) / die. Returns true if the tank itself was destroyed this tick. */
function applyTankSiege(f, dt) {
  const node = state.nodes[f.siegeNodeId];
  if (!node) { f.siegeNodeId = undefined; f._idle = true; return false; }
  if (isAlly(node.owner, f.owner)) { advanceTank(f); return false; }   // infantry took it — move on
  catchUpRegen(node);
  if (node.units > 0) f.units -= node.units * TANK_NODE_RETALIATE * dt;  // defenders shoot back
  node.units -= TANK_UNIT_DPS_NODE * dt;
  if (node.units < 0) node.units = 0;          // floor at 0 — tanks suppress, never drive it negative
  if (Math.random() < 3 * dt) {
    state.tracers.push({ x1: f.x, y1: f.y, x2: node.x, y2: node.y, age: 0, maxAge: 0.25, color: COLOR[f.owner] });
  }
  // Garrison broken (≤ suppression floor): the tank's job is done here — roll on
  // to the next frontier and leave the actual capture to a following infantry
  // column. We do NOT change node.owner.
  if (node.units <= TANK_SUPPRESS_UNITS) { advanceTank(f); return false; }
  if (f.units <= 0.5) {                       // overwhelmed at the wall — dies at the node (off-road, no hulk)
    spawnBigExplosion(f.x, f.y, '#ffaa55', 26);
    spawnScorch(f.x, f.y, 'big');
    f._dead = true; return true;
  }
  return false;
}

/** Per sub-step tank tick: weapons for all tanks, plus siege / idle handling. */
export function updateGroundTanks(dt) {
  const tanks = [];
  for (const f of state.fleets) if (f.kind === 'tank' && !f._dead) tanks.push(f);
  if (tanks.length === 0) return;
  let dirty = false;

  // 1) Anti-fleet fire for the whole tank force in one pass (wasm batch / JS
  //    fallback). Marks dead targets — a tank killed here is skipped in (2).
  if (applyTankFleetDamage(tanks, dt)) dirty = true;

  // 2) Per-tank: turret siege + node bombard-siege / idle re-scan.
  for (const f of tanks) {
    if (f._dead) continue;
    applyTankTurretSiege(f, dt);
    if (f.siegeNodeId !== undefined) {
      if (applyTankSiege(f, dt)) dirty = true;
    } else if (f._idle) {
      // Parked with no frontier — re-scan periodically so a tank re-mobilises
      // the moment the front shifts and a fresh target becomes reachable.
      if (state.elapsed >= (f._nextRecheckT || 0)) {
        f._nextRecheckT = state.elapsed + TANK_SIEGE_RECHECK_T;
        const home = state.nodes[f._homeNodeId];
        const tgt = home ? pickTankTarget(f.owner, home) : null;
        if (tgt) {
          f._idle = false; f.path = tgt.path; f.segIdx = 0; f.segTraveled = 0;
          f.targetNodeId = tgt.node.id;
        }
      }
    }
  }

  if (dirty) {
    for (let i = state.fleets.length - 1; i >= 0; i--) {
      if (state.fleets[i]._dead) state.fleets.splice(i, 1);
    }
  }
}

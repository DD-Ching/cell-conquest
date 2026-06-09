// =====================================================
// Troop / engineer fleet logic.
// Drones live in engineering.js (different motion model).
// =====================================================
import { state } from './state.js';
import {
  FLEET_SPEED, TANK_UNIT_SPEED,
  DETOUR_LOOKAHEAD, DETOUR_OFFSET, DETOUR_SPEED_MIN,
  WRECK_RENDER_R,
} from './config.js';
import { COLOR } from './factions.js';
import { dist } from './util.js';
import { findPath, catchUpRegen } from './world.js';
import { isAlly } from './alliance.js';
import {
  ENG_SPEED, ekey,
  engineerArrivedAtTurret, engineerArrivedAtNetEdge,
} from './engineering.js';
import { beginTankSiege } from './tanks.js';
import { sfxCapture } from './audio.js';

// Short final-leg off-road speed (engineer→build-site, assault→turret,
// return→home). These are 30–150 px hops, not the "stuck behind a wreck
// pile" mechanic — that one lives in DETOUR_SPEED_MIN (config.js) and
// stays at 0.014 so wreck-pile detours genuinely choke a road.
const OFFROAD_SPEED_MUL = 0.35;

/** Try to dispatch a troop fleet (own-territory path). Returns true on success. */
export function sendFleet(from, to, amount) {
  amount = Math.floor(amount);
  if (!(amount >= 1)) return false;        // rejects NaN/Infinity/≤0 (a NaN amount must never subtract from a node)
  catchUpRegen(from);                       // fresh units count before subtracting
  amount = Math.min(amount, Math.floor(from.units));
  if (!(amount >= 1)) return false;        // rejects NaN/Infinity/≤0 (a NaN amount must never subtract from a node)
  const path = findPath(from.id, to.id, from.owner);
  if (!path || path.length < 2) {
    from.flash = Math.max(from.flash, 0.6);
    return false;
  }
  from.units -= amount;
  state.fleets.push({
    _id: state._nextFleetId++,
    owner: from.owner, units: amount,
    path, segIdx: 0,
    x: from.x, y: from.y,
    segTraveled: 0,
  });
  return true;
}

/** Dispatch an "assault" fleet — troops that road-travel to the closest own
 *  anchor node then leave the road to suicide-attack an enemy turret. */
export function assaultTurret(from, turret, amount) {
  amount = Math.floor(amount);
  if (!(amount >= 1)) return false;        // rejects NaN/Infinity/≤0 (a NaN amount must never subtract from a node)
  catchUpRegen(from);                       // fresh units count before subtracting
  amount = Math.min(amount, Math.floor(from.units));
  if (!(amount >= 1)) return false;        // rejects NaN/Infinity/≤0 (a NaN amount must never subtract from a node)
  // Anchor: nearest own node to the turret.
  let anchor = from, anchorDist = Math.hypot(from.x - turret.x, from.y - turret.y);
  for (const n of state.nodes) {
    if (n.owner !== from.owner) continue;
    const d = Math.hypot(n.x - turret.x, n.y - turret.y);
    if (d < anchorDist) { anchorDist = d; anchor = n; }
  }
  const path = (from.id === anchor.id) ? [from.id] : findPath(from.id, anchor.id, from.owner);
  if (!path) { from.flash = Math.max(from.flash, 0.6); return false; }
  from.units -= amount;
  state.fleets.push({
    _id: state._nextFleetId++,
    kind: 'assault', owner: from.owner, units: amount, path,
    segIdx: 0, segTraveled: 0,
    x: from.x, y: from.y,
    finalX: turret.x, finalY: turret.y,
    targetTurretId: turret.id,
    offroad: false,
  });
  return true;
}

// =====================================================
// Per-edge wreck spatial cache
// =====================================================
// Each entry stores wrecks along the edge's CANONICAL direction (low-id node
// → high-id node), sorted ascending by projection. The detour scan binary-
// searches this in O(log W) per fleet sub-step instead of the O(W) linear
// loop it replaces. At late-game scale (≥100 fleets × 10 sub-steps × heavy
// edges) the savings dominate sim time.
//
// Rebuilt at the top of every simulateFleets() call — wrecks die / spawn
// freely between calls, and keeping the cache fresh is cheaper than
// invalidating it from every mutation site.
function rebuildWrecksByEdge() {
  state.wrecksByEdge.clear();
  for (const [key, e] of state.edgeData) {
    if (!e.wrecks || e.wrecks.length === 0) continue;
    // Recover the canonical (low-id, high-id) endpoints from the key. ekey
    // stores them sorted, so splitting on '_' gives them directly.
    const us = key.indexOf('_');
    const aId = +key.slice(0, us);
    const bId = +key.slice(us + 1);
    const aN = state.nodes[aId], bN = state.nodes[bId];
    if (!aN || !bN) continue;
    const dx = bN.x - aN.x, dy = bN.y - aN.y;
    const segLen = Math.hypot(dx, dy) || 1;
    const dirX = dx / segLen, dirY = dy / segLen;
    // perpendicular (90° CCW) in canonical frame
    const pxn = -dirY, pyn = dirX;
    const ws = e.wrecks;
    const n = ws.length;
    // Compute (proj, perp) pairs, then sort ascending by proj.
    // For small n (cap = WRECK_MAX_PER_EDGE = 18) an inline insertion sort
    // beats Array.sort() — no comparator-call overhead, predictable cost.
    // Allocation cost (two small Float32Arrays per edge with wrecks per
    // sub-step) is dwarfed by the per-fleet O(W) scan it replaces once
    // either fleet count or wrecks-per-edge grow into late-game scale.
    const projs = new Float32Array(n);
    const perps = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = ws[i];
      const wDx = w.x - aN.x, wDy = w.y - aN.y;
      const p = wDx * dirX + wDy * dirY;
      const q = wDx * pxn + wDy * pyn;
      // Insertion-sort the new entry into [0..i].
      let j = i;
      while (j > 0 && projs[j - 1] > p) {
        projs[j] = projs[j - 1];
        perps[j] = perps[j - 1];
        j--;
      }
      projs[j] = p;
      perps[j] = q;
    }
    state.wrecksByEdge.set(key, { projs, perps, segLen, aId, bId });
  }
}

/** Binary search: lowest index `i` such that `arr[i] >= target`.
 *  Returns `arr.length` if no element satisfies. */
function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Advance path-based fleets (troops + deploy-engineers). Drones in engineering.js. */
export function simulateFleets(dt) {
  // Refresh the per-edge wreck spatial cache before the fleet loop so the
  // inner detour scan can binary-search a sorted projection array instead
  // of linearly scanning each edge's wreck list per fleet sub-step.
  rebuildWrecksByEdge();
  for (let i = state.fleets.length - 1; i >= 0; i--) {
    const f = state.fleets[i];
    if (f.kind === 'drone') continue;
    // Parked tanks (besieging a node, or idle with no reachable frontier) are
    // driven by tanks.updateGroundTanks, not by road movement — skip them here.
    if (f.kind === 'tank' && (f.siegeNodeId !== undefined || f._idle)) continue;

    // Tank roll-out: a freshly-built tank starts at its FACTORY (an arbitrary
    // world point) and must reach the road graph before it can follow a path.
    // Roll it OFF-ROAD straight to the first path node, THEN hand it to the
    // normal road traversal below. Without this the tank snapped onto path[0]
    // on its first tick and looked like it "emerged from" that node.
    if (f.kind === 'tank' && f._approaching) {
      const a0 = state.nodes[f.path[0]];
      if (!a0) { f._approaching = false; }
      else {
        const ax = a0.x - f.x, ay = a0.y - f.y;
        const ad = Math.hypot(ax, ay);
        if (ad < 10) { f._approaching = false; f.segIdx = 0; f.segTraveled = 0; }
        else {
          const step = TANK_UNIT_SPEED * OFFROAD_SPEED_MUL * dt;
          f.x += (ax / ad) * step; f.y += (ay / ad) * step;
          f.heading = Math.atan2(ay, ax);
          continue;
        }
      }
    }

    // Deploy + assault + return: off-road final leg to a world point
    if ((f.kind === 'deploy' || f.kind === 'assault' || f.kind === 'return') && f.offroad) {
      const dx = f.finalX - f.x, dy = f.finalY - f.y;
      const d = Math.hypot(dx, dy);
      if (d < 4) {
        if (f.kind === 'deploy') {
          // Net engineer (targets an edge) vs turret engineer (targets a turret site)
          if (f.targetEdgeA !== undefined) {
            const res = engineerArrivedAtNetEdge(f);
            if (!res.consumed && res.redirect) {
              // Engineer keeps working: walk off-road to another road that needs work.
              const aN = state.nodes[res.redirect.a], bN = state.nodes[res.redirect.b];
              f.targetEdgeA = res.redirect.a; f.targetEdgeB = res.redirect.b;
              // Aim at the nearer ENDPOINT (a road junction), not the edge midpoint,
              // so the engineer hops node-to-node instead of cutting across dirt.
              const useA = Math.hypot(f.x - aN.x, f.y - aN.y) <= Math.hypot(f.x - bN.x, f.y - bN.y);
              f.finalX = useA ? aN.x : bN.x; f.finalY = useA ? aN.y : bN.y;
              continue;
            }
          } else {
            engineerArrivedAtTurret(f);
          }
        } else if (f.kind === 'assault') {
          // Assault arrival: each unit can absorb 8 HP of the turret. Survivors
          // (the troops not needed to finish the kill) head home to the nearest
          // friendly node instead of vanishing.
          const t = state.turretById.get(f.targetTurretId);
          let consumed = 0;
          if (t && t.owner !== f.owner) {
            const possible = Math.max(0, f.units) * 8;
            const dealt = Math.min(possible, Math.max(0, t.hp));
            t.hp -= dealt;
            consumed = dealt / 8;
          }
          const survivors = Math.floor(Math.max(0, f.units - consumed));
          if (survivors >= 1) {
            // Pick the nearest own node to head back to
            let home = null, homeD = Infinity;
            for (const n of state.nodes) {
              if (n.owner !== f.owner) continue;
              const dd = Math.hypot(n.x - f.x, n.y - f.y);
              if (dd < homeD) { homeD = dd; home = n; }
            }
            if (home) {
              f.kind = 'return';
              f.units = survivors;
              f.finalX = home.x; f.finalY = home.y;
              f.targetNodeId = home.id;
              delete f.targetTurretId;
              continue;       // off-road movement next tick will take them home
            }
          }
        } else if (f.kind === 'return') {
          // Survivors arriving home — fold them back into the node defenders.
          const home = state.nodes[f.targetNodeId];
          if (home) arriveAt({ owner: f.owner, units: Math.floor(f.units) }, home);
        }
        state.fleets.splice(i, 1);
        continue;
      }
      // Movement: returning troops use normal fleet speed (faster than engineer); they're
      // not carrying anything, just hurrying home.
      const speed = (f.kind === 'deploy') ? ENG_SPEED * OFFROAD_SPEED_MUL
                                          : FLEET_SPEED * OFFROAD_SPEED_MUL;
      const step = speed * dt;
      f.x += (dx / d) * step;
      f.y += (dy / d) * step;
      continue;
    }

    const baseSpeed = f.kind === 'tank' ? TANK_UNIT_SPEED
                    : (f.kind === 'engineer' || f.kind === 'deploy') ? ENG_SPEED
                    : FLEET_SPEED;
    // Detour: peek ahead on the current segment for any wreck pile in our path
    // and compute a lateral offset around it. While offset is non-zero we move
    // slower (off-road tax — natural cause of congestion behind a wreck cluster).
    let speedMul = 1.0;
    let lateralX = 0, lateralY = 0;
    if (f.segIdx < f.path.length - 1) {
      const aId = f.path[f.segIdx], bId = f.path[f.segIdx + 1];
      const aN = state.nodes[aId];
      const bN = state.nodes[bId];
      const dx = bN.x - aN.x, dy = bN.y - aN.y;
      const segLen = Math.hypot(dx, dy) || 1;
      const segDirX = dx / segLen, segDirY = dy / segLen;
      // perpendicular (90° CCW) in the fleet's traversal frame
      const pxn = -segDirY, pyn = segDirX;
      const cache = state.wrecksByEdge.get(ekey(aId, bId));
      if (cache) {
        // Cache stores wrecks along the canonical direction (low-id → high-id),
        // sorted by projection. We translate the fleet's "ahead in my direction"
        // search window into a canonical-proj range and binary-search.
        const { projs, perps, segLen: cSegLen } = cache;
        const canonical = aId < bId;
        let nearestAhead = Infinity, nearestPerp = 0;
        if (canonical) {
          // Fleet traverses canonically: fleet-proj == canon-proj. We want the
          // smallest canon-proj > f.segTraveled - WRECK_RENDER_R that is also
          // < f.segTraveled + DETOUR_LOOKAHEAD.
          const lo = lowerBound(projs, f.segTraveled - WRECK_RENDER_R);
          if (lo < projs.length) {
            const cp = projs[lo];
            const ahead = cp - f.segTraveled;
            if (ahead < DETOUR_LOOKAHEAD) {
              nearestAhead = ahead;
              nearestPerp = perps[lo];
            }
          }
        } else {
          // Fleet traverses reverse: fleet-proj == cSegLen - canon-proj. The
          // smallest fleet-ahead corresponds to the LARGEST canon-proj that is
          // still < cSegLen - f.segTraveled + WRECK_RENDER_R.
          const upper = cSegLen - f.segTraveled + WRECK_RENDER_R;
          // lowerBound returns first index with proj >= upper; one before that
          // is the largest with proj < upper.
          const idx = lowerBound(projs, upper) - 1;
          if (idx >= 0) {
            const cp = projs[idx];
            const ahead = (cSegLen - cp) - f.segTraveled;
            if (ahead < DETOUR_LOOKAHEAD) {
              nearestAhead = ahead;
              // Perpendicular flips sign when traversal direction reverses
              // (segDir rotated 180° → CCW perpendicular flipped).
              nearestPerp = -perps[idx];
            }
          }
        }
        if (nearestAhead < Infinity) {
          // Approach factor — full at closest pass, fades at edges of lookahead
          const approach = 1 - Math.min(1, Math.abs(nearestAhead) / DETOUR_LOOKAHEAD);
          // Steer to the OPPOSITE side of where the pile sits
          const side = nearestPerp >= 0 ? -1 : 1;
          const off = DETOUR_OFFSET * approach;
          lateralX = pxn * side * off;
          lateralY = pyn * side * off;
          // Slower while off-centerline — peak slowdown at peak detour
          speedMul = DETOUR_SPEED_MIN + (1 - DETOUR_SPEED_MIN) * (1 - approach);
        }
      }
    }
    f.segTraveled += baseSpeed * speedMul * dt;

    while (f.segIdx < f.path.length - 1) {
      const segLen = dist(state.nodes[f.path[f.segIdx]], state.nodes[f.path[f.segIdx + 1]]);
      if (f.segTraveled < segLen) break;
      f.segTraveled -= segLen;
      f.segIdx++;
    }

    if (f.segIdx >= f.path.length - 1) {
      // Road portion done.
      if (f.kind === 'tank') {
        // Tank reached its target node — park it and open the bombard-siege.
        // It is NOT spliced (units = HP, never merges into a garrison); the
        // siege / capture / re-advance all run in tanks.updateGroundTanks.
        const node = state.nodes[f.path[f.path.length - 1]];
        if (node) beginTankSiege(f, node);
        continue;
      }
      if (f.kind === 'deploy' || f.kind === 'assault') {
        // Begin off-road leg toward the world-coord target (turret site).
        const anchor = state.nodes[f.path[f.path.length - 1]];
        f.x = anchor.x; f.y = anchor.y;
        f.offroad = true;
        continue;
      }
      const target = state.nodes[f.path[f.path.length - 1]];
      if (target) arriveAt({ owner: f.owner, units: Math.floor(f.units) }, target);
      state.fleets.splice(i, 1);
      continue;
    }

    const segA = state.nodes[f.path[f.segIdx]];
    const segB = state.nodes[f.path[f.segIdx + 1]];
    const segLen = dist(segA, segB);
    const t = Math.min(1, f.segTraveled / Math.max(1, segLen));
    // Centerline position, then layer the detour offset on top.
    f.x = segA.x + (segB.x - segA.x) * t + lateralX;
    f.y = segA.y + (segB.y - segA.y) * t + lateralY;
    // Tanks store a heading so the sprite faces its direction of travel (and
    // keeps that facing while parked in a siege).
    if (f.kind === 'tank') f.heading = Math.atan2(segB.y - segA.y, segB.x - segA.x);
  }
}

/** Apply a troop fleet's arrival: capture, reinforce, or weaken. Internal —
 *  only called from simulateFleets above when a fleet hits its destination. */
function arriveAt(fleet, target) {
  // Firewall: a non-finite arriving force would poison target.units (and then
  // cascade across the map as that node feeds new fleets). Drop it. sendFleet
  // already rejects non-finite amounts, so this is belt-and-suspenders.
  if (!Number.isFinite(fleet.units)) return;
  // Capture-or-reinforce combat needs the current defender count — pull
  // the regen accrual into target.units before the comparison so a node
  // last touched 30 game-seconds ago doesn't fight at stale strength.
  catchUpRegen(target);
  if (isAlly(target.owner, fleet.owner)) {
    // Same side (own or allied lieutenant) — reinforce instead of fight.
    target.units = Math.min(target.capacity * 1.5, target.units + fleet.units);
    target.flash = 0.5;
  } else {
    if (fleet.units > target.units) {
      target.owner = fleet.owner;
      target.units = fleet.units - target.units;
      target.flash = 1;
      target.pulse = 1;
      // Owner changed — reset the lazy-regen baseline so the new owner
      // doesn't get a back-dated free-regen bonus.
      target.lastRegenT = state.elapsed;
      spawnCaptureParticles(target, fleet.owner);
    } else {
      target.units -= fleet.units;
      target.flash = 0.6;
    }
  }
}

function spawnCaptureParticles(node, owner) {
  sfxCapture(node.x, node.y);            // spatialised capture blip (no-op if audio off/muted)
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 80 + Math.random() * 140;
    state.particles.push({
      x: node.x, y: node.y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 0.9, maxLife: 0.9,
      color: COLOR[owner],
      kind: 'capture',
    });
  }
}

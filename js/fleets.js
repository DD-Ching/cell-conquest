// =====================================================
// Troop / engineer fleet logic.
// Drones live in engineering.js (different motion model).
// =====================================================
import { state } from './state.js';
import {
  FLEET_SPEED,
  DETOUR_LOOKAHEAD, DETOUR_OFFSET, DETOUR_SPEED_MIN,
  WRECK_RENDER_R,
} from './config.js';
import { COLOR } from './factions.js';
import { dist } from './util.js';
import { findPath } from './world.js';
import {
  ENG_SPEED, getEdge,
  engineerArrivedAtTurret, engineerArrivedAtNetEdge,
} from './engineering.js';

const OFFROAD_SPEED_MUL = 0.4;

/** Try to dispatch a troop fleet (own-territory path). Returns true on success. */
export function sendFleet(from, to, amount) {
  amount = Math.floor(amount);
  if (amount < 1) return false;
  amount = Math.min(amount, Math.floor(from.units));
  if (amount < 1) return false;
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
  if (amount < 1) return false;
  amount = Math.min(amount, Math.floor(from.units));
  if (amount < 1) return false;
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

/** Advance path-based fleets (troops + deploy-engineers). Drones in engineering.js. */
export function simulateFleets(dt) {
  for (let i = state.fleets.length - 1; i >= 0; i--) {
    const f = state.fleets[i];
    if (f.kind === 'drone') continue;

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
              f.finalX = (aN.x + bN.x) / 2; f.finalY = (aN.y + bN.y) / 2;
              continue;
            }
          } else {
            engineerArrivedAtTurret(f);
          }
        } else if (f.kind === 'assault') {
          // Assault arrival: each unit can absorb 8 HP of the turret. Survivors
          // (the troops not needed to finish the kill) head home to the nearest
          // friendly node instead of vanishing.
          const t = state.turrets.find(tt => tt.id === f.targetTurretId);
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

    const baseSpeed = (f.kind === 'engineer' || f.kind === 'deploy') ? ENG_SPEED : FLEET_SPEED;
    // Detour: peek ahead on the current segment for any wreck pile in our path
    // and compute a lateral offset around it. While offset is non-zero we move
    // slower (off-road tax — natural cause of congestion behind a wreck cluster).
    let speedMul = 1.0;
    let lateralX = 0, lateralY = 0;
    let segDirX = 0, segDirY = 0;
    if (f.segIdx < f.path.length - 1) {
      const aN = state.nodes[f.path[f.segIdx]];
      const bN = state.nodes[f.path[f.segIdx + 1]];
      const dx = bN.x - aN.x, dy = bN.y - aN.y;
      const segLen = Math.hypot(dx, dy) || 1;
      segDirX = dx / segLen; segDirY = dy / segLen;
      // perpendicular (90° CCW)
      const pxn = -segDirY, pyn = segDirX;
      const e = getEdge(f.path[f.segIdx], f.path[f.segIdx + 1]);
      if (e && e.wrecks && e.wrecks.length > 0) {
        // Find the nearest pile AHEAD on this segment (within DETOUR_LOOKAHEAD)
        let nearestAhead = Infinity, nearestPerp = 0;
        for (const w of e.wrecks) {
          const wDx = w.x - aN.x, wDy = w.y - aN.y;
          const wt = wDx * segDirX + wDy * segDirY;        // proj onto seg
          const wperp = wDx * pxn + wDy * pyn;             // perpendicular signed
          const ahead = wt - f.segTraveled;
          if (ahead > -WRECK_RENDER_R && ahead < DETOUR_LOOKAHEAD && ahead < nearestAhead) {
            nearestAhead = ahead;
            nearestPerp = wperp;
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
  }
}

/** Apply a troop fleet's arrival: capture, reinforce, or weaken. */
export function arriveAt(fleet, target) {
  if (target.owner === fleet.owner) {
    target.units = Math.min(target.capacity * 1.5, target.units + fleet.units);
    target.flash = 0.5;
  } else {
    if (fleet.units > target.units) {
      target.owner = fleet.owner;
      target.units = fleet.units - target.units;
      target.flash = 1;
      target.pulse = 1;
      spawnCaptureParticles(target, fleet.owner);
    } else {
      target.units -= fleet.units;
      target.flash = 0.6;
    }
  }
}

export function spawnCaptureParticles(node, owner) {
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 80 + Math.random() * 140;
    state.particles.push({
      x: node.x, y: node.y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 0.9, maxLife: 0.9,
      color: COLOR[owner]
    });
  }
}

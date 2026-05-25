// =====================================================
// Troop / engineer fleet logic.
// Drones live in engineering.js (different motion model).
// =====================================================
import { state } from './state.js';
import { FLEET_SPEED } from './config.js';
import { COLOR } from './factions.js';
import { dist } from './util.js';
import { findPath } from './world.js';
import { ENG_SPEED, edgeSpeedMul, engineerArrived } from './engineering.js';

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
    owner: from.owner, units: amount,
    path, segIdx: 0,
    x: from.x, y: from.y,
    segTraveled: 0,
  });
  return true;
}

/** Advance path-based fleets (troops + engineers). Drones are handled separately. */
export function simulateFleets(dt) {
  for (let i = state.fleets.length - 1; i >= 0; i--) {
    const f = state.fleets[i];
    if (f.kind === 'drone') continue;            // drones updated in engineering.js
    const baseSpeed = (f.kind === 'engineer') ? ENG_SPEED : FLEET_SPEED;
    let segMul = 1.0;
    if (f.segIdx < f.path.length - 1) {
      segMul = edgeSpeedMul(f.path[f.segIdx], f.path[f.segIdx + 1]);
    }
    f.segTraveled += baseSpeed * segMul * dt;

    while (f.segIdx < f.path.length - 1) {
      const segLen = dist(state.nodes[f.path[f.segIdx]], state.nodes[f.path[f.segIdx + 1]]);
      if (f.segTraveled < segLen) break;
      f.segTraveled -= segLen;
      f.segIdx++;
    }

    if (f.segIdx >= f.path.length - 1) {
      const target = state.nodes[f.path[f.path.length - 1]];
      if (target) {
        if (f.kind === 'engineer') engineerArrived(f, target);
        else arriveAt({ owner: f.owner, units: Math.floor(f.units) }, target);
      }
      state.fleets.splice(i, 1);
      continue;
    }

    const segA = state.nodes[f.path[f.segIdx]];
    const segB = state.nodes[f.path[f.segIdx + 1]];
    const segLen = dist(segA, segB);
    const t = Math.min(1, f.segTraveled / Math.max(1, segLen));
    f.x = segA.x + (segB.x - segA.x) * t;
    f.y = segA.y + (segB.y - segA.y) * t;
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

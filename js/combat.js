// =====================================================
// Turret combat ticks: anti-air, tank (ground/siege), artillery (AOE shells).
//
// Each function is a per-tick simulator that scans state.turrets +
// state.fleets and applies damage / spawns visual effects. Carved out
// of engineering.js so that combat logic isn't tangled with the
// building lifecycle.
// =====================================================
import { state } from './state.js';
import {
  AA_RADIUS, AA_DPS,
  TANK_RADIUS, TANK_DPS,
  ARTILLERY_RANGE, ARTILLERY_AOE, ARTILLERY_INTERVAL,
  ARTILLERY_INACCURACY, ARTILLERY_DAMAGE_TURRET, ARTILLERY_DAMAGE_FLEET,
  ARTILLERY_SHELL_FLIGHT,
} from './config.js';
import { COLOR } from './factions.js';
import { addWreckBlockage, spawnBigExplosion } from './engineering.js';

// Pre-squared radii — radius comparisons use dx²+dy² < r² to skip sqrt.
const AA_R2          = AA_RADIUS * AA_RADIUS;
const TANK_R2        = TANK_RADIUS * TANK_RADIUS;
const ARTILLERY_R2   = ARTILLERY_RANGE * ARTILLERY_RANGE;
const ARTILLERY_AOE2 = ARTILLERY_AOE * ARTILLERY_AOE;

// ---- Anti-air with saturation ----
// Each AA splits its DPS across every enemy drone currently in its range.
// One drone in range = full AA_DPS; ten drones = AA_DPS / 10 each. So massed
// drone swarms saturate the defense and a fraction can punch through.
export function updateAntiAir(dt) {
  const totalTracerRate = 5;   // total beams/sec per AA (split across targets)
  for (const t of state.turrets) {
    if (t.type !== 'antiair' || !t.active) continue;
    const inRange = [];
    for (const f of state.fleets) {
      if (f.kind !== 'drone' || f.owner === t.owner) continue;
      const dx = f.x - t.x, dy = f.y - t.y;
      if (dx * dx + dy * dy <= AA_R2) inRange.push(f);
    }
    if (inRange.length === 0) continue;
    const dpsPerTarget = AA_DPS / inRange.length;
    const tracerPerTarget = totalTracerRate / inRange.length;
    for (const f of inRange) {
      f.hp -= dpsPerTarget * dt;
      if (Math.random() < tracerPerTarget * dt) {
        state.tracers.push({
          x1: t.x, y1: t.y, x2: f.x, y2: f.y,
          age: 0, maxAge: 0.18, color: COLOR[t.owner],
        });
      }
    }
  }
}

// ---- Tanks — anti-ground (and slow siege of enemy turrets) ----
// Cannot target drones — that's AA's job. Lower DPS than AA, longer range.
export function updateTanks(dt) {
  const tracerRate = 3;
  for (const t of state.turrets) {
    if (t.type !== 'tank' || !t.active) continue;
    // Damage enemy ground fleets in range
    for (let i = state.fleets.length - 1; i >= 0; i--) {
      const f = state.fleets[i];
      if (f.owner === t.owner) continue;
      if (f.kind === 'drone') continue;
      const dx = f.x - t.x, dy = f.y - t.y;
      if (dx * dx + dy * dy > TANK_R2) continue;
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
    // Siege: slow chip damage to enemy turrets within range
    for (const o of state.turrets) {
      if (o.owner === t.owner) continue;
      const dx = o.x - t.x, dy = o.y - t.y;
      if (dx * dx + dy * dy > TANK_R2) continue;
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

// ---- Artillery — long-range INACCURATE AOE cannon ----
// Picks the densest enemy cluster within range, applies a random wobble to
// the aim, and lobs a shell that detonates in an AOE circle. Stacking many
// turrets at one point becomes a liability since one shell can wipe them.
export function updateArtillery(dt) {
  for (const t of state.turrets) {
    if (t.type !== 'artillery' || !t.active) continue;
    if (t.artyCooldown === undefined) t.artyCooldown = ARTILLERY_INTERVAL;
    t.artyCooldown -= dt;
    if (t.artyCooldown > 0) continue;
    t.artyCooldown = ARTILLERY_INTERVAL;
    fireArtilleryShell(t);
  }
}

function fireArtilleryShell(t) {
  const cands = [];
  for (const e of state.turrets) {
    if (e.owner === t.owner) continue;
    const dx = e.x - t.x, dy = e.y - t.y;
    if (dx * dx + dy * dy > ARTILLERY_R2) continue;
    cands.push({ x: e.x, y: e.y, weight: 2 });   // turrets worth more
  }
  for (const f of state.fleets) {
    if (f.kind === 'drone') continue;
    if (f.owner === t.owner) continue;
    const dx = f.x - t.x, dy = f.y - t.y;
    if (dx * dx + dy * dy > ARTILLERY_R2) continue;
    cands.push({ x: f.x, y: f.y, weight: 1 });
  }
  if (cands.length === 0) return;

  // Pick the target with the most neighbors inside the AOE — that's a "cluster"
  let best = cands[0], bestScore = -1;
  for (const a of cands) {
    let s = 0;
    for (const o of cands) {
      const dx = o.x - a.x, dy = o.y - a.y;
      if (dx * dx + dy * dy < ARTILLERY_AOE2) s += o.weight;
    }
    if (s > bestScore) { bestScore = s; best = a; }
  }

  // Apply inaccuracy (random offset within ARTILLERY_INACCURACY)
  const ang = Math.random() * Math.PI * 2;
  const r = Math.random() * ARTILLERY_INACCURACY;
  const impactX = best.x + Math.cos(ang) * r;
  const impactY = best.y + Math.sin(ang) * r;

  state.shells.push({
    x1: t.x, y1: t.y, x2: impactX, y2: impactY,
    t: 0, maxT: ARTILLERY_SHELL_FLIGHT, owner: t.owner,
  });
}

/** Advance shells in flight; detonate when their flight time expires. */
export function updateShells(dt) {
  for (let i = state.shells.length - 1; i >= 0; i--) {
    const s = state.shells[i];
    s.t += dt;
    if (s.t >= s.maxT) {
      detonateArtillery(s.x2, s.y2, s.owner);
      state.shells.splice(i, 1);
    }
  }
}

/** AOE damage at (x, y) — hits enemy turrets and ground fleets within ARTILLERY_AOE. */
function detonateArtillery(x, y, owner) {
  for (const t of state.turrets) {
    if (t.owner === owner) continue;
    const dx = t.x - x, dy = t.y - y;
    if (dx * dx + dy * dy < ARTILLERY_AOE2) t.hp -= ARTILLERY_DAMAGE_TURRET;
  }
  for (const f of state.fleets) {
    if (f.kind === 'drone') continue;
    if (f.owner === owner) continue;
    const dx = f.x - x, dy = f.y - y;
    if (dx * dx + dy * dy >= ARTILLERY_AOE2) continue;
    f.units -= ARTILLERY_DAMAGE_FLEET;
    if (f.units < 0.5) {
      addWreckBlockage(f);
      f._dead = true;
    }
  }
  // Cleanup dead fleets
  for (let i = state.fleets.length - 1; i >= 0; i--) {
    if (state.fleets[i]._dead) state.fleets.splice(i, 1);
  }
  spawnBigExplosion(x, y, '#ffcc66', 30);
  state.tracers.push({
    x1: x, y1: y, x2: x, y2: y,
    age: 0, maxAge: 0.35, color: '#ffd066',
  });
}

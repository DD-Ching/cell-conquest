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
import { addWreckBlockage, spawnBigExplosion, spawnScorch } from './engineering.js';

// Pre-squared radii — radius comparisons use dx²+dy² < r² to skip sqrt.
const AA_R2          = AA_RADIUS * AA_RADIUS;
const TANK_R2        = TANK_RADIUS * TANK_RADIUS;
const ARTILLERY_R2   = ARTILLERY_RANGE * ARTILLERY_RANGE;
const ARTILLERY_AOE2 = ARTILLERY_AOE * ARTILLERY_AOE;

// Spatial-grid cell size — matches the build in main.js simulate().
const GRID_CELL = 250;

/** Iterate every entity in `grid` within R of (x,y) and call `fn(t)`.
 *  Touches a (2*range+1)² cell window — for TANK_RADIUS that's 9 cells. */
function forNear(grid, x, y, R, fn) {
  const range = Math.ceil(R / GRID_CELL);
  const cx0 = Math.floor(x / GRID_CELL);
  const cy0 = Math.floor(y / GRID_CELL);
  for (let cx = cx0 - range; cx <= cx0 + range; cx++) {
    for (let cy = cy0 - range; cy <= cy0 + range; cy++) {
      const bucket = grid.get(cx * 10000 + cy);
      if (bucket) for (const t of bucket) fn(t);
    }
  }
}
const forTurretsNear = (x, y, R, fn) => forNear(state.turretGrid, x, y, R, fn);
const forGroundNear  = (x, y, R, fn) => forNear(state.groundFleetGrid, x, y, R, fn);

// ---- Anti-air with saturation ----
// Each AA splits its DPS across every enemy drone currently in its range.
// One drone in range = full AA_DPS; ten drones = AA_DPS / 10 each. So massed
// drone swarms saturate the defense and a fraction can punch through.
export function updateAntiAir(dt) {
  const totalTracerRate = 5;   // total beams/sec per AA (split across targets)
  const aaTurrets = state.turretsByType.get('antiair');
  if (!aaTurrets) return;
  // Spatial-grid query: AA_RADIUS = 200 → 3×3 cell window centered on AA.
  // Lets the inner check ignore drones that aren't even near this turret.
  const aaRange = Math.ceil(AA_RADIUS / GRID_CELL);
  for (const t of aaTurrets) {
    if (!t.active) continue;
    const inRange = [];
    const cx0 = Math.floor(t.x / GRID_CELL);
    const cy0 = Math.floor(t.y / GRID_CELL);
    for (let cx = cx0 - aaRange; cx <= cx0 + aaRange; cx++) {
      for (let cy = cy0 - aaRange; cy <= cy0 + aaRange; cy++) {
        const bucket = state.droneGrid.get(cx * 10000 + cy);
        if (!bucket) continue;
        for (const f of bucket) {
          if (f.owner === t.owner) continue;
          const dx = f.x - t.x, dy = f.y - t.y;
          if (dx * dx + dy * dy <= AA_R2) inRange.push(f);
        }
      }
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
  const tankTurrets = state.turretsByType.get('tank');
  if (!tankTurrets) return;
  let anyKill = false;
  for (const t of tankTurrets) {
    if (!t.active) continue;
    // Damage enemy ground fleets in range. Grid query skips out-of-range
    // fleets entirely (and drones — they're in a separate grid). Kills are
    // marked via f._dead and swept once at the end of the function so we
    // don't splice during iteration.
    forGroundNear(t.x, t.y, TANK_RADIUS, (f) => {
      if (f.owner === t.owner) return;
      if (f._dead) return;
      const dx = f.x - t.x, dy = f.y - t.y;
      if (dx * dx + dy * dy > TANK_R2) return;
      f.units -= TANK_DPS * 0.6 * dt;
      if (f.units < 0.5) {
        addWreckBlockage(f);
        spawnBigExplosion(f.x, f.y, '#ff8a3a', 8);
        spawnScorch(f.x, f.y, 'medium');
        f._dead = true;
        anyKill = true;
        return;
      }
      if (Math.random() < tracerRate * dt) {
        state.tracers.push({
          x1: t.x, y1: t.y, x2: f.x, y2: f.y,
          age: 0, maxAge: 0.22, color: COLOR[t.owner],
        });
      }
    });
    // Siege: slow chip damage to enemy turrets within range. Grid lookup
    // touches a 3×3 cell window instead of scanning every turret.
    forTurretsNear(t.x, t.y, TANK_RADIUS, (o) => {
      if (o.owner === t.owner) return;
      if (o.pendingEngineer) return;       // dirt placeholder, not real yet
      const dx = o.x - t.x, dy = o.y - t.y;
      if (dx * dx + dy * dy > TANK_R2) return;
      o.hp -= TANK_DPS * 0.7 * dt;
      if (Math.random() < tracerRate * 0.4 * dt) {
        state.tracers.push({
          x1: t.x, y1: t.y, x2: o.x, y2: o.y,
          age: 0, maxAge: 0.22, color: COLOR[t.owner],
        });
      }
    });
  }
  // Single cleanup pass for fleets killed by any tank this tick. Skipped
  // entirely when no tank scored a kill — pure regen-only ticks pay nothing.
  if (anyKill) {
    for (let i = state.fleets.length - 1; i >= 0; i--) {
      if (state.fleets[i]._dead) state.fleets.splice(i, 1);
    }
  }
}

// ---- Artillery — long-range INACCURATE AOE cannon ----
// Picks the densest enemy cluster within range, applies a random wobble to
// the aim, and lobs a shell that detonates in an AOE circle. Stacking many
// turrets at one point becomes a liability since one shell can wipe them.
export function updateArtillery(dt) {
  const artyTurrets = state.turretsByType.get('artillery');
  if (!artyTurrets) return;
  for (const t of artyTurrets) {
    if (!t.active) continue;
    if (t.artyCooldown === undefined) t.artyCooldown = ARTILLERY_INTERVAL;
    t.artyCooldown -= dt;
    if (t.artyCooldown > 0) continue;
    t.artyCooldown = ARTILLERY_INTERVAL;
    fireArtilleryShell(t);
  }
}

function fireArtilleryShell(t) {
  const cands = [];
  // Grid query saves scanning out-of-range turrets — ARTILLERY_RANGE 420 px
  // means a 4×4 cell window vs the whole turret array.
  forTurretsNear(t.x, t.y, ARTILLERY_RANGE, (e) => {
    if (e.owner === t.owner) return;
    if (e.pendingEngineer) return;          // dirt placeholder, not a real target
    const dx = e.x - t.x, dy = e.y - t.y;
    if (dx * dx + dy * dy > ARTILLERY_R2) return;
    cands.push({ x: e.x, y: e.y, weight: 2 });   // turrets worth more
  });
  // Ground fleets in range via grid (skips drones automatically — they're in
  // droneGrid). Massive saving when there are hundreds of fleets on the map.
  forGroundNear(t.x, t.y, ARTILLERY_RANGE, (f) => {
    if (f.owner === t.owner) return;
    const dx = f.x - t.x, dy = f.y - t.y;
    if (dx * dx + dy * dy > ARTILLERY_R2) return;
    cands.push({ x: f.x, y: f.y, weight: 1 });
  });
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
  // Grid query — AOE radius is small (~42 px) so only 1 cell typically touched.
  forTurretsNear(x, y, ARTILLERY_AOE, (t) => {
    if (t.owner === owner) return;
    if (t.pendingEngineer) return;          // nothing to destroy yet
    const dx = t.x - x, dy = t.y - y;
    if (dx * dx + dy * dy < ARTILLERY_AOE2) t.hp -= ARTILLERY_DAMAGE_TURRET;
  });
  // Ground fleets caught in the blast — small AOE radius means typically 1-2
  // grid cells touched. Drones are immune (separate grid).
  forGroundNear(x, y, ARTILLERY_AOE, (f) => {
    if (f.owner === owner) return;
    if (f._dead) return;       // already killed by an earlier overlapping shell
    const dx = f.x - x, dy = f.y - y;
    if (dx * dx + dy * dy >= ARTILLERY_AOE2) return;
    f.units -= ARTILLERY_DAMAGE_FLEET;
    if (f.units < 0.5) {
      addWreckBlockage(f);
      spawnScorch(f.x, f.y, 'medium');
      f._dead = true;
    }
  });
  // Cleanup dead fleets — full state.fleets scan only when something died.
  for (let i = state.fleets.length - 1; i >= 0; i--) {
    if (state.fleets[i]._dead) state.fleets.splice(i, 1);
  }
  spawnBigExplosion(x, y, '#ffcc66', 30);
  spawnScorch(x, y, 'big');
  state.tracers.push({
    x1: x, y1: y, x2: x, y2: y,
    age: 0, maxAge: 0.35, color: '#ffd066',
  });
}

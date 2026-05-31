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
  ARTILLERY_RANGE, ARTILLERY_MIN_RANGE, ARTILLERY_AOE, ARTILLERY_INTERVAL,
  ARTILLERY_INACCURACY, ARTILLERY_DAMAGE_TURRET, ARTILLERY_DAMAGE_FLEET,
  ARTILLERY_SHELL_FLIGHT,
  SHELL_CAP,
} from './config.js';
import { COLOR } from './factions.js';
import { addWreckBlockage, spawnBigExplosion, spawnScorch } from './engineering.js';
import { isWasmReady, wasmAaApplyDamage } from './wasm-bridge.js';
import { isAlly } from './alliance.js';

// Pre-squared radii — radius comparisons use dx²+dy² < r² to skip sqrt.
const AA_R2          = AA_RADIUS * AA_RADIUS;
const ARTILLERY_R2     = ARTILLERY_RANGE * ARTILLERY_RANGE;
const ARTILLERY_MIN_R2 = ARTILLERY_MIN_RANGE * ARTILLERY_MIN_RANGE;   // dead-zone (too close to hit)
const ARTILLERY_AOE2   = ARTILLERY_AOE * ARTILLERY_AOE;

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
  // AA is a flak MACHINE GUN, not a missile battery: it spits a rapid stream
  // of visible tracer ROUNDS at its target (rendered as travelling bullets in
  // render-atmosphere.drawTracers, tagged kind:'aa'). Cadence is high so the
  // stream reads as automatic fire; each round is short-lived.
  const AA_FIRE_RATE = 13;     // tracer rounds/sec per firing AA (machine-gun cadence)
  const AA_ROUND_AGE = 0.12;   // round lifetime — snappy, so bullets streak fast
  const aaTurrets = state.turretsByType.get('antiair');
  if (!aaTurrets) return;

  // WASM FAST PATH — batch all active AAs + all drones into one Rust call.
  // Rust builds its own drone grid + applies saturation damage. Tracers are
  // still spawned from JS afterward (visual-only, doesn't affect damage).
  if (isWasmReady()) {
    const activeAAs = [];
    for (const t of aaTurrets) if (t.active) activeAAs.push(t);
    const drones = [];
    for (const f of state.fleets) if (f.kind === 'drone') drones.push(f);
    const newHp = wasmAaApplyDamage(activeAAs, drones, AA_R2, AA_DPS, dt);
    if (newHp) {
      for (let i = 0; i < drones.length; i++) drones[i].hp = newHp[i];
      // Tracer pass — purely cosmetic machine-gun rounds, one per firing AA
      // per frame at the cadence above. Doesn't affect damage (Rust did that).
      const TRACER_PROB = AA_FIRE_RATE * dt;
      const aaRange = Math.ceil(AA_RADIUS / GRID_CELL);
      for (const t of activeAAs) {
        if (Math.random() > TRACER_PROB) continue;
        // pick the first in-range enemy drone for the beam endpoint
        const cx0 = Math.floor(t.x / GRID_CELL);
        const cy0 = Math.floor(t.y / GRID_CELL);
        let target = null;
        outer: for (let cx = cx0 - aaRange; cx <= cx0 + aaRange; cx++) {
          for (let cy = cy0 - aaRange; cy <= cy0 + aaRange; cy++) {
            const bucket = state.droneGrid.get(cx * 10000 + cy);
            if (!bucket) continue;
            for (const f of bucket) {
              if (isAlly(f.owner, t.owner)) continue;
              const dx = f.x - t.x, dy = f.y - t.y;
              if (dx * dx + dy * dy <= AA_R2) { target = f; break outer; }
            }
          }
        }
        if (target) {
          state.tracers.push({
            x1: t.x, y1: t.y, x2: target.x, y2: target.y,
            age: 0, maxAge: AA_ROUND_AGE, color: COLOR[t.owner], kind: 'aa',
          });
        }
      }
      return;
    }
  }

  // JS FALLBACK — original gridded path.
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
          if (isAlly(f.owner, t.owner)) continue;
          const dx = f.x - t.x, dy = f.y - t.y;
          if (dx * dx + dy * dy <= AA_R2) inRange.push(f);
        }
      }
    }
    if (inRange.length === 0) continue;
    const dpsPerTarget = AA_DPS / inRange.length;
    for (const f of inRange) f.hp -= dpsPerTarget * dt;
    // Machine-gun round at the cadence above, aimed at a random in-range drone.
    if (Math.random() < AA_FIRE_RATE * dt) {
      const f = inRange[(Math.random() * inRange.length) | 0];
      state.tracers.push({
        x1: t.x, y1: t.y, x2: f.x, y2: f.y,
        age: 0, maxAge: AA_ROUND_AGE, color: COLOR[t.owner], kind: 'aa',
      });
    }
  }
}

// ---- Tanks ----
// The static tank TURRET is gone: 'tank' is now a FACTORY building that rolls out
// MOBILE tank units. Their weapons (gun down enemy ground fleets, siege enemy
// turrets) + arrival bombard-siege live in tanks.updateGroundTanks, which main.js
// calls in this same combat-gated block. (Tank movement rides fleets.simulateFleets.)

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
  // Grid query saves scanning out-of-range turrets — the wide ARTILLERY_RANGE
  // touches a larger cell window than tank/AA but still skips the whole array.
  // Targets must sit in the ANNULUS [MIN_RANGE, RANGE]: beyond MAX is out of
  // reach, inside MIN is the high-arc dead zone (too close to lob a shell at).
  forTurretsNear(t.x, t.y, ARTILLERY_RANGE, (e) => {
    if (isAlly(e.owner, t.owner)) return;
    if (e.pendingEngineer) return;          // dirt placeholder, not a real target
    const dx = e.x - t.x, dy = e.y - t.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > ARTILLERY_R2 || d2 < ARTILLERY_MIN_R2) return;
    cands.push({ x: e.x, y: e.y, weight: 2 });   // turrets worth more
  });
  // Ground fleets in range via grid (skips drones automatically — they're in
  // droneGrid). Massive saving when there are hundreds of fleets on the map.
  forGroundNear(t.x, t.y, ARTILLERY_RANGE, (f) => {
    if (isAlly(f.owner, t.owner)) return;
    const dx = f.x - t.x, dy = f.y - t.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > ARTILLERY_R2 || d2 < ARTILLERY_MIN_R2) return;
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
  // FIFO budget: under normal play in-flight shells stay well under SHELL_CAP
  // (5 s ARTILLERY_INTERVAL × 0.7 s flight ≈ <1 shell per turret in air at
  // any moment). The cap is a saturation safety against pathological cases
  // (many artillery firing in lockstep). Front-trim is safe because the loop
  // iterates from the end; oldest shells are closest to impact so dropping
  // them is the smallest gameplay loss available.
  if (state.shells.length > SHELL_CAP) {
    state.shells.splice(0, state.shells.length - SHELL_CAP);
  }
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
    if (isAlly(t.owner, owner)) return;
    if (t.pendingEngineer) return;          // nothing to destroy yet
    const dx = t.x - x, dy = t.y - y;
    if (dx * dx + dy * dy < ARTILLERY_AOE2) t.hp -= ARTILLERY_DAMAGE_TURRET;
  });
  // Ground fleets caught in the blast — small AOE radius means typically 1-2
  // grid cells touched. Drones are immune (separate grid).
  forGroundNear(x, y, ARTILLERY_AOE, (f) => {
    if (isAlly(f.owner, owner)) return;
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

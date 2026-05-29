// =====================================================
// Scorch marks (殘骸 / 灰燼 / 燃燒) — cosmetic-only burn texture.
//
// Split out of `engineering.js` (which defends the buildings/edges/engineer
// boundary). This file owns the two-layer ground-scorch system and nothing
// else; it is pure visual texture, NEVER queried by AI, pathing, or collision.
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
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';

const MAX_ACTIVE_SCORCHES = 80;
// Scale lowered for the 12000×9000 world — at 0.5 the offscreen canvas
// would be 6000×4500 = 108 MB. 0.2 keeps it at 2400×1800 ≈ 17 MB which is
// still fine on desktop. Baked scorches lose a bit of fine detail (1 baked
// pixel ≈ 5 world px) but they're meant to be muddy smudges anyway.
const GROUND_SCORCH_SCALE = 0.2;

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

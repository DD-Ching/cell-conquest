// =====================================================
// Day/night ambiance — pure cosmetic screen-space tint.
//
// A slow global wash that drifts the whole scene dawn → noon → dusk → night
// and back, driven by state.dayPhase (0..1, advanced on REAL time in main.js
// so it's independent of game speed and NEVER read by sim/AI). This is an
// atmosphere layer only — explicitly NOT a mechanic (vision limits live in
// fog.js). Kept deliberately subtle so the Mars palette still reads.
//
// Drawn in SCREEN space (after the world transform is restored), as a single
// translucent fill over the whole canvas. Self-contained new module so it
// composes without touching the existing background gradient.
// =====================================================
import { state } from './state.js';

// Four anchor tints around the cycle. Alpha kept low — this is a veil, not a
// repaint. phase 0=dawn (warm), .25=noon (near-clear), .5=dusk (amber),
// .75=night (cool blue, deepest).
const KEYS = [
  { p: 0.00, r: 60,  g: 30,  b: 30,  a: 0.16 },   // dawn — warm rust haze
  { p: 0.25, r: 255, g: 240, b: 200, a: 0.04 },   // noon — bright, almost clear
  { p: 0.50, r: 80,  g: 38,  b: 22,  a: 0.18 },   // dusk — deep amber
  { p: 0.75, r: 18,  g: 24,  b: 52,  a: 0.34 },   // night — cool blue, darkest
];

function lerp(a, b, t) { return a + (b - a) * t; }

/** Interpolate the tint for the current dayPhase across the 4 anchors. */
function tintFor(phase) {
  const n = KEYS.length;
  // Find the segment [i, i+1] (wrapping) that phase falls in.
  let i = 0;
  for (let k = 0; k < n; k++) {
    const cur = KEYS[k].p;
    const nxt = (k + 1 < n) ? KEYS[k + 1].p : 1.0;
    if (phase >= cur && phase < nxt) { i = k; break; }
    if (k === n - 1) i = k;   // phase in [.75, 1) → night→dawn wrap
  }
  const a = KEYS[i];
  const b = KEYS[(i + 1) % n];
  const segStart = a.p;
  const segEnd = (i + 1 < n) ? KEYS[i + 1].p : 1.0;
  const t = segEnd > segStart ? (phase - segStart) / (segEnd - segStart) : 0;
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
    a: lerp(a.a, b.a, t),
  };
}

/** Paint the day/night veil over the whole screen (screen-space). */
export function drawDayNight(ctx, W, H) {
  const phase = state.dayPhase;
  if (phase == null) return;
  const c = tintFor(((phase % 1) + 1) % 1);
  if (c.a <= 0.002) return;
  ctx.save();
  ctx.fillStyle = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

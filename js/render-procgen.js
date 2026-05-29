// =====================================================
// Procgen tactical-map art — dark command-map ground layer + region labels.
//
// Only active when the geography-first generator ran (state.regions non-empty);
// legacy maps draw nothing. Renders the macro "sci-fi reconnaissance map" look
// BENEATH the faction turf wash / grid / roads / units:
//
//   • A static, BAKED offscreen (rebuilt only when the world changes) carries
//     everything that never moves: a dark command-map wash, muted per-region
//     terrain tint, faint topographic contour rings, seeded crater landmarks,
//     and the river/canyon channels. One drawImage per frame — cheap even at
//     40× late game (the spec's "cache static layers").
//   • Per frame we add only the region NAME labels (≤15 fillText), sized in
//     screen space and faded out as you zoom in so they read as atmospheric
//     sector names at the strategic overview.
//
// Worker-safe: render.js calls this in both contexts; the render snapshot ships
// state.regions / barriers / worldSeed, and the buffer uses OffscreenCanvas off
// the main thread.
//
// TODO(art pass 2): nodeType tactical icons, animated supply-route dashes,
// holographic scanline overlay, mountain-ridge silhouettes.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';
import { REGION_TINT, rgba } from './tactical-theme.js';

const TEX_MAX = 1400;                  // baked map long side (px) — fixed, world-size independent
let buf = null, bufW = 0, bufH = 0, scale = 1, bakedSig = null;

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h; return c;
  }
  return new OffscreenCanvas(w, h);
}

// Small seeded PRNG so the decorative craters are deterministic per world.
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sig() {
  return `${state.worldSeed}|${state.regions.length}|${WORLD_W}x${WORLD_H}`;
}

/** Bake the static tactical-map ground into the offscreen buffer (world coords
 *  via a scale transform, so all sizes below are in WORLD px). */
function bakeTacticalMap() {
  scale = TEX_MAX / Math.max(WORLD_W, WORLD_H);
  bufW = Math.max(1, Math.round(WORLD_W * scale));
  bufH = Math.max(1, Math.round(WORLD_H * scale));
  buf = makeCanvas(bufW, bufH);
  const c = buf.getContext('2d');
  c.clearRect(0, 0, bufW, bufH);
  c.save();
  c.scale(scale, scale);

  // 1) Command-map wash — a cool dark veil over the rust terrain for the
  //    serious "satellite recon" mood.
  c.fillStyle = 'rgba(10, 8, 14, 0.30)';
  c.fillRect(0, 0, WORLD_W, WORLD_H);

  // 2) Region zones — muted tint + faint topographic contour rings so each
  //    region reads as a controlled sector with elevation, not a flat patch.
  for (const r of state.regions) {
    const col = REGION_TINT[r.type] || '#6a6a78';
    const g = c.createRadialGradient(r.x, r.y, 0, r.x, r.y, r.radius);
    g.addColorStop(0,   rgba(col, 0.16));
    g.addColorStop(0.55, rgba(col, 0.07));
    g.addColorStop(1,   rgba(col, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(r.x, r.y, r.radius, 0, Math.PI * 2); c.fill();
    c.strokeStyle = rgba(col, 0.10);
    c.lineWidth = 2.5;                        // world px (ctx is scaled to world coords)
    for (let k = 1; k <= 3; k++) {
      c.beginPath(); c.arc(r.x, r.y, r.radius * (0.32 + 0.22 * k), 0, Math.PI * 2); c.stroke();
    }
  }

  // 3) Crater landmarks — seeded, scattered. Dark bowl + faint warm rim.
  const rng = mulberry32(((state.worldSeed || 1) ^ 0x9e3779b9) >>> 0);
  const craters = Math.round((WORLD_W * WORLD_H) / 9e6);
  for (let i = 0; i < craters; i++) {
    const x = rng() * WORLD_W, y = rng() * WORLD_H, rr = 120 + rng() * 280;
    c.fillStyle = 'rgba(8, 5, 4, 0.30)';
    c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(190, 135, 90, 0.10)';
    c.lineWidth = 3;
    c.beginPath(); c.arc(x, y, rr * 0.95, 0, Math.PI * 2); c.stroke();
  }

  // 4) Barriers — rivers/canyons as wide terrain channels (now baked).
  for (const bar of state.barriers) {
    const p = bar.points;
    if (!p || p.length < 2) continue;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) c.lineTo(p[i].x, p[i].y);
    const river = bar.kind === 'river';
    c.strokeStyle = river ? 'rgba(34, 60, 96, 0.50)' : 'rgba(24, 15, 10, 0.60)';
    c.lineWidth = 100; c.stroke();
    c.strokeStyle = river ? 'rgba(66, 116, 166, 0.55)' : 'rgba(12, 8, 6, 0.75)';
    c.lineWidth = 44; c.stroke();
    c.lineCap = 'butt'; c.lineJoin = 'miter';
  }

  c.restore();
  bakedSig = sig();
}

/** Bottom-layer tactical ground + sector-name labels. Call in WORLD space. */
export function drawProcgen(ctx, zoom) {
  if (!state.regions || !state.regions.length) return;   // legacy gen → nothing
  if (bakedSig !== sig() || !buf) bakeTacticalMap();
  ctx.drawImage(buf, 0, 0, WORLD_W, WORLD_H);

  // Sector names — faint, tracked, uppercase; fade out as you zoom in so they
  // stay an overview flourish, not clutter when fighting up close.
  const a = Math.max(0, Math.min(0.42, (0.55 - zoom) / 0.5));
  if (a <= 0.01) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = (4 / zoom) + 'px';
  for (const r of state.regions) {
    if (!r.name) continue;
    const f = 26 / zoom;
    ctx.font = `600 ${f}px -apple-system, system-ui, sans-serif`;
    const txt = r.name.toUpperCase();
    ctx.lineWidth = 4 / zoom;
    ctx.strokeStyle = `rgba(0, 0, 0, ${a * 0.85})`;
    ctx.strokeText(txt, r.x, r.y);
    ctx.fillStyle = `rgba(216, 208, 192, ${a})`;
    ctx.fillText(txt, r.x, r.y);
  }
  ctx.restore();
}

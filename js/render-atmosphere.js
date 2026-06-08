// =====================================================
// Atmosphere + environment layers — Mars dust, sand patches, craters,
// rocks, scorch marks, particles, AA tracer beams, weather, vignette.
//
// Two parts (the per-tick SIM/update half moved to atmosphere-sim.js):
//  1. Draw layers (background, terrain, hex grid, scorches, weather
//     haze, particles, tracers, world boundary, heat haze, vignette).
//  2. Private helpers (#region "private" at bottom) for shared
//     dust-layer drawing + small geometry utilities.
//
// The state-update half (makeSnow / updateSnow / updateParticles +
// makeDustLayer + the weather/dust advance helpers) lives in
// atmosphere-sim.js and is re-exported below so importers of this module
// keep their existing imports — those fns are presentation-only (they
// advance state ONLY the draw layers here read), not part of the sim.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';

// Re-export the per-tick atmosphere SIM half (split into a sibling so this
// file stays under the line cap). Keeps the public surface of this module
// unchanged: makeSnow / updateSnow / updateParticles / makeDustLayer remain
// importable from './render-atmosphere.js'.
export {
  makeSnow, updateSnow, updateParticles, makeDustLayer,
} from './atmosphere-sim.js';

// =====================================================
// Terrain bake — sand patches, craters, rocks are all completely static once
// placeTerrain finishes generating them. Replaying ~6000 ctx ops per frame is
// the largest render cost we can eliminate with one drawImage of a pre-baked
// half-res canvas. ~17 MB texture sits in VRAM; per frame is GPU bitblt.
// =====================================================
const TERRAIN_BAKE_SCALE = 0.2;   // 12000×9000 world → 2400×1800 offscreen ≈ 17 MB

export function bakeTerrain() {
  // Context-aware canvas allocation: in a Window we use the DOM, in a
  // Worker we use OffscreenCanvas (no `document`). Either is fine as a
  // drawImage source, so all downstream code (drawTerrain) works as-is.
  const W = Math.ceil(WORLD_W * TERRAIN_BAKE_SCALE);
  const H = Math.ceil(WORLD_H * TERRAIN_BAKE_SCALE);
  const hasDoc = typeof document !== 'undefined';
  console.log('[bakeTerrain] hasDoc=', hasDoc, 'has OffscreenCanvas=', typeof OffscreenCanvas !== 'undefined');
  let c;
  if (hasDoc) {
    c = document.createElement('canvas');
    c.width = W; c.height = H;
  } else {
    c = new OffscreenCanvas(W, H);
  }
  const bctx = c.getContext('2d');
  bctx.scale(TERRAIN_BAKE_SCALE, TERRAIN_BAKE_SCALE);

  // Patches first (largest), then craters, then rocks — matches the live-draw
  // painter order so transparency stacking is identical.
  for (const t of state.terrain) {
    if (t.kind !== 'patch') continue;
    const g = bctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, t.r);
    const inner = Math.floor(80 * t.shade);
    g.addColorStop(0, `rgba(${inner + 30}, ${Math.floor(inner * 0.55)}, ${Math.floor(inner * 0.30)}, 0.22)`);
    g.addColorStop(1, 'rgba(60, 30, 12, 0)');
    bctx.fillStyle = g;
    bctx.beginPath(); bctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); bctx.fill();
  }
  for (const t of state.terrain) {
    if (t.kind !== 'crater') continue;
    bctx.fillStyle = 'rgba(20, 10, 5, 0.45)';
    bctx.beginPath(); bctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); bctx.fill();
    bctx.strokeStyle = `rgba(${Math.floor(200 * t.shade)}, ${Math.floor(140 * t.shade)}, ${Math.floor(90 * t.shade)}, 0.35)`;
    bctx.lineWidth = 0.8 / TERRAIN_BAKE_SCALE;  // world-px line width inside the scaled bake ctx
    bctx.stroke();
  }
  for (const t of state.terrain) {
    if (t.kind !== 'rock') continue;
    bctx.fillStyle = `rgba(${Math.floor(30 * t.shade)}, ${Math.floor(18 * t.shade)}, ${Math.floor(10 * t.shade)}, 0.8)`;
    bctx.beginPath(); bctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); bctx.fill();
    bctx.fillStyle = `rgba(${Math.floor(180 * t.shade)}, ${Math.floor(120 * t.shade)}, ${Math.floor(80 * t.shade)}, 0.35)`;
    bctx.beginPath(); bctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.3, t.r * 0.5, 0, Math.PI * 2); bctx.fill();
  }
  state.bakedTerrain = c;
}

// =====================================================
// Draw layers — called by render() in painter order.
// =====================================================

// ---- Screen-space background (Mars surface + drifting dust) ----
export function drawBackground(ctx, W, H) {
  ctx.fillStyle = '#3d1f0e';
  ctx.fillRect(0, 0, W, H);
  // Soft warm haze toward the middle to add depth
  const haze = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.7);
  haze.addColorStop(0, 'rgba(120, 60, 25, 0.25)');
  haze.addColorStop(1, 'rgba(60, 30, 12, 0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, W, H);
  // Far parallax grit first (dimmer, behind), then foreground so near grit
  // visually occludes the far layer. Both are short horizontal streaks, not stars.
  drawDustStreaks(ctx, state.dustFar, 0.35);
  drawDustStreaks(ctx, state.dust, 0.55);
  ctx.globalAlpha = 1;
}

// ---- World-space ground terrain (sand patches, craters, rocks) ----
// Single drawImage blit of the pre-baked terrain canvas (see bakeTerrain()).
// All the per-feature ctx work has already happened off-frame.
export function drawTerrain(ctx, zoom) {
  if (state.bakedTerrain) {
    ctx.drawImage(state.bakedTerrain, 0, 0, WORLD_W, WORLD_H);
    return;
  }
  // Fallback path — bake not yet ready (shouldn't happen after newGame). Run
  // the live draw so the screen isn't blank during the one frame before bake.
  const { vL, vT, vR, vB } = state._view;
  for (const t of state.terrain) {
    if (t.kind !== 'patch') continue;
    if (t.x + t.r < vL || t.x - t.r > vR || t.y + t.r < vT || t.y - t.r > vB) continue;
    const g = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, t.r);
    const inner = Math.floor(80 * t.shade);
    g.addColorStop(0, `rgba(${inner + 30}, ${Math.floor(inner * 0.55)}, ${Math.floor(inner * 0.30)}, 0.22)`);
    g.addColorStop(1, 'rgba(60, 30, 12, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); ctx.fill();
  }
}

// ---- Hex grid watermark (faint tactical-map overlay, world-space) ----
// Drawn AFTER terrain, BEFORE scorches. Skipped at LOD < 2 — at low zoom the
// 80-px cells collapse to a moiré smear that reads as noise, not a grid, and
// the extra strokes aren't worth their cost when zoomed out.
const HEX_SIZE = 80;                  // world-px, flat-to-flat radius of a hex cell
export function drawHexGrid(ctx, zoom) {
  if (state._lod < 2) return;
  const { vL, vT, vR, vB } = state._view;
  // Pointy-top hex layout. Column spacing = 1.5*size, row spacing = sqrt(3)*size.
  const colStep = HEX_SIZE * 1.5;
  const rowStep = HEX_SIZE * Math.sqrt(3);
  ctx.strokeStyle = 'rgba(220, 180, 140, 0.025)';
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  // Iterate only the visible window of hex centres (+1 cell margin).
  const c0 = Math.floor(vL / colStep) - 1, c1 = Math.ceil(vR / colStep) + 1;
  const r0 = Math.floor(vT / rowStep) - 1, r1 = Math.ceil(vB / rowStep) + 1;
  for (let c = c0; c <= c1; c++) {
    const cx = c * colStep;
    const yOff = (c & 1) ? rowStep / 2 : 0;   // odd columns shift down half a row
    for (let r = r0; r <= r1; r++) {
      const cy = r * rowStep + yOff;
      strokeHex(ctx, cx, cy, HEX_SIZE);
    }
  }
  ctx.stroke();
}

// ---- Weather haze (full-screen rust overlay, world-space, before units) ----
// A single fillRect with a rust gradient — one cheap call per frame. Alpha
// tracks weather intensity (capped 0.35) so a sand storm visibly thickens the
// air WITHOUT touching any gameplay query. Drawn over terrain/scorches but
// under units so the world recedes into the murk.
export function drawWeatherHaze(ctx, zoom) {
  const intensity = state.weather ? state.weather.intensity : 0;
  if (intensity <= 0.05) return;
  const a = Math.min(0.35, intensity * 0.5);
  const { vL, vT, vR, vB } = state._view;
  // Subtle vertical gradient: thicker at the horizon (top) than the foreground.
  const g = ctx.createLinearGradient(0, vT, 0, vB);
  g.addColorStop(0, `rgba(150, 80, 38, ${a})`);
  g.addColorStop(1, `rgba(120, 62, 28, ${a * 0.7})`);
  ctx.fillStyle = g;
  ctx.fillRect(vL, vT, vR - vL, vB - vT);
}

// ---- Scorch marks: permanent ground-baked layer + currently-burning marks ----
// See engineering.js (spawnScorch / updateScorches / bakeScorchToGround).
export function drawScorches(ctx, zoom, now) {
  if (state.groundScorch) {
    ctx.drawImage(state.groundScorch, 0, 0, WORLD_W, WORLD_H);
  }
  // Baked layer already covers the map; the per-frame active-scorch radial
  // gradients are decorations not worth their cost when zoomed out.
  if (state._lod < 2) return;
  const { vL, vT, vR, vB } = state._view;
  for (const s of state.scorches) {
    if (s.x + s.r < vL || s.x - s.r > vR || s.y + s.r < vT || s.y - s.r > vB) continue;
    // Constant-alpha smudge — same gradient as the baked version so the
    // active→baked handoff is pixel-identical (no visual pop).
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.rot);
    const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, s.r);
    sg.addColorStop(0,    'rgba(8, 4, 2, 0.78)');
    sg.addColorStop(0.55, 'rgba(22, 11, 5, 0.48)');
    sg.addColorStop(1,    'rgba(60, 30, 15, 0)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.ellipse(0, 0, s.r, s.r * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Flickering ember glow during the burning phase (first ~65% of life)
    const burnFrac = Math.max(0, 1 - s.age / (s.maxAge * 0.65));
    if (burnFrac > 0) {
      const flick = 0.55 + 0.45 * Math.sin(now / 70 + s.x * 0.13 + s.y * 0.07);
      const gR = s.r * 0.42 * (0.85 + flick * 0.18);
      const gg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, gR);
      gg.addColorStop(0, `rgba(255, 170, 70, ${0.55 * burnFrac * flick})`);
      gg.addColorStop(0.55, `rgba(255, 110, 35, ${0.25 * burnFrac * flick})`);
      gg.addColorStop(1, 'rgba(255, 80, 20, 0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(s.x, s.y, gR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---- World boundary (subtle dashed border so player knows where the map ends) ----
export function drawWorldBoundary(ctx, zoom) {
  ctx.strokeStyle = 'rgba(180, 130, 80, 0.18)';
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([8 / zoom, 6 / zoom]);
  ctx.strokeRect(0, 0, WORLD_W, WORLD_H);
  ctx.setLineDash([]);
}

// ---- AA tracer beams (drawn before nodes/turrets so beams pass behind icons) ----
export function drawTracers(ctx, zoom) {
  // Tracers are sub-frame flashes. The cheap beam tracers (tank/drone) aren't
  // worth drawing at low zoom (single pixel of dust) — but AA machine-gun rounds
  // are the readable "the flak guns are FIRING" signal the player wants to see,
  // so those keep drawing even zoomed out (just view-culled).
  const lowLod = state._lod < 2;
  const { vL, vT, vR, vB } = state._view;
  for (const t of state.tracers) {
    if (lowLod && t.kind !== 'aa') continue;
    if (Math.max(t.x1, t.x2) < vL || Math.min(t.x1, t.x2) > vR ||
        Math.max(t.y1, t.y2) < vT || Math.min(t.y1, t.y2) > vB) continue;
    const p = t.age / t.maxAge;          // 0 at muzzle → 1 at target
    if (t.kind === 'aa') {
      // Machine-gun tracer ROUND: a bright streak travelling from the gun to
      // the drone + a muzzle flash at the barrel. A rapid stream of these reads
      // as automatic flak fire and lets you actually see the individual rounds.
      const bx = t.x1 + (t.x2 - t.x1) * p;
      const by = t.y1 + (t.y2 - t.y1) * p;
      let dx = t.x2 - t.x1, dy = t.y2 - t.y1;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const streak = 14;                 // streak tail length (world px)
      ctx.strokeStyle = t.color;
      ctx.globalAlpha = 0.95 * (1 - p * 0.4);
      ctx.lineWidth = 2.2 / zoom;
      ctx.beginPath();
      ctx.moveTo(bx - dx * streak, by - dy * streak);
      ctx.lineTo(bx, by);
      ctx.stroke();
      // white-hot bullet tip
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = 0.9 * (1 - p);
      ctx.beginPath();
      ctx.arc(bx, by, 1.8 / zoom, 0, Math.PI * 2);
      ctx.fill();
      // muzzle flash, brightest the instant the round leaves the barrel
      if (p < 0.35) {
        ctx.fillStyle = '#ffe08a';
        ctx.globalAlpha = (0.35 - p) / 0.35 * 0.8;
        ctx.beginPath();
        ctx.arc(t.x1, t.y1, 3.2 / zoom, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    // Default beam (tank shells, drone tracers): a fading line.
    const a = 1 - p;
    ctx.strokeStyle = t.color;
    ctx.globalAlpha = a * 0.85;
    ctx.lineWidth = (1.0 + 1.5 * a) / zoom;
    ctx.beginPath();
    ctx.moveTo(t.x1, t.y1);
    ctx.lineTo(t.x2, t.y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ---- Particles (life-based alpha fade) ----
// Branched by p.kind so different events read differently. Untagged particles
// (embers / smoke from scorches) fall through to the default circle shape so
// glowing dots and rising ash still look right.
//   'impact'    — rotated speck square (small combat hits)
//   'explosion' — circle + outer halo (big bangs, drone impacts)
//   'capture'   — expanding ring (no fill) for node ownership change
//   'dust'      — short elongated streak oriented along velocity
//   (none)      — circle (default)
// Hot path: thousands of particles per frame in late game. Branch must be
// allocation-free; `p.rot` is lazy-initialized so the spawn site doesn't
// pay Math.random() for kinds that don't read it.
const TAU = Math.PI * 2;
export function drawParticles(ctx, zoom) {
  // Particles are 2-3 px specks — drop them at low zoom.
  if (state._lod < 2) return;
  const { vL, vT, vR, vB } = state._view;
  const r = 2 / zoom;                            // base draw radius (zoom-stable)
  for (const p of state.particles) {
    if (p.x < vL || p.x > vR || p.y < vT || p.y > vB) continue;
    const a = p.life / p.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    const k = p.kind;
    if (k === 'impact') {
      // Tiny rotated square — debris fleck.
      if (p.rot === undefined) p.rot = Math.random() * TAU;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const s = 1.5 / zoom;
      ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.restore();
    } else if (k === 'explosion') {
      // Core + faint outer halo so the bang reads bigger than a flat dot.
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = a * 0.3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.8, 0, TAU);
      ctx.fill();
    } else if (k === 'capture') {
      // Expanding ring — radius grows as life drains. Stroked (no fill).
      const ringR = (1 - a) * 18 / zoom;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.2 / zoom;
      ctx.beginPath();
      ctx.arc(p.x, p.y, ringR, 0, TAU);
      ctx.stroke();
    } else if (k === 'dust') {
      // Elongated streak oriented along the velocity vector.
      const rot = Math.atan2(p.vy, p.vx);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(rot);
      ctx.fillRect(-1.5 / zoom, -0.5 / zoom, 3 / zoom, 1 / zoom);
      ctx.restore();
    } else {
      // Default (no kind) — original circle. Used by embers / smoke / etc.
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ---- Heat haze near combat (world-space, additive shimmer over hotspots) ----
// Where lots of fresh tracers cluster (active firefight), lay a faint warm
// brightness bloom that pulses — a cheap stand-in for air distortion. Capped
// at HEAT_MAX hotspots/frame and skipped at LOD < 2 so cost stays bounded.
const HEAT_MAX = 10;
export function drawHeatHaze(ctx, zoom, now) {
  if (state._lod < 2) return;
  const tracers = state.tracers;
  if (!tracers || tracers.length === 0) return;
  const { vL, vT, vR, vB } = state._view;
  ctx.globalCompositeOperation = 'lighter';
  let drawn = 0;
  for (let i = 0; i < tracers.length && drawn < HEAT_MAX; i++) {
    const t = tracers[i];
    // Only fresh tracers (firefight still hot) — old ones are nearly faded.
    const heat = 1 - t.age / t.maxAge;
    if (heat < 0.5) continue;
    // Hotspot at the muzzle end (x1,y1 = the firing turret).
    const x = t.x1, y = t.y1;
    if (x < vL || x > vR || y < vT || y > vB) continue;
    const pulse = 0.6 + 0.4 * Math.sin(now / 90 + x * 0.05 + y * 0.03);
    const R = 34 + 10 * pulse;
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, `rgba(255, 180, 120, ${0.06 * heat * pulse})`);
    g.addColorStop(1, 'rgba(255, 150, 90, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    drawn++;
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ---- Vignette (screen-space, drawn LAST before HUD) ----
// Full-screen radial darkening at the edges — focuses the eye on the centre
// and seats the bright Mars surface inside a deep frame. MUST be called
// OUTSIDE the world transform (screen coords): one fillRect with a cached-ish
// radial gradient, ~free per frame.
export function drawVignette(ctx, W, H) {
  const g = ctx.createRadialGradient(
    W * 0.5, H * 0.5, Math.min(W, H) * 0.32,
    W * 0.5, H * 0.5, Math.max(W, H) * 0.72,
  );
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(10, 5, 2, 0.55)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// =====================================================
// Private helpers — not part of the render() painter order. Shared dust-layer
// drawing + small geometry utilities. Kept down here so the public draw layers
// above read top-to-bottom in z-order. (The dust/weather/particle advance
// helpers that feed these layers live in atmosphere-sim.js.)
// =====================================================

// Render one dust layer as wind-blown horizontal streaks. alphaMul dims the
// far layer relative to the foreground for depth separation.
function drawDustStreaks(ctx, arr, alphaMul) {
  if (!arr) return;
  for (const s of arr) {
    ctx.globalAlpha = s.a * alphaMul;
    ctx.fillStyle = `hsl(${s.hue}, 50%, 45%)`;
    ctx.fillRect(s.x, s.y, s.r * 1.4, 0.6);
  }
}

// Append one pointy-top hexagon's outline to the current path (single stroke
// for the whole grid keeps it to one GPU call).
function strokeHex(ctx, cx, cy, size) {
  for (let i = 0; i < 6; i++) {
    const ang = Math.PI / 180 * (60 * i - 30);
    const x = cx + size * Math.cos(ang);
    const y = cy + size * Math.sin(ang);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// =====================================================
// Atmosphere + environment layers — Mars dust, sand patches, craters,
// rocks, scorch marks, particles, AA tracer beams.
//
// Two parts:
//  1. State-update helpers (makeSnow / updateSnow / updateParticles) —
//     not draw fns, but presentation-only so they live here, not in sim.
//  2. Draw layers (background, terrain, scorches, particles, tracers,
//     world boundary).
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';

// =====================================================
// Terrain bake — sand patches, craters, rocks are all completely static once
// placeTerrain finishes generating them. Replaying ~6000 ctx ops per frame is
// the largest render cost we can eliminate with one drawImage of a pre-baked
// half-res canvas. ~17 MB texture sits in VRAM; per frame is GPU bitblt.
// =====================================================
const TERRAIN_BAKE_SCALE = 0.2;   // 12000×9000 world → 2400×1800 offscreen ≈ 17 MB

export function bakeTerrain() {
  const c = document.createElement('canvas');
  c.width  = Math.ceil(WORLD_W * TERRAIN_BAKE_SCALE);
  c.height = Math.ceil(WORLD_H * TERRAIN_BAKE_SCALE);
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
// Atmosphere lifecycle (dust + particles)
// =====================================================

// Mars dust — drifts mostly sideways with slow vertical haze.
export function makeSnow() {
  state.dust = [];
  const count = Math.floor((state.W * state.H) / 14000);
  for (let i = 0; i < count; i++) {
    state.dust.push({
      x: Math.random() * state.W, y: Math.random() * state.H,
      vx: 18 + Math.random() * 30,            // wind blowing right
      vy: -4 + Math.random() * 10,            // slight vertical drift
      r: 0.5 + Math.random() * 1.4,
      a: 0.18 + Math.random() * 0.4,
      drift: Math.random() * Math.PI * 2,
      hue: 18 + Math.random() * 22,           // 18..40 = sandy orange range
    });
  }
}

export function updateSnow(dt) {
  for (const s of state.dust) {
    s.x += (s.vx + Math.sin(performance.now() / 1500 + s.drift) * 4) * dt;
    s.y += s.vy * dt;
    if (s.x > state.W + 5) { s.x = -5; s.y = Math.random() * state.H; }
    if (s.x < -5) s.x = state.W + 5;
    if (s.y > state.H + 5) s.y = -5;
    if (s.y < -5) s.y = state.H + 5;
  }
}

export function updateParticles(dt) {
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.95; p.vy *= 0.95;
    p.life -= dt;
    if (p.life <= 0) state.particles.splice(i, 1);
  }
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
  // Wind-blown grit — short horizontal streaks, not stars
  for (const s of state.dust) {
    ctx.globalAlpha = s.a * 0.55;
    ctx.fillStyle = `hsl(${s.hue}, 50%, 45%)`;
    ctx.fillRect(s.x, s.y, s.r * 1.4, 0.6);
  }
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
  // Tracers are sub-frame flashes — at low zoom they're a single pixel of dust
  // and not worth the per-frame draw cost.
  if (state._lod < 2) return;
  const { vL, vT, vR, vB } = state._view;
  for (const t of state.tracers) {
    if (Math.max(t.x1, t.x2) < vL || Math.min(t.x1, t.x2) > vR ||
        Math.max(t.y1, t.y2) < vT || Math.min(t.y1, t.y2) > vB) continue;
    const a = 1 - t.age / t.maxAge;
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
export function drawParticles(ctx, zoom) {
  // Particles are 2-3 px specks — drop them at low zoom.
  if (state._lod < 2) return;
  const { vL, vT, vR, vB } = state._view;
  for (const p of state.particles) {
    if (p.x < vL || p.x > vR || p.y < vT || p.y > vB) continue;
    const a = p.life / p.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2 / zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// =====================================================
// All canvas rendering: main view + minimap + HUD updates.
// Reads from state; never mutates game data (only DOM + canvas).
//
// Organization:
//   • HUD (DOM-side faction roster / timer / zoom)
//   • Atmosphere helpers (dust + particle update — happen each tick but
//     they're presentation-only so they live here, not in the sim)
//   • Layer renderers — each one paints a single visual layer in world or
//     screen space, taking (ctx, ...) explicitly. Top-level render() is
//     just orchestration: it sets up the canvas + transforms and calls
//     the layers in painter order.
//   • drawDragPreview, renderMinimap kept as-is at the bottom.
// =====================================================
import { state } from './state.js';
import {
  WORLD_W, WORLD_H, AA_RADIUS, TANK_RADIUS, DRONE_HP_AIR,
  NET_PICK_R, NET_LEVEL_MAX, ARTILLERY_INTERVAL, ARTILLERY_AOE,
} from './config.js';
import { COLOR, GLOW, FACTIONS, factionStats } from './factions.js';
import { dist, formatTime } from './util.js';
import { findPath, nodeAt, roadAt } from './world.js';
import { getEdge, edgeVisualBlockage, TURRET_RANGES } from './engineering.js';
import {
  drawRoadStyled, drawTroopSprite, drawEngineerSprite, drawDroneSprite,
  drawAATurret, drawTankTurret, drawFactoryTurret, drawArtilleryTurret,
} from './sprites.js';

// =====================================================
// HUD (DOM)
// =====================================================
// Cached DOM refs — populated by buildHUD, reused by updateHUD so we don't
// re-getElementById 10+ times per frame.
const _hudEls = { unitsByFaction: {}, nodesByFaction: {}, timer: null, zoom: null, speed: null };
let _hudLastT = 0;

export function buildHUD() {
  const hud = document.getElementById('hud');
  if (!hud) return;
  hud.innerHTML = '<div class="hud-header">Forces</div>';
  for (const f of FACTIONS) {
    if (f.id === 'neutral') continue;     // neutral isn't a competing force
    const stats = factionStats[f.id];
    const strength = stats ? stats.strength : 1.0;
    const fillPct = Math.max(0, Math.min(100, ((strength - 0.5) / 1.0) * 100));
    const isPlayer = f.id === 'player';
    const tag = isPlayer ? 'BASE' : (
      strength >= 1.15 ? 'STRONG'
      : strength >= 1.00 ? 'STEADY'
      : 'WEAK'
    );
    const row = document.createElement('div');
    row.className = 'faction-row';
    row.style.color = f.color;
    row.innerHTML = `
      <span class="swatch" style="background:${f.color}"></span>
      <span class="name" style="color:${f.color}">${f.name}</span>
      <span class="stats">
        <span class="u" id="${f.id}-units">0</span><span class="lbl">u</span>
        <span class="n" id="${f.id}-nodes">0</span><span class="lbl">n</span>
      </span>
      <div class="strength-row" title="${isPlayer ? 'You (baseline)' : `Strength: ${strength.toFixed(2)} — ${tag}`}">
        <div class="fill" style="width:${fillPct}%; color:${f.color}"></div>
      </div>
    `;
    hud.appendChild(row);
  }
  // Resolve all the per-update DOM refs once. updateHUD reads from the cache.
  _hudEls.unitsByFaction = {};
  _hudEls.nodesByFaction = {};
  for (const f of FACTIONS) {
    _hudEls.unitsByFaction[f.id] = document.getElementById(`${f.id}-units`);
    _hudEls.nodesByFaction[f.id] = document.getElementById(`${f.id}-nodes`);
  }
  _hudEls.timer = document.getElementById('timer');
  _hudEls.zoom  = document.getElementById('zoom');
  _hudEls.speed = document.getElementById('speed');
  _hudLastT = 0;
}

export function updateHUD() {
  // Throttle to ~10 Hz. HUD counters changing 60×/sec aren't noticeably more
  // responsive than 10×/sec, and DOM writes are real per-frame work.
  const now = performance.now();
  if (now - _hudLastT < 100) return;
  _hudLastT = now;

  const c = {};
  for (const f of FACTIONS) c[f.id] = [0, 0];
  for (const n of state.nodes) {
    c[n.owner][0] += n.units;
    c[n.owner][1] += 1;
  }
  for (const f of state.fleets) if (c[f.owner]) c[f.owner][0] += (f.units || 0);
  for (const f of FACTIONS) {
    const u = _hudEls.unitsByFaction[f.id];
    const ns = _hudEls.nodesByFaction[f.id];
    if (u) u.textContent = Math.floor(c[f.id][0]);
    if (ns) ns.textContent = c[f.id][1];
  }
  if (_hudEls.timer) _hudEls.timer.textContent = formatTime(state.elapsed);
  if (_hudEls.zoom)  _hudEls.zoom.textContent  = `${Math.round(state.zoom * 100)}%`;
  if (_hudEls.speed) _hudEls.speed.textContent = `Speed ${state.timeScale}×`;
}

// =====================================================
// Atmosphere
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
// Layer renderers — called by render() in painter order.
// Each one is responsible for ONE visual layer and reads from state.
// =====================================================

// ---- Screen-space background (Mars surface + drifting dust) ----
function drawBackground(ctx, W, H) {
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
function drawTerrain(ctx, zoom) {
  const { vL, vT, vR, vB } = state._view;
  // Big soft sand patches first
  for (const t of state.terrain) {
    if (t.kind !== 'patch') continue;
    if (t.x + t.r < vL || t.x - t.r > vR || t.y + t.r < vT || t.y - t.r > vB) continue;
    const g = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, t.r);
    const inner = Math.floor(80 * t.shade);
    g.addColorStop(0, `rgba(${inner + 30}, ${Math.floor(inner * 0.55)}, ${Math.floor(inner * 0.30)}, 0.22)`);
    g.addColorStop(1, 'rgba(60, 30, 12, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Then craters (slightly raised dark rim + darker inside)
  for (const t of state.terrain) {
    if (t.kind !== 'crater') continue;
    if (t.x + t.r < vL || t.x - t.r > vR || t.y + t.r < vT || t.y - t.r > vB) continue;
    ctx.fillStyle = 'rgba(20, 10, 5, 0.45)';
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${Math.floor(200 * t.shade)}, ${Math.floor(140 * t.shade)}, ${Math.floor(90 * t.shade)}, 0.35)`;
    ctx.lineWidth = 0.8 / zoom;
    ctx.stroke();
  }
  // Rocks are sub-3-px specks at low zoom — invisible anyway, skip.
  if (state._lod < 3) return;
  for (const t of state.terrain) {
    if (t.kind !== 'rock') continue;
    if (t.x + t.r < vL || t.x - t.r > vR || t.y + t.r < vT || t.y - t.r > vB) continue;
    ctx.fillStyle = `rgba(${Math.floor(30 * t.shade)}, ${Math.floor(18 * t.shade)}, ${Math.floor(10 * t.shade)}, 0.8)`;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${Math.floor(180 * t.shade)}, ${Math.floor(120 * t.shade)}, ${Math.floor(80 * t.shade)}, 0.35)`;
    ctx.beginPath();
    ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.3, t.r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- Scorch marks: permanent ground-baked layer + currently-burning marks ----
// See engineering.js (spawnScorch / updateScorches / bakeScorchToGround).
function drawScorches(ctx, zoom, now) {
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
function drawWorldBoundary(ctx, zoom) {
  ctx.strokeStyle = 'rgba(180, 130, 80, 0.18)';
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([8 / zoom, 6 / zoom]);
  ctx.strokeRect(0, 0, WORLD_W, WORLD_H);
  ctx.setLineDash([]);
}

// ---- Roads (TD-style path with sand-tint blockage readout) ----
function drawRoads(ctx, zoom) {
  const { vL, vT, vR, vB } = state._view;
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    // Segment-AABB cull
    if (Math.max(a.x, b.x) < vL || Math.min(a.x, b.x) > vR ||
        Math.max(a.y, b.y) < vT || Math.min(a.y, b.y) > vB) continue;
    const e = getEdge(r.a, r.b);
    // Tint derived purely from pile count — visual readout of congestion,
    // not a speed multiplier (slowdown comes from physical detour).
    drawRoadStyled(ctx, a, b, edgeVisualBlockage(e), zoom);
  }
}

// ---- Wreck piles (physical debris fleets must steer around) ----
function drawWreckPiles(ctx, zoom) {
  const { vL, vT, vR, vB } = state._view;
  const lowLOD = state._lod < 2;
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    // Edge-AABB cull on the parent road — wrecks live on the segment
    if (Math.max(a.x, b.x) < vL || Math.min(a.x, b.x) > vR ||
        Math.max(a.y, b.y) < vT || Math.min(a.y, b.y) > vB) continue;
    const e = getEdge(r.a, r.b);
    if (!e || !e.wrecks || e.wrecks.length === 0) continue;
    if (lowLOD) {
      // Match WRECK_RENDER_R = 8 so the pile footprint stays the same as
      // the detailed render — a road full of wrecks looks just as choked
      // at low zoom as at high zoom.
      ctx.fillStyle = 'rgba(20, 10, 4, 0.75)';
      for (const w of e.wrecks) ctx.fillRect(w.x - 8, w.y - 8, 16, 16);
      continue;
    }
    for (const w of e.wrecks) {
      const hpFrac = Math.max(0.4, w.hp / w.hpMax);   // fades while being cleared
      ctx.save();
      ctx.translate(w.x, w.y);
      ctx.rotate(w.rot);
      // Soot halo on the sand around the pile
      ctx.fillStyle = `rgba(20, 10, 4, ${0.55 * hpFrac})`;
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.fill();
      // Twisted-metal chunk (dark core)
      ctx.fillStyle = `rgba(40, 24, 12, ${hpFrac})`;
      ctx.fillRect(-7, -5, 14, 10);
      ctx.fillStyle = `rgba(70, 42, 22, ${hpFrac})`;
      ctx.fillRect(-5, -3, 10, 6);
      // Tiny orange ember speck — still-smoldering hint
      ctx.fillStyle = `rgba(255, 130, 50, ${0.7 * hpFrac})`;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    }
  }
}

// ---- Drone nets (faction-agnostic edge fences with charge readout) ----
function drawNets(ctx, zoom) {
  const NET_COLOR = '#e8d6a8';
  for (const r of state.roads) {
    const e = getEdge(r.a, r.b);
    if (!e || e.netLevel <= 0) continue;
    const a = state.nodes[r.a], b = state.nodes[r.b];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;                    // perpendicular unit vector
    const off = 6;
    const x1 = a.x + px * off, y1 = a.y + py * off;
    const x2 = b.x + px * off, y2 = b.y + py * off;
    const maxCh = 60;                           // NET_CHARGES_LEVEL[NET_LEVEL_MAX] = 60
    const chargeFrac = Math.max(0.25, Math.min(1, e.netCharges / maxCh));
    ctx.strokeStyle = NET_COLOR;
    ctx.globalAlpha = 0.55 + 0.4 * chargeFrac;
    ctx.lineWidth = (1.1 + e.netLevel * 0.6) / zoom;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    // Fence-post ticks along the net
    const tickSpacing = 22;
    const nTicks = Math.max(1, Math.floor(len / tickSpacing));
    const tickH = 2 + e.netLevel * 0.6;
    for (let k = 0; k < nTicks; k++) {
      const t = (k + 0.5) / nTicks;
      const cx = a.x * (1 - t) + b.x * t + px * off;
      const cy = a.y * (1 - t) + b.y * t + py * off;
      ctx.beginPath();
      ctx.moveTo(cx + px * tickH, cy + py * tickH);
      ctx.lineTo(cx - px * tickH, cy - py * tickH);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Compact label near the midpoint
    const mx = (a.x + b.x) / 2 + px * (off + 10);
    const my = (a.y + b.y) / 2 + py * (off + 10);
    ctx.fillStyle = NET_COLOR;
    ctx.font = `bold ${10 / zoom}px ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`L${e.netLevel} ${e.netCharges}`, mx, my);
  }
}

// ---- Artillery shells in flight (parabolic arc + impact-warning ring) ----
function drawShells(ctx, zoom) {
  const { vL, vT, vR, vB } = state._view;
  for (const s of state.shells) {
    // Segment-AABB cull: skip if both endpoints are wholly to one side of view.
    // Impact ring at (x2,y2) needs ARTILLERY_AOE margin.
    const aoe = ARTILLERY_AOE;
    if (Math.max(s.x1, s.x2 + aoe) < vL || Math.min(s.x1, s.x2 - aoe) > vR ||
        Math.max(s.y1, s.y2 + aoe) < vT || Math.min(s.y1, s.y2 - aoe) > vB) continue;
    const p = Math.min(1, s.t / s.maxT);
    const lx = s.x1 + (s.x2 - s.x1) * p;
    const ly = s.y1 + (s.y2 - s.y1) * p - 50 * Math.sin(p * Math.PI);
    // Trail
    ctx.strokeStyle = 'rgba(255, 220, 130, 0.55)';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1); ctx.lineTo(lx, ly);
    ctx.stroke();
    // Shell head
    ctx.fillStyle = '#ffe080';
    ctx.beginPath(); ctx.arc(lx, ly, 2.2, 0, Math.PI * 2); ctx.fill();
    // Impact-warning ring at target (grows + brightens as shell approaches)
    const warn = p;
    ctx.strokeStyle = `rgba(255, 180, 80, ${0.35 + warn * 0.5})`;
    ctx.lineWidth = (1 + warn * 1.5) / zoom;
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.beginPath();
    ctx.arc(s.x2, s.y2, ARTILLERY_AOE, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---- AA tracer beams (drawn before nodes/turrets so beams pass behind icons) ----
function drawTracers(ctx, zoom) {
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

// ---- Fleet trails (faint line from fleet to its next segment node) ----
function drawFleetTrails(ctx, zoom) {
  if (state._lod < 2) return;            // skip decoration at low zoom
  for (const f of state.fleets) {
    if (f.kind === 'drone') continue;
    if (!f.path || f.segIdx >= f.path.length - 1) continue;
    const segB = state.nodes[f.path[f.segIdx + 1]];
    ctx.strokeStyle = COLOR[f.owner] + '40';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.lineTo(segB.x, segB.y);
    ctx.stroke();
  }
}

// ---- Range rings around active AA / tank / artillery turrets ----
function drawRangeRings(ctx, zoom) {
  if (state._lod < 2) return;            // dashed rings invisible when tiny
  for (const t of state.turrets) {
    if (!t.active) continue;
    const r = TURRET_RANGES[t.type];
    if (!r) continue;
    const alpha = t.type === 'tank' ? '50' : '30';
    ctx.strokeStyle = COLOR[t.owner] + alpha;
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([6 / zoom, 6 / zoom]);
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---- Nodes (fortified compounds: rim, glow, inner structures, count) ----
function drawNodes(ctx, zoom, now) {
  const { vL, vT, vR, vB } = state._view;
  for (const n of state.nodes) {
    // Nodes have a 2.4× glow halo around them — cull with that margin.
    const halo = n.size * 2.4;
    if (n.x + halo < vL || n.x - halo > vR || n.y + halo < vT || n.y - halo > vB) continue;
    const degree = state.adj.get(n.id)?.size || 0;

    // Outer glow halo
    const grad = ctx.createRadialGradient(n.x, n.y, n.size * 0.5, n.x, n.y, n.size * 2.4);
    grad.addColorStop(0, GLOW[n.owner]);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size * 2.4, 0, Math.PI * 2);
    ctx.fill();

    // Capture pulse (one-shot animation)
    if (n.pulse > 0) {
      ctx.strokeStyle = COLOR[n.owner];
      ctx.globalAlpha = n.pulse;
      ctx.lineWidth = 2 / zoom;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size + (1 - n.pulse) * 28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Ambient breathing pulse — owned nodes feel alive (different phase per node)
    if (n.owner !== 'neutral') {
      const breath = 0.35 + 0.25 * Math.sin(now / 600 + n.id * 0.7);
      ctx.strokeStyle = COLOR[n.owner];
      ctx.globalAlpha = breath * 0.45;
      ctx.lineWidth = 1.5 / zoom;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size + 3 + breath * 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (state.selectedIds.has(n.id)) {
      ctx.strokeStyle = '#fff';
      ctx.globalAlpha = 0.65 + Math.sin(now / 180) * 0.25;
      ctx.lineWidth = 2 / zoom;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Faction rim
    ctx.fillStyle = COLOR[n.owner];
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
    ctx.fill();

    // Dark inner compound
    ctx.fillStyle = 'rgba(15, 8, 4, 0.7)';
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size - 4, 0, Math.PI * 2);
    ctx.fill();

    // Inner "buildings": small dots around perimeter inside the dark area.
    // Density scales with hub degree — bigger hubs look more substantial.
    if (degree > 0) {
      const buildings = Math.min(8, Math.max(3, degree + 2));
      const innerR = n.size - 8;
      const slowSpin = now / 6000;       // very slow rotation
      for (let k = 0; k < buildings; k++) {
        const a = slowSpin + (k / buildings) * Math.PI * 2;
        const bx = n.x + Math.cos(a) * innerR;
        const by = n.y + Math.sin(a) * innerR;
        ctx.fillStyle = COLOR[n.owner];
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.arc(bx, by, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    if (n.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${n.flash * 0.45})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Unit count label centered in compound
    ctx.fillStyle = '#fff';
    const screenFont = Math.max(15, Math.min(28, n.size * 0.85 * zoom));
    const worldFont = screenFont / zoom;
    ctx.font = `bold ${worldFont}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.floor(n.units), n.x, n.y);

    if (n.engineers > 0) {
      const ex = n.x - n.size - 4;
      const ey = n.y + n.size + 4;
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${10 / zoom}px sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('🔧' + n.engineers, ex, ey);
    }
    if (n.flashBuild > 0) {
      ctx.strokeStyle = `rgba(255,220,140,${n.flashBuild})`;
      ctx.lineWidth = 2 / zoom;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size + 14 * (1 - n.flashBuild), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// ---- Turrets (sprite + aim + progress arc + HP bar + stockpile badge) ----
function drawTurrets(ctx, zoom, now) {
  const { vL, vT, vR, vB } = state._view;
  // Low LOD: detailed sprites become invisible chunks at zoom 0.5×, so we
  // fall back to single colored primitives. SIZE-MATCHED to the original
  // sprites so the world map doesn't visually shrink when LOD kicks in
  // (AA sprite is ~51 px, tank is ~57, factory ~57, artillery ~66).
  if (state._lod < 2) {
    for (const t of state.turrets) {
      if (t.x + 35 < vL || t.x - 35 > vR || t.y + 35 < vT || t.y - 35 > vB) continue;
      if (t.pendingEngineer) ctx.globalAlpha = 0.35;
      ctx.fillStyle = t.active ? COLOR[t.owner] : COLOR[t.owner] + '88';
      if (t.type === 'antiair') {
        // AA sprite is r≈24 (48 px diameter). Match with a 48×48 square.
        ctx.fillRect(t.x - 24, t.y - 24, 48, 48);
      } else if (t.type === 'tank') {
        // Tank chassis is ~48×40. Draw a chunky rounded square footprint.
        ctx.fillRect(t.x - 22, t.y - 18, 44, 36);
      } else if (t.type === 'factory') {
        // Factory sprite is 57. Slightly larger building footprint.
        ctx.fillRect(t.x - 28, t.y - 28, 56, 56);
      } else if (t.type === 'artillery') {
        // Artillery sprite is 66, long barrel. Diamond r≈33 matches reach.
        ctx.beginPath();
        ctx.moveTo(t.x, t.y - 33); ctx.lineTo(t.x + 33, t.y);
        ctx.lineTo(t.x, t.y + 33); ctx.lineTo(t.x - 33, t.y);
        ctx.closePath(); ctx.fill();
      }
      if (t.pendingEngineer) ctx.globalAlpha = 1.0;
    }
    return;
  }
  for (const t of state.turrets) {
    // Sprites span ~35 px from pivot; skip if outside view + margin.
    if (t.x + 35 < vL || t.x - 35 > vR || t.y + 35 < vT || t.y - 35 > vB) continue;
    // Pending sites (engineer en route) render as ghost placeholders — visual
    // mirror of the gameplay rule that they're not yet attackable.
    if (t.pendingEngineer) ctx.globalAlpha = 0.35;
    if (t.type === 'antiair') {
      drawAATurret(ctx, t.x, t.y, t.owner, t.active, zoom, now);
    } else if (t.type === 'tank') {
      // Aim at nearest enemy ground fleet. Spatial-grid query — 3×3 cell
      // window around the tank instead of scanning every fleet on the map.
      let aimAngle = t.aimAngle || 0, aimD2 = Infinity;
      const CELL = 250;
      const cx0 = Math.floor(t.x / CELL);
      const cy0 = Math.floor(t.y / CELL);
      for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
        for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) {
          const bucket = state.groundFleetGrid.get(cx * 10000 + cy);
          if (!bucket) continue;
          for (const f of bucket) {
            if (f.owner === t.owner) continue;
            const dx = f.x - t.x, dy = f.y - t.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < aimD2) { aimD2 = d2; aimAngle = Math.atan2(dy, dx); }
          }
        }
      }
      t.aimAngle = aimAngle;
      drawTankTurret(ctx, t.x, t.y, t.owner, t.active, zoom, aimAngle);
    } else if (t.type === 'factory') {
      drawFactoryTurret(ctx, t.x, t.y, t.owner, t.active, zoom, now, t.prodCooldown < 1.5);
      // Stockpile badge: when Hold-Fire is on, factories accumulate drones
      if (t.dronesReady > 0) {
        ctx.fillStyle = 'rgba(255, 200, 90, 0.9)';
        ctx.beginPath();
        ctx.arc(t.x + 21, t.y - 24, 10.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0a0604';
        ctx.font = `bold ${11 / zoom}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t.dronesReady, t.x + 21, t.y - 24);
      }
    } else if (t.type === 'artillery') {
      // Aim toward nearest enemy turret via spatial grid. Artillery range
      // is 420 px → 2-cell window. Falls back to last known aim if no enemy
      // turret is anywhere near it.
      let aimAngle = t.aimAngle || 0, aimD2 = Infinity;
      const CELL = 250;
      const cx0 = Math.floor(t.x / CELL);
      const cy0 = Math.floor(t.y / CELL);
      for (let cx = cx0 - 2; cx <= cx0 + 2; cx++) {
        for (let cy = cy0 - 2; cy <= cy0 + 2; cy++) {
          const bucket = state.turretGrid.get(cx * 10000 + cy);
          if (!bucket) continue;
          for (const e of bucket) {
            if (e.owner === t.owner) continue;
            const dx = e.x - t.x, dy = e.y - t.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < aimD2) { aimD2 = d2; aimAngle = Math.atan2(dy, dx); }
          }
        }
      }
      t.aimAngle = aimAngle;
      // Recent-fire flash: cooldown just reset → recoil kick
      const flash = (t.artyCooldown !== undefined && t.artyCooldown > ARTILLERY_INTERVAL - 0.25)
        ? (t.artyCooldown - (ARTILLERY_INTERVAL - 0.25)) / 0.25
        : 0;
      drawArtilleryTurret(ctx, t.x, t.y, t.owner, t.active, zoom, aimAngle, flash);
    }
    // Progress arc only when an engineer has arrived and started building;
    // pending sites show no arc (nothing's happening there yet).
    if (!t.active && !t.pendingEngineer) {
      ctx.strokeStyle = '#ffd066';
      ctx.lineWidth = 3 / zoom;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 22.5, -Math.PI / 2, -Math.PI / 2 + t.progress * Math.PI * 2);
      ctx.stroke();
    }
    // HP bar (only if damaged)
    if (t.active && t.hp < t.hpMax) {
      const bw = 39, frac = t.hp / t.hpMax;
      ctx.fillStyle = 'rgba(20,20,20,0.6)';
      ctx.fillRect(t.x - bw / 2, t.y + 24, bw, 3.5);
      ctx.fillStyle = frac > 0.5 ? '#7be57b' : frac > 0.25 ? '#ffd066' : '#ff6678';
      ctx.fillRect(t.x - bw / 2, t.y + 24, bw * frac, 3.5);
    }
    if (t.pendingEngineer) ctx.globalAlpha = 1.0;
  }
}

// ---- Placement preview (semi-transparent ghost while player is in place-mode) ----
function drawPlacementPreview(ctx, zoom, now) {
  if (!state.placeMode) return;
  const wx = state.mousePos.x, wy = state.mousePos.y;
  if (state.placeMode.type === 'net') {
    // Net targets a road segment — highlight nearest road within tolerance.
    const r = roadAt(wx, wy, NET_PICK_R);
    if (r) {
      const a = state.nodes[r.a], b = state.nodes[r.b];
      ctx.strokeStyle = 'rgba(160, 220, 255, 0.85)';
      ctx.lineWidth = 4 / zoom;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // Hint: show what this trip will do (clear wrecks vs upgrade net)
      const e = getEdge(r.a, r.b);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.fillStyle = '#a4d8ff';
      ctx.font = `bold ${11 / zoom}px ui-monospace, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      let hint;
      if (!e) hint = '';
      else if (e.wrecks && e.wrecks.length > 0) hint = `clear ${e.wrecks.length} wreck${e.wrecks.length > 1 ? 's' : ''}`;
      else if (e.netLevel < NET_LEVEL_MAX) hint = `+net L${e.netLevel + 1}`;
      else hint = 'net maxed';
      ctx.fillText(hint, mx, my - 10);
    } else {
      ctx.fillStyle = 'rgba(160, 220, 255, 0.4)';
      ctx.beginPath(); ctx.arc(wx, wy, 4, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    // Turret world-point preview — render the actual sprite (semi-transparent)
    ctx.globalAlpha = 0.65;
    if (state.placeMode.type === 'antiair') {
      drawAATurret(ctx, wx, wy, state.placeMode.byOwner, true, zoom, now);
    } else if (state.placeMode.type === 'tank') {
      drawTankTurret(ctx, wx, wy, state.placeMode.byOwner, true, zoom, 0);
    } else if (state.placeMode.type === 'factory') {
      drawFactoryTurret(ctx, wx, wy, state.placeMode.byOwner, true, zoom, now, false);
    } else if (state.placeMode.type === 'artillery') {
      drawArtilleryTurret(ctx, wx, wy, state.placeMode.byOwner, true, zoom, 0, 0);
    }
    ctx.globalAlpha = 1;
    const previewR = TURRET_RANGES[state.placeMode.type];
    if (previewR) {
      ctx.strokeStyle = 'rgba(255, 220, 130, 0.5)';
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([5 / zoom, 5 / zoom]);
      ctx.beginPath();
      ctx.arc(wx, wy, previewR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// ---- Ground fleets — column of vehicles trailing a leader ----
function drawTroopFleets(ctx, zoom) {
  const COLUMN_MAX = 8;
  const PER_VEH = 5;
  const GAP = 13;       // px between adjacent vehicles along the column
  const { vL, vT, vR, vB } = state._view;
  // Column trails up to ~COLUMN_MAX*GAP ≈ 100 px back from the leader,
  // plus sprite half-width. 120 px margin catches partial-visible columns.
  for (const f of state.fleets) {
    if (f.kind === 'drone') continue;
    if (f.x + 120 < vL || f.x - 120 > vR || f.y + 120 < vT || f.y - 120 > vB) continue;
    let angle = 0;
    if ((f.kind === 'deploy' || f.kind === 'assault' || f.kind === 'return') && f.offroad) {
      angle = Math.atan2(f.finalY - f.y, f.finalX - f.x);
    } else if (f.path && f.segIdx < f.path.length - 1) {
      const segB = state.nodes[f.path[f.segIdx + 1]];
      angle = Math.atan2(segB.y - f.y, segB.x - f.x);
    } else if (!f.path) {
      continue;
    }
    // LOW LOD: collapse the column-of-sprites into ONE oriented rect that
    // matches the visual footprint of the full column at LOD 3 (~36 px wide,
    // and as long as the column would have been — GAP*count of vehicles). So
    // the fleet doesn't visually shrink when the player zooms out.
    if (state._lod < 2) {
      const totalUnits = Math.max(1, Math.floor(f.units));
      const veh = Math.min(COLUMN_MAX, Math.max(1, Math.ceil(totalUnits / PER_VEH)));
      const len = 18 + veh * GAP;        // half-length each side ≈ leader→tail
      const wid = 18;                    // half-width matches single sprite
      const cos = Math.cos(angle), sin = Math.sin(angle);
      // Oriented rectangle (4 corners) trailing the leader.
      const hx = cos * 18, hy = sin * 18;            // leader offset
      const bx = -cos * (len - 18), by = -sin * (len - 18); // tail offset
      const px = -sin * wid, py = cos * wid;         // perpendicular
      ctx.fillStyle = COLOR[f.owner];
      ctx.beginPath();
      ctx.moveTo(f.x + hx + px, f.y + hy + py);
      ctx.lineTo(f.x + hx - px, f.y + hy - py);
      ctx.lineTo(f.x + bx - px, f.y + by - py);
      ctx.lineTo(f.x + bx + px, f.y + by + py);
      ctx.closePath();
      ctx.fill();
      continue;
    }
    // ENGINEERS / DEPLOY: single dozer (they're individual vehicles)
    if (f.kind === 'engineer' || f.kind === 'deploy') {
      drawEngineerSprite(ctx, f.x, f.y, angle, f.owner, zoom);
      ctx.fillStyle = COLOR[f.owner];
      ctx.font = `bold ${12 / zoom}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('⚙', f.x, f.y - 18);
      continue;
    }
    // TROOPS / ASSAULT: column of individual vehicles (1 sprite ≈ 5 units, max 8)
    const totalUnits = Math.max(1, Math.floor(f.units));
    const showCount = Math.min(COLUMN_MAX, Math.max(1, Math.ceil(totalUnits / PER_VEH)));
    const perVehUnits = totalUnits / showCount;
    const backX = -Math.cos(angle), backY = -Math.sin(angle);
    const perpX = -Math.sin(angle), perpY = Math.cos(angle);
    for (let k = 0; k < showCount; k++) {
      // Alternating lateral jitter so it doesn't look like a comb
      const jitter = (k % 2 === 0 ? 1 : -1) * (k > 0 ? 1.6 : 0);
      const vx = f.x + backX * (k * GAP) + perpX * jitter;
      const vy = f.y + backY * (k * GAP) + perpY * jitter;
      if (f.kind === 'assault') {
        drawTroopSprite(ctx, vx, vy, angle, Math.max(40, perVehUnits), f.owner, zoom);
      } else {
        drawTroopSprite(ctx, vx, vy, angle, perVehUnits, f.owner, zoom);
      }
    }
    // Total-count label above the column leader
    ctx.fillStyle = COLOR[f.owner];
    ctx.font = `bold ${12 / zoom}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(totalUnits, f.x, f.y - 18);
  }
}

// ---- Drones (delta-wing sprite + HP bar when damaged) ----
function drawDroneFleets(ctx, zoom, now) {
  const { vL, vT, vR, vB } = state._view;
  // Low LOD: paint drones as oriented triangles matching the full-LOD
  // delta-wing sprite size (~28 px tip-to-tail) so the swarm doesn't
  // visually shrink when zoomed out.
  if (state._lod < 2) {
    for (const f of state.fleets) {
      if (f.kind !== 'drone') continue;
      if (f.x + 18 < vL || f.x - 18 > vR || f.y + 18 < vT || f.y - 18 > vB) continue;
      const angle = Math.atan2(f.ty - f.y, f.tx - f.x);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      // Nose 14 forward, wings 10 back ± 9 perpendicular.
      const nx =  cos * 14,        ny =  sin * 14;
      const lx = -cos * 10 - sin * 9, ly = -sin * 10 + cos * 9;
      const rx = -cos * 10 + sin * 9, ry = -sin * 10 - cos * 9;
      ctx.fillStyle = COLOR[f.owner];
      ctx.beginPath();
      ctx.moveTo(f.x + nx, f.y + ny);
      ctx.lineTo(f.x + lx, f.y + ly);
      ctx.lineTo(f.x + rx, f.y + ry);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }
  for (const f of state.fleets) {
    if (f.kind !== 'drone') continue;
    if (f.x + 35 < vL || f.x - 35 > vR || f.y + 35 < vT || f.y - 35 > vB) continue;
    const angle = Math.atan2(f.ty - f.y, f.tx - f.x);
    drawDroneSprite(ctx, f.x, f.y, angle, f.owner, zoom, now);
    if (f.hp < DRONE_HP_AIR) {
      const bw = 18, frac = Math.max(0, f.hp) / DRONE_HP_AIR;
      ctx.fillStyle = 'rgba(20,20,20,0.5)';
      ctx.fillRect(f.x - bw / 2, f.y + 12, bw, 3);
      ctx.fillStyle = '#ff6678';
      ctx.fillRect(f.x - bw / 2, f.y + 12, bw * frac, 3);
    }
  }
}

// ---- Particles (life-based alpha fade) ----
function drawParticles(ctx, zoom) {
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

// ---- Salvo-target marker (pulsing crosshair on designated enemy during Hold-Fire) ----
// ---- Always-on-top node count labels (drawn last to beat any sprite) ----
function drawNodeLabelsOnTop(ctx, zoom) {
  const { vL, vT, vR, vB } = state._view;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const n of state.nodes) {
    if (n.x < vL || n.x > vR || n.y < vT || n.y > vB) continue;
    const screenFont = Math.max(15, Math.min(28, n.size * 0.85 * zoom));
    const worldFont = screenFont / zoom;
    ctx.font = `bold ${worldFont}px -apple-system, system-ui, sans-serif`;
    // Dark halo so the number reads on any background (troop columns, scorches,
    // bright glow). Draw it as a thicker stroke under the white fill.
    ctx.lineWidth = Math.max(2, 3 / zoom);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeText(Math.floor(n.units), n.x, n.y);
    ctx.fillStyle = '#fff';
    ctx.fillText(Math.floor(n.units), n.x, n.y);
  }
}

function drawSalvoMarker(ctx, zoom, now) {
  if (!(state.holdFire && state.salvoTarget)) return;
  const s = state.salvoTarget;
  let tx = s.x, ty = s.y;
  if (s.kind === 'turret') {
    const t2 = state.turretById.get(s.id);
    if (t2) { tx = t2.x; ty = t2.y; }
  } else if (s.kind === 'node') {
    const n = state.nodes[s.id];
    if (n) { tx = n.x; ty = n.y; }
  }
  const pulse = 0.6 + 0.4 * Math.sin(now / 200);
  ctx.strokeStyle = `rgba(255, 80, 60, ${pulse})`;
  ctx.lineWidth = 2 / zoom;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.beginPath();
  ctx.arc(tx, ty, 24, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = `rgba(255, 80, 60, ${pulse * 0.9})`;
  ctx.lineWidth = 1.4 / zoom;
  ctx.beginPath();
  ctx.moveTo(tx - 34, ty); ctx.lineTo(tx - 16, ty);
  ctx.moveTo(tx + 16, ty); ctx.lineTo(tx + 34, ty);
  ctx.moveTo(tx, ty - 34); ctx.lineTo(tx, ty - 16);
  ctx.moveTo(tx, ty + 16); ctx.lineTo(tx, ty + 34);
  ctx.stroke();
}

// ---- Hold-Fire screen-space banner (drawn AFTER world transform restored) ----
function drawHoldFireBanner(ctx, W, now) {
  if (!state.holdFire) return;
  let total = 0;
  for (const t of state.turrets) {
    if (t.owner === 'player' && t.type === 'factory') total += t.dronesReady || 0;
  }
  const targeted = !!state.salvoTarget;
  const text = targeted
    ? `⏸  HOLD-FIRE  ${total} drones  →  TARGET LOCKED  —  H to strike, Esc to clear`
    : `⏸  HOLD-FIRE  ${total} drone${total === 1 ? '' : 's'} ready  —  click an enemy to lock target, H to auto-launch`;
  const a = 0.85 + Math.sin(now / 250) * 0.15;
  ctx.font = 'bold 14px ui-monospace, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const w = ctx.measureText(text).width + 28;
  const cx = W / 2, cy = 52;
  const baseTint = targeted ? '255, 110, 90' : '255, 200, 90';
  ctx.fillStyle = `rgba(${baseTint}, ${a * 0.22})`;
  ctx.fillRect(cx - w / 2, cy, w, 30);
  ctx.strokeStyle = `rgba(${baseTint}, ${a})`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - w / 2, cy, w, 30);
  ctx.fillStyle = targeted ? `rgba(255, 200, 180, ${a})` : `rgba(255, 220, 130, ${a})`;
  ctx.fillText(text, cx, cy + 8);
}

// =====================================================
// Main render — orchestration only. Set up the canvas + world transform,
// then call each layer in painter order. Add / reorder layers HERE, never
// inside this function's logic block — the layer renderers above are the
// place to put rendering details.
// =====================================================
export function render() {
  const ctx = state.ctx, W = state.W, H = state.H, zoom = state.zoom;
  const now = performance.now();

  // Frustum bounds in WORLD space — every layer culls entities outside this
  // box before drawing. A generous margin (200 px) handles sprites whose
  // pivot is just off-screen but whose body still leaks into view.
  const vM = 200;
  const vL = state.cameraX - vM;
  const vT = state.cameraY - vM;
  const vR = state.cameraX + W / zoom + vM;
  const vB = state.cameraY + H / zoom + vM;
  state._view = { vL, vT, vR, vB };
  // Level-of-Detail tier based on zoom. Bigger maps mean more zoom-out time,
  // and at small sprite sizes the detail doesn't read anyway — skipping it
  // is free perf with no visible loss.
  //   3 = full detail (zoom in close)
  //   2 = medium (skip the smallest decorations + tracers/particles)
  //   1 = pixel-quality (skip individual fleet sprites — render whole columns
  //                       as one colored dot; skip rocks, active scorches,
  //                       fleet trails, range rings, drone HP bars)
  state._lod = zoom >= 1.0 ? 3 : zoom >= 0.6 ? 2 : 1;

  // Screen-space background (no world transform)
  drawBackground(ctx, W, H);

  // World space ------------------------------------------------
  ctx.save();
  ctx.scale(zoom, zoom);
  ctx.translate(-state.cameraX, -state.cameraY);

  drawTerrain(ctx, zoom);
  drawScorches(ctx, zoom, now);
  drawWorldBoundary(ctx, zoom);
  drawRoads(ctx, zoom);
  drawWreckPiles(ctx, zoom);
  drawNets(ctx, zoom);
  drawShells(ctx, zoom);
  drawTracers(ctx, zoom);
  drawFleetTrails(ctx, zoom);
  drawRangeRings(ctx, zoom);
  drawNodes(ctx, zoom, now);
  drawTurrets(ctx, zoom, now);
  drawPlacementPreview(ctx, zoom, now);
  drawTroopFleets(ctx, zoom);
  drawDroneFleets(ctx, zoom, now);
  drawParticles(ctx, zoom);
  if (state.drag && state.drag.moved) drawDragPreview(ctx, zoom);
  drawSalvoMarker(ctx, zoom, now);
  // Always-on-top: node unit counts. Otherwise massed troop columns or drone
  // swarms parked on a node can completely hide the number — unplayable.
  drawNodeLabelsOnTop(ctx, zoom);

  ctx.restore();
  // --- end world space ----------------------------------------

  drawHoldFireBanner(ctx, W, now);
}

// =====================================================
// Drag preview (selection / send-arrow / box-select) — kept as a standalone
// function so it can be added or removed from the render pipeline without
// disturbing the layer order.
// =====================================================
function drawDragPreview(ctx, zoom) {
  const drag = state.drag;
  if (drag.mode === 'send' && drag.originNode) {
    const releaseNode = nodeAt(drag.x, drag.y);
    const sources = state.selectedIds.has(drag.originNode.id)
      ? [...state.selectedIds].map(id => state.nodes[id]).filter(nd => nd && nd.owner === 'player')
      : [drag.originNode];

    for (const src of sources) {
      if (!src) continue;
      if (releaseNode && src.id === releaseNode.id) continue;
      if (releaseNode) {
        const path = findPath(src.id, releaseNode.id, src.owner);
        if (path && path.length > 1) {
          const isAttack = releaseNode.owner !== src.owner;
          ctx.strokeStyle = isAttack ? 'rgba(255,102,120,0.9)' : 'rgba(92,179,255,0.9)';
          ctx.lineWidth = 2 / zoom;
          ctx.setLineDash([6 / zoom, 6 / zoom]);
          ctx.beginPath();
          for (let i = 0; i < path.length; i++) {
            const n = state.nodes[path[i]];
            if (i === 0) ctx.moveTo(n.x, n.y);
            else ctx.lineTo(n.x, n.y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          const last = state.nodes[path[path.length - 1]];
          const prev = state.nodes[path[path.length - 2]];
          const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
          const tipX = last.x - Math.cos(ang) * (last.size + 2);
          const tipY = last.y - Math.sin(ang) * (last.size + 2);
          const ah = 11;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - ah * Math.cos(ang - 0.4), tipY - ah * Math.sin(ang - 0.4));
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - ah * Math.cos(ang + 0.4), tipY - ah * Math.sin(ang + 0.4));
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(200, 90, 90, 0.6)';
          ctx.lineWidth = 2 / zoom;
          ctx.setLineDash([3 / zoom, 5 / zoom]);
          ctx.beginPath();
          ctx.moveTo(src.x, src.y);
          ctx.lineTo(releaseNode.x, releaseNode.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        ctx.strokeStyle = 'rgba(180, 190, 210, 0.5)';
        ctx.lineWidth = 1.5 / zoom;
        ctx.setLineDash([6 / zoom, 6 / zoom]);
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(drag.x, drag.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  } else if (drag.mode === 'box') {
    const x = Math.min(drag.startX, drag.x);
    const y = Math.min(drag.startY, drag.y);
    const w = Math.abs(drag.x - drag.startX);
    const h = Math.abs(drag.y - drag.startY);
    ctx.fillStyle = 'rgba(92, 179, 255, 0.1)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(92, 179, 255, 0.6)';
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(x, y, w, h);
  }
}

// =====================================================
// Minimap
// =====================================================
export function renderMinimap() {
  const mctx = state.mctx;
  if (!mctx) return;
  const mw = state.minimap.width, mh = state.minimap.height;
  mctx.clearRect(0, 0, mw, mh);
  mctx.fillStyle = 'rgba(8, 16, 30, 0.6)';
  mctx.fillRect(0, 0, mw, mh);
  const sx = mw / WORLD_W, sy = mh / WORLD_H;
  mctx.strokeStyle = 'rgba(140, 160, 195, 0.25)';
  mctx.lineWidth = 0.5;
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    mctx.beginPath();
    mctx.moveTo(a.x * sx, a.y * sy);
    mctx.lineTo(b.x * sx, b.y * sy);
    mctx.stroke();
  }
  for (const n of state.nodes) {
    mctx.fillStyle = COLOR[n.owner];
    mctx.beginPath();
    mctx.arc(n.x * sx, n.y * sy, Math.max(2, n.size * sx * 0.5), 0, Math.PI * 2);
    mctx.fill();
  }
  mctx.strokeStyle = 'rgba(220, 230, 245, 0.7)';
  mctx.lineWidth = 1;
  mctx.strokeRect(state.cameraX * sx, state.cameraY * sy, (state.W / state.zoom) * sx, (state.H / state.zoom) * sy);
}

// =====================================================
// All canvas rendering: main view + minimap + HUD updates.
// Reads from state; never mutates game data (only DOM + canvas).
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H, AA_RADIUS, DRONE_HP_AIR, BLOCKAGE_HEAVY } from './config.js';
import { COLOR, GLOW, FACTIONS } from './factions.js';
import { dist, formatTime } from './util.js';
import { findPath, nodeAt } from './world.js';
import { getEdge } from './engineering.js';

// =====================================================
// HUD (DOM)
// =====================================================
export function buildHUD() {
  const hud = document.getElementById('hud');
  if (!hud) return;
  hud.innerHTML = '';
  for (const f of FACTIONS) {
    const row = document.createElement('div');
    row.innerHTML = `
      <span class="swatch" style="background:${f.color}"></span><span style="color:${f.color}">${f.name}</span>
      &nbsp; <span id="${f.id}-units">0</span><span class="label">u</span>
      &nbsp; <span id="${f.id}-nodes">0</span><span class="label">n</span>
    `;
    hud.appendChild(row);
  }
}

export function updateHUD() {
  const c = {};
  for (const f of FACTIONS) c[f.id] = [0, 0];
  for (const n of state.nodes) {
    c[n.owner][0] += n.units;
    c[n.owner][1] += 1;
  }
  for (const f of state.fleets) if (c[f.owner]) c[f.owner][0] += (f.units || 0);
  for (const f of FACTIONS) {
    const u = document.getElementById(`${f.id}-units`);
    const ns = document.getElementById(`${f.id}-nodes`);
    if (u) u.textContent = Math.floor(c[f.id][0]);
    if (ns) ns.textContent = c[f.id][1];
  }
  const t = document.getElementById('timer');     if (t) t.textContent = formatTime(state.elapsed);
  const z = document.getElementById('zoom');      if (z) z.textContent = `${Math.round(state.zoom * 100)}%`;
  const s = document.getElementById('speed');     if (s) s.textContent = `Speed ${state.timeScale}×`;
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
// Main render
// =====================================================
export function render() {
  const ctx = state.ctx, W = state.W, H = state.H, zoom = state.zoom;

  // Martian sky — dusty rust gradient (warm rather than cold).
  const bg = ctx.createRadialGradient(W / 2, H * 0.6, 0, W / 2, H * 0.6, Math.max(W, H) * 0.8);
  bg.addColorStop(0, '#3a1a08');
  bg.addColorStop(0.6, '#1f0d05');
  bg.addColorStop(1, '#0d0703');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Mars dust (screen-space, blowing sideways)
  for (const s of state.dust) {
    ctx.globalAlpha = s.a;
    ctx.fillStyle = `hsl(${s.hue}, 65%, 60%)`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // World space
  ctx.save();
  ctx.scale(zoom, zoom);
  ctx.translate(-state.cameraX, -state.cameraY);

  // World boundary
  ctx.strokeStyle = 'rgba(180, 130, 80, 0.25)';
  ctx.lineWidth = 1 / zoom;
  ctx.strokeRect(0, 0, WORLD_W, WORLD_H);

  // Roads (color by blockage) — sand → bright orange-red as blockage rises
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    const e = getEdge(r.a, r.b);
    const blk = e ? e.blockage : 0;
    if (blk > 0.05) {
      const t = Math.min(1, blk);
      const cr = Math.floor(180 + 60 * t), cg = Math.floor(140 - 80 * t), cb = Math.floor(100 - 70 * t);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.5 + 0.4 * t})`;
      ctx.lineWidth = (1.3 + 1.8 * t) / zoom;
      if (blk > BLOCKAGE_HEAVY) ctx.setLineDash([6 / zoom, 4 / zoom]);
    } else {
      ctx.strokeStyle = 'rgba(200, 160, 110, 0.32)';
      ctx.lineWidth = 1.3 / zoom;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // AA tracer beams — render before nodes so beams pass behind icons.
  // Stacking AAs all draw beams → visible saturation interception.
  for (const t of state.tracers) {
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

  // Fleet trails (skip drones)
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

  // AA radius rings (active only)
  for (const n of state.nodes) {
    for (const b of n.buildings || []) {
      if (b.type !== 'antiair' || !b.active) continue;
      ctx.strokeStyle = COLOR[n.owner] + '30';
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([6 / zoom, 6 / zoom]);
      ctx.beginPath();
      ctx.arc(n.x, n.y, AA_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Nodes
  for (const n of state.nodes) {
    const grad = ctx.createRadialGradient(n.x, n.y, n.size * 0.5, n.x, n.y, n.size * 2.4);
    grad.addColorStop(0, GLOW[n.owner]);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size * 2.4, 0, Math.PI * 2);
    ctx.fill();

    if (n.pulse > 0) {
      ctx.strokeStyle = COLOR[n.owner];
      ctx.globalAlpha = n.pulse;
      ctx.lineWidth = 2 / zoom;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size + (1 - n.pulse) * 28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (state.selectedIds.has(n.id)) {
      ctx.strokeStyle = '#fff';
      ctx.globalAlpha = 0.65 + Math.sin(performance.now() / 180) * 0.25;
      ctx.lineWidth = 2 / zoom;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = COLOR[n.owner];
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(5, 10, 20, 0.5)';
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size - 3, 0, Math.PI * 2);
    ctx.fill();

    if (n.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${n.flash * 0.45})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#fff';
    const screenFont = Math.max(15, Math.min(28, n.size * 0.85 * zoom));
    const worldFont = screenFont / zoom;
    ctx.font = `bold ${worldFont}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.floor(n.units), n.x, n.y);

    // Building icons + progress + HP bars
    if (n.buildings && n.buildings.length) {
      const r = n.size + 8;
      let slotI = 0;
      const slotAngle = (i) => -Math.PI / 2 + (i - (n.buildings.length - 1) / 2) * 0.55;
      for (const b of n.buildings) {
        const ang = slotAngle(slotI);
        const bx = n.x + Math.cos(ang) * r;
        const by = n.y + Math.sin(ang) * r;
        const iconR = 5.5;
        ctx.fillStyle = b.active ? COLOR[n.owner] : 'rgba(120,120,120,0.7)';
        ctx.beginPath(); ctx.arc(bx, by, iconR, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${10 / zoom}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const glyph = b.type === 'antiair' ? 'A' : b.type === 'factory' ? 'F' : 'N';
        ctx.fillText(glyph, bx, by);
        if (!b.active) {
          ctx.strokeStyle = '#ffd066';
          ctx.lineWidth = 1.5 / zoom;
          ctx.beginPath();
          ctx.arc(bx, by, iconR + 1.5, -Math.PI / 2, -Math.PI / 2 + b.progress * Math.PI * 2);
          ctx.stroke();
        }
        if (b.active && b.hp < b.hpMax) {
          const bw = 12, frac = b.hp / b.hpMax;
          ctx.fillStyle = 'rgba(20,20,20,0.6)';
          ctx.fillRect(bx - bw / 2, by + iconR + 2, bw, 2);
          ctx.fillStyle = frac > 0.5 ? '#7be57b' : frac > 0.25 ? '#ffd066' : '#ff6678';
          ctx.fillRect(bx - bw / 2, by + iconR + 2, bw * frac, 2);
        }
        slotI++;
      }
    }
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

  // Fleet ships (troops + engineers — drones rendered next)
  for (const f of state.fleets) {
    if (f.kind === 'drone') continue;
    if (!f.path || f.segIdx >= f.path.length - 1) continue;
    const segB = state.nodes[f.path[f.segIdx + 1]];
    const angle = Math.atan2(segB.y - f.y, segB.x - f.x);
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(angle);
    if (f.kind === 'engineer') {
      ctx.fillStyle = '#ffd066';
      ctx.fillRect(-5, -4, 10, 8);
      ctx.fillStyle = COLOR[f.owner];
      ctx.fillRect(-2, -6, 4, 3);
    } else {
      ctx.fillStyle = COLOR[f.owner];
      const sz = Math.min(11, 4 + Math.log(f.units + 1) * 1.3);
      ctx.beginPath();
      ctx.moveTo(sz, 0);
      ctx.lineTo(-sz * 0.6, -sz * 0.6);
      ctx.lineTo(-sz * 0.3, 0);
      ctx.lineTo(-sz * 0.6, sz * 0.6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = COLOR[f.owner];
    ctx.font = `bold ${13 / zoom}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    if (f.kind === 'engineer') ctx.fillText('⚙', f.x, f.y - 14 / zoom);
    else ctx.fillText(Math.floor(f.units), f.x, f.y - 14 / zoom);
  }

  // Drones (straight-line, X-shape)
  for (const f of state.fleets) {
    if (f.kind !== 'drone') continue;
    const angle = Math.atan2(f.ty - f.y, f.tx - f.x);
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(angle);
    ctx.strokeStyle = COLOR[f.owner];
    ctx.lineWidth = 1.6 / zoom;
    ctx.beginPath();
    ctx.moveTo(-4, -4); ctx.lineTo(4, 4);
    ctx.moveTo(-4, 4); ctx.lineTo(4, -4);
    ctx.stroke();
    ctx.fillStyle = COLOR[f.owner];
    ctx.beginPath(); ctx.arc(0, 0, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (f.hp < DRONE_HP_AIR) {
      const bw = 12, frac = Math.max(0, f.hp) / DRONE_HP_AIR;
      ctx.fillStyle = 'rgba(20,20,20,0.5)';
      ctx.fillRect(f.x - bw / 2, f.y + 7, bw, 2);
      ctx.fillStyle = '#ff6678';
      ctx.fillRect(f.x - bw / 2, f.y + 7, bw * frac, 2);
    }
  }

  // Particles
  for (const p of state.particles) {
    const a = p.life / p.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2 / zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Drag preview
  if (state.drag && state.drag.moved) {
    drawDragPreview(ctx, zoom);
  }

  ctx.restore();
}

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

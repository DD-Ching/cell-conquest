// =====================================================
// All canvas rendering: main view + minimap + HUD updates.
// Reads from state; never mutates game data (only DOM + canvas).
// =====================================================
import { state } from './state.js';
import {
  WORLD_W, WORLD_H, AA_RADIUS, TANK_RADIUS, DRONE_HP_AIR,
  NET_PICK_R, NET_LEVEL_MAX, ARTILLERY_INTERVAL, ARTILLERY_AOE,
} from './config.js';
import { COLOR, GLOW, FACTIONS } from './factions.js';
import { dist, formatTime } from './util.js';
import { findPath, nodeAt, roadAt } from './world.js';
import { getEdge, TURRET_RANGES } from './engineering.js';
import {
  drawRoadStyled, drawTroopSprite, drawEngineerSprite, drawDroneSprite,
  drawAATurret, drawTankTurret, drawFactoryTurret, drawArtilleryTurret,
} from './sprites.js';

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

  // Mars surface — uniform rust-brown ground (NOT a space sky).
  // Subtle large-scale gradient suggests sun-baked terrain rather than vacuum.
  ctx.fillStyle = '#3d1f0e';
  ctx.fillRect(0, 0, W, H);
  // Soft warm haze toward the middle to add depth
  const haze = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.7);
  haze.addColorStop(0, 'rgba(120, 60, 25, 0.25)');
  haze.addColorStop(1, 'rgba(60, 30, 12, 0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, W, H);

  // Wind-blown grit (screen-space, less twinkly than before — feels like sand
  // grains being carried over the surface, not stars in space).
  for (const s of state.dust) {
    ctx.globalAlpha = s.a * 0.55;
    ctx.fillStyle = `hsl(${s.hue}, 50%, 45%)`;
    ctx.fillRect(s.x, s.y, s.r * 1.4, 0.6);   // short horizontal streaks
  }
  ctx.globalAlpha = 1;

  // World space
  ctx.save();
  ctx.scale(zoom, zoom);
  ctx.translate(-state.cameraX, -state.cameraY);

  // ---- Ground terrain (scrolls with the camera so you feel like you're moving over Mars) ----
  // Big soft sand patches first
  for (const t of state.terrain) {
    if (t.kind !== 'patch') continue;
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
    ctx.fillStyle = 'rgba(20, 10, 5, 0.45)';
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${Math.floor(200 * t.shade)}, ${Math.floor(140 * t.shade)}, ${Math.floor(90 * t.shade)}, 0.35)`;
    ctx.lineWidth = 0.8 / zoom;
    ctx.stroke();
  }
  // Then rocks (small dark dots, slight highlight)
  for (const t of state.terrain) {
    if (t.kind !== 'rock') continue;
    ctx.fillStyle = `rgba(${Math.floor(30 * t.shade)}, ${Math.floor(18 * t.shade)}, ${Math.floor(10 * t.shade)}, 0.8)`;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${Math.floor(180 * t.shade)}, ${Math.floor(120 * t.shade)}, ${Math.floor(80 * t.shade)}, 0.35)`;
    ctx.beginPath();
    ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.3, t.r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // World boundary — subtle dotted line, doesn't dominate
  ctx.strokeStyle = 'rgba(180, 130, 80, 0.18)';
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([8 / zoom, 6 / zoom]);
  ctx.strokeRect(0, 0, WORLD_W, WORLD_H);
  ctx.setLineDash([]);

  // Roads — thick TD-style path with edge highlights
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    const e = getEdge(r.a, r.b);
    drawRoadStyled(ctx, a, b, e ? e.blockage : 0, zoom);
  }

  // Drone nets on edges — faction-agnostic infrastructure (like road wreckage).
  // Higher level = thicker; charge level fades alpha. Drawn in a neutral
  // cream / sand tone so it reads as terrain, not as faction property.
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

  // Artillery shells in flight — parabolic arc + impact-warning circle.
  // The warning telegraph gives the defender a chance to see incoming AOE.
  for (const s of state.shells) {
    const p = Math.min(1, s.t / s.maxT);
    // Position: interpolate + arc lift (parabolic — peaks at p=0.5)
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

  // Range rings — AA and tank (active only). Tank ring slightly warmer alpha.
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

  // Time reference for any animated visuals below (breathing pulses, rotors, etc.)
  const now = performance.now();

  // Nodes — fortified compounds with rim, glow, and inner structures
  for (const n of state.nodes) {
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

    // Inner "buildings": a few small dots around the perimeter inside the dark area.
    // Density scales with hub degree — bigger hubs look like more substantial compounds.
    if (degree > 0) {
      const buildings = Math.min(8, Math.max(3, degree + 2));
      const innerR = n.size - 8;
      const slowSpin = now / 6000;       // very slow rotation so it doesn't feel busy
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

  // Turrets — distinct sprites per type
  for (const t of state.turrets) {
    if (t.type === 'antiair') {
      drawAATurret(ctx, t.x, t.y, t.owner, t.active, zoom, now);
    } else if (t.type === 'tank') {
      // Aim at nearest enemy fleet (visual flavor; firing is omnidirectional)
      let aimAngle = 0, aimD = Infinity;
      for (const f of state.fleets) {
        if (f.owner === t.owner) continue;
        if (f.kind === 'drone') continue;
        const d = Math.hypot(f.x - t.x, f.y - t.y);
        if (d < aimD) { aimD = d; aimAngle = Math.atan2(f.y - t.y, f.x - t.x); }
      }
      drawTankTurret(ctx, t.x, t.y, t.owner, t.active, zoom, aimAngle);
    } else if (t.type === 'factory') {
      drawFactoryTurret(ctx, t.x, t.y, t.owner, t.active, zoom, now, t.prodCooldown < 1.5);
      // Stockpile badge: when Hold-Fire is on, factories accumulate drones
      if (t.dronesReady > 0) {
        ctx.fillStyle = 'rgba(255, 200, 90, 0.85)';
        ctx.beginPath();
        ctx.arc(t.x + 10, t.y - 12, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0a0604';
        ctx.font = `bold ${9 / zoom}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t.dronesReady, t.x + 10, t.y - 12);
      }
    } else if (t.type === 'artillery') {
      // Aim toward the densest visible enemy point (rough — just nearest target)
      let aimAngle = 0, aimD = Infinity;
      for (const e of state.turrets) {
        if (e.owner === t.owner) continue;
        const d = Math.hypot(e.x - t.x, e.y - t.y);
        if (d < aimD) { aimD = d; aimAngle = Math.atan2(e.y - t.y, e.x - t.x); }
      }
      // Recent-fire flash: cooldown just reset → recoil kick
      const flash = (t.artyCooldown !== undefined && t.artyCooldown > ARTILLERY_INTERVAL - 0.25)
        ? (t.artyCooldown - (ARTILLERY_INTERVAL - 0.25)) / 0.25
        : 0;
      drawArtilleryTurret(ctx, t.x, t.y, t.owner, t.active, zoom, aimAngle, flash);
    }
    // Progress arc while building (any type)
    if (!t.active) {
      ctx.strokeStyle = '#ffd066';
      ctx.lineWidth = 1.8 / zoom;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 11, -Math.PI / 2, -Math.PI / 2 + t.progress * Math.PI * 2);
      ctx.stroke();
    }
    // HP bar (only if damaged)
    if (t.active && t.hp < t.hpMax) {
      const bw = 20, frac = t.hp / t.hpMax;
      ctx.fillStyle = 'rgba(20,20,20,0.6)';
      ctx.fillRect(t.x - bw / 2, t.y + 11, bw, 2);
      ctx.fillStyle = frac > 0.5 ? '#7be57b' : frac > 0.25 ? '#ffd066' : '#ff6678';
      ctx.fillRect(t.x - bw / 2, t.y + 11, bw * frac, 2);
    }
  }

  // Placement preview (player choosing where to place a turret or net).
  if (state.placeMode) {
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
        // Hint: show what this trip will do (clear wreck vs upgrade net)
        const e = getEdge(r.a, r.b);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.fillStyle = '#a4d8ff';
        ctx.font = `bold ${11 / zoom}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        let hint;
        if (!e) hint = '';
        else if (e.blockage >= 0.15) hint = `clear wreck (${(e.blockage * 100).toFixed(0)}%)`;
        else if (e.netLevel < NET_LEVEL_MAX) hint = `+net L${e.netLevel + 1}`;
        else hint = 'net maxed';
        ctx.fillText(hint, mx, my - 10);
      } else {
        // No road nearby — show small dot at cursor
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

  // Ground fleets — distinct sprites per kind, size-tiered for troops
  for (const f of state.fleets) {
    if (f.kind === 'drone') continue;
    let angle = 0;
    if ((f.kind === 'deploy' || f.kind === 'assault' || f.kind === 'return') && f.offroad) {
      angle = Math.atan2(f.finalY - f.y, f.finalX - f.x);
    } else if (f.path && f.segIdx < f.path.length - 1) {
      const segB = state.nodes[f.path[f.segIdx + 1]];
      angle = Math.atan2(segB.y - f.y, segB.x - f.x);
    } else if (!f.path) {
      continue;
    }
    if (f.kind === 'engineer' || f.kind === 'deploy') {
      drawEngineerSprite(ctx, f.x, f.y, angle, f.owner, zoom);
    } else if (f.kind === 'assault') {
      // Assault wave — render as the heaviest troop tier regardless of unit count
      drawTroopSprite(ctx, f.x, f.y, angle, Math.max(40, f.units), f.owner, zoom);
    } else {
      drawTroopSprite(ctx, f.x, f.y, angle, f.units, f.owner, zoom);
    }
    // Unit count label
    ctx.fillStyle = COLOR[f.owner];
    ctx.font = `bold ${13 / zoom}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    if (f.kind === 'engineer' || f.kind === 'deploy') ctx.fillText('⚙', f.x, f.y - 14 / zoom);
    else ctx.fillText(Math.floor(f.units), f.x, f.y - 14 / zoom);
  }

  // Drones — quadcopter sprite with rotor blur
  for (const f of state.fleets) {
    if (f.kind !== 'drone') continue;
    const angle = Math.atan2(f.ty - f.y, f.tx - f.x);
    drawDroneSprite(ctx, f.x, f.y, angle, f.owner, zoom, now);
    if (f.hp < DRONE_HP_AIR) {
      const bw = 12, frac = Math.max(0, f.hp) / DRONE_HP_AIR;
      ctx.fillStyle = 'rgba(20,20,20,0.5)';
      ctx.fillRect(f.x - bw / 2, f.y + 8, bw, 2);
      ctx.fillStyle = '#ff6678';
      ctx.fillRect(f.x - bw / 2, f.y + 8, bw * frac, 2);
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

  // Salvo-target marker — pulsing crosshair on the designated enemy
  if (state.holdFire && state.salvoTarget) {
    const s = state.salvoTarget;
    let tx = s.x, ty = s.y;
    if (s.kind === 'turret') {
      const t2 = state.turrets.find(tt => tt.id === s.id);
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

  ctx.restore();

  // Hold-Fire screen-space banner (drawn after world transform restored)
  if (state.holdFire) {
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
    const cx = state.W / 2, cy = 52;
    const baseTint = targeted ? '255, 110, 90' : '255, 200, 90';
    ctx.fillStyle = `rgba(${baseTint}, ${a * 0.22})`;
    ctx.fillRect(cx - w / 2, cy, w, 30);
    ctx.strokeStyle = `rgba(${baseTint}, ${a})`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - w / 2, cy, w, 30);
    ctx.fillStyle = targeted ? `rgba(255, 200, 180, ${a})` : `rgba(255, 220, 130, ${a})`;
    ctx.fillText(text, cx, cy + 8);
  }
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

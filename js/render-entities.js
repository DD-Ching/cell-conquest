// =====================================================
// Game entities — the things you actually interact with: nodes, turrets,
// troop fleets, drone fleets, plus the always-on-top node count labels
// that get drawn last so massed sprites can't hide the numbers.
//
// All layers support frustum culling via state._view and LOD via state._lod.
// Sprite primitives come from sprites.js; this module is layer logic only.
// =====================================================
import { state } from './state.js';
import { DRONE_HP_AIR, ARTILLERY_INTERVAL } from './config.js';
import { COLOR, GLOW } from './factions.js';
import { catchUpRegen } from './world.js';
import {
  drawTroopSprite, drawEngineerSprite, drawDroneSprite,
  drawAATurret, drawTankTurret, drawFactoryTurret, drawArtilleryTurret,
} from './sprites.js';
import {
  drawNodeCompounds, drawRadarSweeps, drawNodeBuildings,
} from './render-node-detail.js';

const CELL = 250;                          // matches the spatial-grid cell size
const _warnedOwners = new Set();           // dedupe console warnings per owner
const _tintCache = new Map();              // hex → 70%-toward-white rgb string

/** Brighten a faction hex 70% toward white. Cached per hex so the selection
 *  ring doesn't re-parse on every frame. */
function tintBright(hex) {
  let s = _tintCache.get(hex);
  if (s) return s;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const m = (c) => Math.round(255 * 0.7 + c * 0.3);
  s = `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
  _tintCache.set(hex, s);
  return s;
}

// ---- Nodes (fortified compounds: rim, glow, inner structures, count) ----
// Per-layer passes over the visible set so uniform-alpha layers (selection,
// wounded) set globalAlpha once per pass instead of once per node.
export function drawNodes(ctx, zoom, now) {
  const { vL, vT, vR, vB } = state._view;
  // LOW LOD: skip glow / breathing / inner buildings / flash to keep 1000+
  // visible nodes affordable. catchUpRegen is NOT called here — sim()'s AI
  // tick + HUD pass already ran catchUpAllNodes this frame.
  if (state._lod < 2) {
    // 6-screen-pixel floor so sub-pixel n.size at extreme zoom-out stays
    // visible AND clickable (nodeAt uses a zoom-aware pick tolerance).
    // Owned nodes pop (full alpha + radius); neutrals recede (smaller +
    // translucent) so the big map reads as coloured territory spreading over a
    // muted neutral field, not 830 identical dots.
    const minR = 6 / zoom;
    for (const n of state.nodes) {
      const owned = n.owner !== 'neutral';
      const r = Math.max(n.size, minR) * (owned ? 1 : 0.82);
      if (n.x + r < vL || n.x - r > vR || n.y + r < vT || n.y - r > vB) continue;
      ctx.globalAlpha = owned ? 1 : 0.62;
      ctx.fillStyle = COLOR[n.owner];
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(15, 8, 4, 0.6)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(2, r - 4), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  }

  // Visible set — 2.4× halo margin to keep the glow gradient inside the cull.
  const visible = [];
  for (const n of state.nodes) {
    const halo = n.size * 2.4;
    if (n.x + halo < vL || n.x - halo > vR || n.y + halo < vT || n.y - halo > vB) continue;
    visible.push(n);
  }

  // Pass 1 — glow halos (alpha baked into gradient stops).
  for (const n of visible) {
    const glow = GLOW[n.owner] || GLOW.neutral || 'rgba(160,135,116,0.3)';
    if (!GLOW[n.owner] && !_warnedOwners.has(n.owner)) {
      console.warn('[render] no GLOW for owner', n.owner, '— check rollFactions');
      _warnedOwners.add(n.owner);
    }
    const grad = ctx.createRadialGradient(n.x, n.y, n.size * 0.5, n.x, n.y, n.size * 2.4);
    grad.addColorStop(0, glow);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pass 2 — capture pulses (per-node phase ⇒ per-node alpha).
  for (const n of visible) {
    if (n.pulse <= 0) continue;
    ctx.strokeStyle = COLOR[n.owner];
    ctx.globalAlpha = n.pulse;
    ctx.lineWidth = 2 / zoom;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size + (1 - n.pulse) * 28, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Pass 3 — ambient breathing (owned nodes feel alive; phase varies per id).
  for (const n of visible) {
    if (n.owner === 'neutral') continue;
    const breath = 0.35 + 0.25 * Math.sin(now / 600 + n.id * 0.7);
    ctx.strokeStyle = COLOR[n.owner];
    ctx.globalAlpha = breath * 0.45;
    ctx.lineWidth = 1.5 / zoom;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size + 3 + breath * 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Pass 4 — selection ring. Faction-tinted toward white (reads as "yours").
  // The pulsing alpha is identical across selected nodes ⇒ set once per pass.
  if (state.selectedIds.size > 0) {
    ctx.globalAlpha = 0.65 + Math.sin(now / 180) * 0.25;
    ctx.lineWidth = 2 / zoom;
    for (const n of visible) {
      if (!state.selectedIds.has(n.id)) continue;
      ctx.strokeStyle = tintBright(COLOR[n.owner] || COLOR.neutral || '#ffffff');
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Pass 5 — wounded warning ring (< 35% capacity). Sits OUTSIDE the rim
  // at n.size+10 as a quick "in trouble" cue before the player reads the
  // HP count. Neutral nodes are skipped — they spawn well below 35% by
  // design, so the alarm would fire on every empty neutral.
  ctx.globalAlpha = 0.3 + 0.3 * Math.sin(now / 200);
  ctx.strokeStyle = 'rgb(255, 100, 100)';
  ctx.lineWidth = 1.2 / zoom;
  for (const n of visible) {
    if (n.owner === 'neutral') continue;
    if (n.units / n.capacity >= 0.35) continue;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size + 10, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Pass 6 — faction rim (with outer glow) + dark compound + inner shadow.
  // Helper folds in the rim glow (one shadowBlur sub-pass) and the radial
  // inner-shadow gradient that gives the compound depth (PR: fortified look).
  drawNodeCompounds(ctx, visible, zoom);

  // Pass 6b — radar sweep for medium+ owned nodes, under the buildings so
  // the structures paint on top of the faint sweep line.
  drawRadarSweeps(ctx, visible, zoom, now);

  // Pass 7 — central core + building ring + hub beacon + capture flash.
  drawNodeBuildings(ctx, visible, zoom, now, state.adj);

  // Pass 8 — labels, Lieutenant underline, engineer badge, build flash.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const n of visible) {
    // Unit count, faction-coloured (drawNodeLabelsOnTop repaints over sprites).
    ctx.fillStyle = n.owner === 'neutral' ? '#cfc6b6' : COLOR[n.owner];
    const screenFont = Math.max(15, Math.min(28, n.size * 0.85 * zoom));
    const worldFont = screenFont / zoom;
    ctx.font = `bold ${worldFont}px -apple-system, system-ui, sans-serif`;
    const unitsTxt = String(Math.floor(n.units));
    ctx.fillText(unitsTxt, n.x, n.y);
    // Lieutenant underline (typographic mark, not a separate shape).
    if (n.owner === 'ally1') {
      const half = ctx.measureText(unitsTxt).width / 2;
      const uy = n.y + worldFont * 0.45;
      ctx.strokeStyle = COLOR[n.owner];
      ctx.lineWidth = Math.max(1.4, 1.8 / zoom);
      ctx.beginPath();
      ctx.moveTo(n.x - half, uy);
      ctx.lineTo(n.x + half, uy);
      ctx.stroke();
    }
    if (n.engineers > 0) {
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${10 / zoom}px sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('🔧' + n.engineers, n.x - n.size - 4, n.y + n.size + 4);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
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
export function drawTurrets(ctx, zoom, now) {
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
        ctx.fillRect(t.x - 24, t.y - 24, 48, 48);                      // 48×48 square
      } else if (t.type === 'tank') {
        ctx.fillRect(t.x - 22, t.y - 18, 44, 36);                      // 44×36 chassis
      } else if (t.type === 'factory') {
        ctx.fillRect(t.x - 28, t.y - 28, 56, 56);                      // 56×56 building
      } else if (t.type === 'artillery') {
        ctx.beginPath();                                               // r=33 diamond
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
      // Aim at nearest enemy ground fleet via spatial-grid query (3×3 cells).
      let aimAngle = t.aimAngle || 0, aimD2 = Infinity;
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
      drawTankTurret(ctx, t.x, t.y, t.owner, t.active, zoom, aimAngle, now);
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
      // Aim toward nearest enemy turret via spatial grid (5×5 cells for the
      // longer artillery range). Falls back to last known aim when no enemy.
      let aimAngle = t.aimAngle || 0, aimD2 = Infinity;
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

// ---- Ground fleets — column of vehicles trailing a leader ----
export function drawTroopFleets(ctx, zoom) {
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
export function drawDroneFleets(ctx, zoom, now) {
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
      const nx =  cos * 14,           ny =  sin * 14;
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

// ---- Always-on-top node count labels (drawn last to beat any sprite) ----
export function drawNodeLabelsOnTop(ctx, zoom) {
  const { vL, vT, vR, vB } = state._view;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Big-map declutter: at strategic zoom hundreds of per-node numbers overlap
  // into noise. Show a label only where it carries glance-value — selected,
  // a major hub (size), or a meaningful owned garrison. Everything else stays a
  // coloured dot until you zoom in. (Spec: numbers on hover / selection / high
  // zoom only.) The 0.6 cutoff matches the LOD-1 dot-mode threshold.
  const declutter = zoom < 0.6;
  for (const n of state.nodes) {
    if (n.x < vL || n.x > vR || n.y < vT || n.y > vB) continue;
    if (declutter && !state.selectedIds.has(n.id) &&
        n.size < 48 && !(n.owner !== 'neutral' && n.units >= 30)) continue;
    catchUpRegen(n);                         // fresh units for the top-layer label
    const screenFont = Math.max(15, Math.min(28, n.size * 0.85 * zoom));
    const worldFont = screenFont / zoom;
    ctx.font = `bold ${worldFont}px -apple-system, system-ui, sans-serif`;
    // Dark halo so the number reads on any background (troop columns,
    // scorches, bright glow). Faction colour fill on top — packed strategic
    // zoom is unreadable when every node label is white, but instantly
    // legible when each owner's nodes pop in their own hue.
    ctx.lineWidth = Math.max(2, 3 / zoom);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    const txt = String(Math.floor(n.units));
    ctx.strokeText(txt, n.x, n.y);
    ctx.fillStyle = n.owner === 'neutral' ? '#cfc6b6' : COLOR[n.owner];
    ctx.fillText(txt, n.x, n.y);
    // Auto-control underline for Lieutenant bases (same colour as label so
    // it reads as a typographic mark). Outline first for legibility against
    // bright glow / scorch backgrounds, then fill.
    if (n.owner === 'ally1') {
      const w = ctx.measureText(txt).width;
      const half = w / 2;
      const uy = n.y + worldFont * 0.45;
      ctx.lineWidth = Math.max(2.4, 3 / zoom);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.beginPath();
      ctx.moveTo(n.x - half, uy);
      ctx.lineTo(n.x + half, uy);
      ctx.stroke();
      ctx.strokeStyle = COLOR[n.owner];
      ctx.lineWidth = Math.max(1.4, 1.8 / zoom);
      ctx.beginPath();
      ctx.moveTo(n.x - half, uy);
      ctx.lineTo(n.x + half, uy);
      ctx.stroke();
    }
  }
}

// =====================================================
// World infrastructure layers — roads, drone nets, wreck piles, fleet trails,
// turret range rings, artillery shells in flight, and overlay UI (placement
// preview, salvo marker, hold-fire banner, drag preview) + the minimap.
//
// "World infrastructure" = stuff bound to the road graph or to interactive
// overlays. The actual combat entities (nodes, turrets, fleets) live in
// render-entities.js.
// =====================================================
import { state } from './state.js';
import {
  WORLD_W, WORLD_H, ARTILLERY_AOE, ARTILLERY_INTERVAL,
  NET_PICK_R, NET_LEVEL_MAX,
} from './config.js';
import { COLOR } from './factions.js';
import { findPath, nodeAt, roadAt } from './world.js';
import { getEdge, edgeVisualBlockage, TURRET_RANGES } from './engineering.js';
import {
  drawRoadStyled,
  drawAATurret, drawTankTurret, drawFactoryTurret, drawArtilleryTurret,
} from './sprites.js';

// ---- Roads (TD-style path with sand-tint blockage readout) ----
export function drawRoads(ctx, zoom) {
  const { vL, vT, vR, vB } = state._view;
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    // Segment-AABB cull
    if (Math.max(a.x, b.x) < vL || Math.min(a.x, b.x) > vR ||
        Math.max(a.y, b.y) < vT || Math.min(a.y, b.y) > vB) continue;
    const e = getEdge(r.a, r.b);
    // Tint derived purely from pile count — visual readout of congestion,
    // not a speed multiplier (slowdown comes from physical detour).
    // widthMul comes from world.buildRoads (Gaussian × endpoint connectivity).
    drawRoadStyled(ctx, a, b, edgeVisualBlockage(e), zoom, r.widthMul);
  }
}

// ---- Wreck piles (physical debris fleets must steer around) ----
export function drawWreckPiles(ctx, zoom) {
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
export function drawNets(ctx, zoom) {
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
export function drawShells(ctx, zoom) {
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

// ---- Fleet trails (faint line from fleet to its next segment node) ----
export function drawFleetTrails(ctx, zoom) {
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
export function drawRangeRings(ctx, zoom) {
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

// ---- Placement preview (semi-transparent ghost while player is in place-mode) ----
export function drawPlacementPreview(ctx, zoom, now) {
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

// ---- Salvo-target marker (pulsing crosshair on designated enemy during Hold-Fire) ----
export function drawSalvoMarker(ctx, zoom, now) {
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
export function drawHoldFireBanner(ctx, W, now) {
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

// ---- Drag preview (selection / send-arrow / box-select) ----
// Kept here (not in render-entities) because it operates on the road graph
// (findPath) and is conceptually a UI overlay, not an entity.
export function drawDragPreview(ctx, zoom) {
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

// ---- Minimap (bottom-right strategic overview) ----
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

// =====================================================
// World infrastructure layers bound to the road graph — roads, drone nets,
// wreck piles, fleet trails, turret range rings, artillery shells in flight.
//
// Interactive overlays (placement preview, salvo marker, hold-fire banner,
// home indicators, drag preview) live in render-overlays.js; the minimap in
// render-minimap.js. Combat entities (nodes, turrets, fleets) live in
// render-entities.js.
// =====================================================
import { state } from './state.js';
import { ARTILLERY_AOE } from './config.js';
import { COLOR } from './factions.js';
import { getEdge, edgeVisualBlockage, TURRET_RANGES } from './engineering.js';
import { drawRoadStyled } from './sprites.js';
import { roadBow, curveOffsetForPoint } from './road-curve.js';

// ---- Roads (TD-style path with sand-tint blockage readout) ----
export function drawRoads(ctx, zoom, now = 0) {
  const { vL, vT, vR, vB } = state._view;
  // Cartographic road hierarchy: at strategic zoom (low LOD) the local-road mesh
  // fades back so the inter-region HIGHWAY skeleton reads first — the way a real
  // map drops local streets when you zoom out. detailed/debug keep every road at
  // full strength.
  const mode = state.mapMode;
  const fadeLocals = (mode === 'cinematic' || mode === 'strategic') && state._lod < 2;
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    // Segment-AABB cull
    if (Math.max(a.x, b.x) < vL || Math.min(a.x, b.x) > vR ||
        Math.max(a.y, b.y) < vT || Math.min(a.y, b.y) > vB) continue;
    const minor = fadeLocals && r.kind !== 'highway' && r.kind !== 'bridge';
    if (minor) ctx.globalAlpha = 0.3;
    const e = getEdge(r.a, r.b);
    // Tint derived purely from pile count — visual readout of congestion,
    // not a speed multiplier (slowdown comes from physical detour).
    // widthMul comes from world.buildRoads (Gaussian × endpoint connectivity).
    // `now` animates highway supply-line dashes. `bow` gently bends the painted
    // road off the straight chord — render-only, outcome-neutral (road-curve.js).
    const bow = roadBow(a.id, b.id, Math.hypot(b.x - a.x, b.y - a.y));
    drawRoadStyled(ctx, a, b, edgeVisualBlockage(e), zoom, r.widthMul, r.kind, now, bow);
    if (minor) ctx.globalAlpha = 1;
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
      // at low zoom as at high zoom. Each pile rides the painted road curve
      // (sim w.x/w.y stay on the straight centerline — see road-curve.js).
      ctx.fillStyle = 'rgba(20, 10, 4, 0.75)';
      for (const w of e.wrecks) {
        const o = curveOffsetForPoint(a.x, a.y, b.x, b.y, a.id, b.id, w.x, w.y);
        ctx.fillRect(w.x - 8 + o.ox, w.y - 8 + o.oy, 16, 16);
      }
      continue;
    }
    for (const w of e.wrecks) {
      const hpFrac = Math.max(0.4, w.hp / w.hpMax);   // fades while being cleared
      const o = curveOffsetForPoint(a.x, a.y, b.x, b.y, a.id, b.id, w.x, w.y);
      ctx.save();
      ctx.translate(w.x + o.ox, w.y + o.oy);
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
  const { vL, vT, vR, vB } = state._view;
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    // Segment-AABB cull BEFORE getEdge — off-screen roads skip the ekey lookup
    // (and its string alloc) entirely. Same cull drawRoads/drawWreckPiles use.
    if (Math.max(a.x, b.x) < vL || Math.min(a.x, b.x) > vR ||
        Math.max(a.y, b.y) < vT || Math.min(a.y, b.y) > vB) continue;
    const e = getEdge(r.a, r.b);
    if (!e || e.netLevel <= 0) continue;
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
    // World-space width matches roads — fence thickness scales with the map.
    ctx.lineWidth = 1.1 + e.netLevel * 0.6;
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
    const segA = state.nodes[f.path[f.segIdx]];
    const segB = state.nodes[f.path[f.segIdx + 1]];
    // Keep the trail attached to the curve-shifted unit (road-curve.js); the
    // far end is a node, which sits at offset 0, so the trail meets it cleanly.
    let sx = f.x, sy = f.y;
    if (!f.offroad) {
      const o = curveOffsetForPoint(segA.x, segA.y, segB.x, segB.y, segA.id, segB.id, f.x, f.y);
      sx += o.ox; sy += o.oy;
    }
    ctx.strokeStyle = COLOR[f.owner] + '40';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(segB.x, segB.y);
    ctx.stroke();
  }
}

// ---- Range rings around active AA / tank / artillery turrets ----
export function drawRangeRings(ctx, zoom) {
  if (state._lod < 2) return;            // dashed rings invisible when tiny
  const { vL, vT, vR, vB } = state._view;
  for (const t of state.turrets) {
    if (!t.active) continue;
    const r = TURRET_RANGES[t.type];
    if (!r) continue;
    // Circle-AABB cull — skip rings whose entire radius is off-screen.
    if (t.x + r < vL || t.x - r > vR || t.y + r < vT || t.y - r > vB) continue;
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

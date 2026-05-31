// =====================================================
// Territory BORDERS — a glowing "national border" outline traced around each
// faction's claimed turf, sitting on top of the flat territory wash
// (render-territory.js) so an empire reads as a country with a frontier, not
// just a colour stain.
//
// How it hugs the wash exactly: the wash paints, per faction, a union of discs
// (one per node, radius discR) + capsules (one per same-owner edge, half-width
// edgeW/2). We rebuild that SAME shape as a scalar coverage FIELD on a coarse
// grid (field = max over stamps of (radius − distance); −1 outside), then run
// marching-squares at level 0 to extract the union's outline. So the border is
// the literal perimeter of the wash blob — they can never disagree.
//
// Cheap + bounded, like the wash: baked into per-faction Path2D outlines ONCE
// per ownership change (same signature trick), then re-stroked each frame with
// a 3-pass glow. Grid stamping is bbox-local (only cells under each disc/
// capsule), so a rebake is a few hundred k ops even on a full map — and it only
// happens when a node flips owner.
//
// Render order: drawn in render.js right AFTER drawTerritory and BEFORE roads,
// so the frontier glows over its own turf but tactical roads/nodes stay on top.
// Runs in BOTH the main thread and the render worker (same module graph rules
// as render-territory.js — reads only state + COLOR, both hydrated worker-side).
// =====================================================
import { state } from './state.js';
import { COLOR } from './factions.js';
import { marchingSquares } from './map-cartography.js';
import {
  WORLD_W, WORLD_H,
  TERRITORY_MAX_ALPHA, TERRITORY_FADE_START, TERRITORY_FADE_FULL,
  TERRITORY_NODE_R_MUL, TERRITORY_EDGE_W_MUL,
} from './config.js';

// Coarse field grid. ~70 world-px cells → ~172×129 on the 12000×9000 theatre.
// Fine enough for a smooth national border, coarse enough that a rebake is cheap.
const CELL = 70;
const GW = Math.max(2, Math.ceil(WORLD_W / CELL) + 1);
const GH = Math.max(2, Math.ceil(WORLD_H / CELL) + 1);
const FIELD = new Float32Array(GW * GH);   // reused per faction (cleared each bake)

// Baked outlines: owner -> Path2D (world coords). Rebaked on ownership change.
let _paths = new Map();
let _sig = '';
let _fadeAlpha = 0;

/** Median same-owner edge length — footprint scale, identical to the wash so the
 *  border traces the same blob. */
function medianOwnedEdgeLen(byOwner) {
  const lens = [];
  for (const [owner, nodes] of byOwner) {
    for (const n of nodes) {
      for (const nb of state.adj.get(n.id) || []) {
        if (nb <= n.id) continue;
        const m = state.nodes[nb];
        if (m.owner !== owner) continue;
        lens.push(Math.hypot(n.x - m.x, n.y - m.y));
      }
    }
  }
  if (lens.length === 0) return 600;
  lens.sort((a, b) => a - b);
  return lens[lens.length >> 1];
}

/** Squared point→segment distance (for capsule stamping). */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Stamp `radius − distance` (a cone) into FIELD over the cells inside the
 *  stamp's world bounding box, keeping the max. Union of stamps → coverage. */
function stampDisc(nx, ny, radius) {
  const x0 = Math.max(0, Math.floor((nx - radius) / CELL));
  const x1 = Math.min(GW - 1, Math.ceil((nx + radius) / CELL));
  const y0 = Math.max(0, Math.floor((ny - radius) / CELL));
  const y1 = Math.min(GH - 1, Math.ceil((ny + radius) / CELL));
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const wx = gx * CELL, wy = gy * CELL;
      const v = radius - Math.hypot(wx - nx, wy - ny);
      const i = gy * GW + gx;
      if (v > FIELD[i]) FIELD[i] = v;
    }
  }
}

function stampCapsule(ax, ay, bx, by, halfW) {
  const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - halfW) / CELL));
  const x1 = Math.min(GW - 1, Math.ceil((Math.max(ax, bx) + halfW) / CELL));
  const y0 = Math.max(0, Math.floor((Math.min(ay, by) - halfW) / CELL));
  const y1 = Math.min(GH - 1, Math.ceil((Math.max(ay, by) + halfW) / CELL));
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const wx = gx * CELL, wy = gy * CELL;
      const v = halfW - distToSeg(wx, wy, ax, ay, bx, by);
      const i = gy * GW + gx;
      if (v > FIELD[i]) FIELD[i] = v;
    }
  }
}

/** Rebuild each faction's border outline (Path2D, world coords) from current
 *  ownership. One marching-squares pass per faction over the shared FIELD. */
function bakeBorders() {
  _paths = new Map();
  const byOwner = new Map();
  for (const n of state.nodes) {
    if (n.owner === 'neutral') continue;
    if (!byOwner.has(n.owner)) byOwner.set(n.owner, []);
    byOwner.get(n.owner).push(n);
  }
  if (byOwner.size === 0) return;
  const medLen = medianOwnedEdgeLen(byOwner);
  const discR = Math.max(40, medLen * TERRITORY_NODE_R_MUL);
  const edgeHalf = Math.max(20, medLen * TERRITORY_EDGE_W_MUL) * 0.5;

  for (const [owner, nodes] of byOwner) {
    FIELD.fill(-1);
    for (const n of nodes) stampDisc(n.x, n.y, discR);
    for (const n of nodes) {
      for (const nb of state.adj.get(n.id) || []) {
        if (nb <= n.id) continue;
        const m = state.nodes[nb];
        if (m.owner !== owner) continue;
        stampCapsule(n.x, n.y, m.x, m.y, edgeHalf);
      }
    }
    const segs = marchingSquares(FIELD, GW, GH, 0);
    if (segs.length === 0) continue;
    const path = new Path2D();
    for (const s of segs) {
      path.moveTo(s.x1 * CELL, s.y1 * CELL);
      path.lineTo(s.x2 * CELL, s.y2 * CELL);
    }
    _paths.set(owner, path);
  }
}

/** Lighten a faction hex toward white so the bright core reads as a crisp
 *  frontier line over its own (same-hue) wash. */
const _liteCache = new Map();
function lighten(hex) {
  let s = _liteCache.get(hex);
  if (s) return s;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const m = (c) => Math.round(c + (255 - c) * 0.45);
  s = `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
  _liteCache.set(hex, s);
  return s;
}

/** Public: stroke the territory borders. Called from render.js in world space,
 *  right after drawTerritory. Fades in with the same "map has settled" driver
 *  as the wash so the two appear together. */
export function drawTerritoryBorders(ctx, zoom) {
  // Same fade driver as the wash (fraction of nodes claimed).
  let claimed = 0;
  for (const n of state.nodes) if (n.owner !== 'neutral') claimed++;
  const frac = claimed / Math.max(1, state.nodes.length);
  let target = 0;
  if (frac > TERRITORY_FADE_START) {
    target = Math.min(1, (frac - TERRITORY_FADE_START) / (TERRITORY_FADE_FULL - TERRITORY_FADE_START));
  }
  _fadeAlpha += (target - _fadeAlpha) * 0.05;
  if (_fadeAlpha < 0.01) return;

  const sig = ownershipSig();
  if (sig !== _sig) { _sig = sig; bakeBorders(); }
  if (_paths.size === 0) return;

  // World-space widths (scale with the map like roads) divided by nothing — the
  // ctx is already world-scaled. 3 concentric passes = a cheap bloom: wide+faint
  // outer halo → mid → bright lightened core. Border alpha is pushed a bit above
  // the wash so the frontier line clearly pops off its own turf.
  const a = _fadeAlpha;
  const prev = ctx.globalAlpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const passes = [
    { w: 26, alpha: 0.10, lite: false },
    { w: 12, alpha: 0.22, lite: false },
    { w: 4.5, alpha: 0.95, lite: true },
  ];
  for (const [owner, path] of _paths) {
    const base = COLOR[owner] || '#ffffff';
    for (const p of passes) {
      ctx.strokeStyle = p.lite ? lighten(base) : base;
      ctx.lineWidth = p.w;
      ctx.globalAlpha = prev * a * p.alpha * (TERRITORY_MAX_ALPHA / 0.20);
      ctx.stroke(path);
    }
  }
  ctx.globalAlpha = prev;
}

/** Signature of current ownership so we only rebake when something changed.
 *  Matches render-territory.js's so both bake on the same events. */
function ownershipSig() {
  let s = '';
  for (const n of state.nodes) {
    if (n.owner !== 'neutral') s += n.id + ':' + n.owner + ';';
  }
  return s;
}

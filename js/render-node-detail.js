// =====================================================
// Node detail passes — the "fortified Mars compound" look that turns a flat
// gray button into a base. Split out of render-entities.js (which sits at the
// 500-line hard cap) per the established sibling-file pattern.
//
// Every export here is a PER-LAYER pass: it takes the already-culled visible[]
// node array from drawNodes and walks it once, matching the per-pass structure
// PR #11 introduced (uniform-alpha layers set globalAlpha once per pass).
// All passes assume LOD >= 2 — the caller skips them at low LOD.
//
// PERFORMANCE — this file is on the per-frame hot path (800+ visible nodes
// late-game). HARD RULES, learned the painful way:
//   - NO ctx.shadowBlur. It's the single most expensive canvas2d op; thousands
//     of blurred draws per frame (rim + every building) tank the framerate and
//     stutter motion. Glow is faked with a cheap second stroke.
//   - NO per-node createRadialGradient. Allocating a gradient object per node
//     per frame churns the GC ("memory breaking"). Depth is faked with a flat
//     fill + one inner-rim stroke.
//   - Faction colour strings cached per (hex, alpha).
// =====================================================
import { COLOR } from './factions.js';

// hex → "rgba(r,g,b,A)" cache, keyed by hex+alpha. Avoids per-node hex parse
// + string alloc in the building loop.
const _rgbaCache = new Map();
function rgba(hex, a) {
  const key = hex + a;
  let s = _rgbaCache.get(key);
  if (s) return s;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  s = `rgba(${r}, ${g}, ${b}, ${a})`;
  _rgbaCache.set(key, s);
  return s;
}

// Fixed building angles — pre-baked so the loop does a table lookup instead of
// k/count*2π every node.
const _ringAngles = [];
for (let count = 0; count <= 10; count++) {
  const row = [];
  const phase = count * 0.21;
  for (let k = 0; k < count; k++) row.push(phase + (k / count) * Math.PI * 2);
  _ringAngles.push(row);
}

/** Pass D — faction rim (with a CHEAP faked outer glow: one wider, fainter
 *  ring stroke, no shadowBlur) + the dark compound disc with a faked inner
 *  shadow (one inner-rim stroke, no per-node gradient). */
export function drawNodeCompounds(ctx, visible, zoom) {
  // Faked rim glow — a wider faint ring behind the solid rim. One extra stroke
  // per node, zero blur. Reads as a glow at a fraction of the cost.
  ctx.lineWidth = 3 / zoom;
  for (const n of visible) {
    ctx.strokeStyle = rgba(COLOR[n.owner], 0.22);
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size + 1.5 / zoom, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Solid faction rim disc.
  for (const n of visible) {
    ctx.fillStyle = COLOR[n.owner];
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
    ctx.fill();
  }
  // Dark compound disc + a single inner-rim shade stroke for depth (no
  // gradient alloc). The inner stroke sits just inside the rim and darkens
  // the edge, faking the bowl look the gradient used to give.
  for (const n of visible) {
    const inner = n.size - 4;
    ctx.fillStyle = 'rgba(15, 8, 4, 0.72)';
    ctx.beginPath();
    ctx.arc(n.x, n.y, inner, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = 2.5 / zoom;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  for (const n of visible) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size - 5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Pass B — radar sweep for medium+ nodes. One faint faction-tinted radial
 *  line rotating CW once per ~3 s. Cheap: a single line per qualifying node. */
export function drawRadarSweeps(ctx, visible, zoom, now) {
  ctx.lineWidth = 1.2 / zoom;
  ctx.globalAlpha = 0.2;
  const sweep = (now / 3000) * Math.PI * 2;
  for (const n of visible) {
    if (n.owner === 'neutral' || n.size < 22) continue;
    const a = sweep + n.id * 0.9;
    const reach = n.size - 5;
    ctx.strokeStyle = COLOR[n.owner];
    ctx.beginPath();
    ctx.moveTo(n.x, n.y);
    ctx.lineTo(n.x + Math.cos(a) * reach, n.y + Math.sin(a) * reach);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Pass C — building ring + central core + hub beacon. Flat fills only — NO
 *  shadowBlur halo (that was ~8000 blurred draws/frame). A 1px lighter
 *  top-left edge per building gives a cheap hint of depth instead. */
export function drawNodeBuildings(ctx, visible, zoom, now, adj) {
  const slowSpin = now / 24000;
  for (const n of visible) {
    const col = COLOR[n.owner];
    let count = Math.round(4 + (n.size - 20) * 0.11);
    if (count < 4) count = 4;
    if (count > 10) count = 10;
    const ringR = n.size - 9;
    const bHalf = Math.max(1.6, n.size * 0.07);
    const angles = _ringAngles[count];

    // Buildings — flat faction fill, no blur. (Halo removed: it was the
    // single biggest per-frame cost in the whole renderer.)
    ctx.fillStyle = rgba(col, 0.62);
    for (let k = 0; k < count; k++) {
      const a = slowSpin + angles[k];
      const bx = n.x + Math.cos(a) * ringR;
      const by = n.y + Math.sin(a) * ringR;
      ctx.fillRect(bx - bHalf, by - bHalf, bHalf * 2, bHalf * 2);
    }
    // Cheap depth: a lighter 1px notch on each building's top-left corner.
    ctx.fillStyle = rgba(col, 0.9);
    const e = Math.max(0.6, bHalf * 0.5);
    for (let k = 0; k < count; k++) {
      const a = slowSpin + angles[k];
      const bx = n.x + Math.cos(a) * ringR;
      const by = n.y + Math.sin(a) * ringR;
      ctx.fillRect(bx - bHalf, by - bHalf, e, e);
    }

    // Central core.
    const coreR = Math.max(2, n.size * 0.16);
    ctx.fillStyle = rgba(col, 0.7);
    ctx.beginPath();
    ctx.arc(n.x, n.y, coreR, 0, Math.PI * 2);
    ctx.fill();

    // Hub beacon — pulsing pip on high-degree command nodes.
    const degree = adj.get(n.id)?.size || 0;
    if (degree >= 4) {
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(now / 400 + n.id);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(1.5, coreR * 0.55), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // One-shot capture flash.
    if (n.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${n.flash * 0.45})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

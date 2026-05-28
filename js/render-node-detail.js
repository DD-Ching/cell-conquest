// =====================================================
// Node detail passes — the "fortified Mars compound" look that turns a flat
// gray button into a base. Split out of render-entities.js (which sits at the
// 500-line hard cap) per the established sibling-file pattern.
//
// Every export here is a PER-LAYER pass: it takes the already-culled visible[]
// node array from drawNodes and walks it once, matching the per-pass structure
// PR #11 introduced (uniform-alpha layers set globalAlpha once per pass, not
// once per node). All passes assume LOD >= 2 — the caller skips them at low LOD.
//
// Performance: drawNodes runs over 800+ visible nodes late-game. No per-node
// allocations in these loops — faction tints are cached per (hex, alpha) so
// fillStyle gets a pre-built string instead of re-parsing hex every frame.
// =====================================================
import { COLOR } from './factions.js';

// hex → "rgba(r,g,b,A)" cache, keyed by hex+alpha. Avoids per-node hex parse
// + string alloc in the building loop (the hot path: ~10 buildings × N nodes).
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

// Fixed building angles (radians) — pre-baked so the loop does a table lookup
// instead of k/count*2π every node. Index by building count (3..10). Each row
// spreads `count` buildings evenly around the ring with a per-row phase offset
// so different-sized compounds don't all align their first building due north.
const _ringAngles = [];
for (let count = 0; count <= 10; count++) {
  const row = [];
  const phase = count * 0.21;            // mild per-count rotation
  for (let k = 0; k < count; k++) row.push(phase + (k / count) * Math.PI * 2);
  _ringAngles.push(row);
}

/** Pass D — faction rim with a 2-3 px outer glow, then the dark compound disc
 *  with a radial inner shadow for depth. Replaces the flat rim + flat dark
 *  fill from the old Pass 6. shadowBlur is set ONCE for the whole rim sub-pass
 *  and reset to 0 before the (un-shadowed) compound fills, so we pay the blur
 *  cost on one stroke layer, not per node twice. */
export function drawNodeCompounds(ctx, visible, zoom) {
  // Rim layer — one shadowBlur for the whole pass (screen-space via /zoom).
  ctx.shadowBlur = 3 / zoom;
  for (const n of visible) {
    const col = COLOR[n.owner];
    ctx.shadowColor = col;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';

  // Dark compound disc + inner shadow gradient (depth: lit center → dark rim).
  for (const n of visible) {
    const inner = n.size - 4;
    ctx.fillStyle = 'rgba(15, 8, 4, 0.7)';
    ctx.beginPath();
    ctx.arc(n.x, n.y, inner, 0, Math.PI * 2);
    ctx.fill();
    // Radial shade — transparent at center, darkening to the rim. Gives the
    // compound a bowl/crater feel instead of a flat puck.
    const g = ctx.createRadialGradient(n.x, n.y, inner * 0.25, n.x, n.y, inner);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(n.x, n.y, inner, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Pass B — radar sweep for medium+ nodes. A single faint faction-tinted
 *  radial line that rotates clockwise once per ~3 s. Skips neutral (no
 *  garrison to scan) and tiny outposts (n.size < 22). Drawn between the rim
 *  and the inner buildings so buildings paint on top of the sweep line. */
export function drawRadarSweeps(ctx, visible, zoom, now) {
  ctx.lineWidth = 1.2 / zoom;
  ctx.globalAlpha = 0.2;
  const sweep = (now / 3000) * Math.PI * 2;      // one revolution / 3 s, CW
  for (const n of visible) {
    if (n.owner === 'neutral' || n.size < 22) continue;
    // Per-node phase from id so neighbouring radars don't sweep in lockstep.
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

/** Pass C — building ring + central core + hub beacon, the heart of the
 *  "compound" read. Replaces the old rotating dot ring:
 *   - a faction-tinted CORE disc at the node center,
 *   - 4-10 BUILDINGS as small squares at fixed ring angles (count scales with
 *     n.size), each with a 1px outer-glow halo, tinted ~60% faction alpha,
 *   - a barely-perceptible slow rotation (fortifications shouldn't spin),
 *   - a pulsing HUB BEACON at center for high-degree command nodes.
 *  Also carries the one-shot capture flash that used to live in the old
 *  overlay helper. */
export function drawNodeBuildings(ctx, visible, zoom, now, adj) {
  const slowSpin = now / 24000;                  // ~barely moving (4× slower)
  for (const n of visible) {
    const col = COLOR[n.owner];
    // Building count scales with node size: ~20px → 4, ~75px → 10.
    let count = Math.round(4 + (n.size - 20) * 0.11);
    if (count < 4) count = 4;
    if (count > 10) count = 10;
    const ringR = n.size - 9;
    const bHalf = Math.max(1.6, n.size * 0.07);  // building half-size (world px)
    const angles = _ringAngles[count];

    // Building halo layer — 1px outer glow, screen-space so it survives zoom.
    ctx.shadowColor = col;
    ctx.shadowBlur = 1.5 / zoom;
    ctx.fillStyle = rgba(col, 0.6);
    for (let k = 0; k < count; k++) {
      const a = slowSpin + angles[k];
      const bx = n.x + Math.cos(a) * ringR;
      const by = n.y + Math.sin(a) * ringR;
      ctx.fillRect(bx - bHalf, by - bHalf, bHalf * 2, bHalf * 2);
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';

    // Central core — small faction-tinted disc anchoring the compound.
    const coreR = Math.max(2, n.size * 0.16);
    ctx.fillStyle = rgba(col, 0.7);
    ctx.beginPath();
    ctx.arc(n.x, n.y, coreR, 0, Math.PI * 2);
    ctx.fill();

    // Hub beacon — high-degree command nodes get a bright pulsing pip so the
    // eye sorts strategic junctions from leaf outposts at a glance.
    const degree = adj.get(n.id)?.size || 0;
    if (degree >= 4) {
      const pulse = 0.55 + 0.45 * Math.sin(now / 400 + n.id);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(1.5, coreR * 0.55), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // One-shot capture flash (preserved from the prior overlay pass).
    if (n.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${n.flash * 0.45})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

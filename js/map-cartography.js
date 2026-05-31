// =====================================================
// Cartographic detail bakes — the layers that turn the satellite elevation
// shade into something that reads as a MAP: topographic contour lines and the
// coastline. Pulled out of render-procgen.js (which owns the bake orchestration
// + region labels) so that file stays lean and this marching-squares code lives
// on its own.
//
// Everything here is BAKE-TIME only: render-procgen calls these once per world
// while building the static offscreen, so per frame it's still a single
// drawImage. The functions take a world-scaled 2D context (the caller has
// already applied c.scale(scale, scale)) and draw in WORLD coordinates, so line
// widths are in world units — matching the river/ridge barrier widths.
//
// Worker-safe: no DOM, no state; called in both the main-thread and
// render-worker bakes. geoGrid is shipped to the worker via the one-shot
// 'procgen' message, so the grid is available in both contexts.
// =====================================================
import { WORLD_W, WORLD_H } from './config.js';

// Marching-squares iso-contour extractor. Walks a scalar `field` (row-major,
// gw×gh) and returns the line segments where it crosses `level`, in GRID
// coordinates (0..gw-1, 0..gh-1) with linear edge interpolation so the contour
// reads smooth, not stair-stepped. Pure geometry — no ctx, no world scaling —
// so callers reuse it for BOTH topographic contours (elevation field) and
// faction-territory borders (coverage field, see render-borders.js).
//
// Returns: [{x1,y1,x2,y2}, …] in grid space. Multiply by your cell size to get
// world coords.
export function marchingSquares(field, gw, gh, level) {
  const segs = [];
  if (!field || gw < 2 || gh < 2) return segs;
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const i = y * gw + x;
      const tl = field[i], tr = field[i + 1], bl = field[i + gw], br = field[i + gw + 1];
      // Case index: which corners sit ABOVE the iso-level (TL=8 TR=4 BR=2 BL=1).
      let cs = 0;
      if (tl > level) cs |= 8;
      if (tr > level) cs |= 4;
      if (br > level) cs |= 2;
      if (bl > level) cs |= 1;
      if (cs === 0 || cs === 15) continue;       // fully above / below → no line
      const x0 = x, y0 = y, x1 = x + 1, y1 = y + 1;
      // Edge crossings (linear interp). Denominators are non-zero because the
      // case test guarantees the two corners straddle `level`.
      const topX   = x0 + (level - tl) / (tr - tl);   // top edge   TL→TR
      const rightY = y0 + (level - tr) / (br - tr);   // right edge TR→BR
      const botX   = x0 + (level - bl) / (br - bl);   // bottom     BL→BR
      const leftY  = y0 + (level - tl) / (bl - tl);   // left edge  TL→BL
      const push = (ax, ay, bx, by) => segs.push({ x1: ax, y1: ay, x2: bx, y2: by });
      switch (cs) {
        case 1: case 14: push(x0, leftY, botX, y1); break;
        case 2: case 13: push(botX, y1, x1, rightY); break;
        case 3: case 12: push(x0, leftY, x1, rightY); break;
        case 4: case 11: push(topX, y0, x1, rightY); break;
        case 6: case 9:  push(topX, y0, botX, y1); break;
        case 7: case 8:  push(x0, leftY, topX, y0); break;
        case 5:          push(x0, leftY, topX, y0); push(botX, y1, x1, rightY); break;   // saddle
        case 10:         push(x0, leftY, botX, y1); push(topX, y0, x1, rightY); break;   // saddle
      }
    }
  }
  return segs;
}

// Marching-squares iso-contours from the coarse elevation grid. Each level is
// drawn as connected line segments with linear edge interpolation, so the lines
// read as smooth topographic contours rather than blocky stair-steps. The grid
// is small (≈110×84), so even several levels are cheap at bake time.
//
// opts: { levels:number[], color:string, lineWidth?:number, alpha?:number }
export function bakeContours(c, gg, { levels, color, lineWidth = 12, alpha = 0.13 }) {
  const { GW, GH, elev } = gg;
  if (!elev || GW < 2 || GH < 2) return;
  const sx = WORLD_W / (GW - 1);
  const sy = WORLD_H / (GH - 1);
  c.save();
  c.globalAlpha = alpha;
  c.strokeStyle = color;
  c.lineWidth = lineWidth;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  for (let li = 0; li < levels.length; li++) {
    // Reuse the shared extractor, then scale grid → world coords for the stroke.
    const segs = marchingSquares(elev, GW, GH, levels[li]);
    for (const s of segs) {
      c.moveTo(s.x1 * sx, s.y1 * sy);
      c.lineTo(s.x2 * sx, s.y2 * sy);
    }
  }
  c.stroke();
  c.restore();
}

/** Convenience: evenly spaced contour levels from just above sea level up to
 *  near the peak. Excludes sea level itself (drawn separately as the coast). */
export function contourLevels(seaLevel, step = 0.085, top = 0.95) {
  const out = [];
  for (let L = seaLevel + step; L < top; L += step) out.push(L);
  return out;
}

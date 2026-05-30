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
    const L = levels[li];
    for (let y = 0; y < GH - 1; y++) {
      for (let x = 0; x < GW - 1; x++) {
        const i = y * GW + x;
        const tl = elev[i], tr = elev[i + 1], bl = elev[i + GW], br = elev[i + GW + 1];
        // Case index: which corners sit ABOVE the iso-level (TL=8 TR=4 BR=2 BL=1).
        let cs = 0;
        if (tl > L) cs |= 8;
        if (tr > L) cs |= 4;
        if (br > L) cs |= 2;
        if (bl > L) cs |= 1;
        if (cs === 0 || cs === 15) continue;     // fully above / below → no line
        const x0 = x * sx, y0 = y * sy, x1 = x0 + sx, y1 = y0 + sy;
        // Edge crossings (linear interp). Denominators are non-zero because the
        // case test guarantees the two corners straddle L.
        const topX    = x0 + sx * ((L - tl) / (tr - tl));   // top edge   TL→TR
        const rightY  = y0 + sy * ((L - tr) / (br - tr));   // right edge TR→BR
        const botX    = x0 + sx * ((L - bl) / (br - bl));   // bottom     BL→BR
        const leftY   = y0 + sy * ((L - tl) / (bl - tl));   // left edge  TL→BL
        switch (cs) {
          case 1: case 14: c.moveTo(x0, leftY);  c.lineTo(botX, y1);  break;
          case 2: case 13: c.moveTo(botX, y1);   c.lineTo(x1, rightY); break;
          case 3: case 12: c.moveTo(x0, leftY);  c.lineTo(x1, rightY); break;
          case 4: case 11: c.moveTo(topX, y0);   c.lineTo(x1, rightY); break;
          case 6: case 9:  c.moveTo(topX, y0);   c.lineTo(botX, y1);  break;
          case 7: case 8:  c.moveTo(x0, leftY);  c.lineTo(topX, y0);  break;
          case 5:          c.moveTo(x0, leftY);  c.lineTo(topX, y0);
                           c.moveTo(botX, y1);   c.lineTo(x1, rightY); break;   // saddle
          case 10:         c.moveTo(x0, leftY);  c.lineTo(botX, y1);
                           c.moveTo(topX, y0);   c.lineTo(x1, rightY); break;   // saddle
        }
      }
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

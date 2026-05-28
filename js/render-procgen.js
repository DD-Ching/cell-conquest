// =====================================================
// Procgen terrain visuals — region tint + barrier (river/canyon) shapes.
//
// Only active when the geography-first generator ran (state.regions non-empty);
// legacy maps draw nothing. Sits low in the world layers (just above the
// faction turf wash, below the hex grid / roads / units) so it communicates the
// map's macro structure without covering gameplay:
//
//   • Region tint  — a soft, type-coloured radial wash at each region centre so
//                    a city / mining / wasteland zone reads as a distinct place.
//   • Barriers     — rivers/canyons drawn as wide terrain channels. Roads draw
//                    LATER (on top), so the few bridge crossings visibly span
//                    the channel while the empty corridor reads as a bottleneck.
//
// Cheap: ≤15 region gradients + 1–2 short polylines per frame, all culled-free
// (tiny counts). Worker-safe — render.js calls this in both contexts; the
// render snapshot ships state.regions + state.barriers.
//
// TODO(procgen): biome area fills (wasteland/desert polygons), region boundary
// outlines, mountain ranges as hatched polygons.
// =====================================================
import { state } from './state.js';

// Neutral terrain hues per region archetype (NOT faction colours — these read
// as ground, the faction turf wash sits beneath and owns the saturated colour).
const REGION_TINT = {
  city:            '#6f86b0',
  industrial_zone: '#b07a3c',
  mining_zone:     '#c79a3c',
  military_base:   '#b05a52',
  frontier:        '#9c8a63',
  wasteland:       '#6b5048',
  research_site:   '#3fa0a0',
};

function rgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Bottom-ish layer: region tint + terrain barriers. Call in WORLD space. */
export function drawProcgen(ctx) {
  const regions = state.regions;
  if (!regions || !regions.length) return;     // legacy gen → nothing to draw

  // Region tint — soft radial wash per region.
  for (const r of regions) {
    const col = REGION_TINT[r.type] || '#888888';
    const g = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, r.radius);
    g.addColorStop(0,   rgba(col, 0.18));
    g.addColorStop(0.6, rgba(col, 0.10));   // flatter core so the zone reads, soft rim
    g.addColorStop(1,   rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Barriers — rivers/canyons as wide terrain channels.
  for (const bar of state.barriers) {
    const p = bar.points;
    if (!p || p.length < 2) continue;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
    const river = bar.kind === 'river';
    ctx.strokeStyle = river ? 'rgba(38, 66, 104, 0.45)' : 'rgba(28, 17, 11, 0.55)';
    ctx.lineWidth = 92;
    ctx.stroke();
    ctx.strokeStyle = river ? 'rgba(70, 120, 170, 0.55)' : 'rgba(14, 9, 7, 0.70)';
    ctx.lineWidth = 46;
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
  }
}

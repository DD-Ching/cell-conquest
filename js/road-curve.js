// =====================================================
// Road curvature — turns the dead-straight graph edges into gently bowed
// "map roads" WITHOUT touching the simulation. This is render-only geometry:
//
//   • The road STROKE is drawn as a quadratic Bézier whose midpoint sits a
//     deterministic, per-edge distance off the straight chord.
//   • Anything that visually rides a road (fleets, wreck piles, drone nets,
//     fleet trails) is displaced by the SAME perpendicular offset so it sits
//     on the painted curve instead of cutting the chord.
//
// The sim (fleets.js movement, combat, wreck-detour math) still uses the
// straight node-to-node centerline for timing, collision, and detours — so
// curving roads is provably OUTCOME-NEUTRAL. It only moves pixels.
//
// Determinism: the bow magnitude + sign come from a hash of the (unordered)
// endpoint node ids, so a given road keeps the same bend every frame and the
// curve is identical on the main thread and inside the render worker (node ids
// are stable across the snapshot). No per-frame state, no RNG.
//
// Math: for a quadratic B(t) = (1-t)²A + 2(1-t)t·C + t²·D with control point
// C = M + n·(2·bow) (M = chord midpoint, n = unit perpendicular), the offset
// from the chord at parameter t is exactly  n · 4·bow·t·(1-t).  At t=0.5 that
// equals n·bow (the midpoint bow); at the endpoints it's 0 (curve meets the
// nodes). So projecting a point's chord-parameter t and adding that offset
// places it precisely on the painted Bézier.
// =====================================================
import { state } from './state.js';

const MAX_BOW_FRAC = 0.13;   // midpoint bow as a fraction of chord length
const MAX_BOW_ABS  = 95;     // hard cap (world px) so long highways don't balloon
const MIN_LEN      = 70;     // shorter stubs stay straight (a tiny curve reads as a kink)

// Reused scratch so the per-fleet / per-wreck offset query doesn't allocate.
// Single-threaded JS: callers read .ox/.oy immediately, before the next call.
const _off = { ox: 0, oy: 0 };
const ZERO = { ox: 0, oy: 0 };

/** Curves are on in every map mode except 'debug' (which restores the literal
 *  straight-edge graph for diagnostics). */
export function roadsCurved() {
  return state.mapMode !== 'debug';
}

/** Deterministic 0..1 hash of an unordered node-id pair (xorshift scramble). */
function edgeHash(aId, bId) {
  const lo = aId < bId ? aId : bId;
  const hi = aId < bId ? bId : aId;
  let h = (Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) >>> 0;
  h ^= h << 13; h >>>= 0;
  h ^= h >>> 17;
  h ^= h << 5;  h >>>= 0;
  return h / 4294967296;
}

/** Signed bow magnitude (world px) for this edge. 0 → draw it straight
 *  (curves disabled, or the edge is too short to bend cleanly). */
export function roadBow(aId, bId, len) {
  if (!roadsCurved() || len < MIN_LEN) return 0;
  const r = edgeHash(aId, bId);                 // 0..1 (unordered)
  const sign = r < 0.5 ? -1 : 1;
  const mag = 0.5 + Math.abs(r - 0.5);          // 0.5 .. 1.0 of the cap
  // Orientation factor: the magnitude is order-independent, but every caller
  // derives the perpendicular from its OWN (a→b) order, and that perpendicular
  // FLIPS when the order reverses. A fleet traversing an edge high-id→low-id
  // would then ride the OPPOSITE side of the chord from where the road is drawn
  // (the "road bows up but units walk the down-arc" bug). Folding the order into
  // the sign makes bow·perp invariant: reverse the order and BOTH flip, so the
  // curve lands on the same side no matter who asks or which way they travel.
  const orient = aId < bId ? 1 : -1;
  return orient * sign * Math.min(MAX_BOW_ABS, len * MAX_BOW_FRAC) * mag;
}

/** Quadratic control point placing the curve's midpoint `bow` off the chord.
 *  Returns the control point plus the unit perpendicular (callers reuse it). */
export function roadControl(ax, ay, bx, by, bow) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;          // unit perpendicular
  return {
    cx: (ax + bx) * 0.5 + px * bow * 2,
    cy: (ay + by) * 0.5 + py * bow * 2,
    px, py, len,
  };
}

/** Append this edge's path (curved when bowed, straight otherwise) to ctx.
 *  Caller has already begun the path / will stroke it. */
export function tracePath(ctx, ax, ay, bx, by, bow) {
  ctx.moveTo(ax, ay);
  if (bow) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    ctx.quadraticCurveTo((ax + bx) * 0.5 + px * bow * 2, (ay + by) * 0.5 + py * bow * 2, bx, by);
  } else {
    ctx.lineTo(bx, by);
  }
}

/** Perpendicular offset to move a world point at chord-parameter t onto the
 *  curve. Returns a REUSED object — read .ox/.oy before calling again. */
export function curveOffsetForPoint(ax, ay, bx, by, aId, bId, wx, wy) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return ZERO;
  const bow = roadBow(aId, bId, len);
  if (!bow) return ZERO;
  let t = ((wx - ax) * dx + (wy - ay) * dy) / (len * len);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const k = 4 * bow * t * (1 - t);
  _off.ox = (-dy / len) * k;
  _off.oy = (dx / len) * k;
  return _off;
}

/** Tangent (heading) angle, in radians, of the (possibly curved) road at the
 *  world point's projected chord-parameter t. On a STRAIGHT edge this is exactly
 *  the chord angle; on a bowed edge it's the Bézier tangent, which can sit up to
 *  ~27° off the chord near the segment ends. Lets a unit that RIDES the painted
 *  curve (e.g. a tank's hull + gun barrel) point along the visible road instead
 *  of the straight node-to-node chord. Render-only — never read by the sim. */
export function curveHeadingForPoint(ax, ay, bx, by, aId, bId, wx, wy) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return Math.atan2(dy, dx);
  const bow = roadBow(aId, bId, len);
  if (!bow) return Math.atan2(dy, dx);            // straight → chord angle
  const px = -dy / len, py = dx / len;            // unit perpendicular
  const cx = (ax + bx) * 0.5 + px * bow * 2;      // quadratic control point
  const cy = (ay + by) * 0.5 + py * bow * 2;
  let t = ((wx - ax) * dx + (wy - ay) * dy) / (len * len);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  // B'(t) = 2(1-t)(C-A) + 2t(B-C)  — quadratic Bézier derivative (tangent).
  const tx = 2 * (1 - t) * (cx - ax) + 2 * t * (bx - cx);
  const ty = 2 * (1 - t) * (cy - ay) + 2 * t * (by - cy);
  return Math.atan2(ty, tx);
}

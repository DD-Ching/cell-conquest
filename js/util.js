// =====================================================
// Pure helpers — no state, no DOM.
// =====================================================

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Closest-point distance from (px,py) to the line segment (ax,ay)-(bx,by). */
export function pointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.0001) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

/** Even-odd ray-cast: is (px,py) inside the polygon `poly` (array of {x,y})?
 *  Used by lasso selection. Treats the vertex list as a closed loop. */
export function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) &&
        (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Do segments (ax,ay)-(bx,by) and (cx,cy)-(dx,dy) properly intersect?
 *  Orientation-sign test; ignores collinear-touch edge cases (fine for the
 *  procgen barrier-crossing check — a road grazing a river endpoint is rare
 *  and harmless either way). */
export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

export function formatTime(s) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

// Numeric key for state.inboundDronesByTarget — replaces the per-lookup string
// concat ('node:'+id etc.) that ran in the hottest drone loops (per drone per
// sub-step). (kind,id) → a unique number: id*4 + code keeps the three separate
// id-spaces distinct (a fleet, a node, and a turret can each hold id 5), and an
// unknown kind lands in its own slot rather than poisoning the map with NaN.
const _INBOUND_CODE = { fleet: 0, node: 1, turret: 2 };
export function inboundKey(kind, id) {
  return id * 4 + (_INBOUND_CODE[kind] ?? 3);
}

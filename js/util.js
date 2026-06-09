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

/** Delaunay triangulation (Bowyer–Watson) of `pts` (array of {x,y}).
 *  Returns triangles as [i, j, k] index triples into `pts`. O(n²) typical —
 *  fine for our use (a faction's owned-node set, recomputed only when ownership
 *  changes). Fewer than 3 points, or all-collinear, returns []. Pure / worker-
 *  safe: used by render-territory.js to build geometric turf polygons. */
export function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return [];
  // Super-triangle that encloses every input point.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dmax = Math.max(maxX - minX, maxY - minY) || 1;
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
  // Vertex coords: real points 0..n-1, super-triangle corners at n, n+1, n+2.
  const vx = new Float64Array(n + 3), vy = new Float64Array(n + 3);
  for (let i = 0; i < n; i++) { vx[i] = pts[i].x; vy[i] = pts[i].y; }
  vx[n] = midX - 20 * dmax;     vy[n] = midY - dmax;
  vx[n + 1] = midX;             vy[n + 1] = midY + 20 * dmax;
  vx[n + 2] = midX + 20 * dmax; vy[n + 2] = midY - dmax;

  let tris = [[n, n + 1, n + 2]];

  // Is (px,py) strictly inside triangle t's circumcircle?
  const inCircum = (t, px, py) => {
    const ax = vx[t[0]], ay = vy[t[0]];
    const bx = vx[t[1]], by = vy[t[1]];
    const cx = vx[t[2]], cy = vy[t[2]];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return false;            // degenerate / collinear
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    const r2 = (ax - ux) ** 2 + (ay - uy) ** 2;
    const ex = px - ux, ey = py - uy;
    return ex * ex + ey * ey <= r2 * (1 + 1e-9);
  };

  for (let i = 0; i < n; i++) {
    const px = vx[i], py = vy[i];
    const bad = [];
    for (const t of tris) if (inCircum(t, px, py)) bad.push(t);
    // Re-triangulate the hole: keep only edges on exactly one bad triangle.
    const edges = [];
    for (const t of bad) {
      const te = [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]];
      for (const e of te) {
        let shared = false;
        for (const t2 of bad) {
          if (t2 === t) continue;
          if ((t2[0] === e[0] || t2[1] === e[0] || t2[2] === e[0]) &&
              (t2[0] === e[1] || t2[1] === e[1] || t2[2] === e[1])) { shared = true; break; }
        }
        if (!shared) edges.push(e);
      }
    }
    tris = tris.filter(t => !bad.includes(t));
    for (const e of edges) tris.push([e[0], e[1], i]);
  }
  // Drop triangles that still touch a super-triangle corner.
  return tris.filter(t => t[0] < n && t[1] < n && t[2] < n);
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

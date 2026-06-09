// =====================================================
// Territory turf — geometric area fill.
//
// Paints each faction's holdings as a SOLID GEOMETRIC AREA: triangulate the
// faction's owned nodes (Delaunay), drop the long, stretched triangles that
// would bridge far-apart clusters (an alpha-shape), and fill what remains in
// the faction colour. The enclosed land reads as turf — "圍起來的地方就是藍色".
//
// This replaces the old disc + capsule "wash" (a node got a fat translucent
// halo and same-owner edges got fat capsules between them) which, with only a
// couple of nodes, drew as a lumpy dog-bone blob. The triangle mesh gives a
// crisp frontier instead.
//
// Three layers, bottom→top:
//   • fill      — the union of kept triangles, one flat colour (one Path2D
//                 fill ⇒ overlaps don't double-darken).
//   • internal  — faint same-colour mesh lines between interior nodes (the
//                 "圍成一堆三角形" read; LOD'd out at deep overview).
//   • boundary  — brighter frontier stroke on edges owned by ONE triangle.
//
// Cheap by construction: the triangulation is rebuilt only when ownership
// changes (a cheap per-frame owners-hash detects this) and is debounced so a
// burst of captures can't thrash it. Per frame we just fill a cached Path2D
// and stroke two cached segment lists.
//
// Worker-safe: render.js calls drawTerritory() in BOTH the main thread and the
// render worker. Both have state.nodes and a populated COLOR map (the worker
// mirrors it from the snapshot); delaunay() + Path2D are pure / available in a
// worker context.
// =====================================================
import { state } from './state.js';
import { COLOR } from './factions.js';
import { delaunay } from './util.js';
import { TERRITORY_MAX_ALPHA } from './config.js';

// ---- Tuning (render-side, not gameplay) ----
const FILL_ALPHA      = Math.max(0.24, TERRITORY_MAX_ALPHA); // turf body opacity (≥0.24 so warm factions still read over the rust ground)
const BOUNDARY_ALPHA  = 0.62;                // frontier outline opacity
const INTERNAL_ALPHA  = 0.10;                // interior mesh-line opacity
const ALPHA_SHAPE_FAC = 2.2;                 // drop a triangle whose longest edge
                                             //   exceeds this × the faction's median
                                             //   triangle-edge length (carves concavities,
                                             //   stops far clusters bridging across the map)
const REBAKE_MIN_DT   = 0.4;                 // s of game time between rebuilds (debounce)
const INTERNAL_MIN_ZOOM = 0.22;             // hide interior mesh below this zoom (overview)

// Cache: one entry per faction with ≥3 owned nodes worth drawing.
let factions = [];           // [{ color, fill:Path2D, boundary:[x1,y1,x2,y2,…], internal:[…] }]
let lastSig = -1, lastBakeT = -1;

const elen = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Recompute the per-faction triangle territory from current ownership. */
function rebuild() {
  factions = [];
  const nodes = state.nodes;

  // Group owned nodes by faction.
  const byOwner = new Map();
  for (const n of nodes) {
    if (!n || n.owner === 'neutral' || !COLOR[n.owner]) continue;
    let arr = byOwner.get(n.owner);
    if (!arr) { arr = []; byOwner.set(n.owner, arr); }
    arr.push(n);
  }

  for (const [owner, ns] of byOwner) {
    if (ns.length < 3) continue;                 // no area to enclose yet
    const tris = delaunay(ns);
    if (!tris.length) continue;

    // Alpha-shape threshold off this faction's own median edge length. With ≤2
    // triangles there's nothing to carve, so keep them all (a fresh 3-node hold
    // always shows its patch even if a touch stretched).
    const applyAlpha = tris.length > 2;
    let maxEdge = Infinity;
    if (applyAlpha) {
      const lens = [];
      for (const t of tris) {
        lens.push(elen(ns[t[0]], ns[t[1]]), elen(ns[t[1]], ns[t[2]]), elen(ns[t[2]], ns[t[0]]));
      }
      lens.sort((a, b) => a - b);
      maxEdge = (lens[lens.length >> 1] || 1) * ALPHA_SHAPE_FAC;
    }

    const fill = new Path2D();
    const edgeCount = new Map();                  // packed edge key → #kept triangles
    let kept = 0;
    for (const t of tris) {
      const a = ns[t[0]], b = ns[t[1]], c = ns[t[2]];
      if (applyAlpha && Math.max(elen(a, b), elen(b, c), elen(c, a)) > maxEdge) continue;
      kept++;
      fill.moveTo(a.x, a.y); fill.lineTo(b.x, b.y); fill.lineTo(c.x, c.y); fill.closePath();
      bumpEdge(edgeCount, t[0], t[1]);
      bumpEdge(edgeCount, t[1], t[2]);
      bumpEdge(edgeCount, t[2], t[0]);
    }
    if (!kept) continue;

    // An edge on exactly one kept triangle is on the frontier; on two it's
    // interior mesh.
    const boundary = [], internal = [];
    for (const [key, c] of edgeCount) {
      const A = ns[Math.floor(key / 1e7)], B = ns[key % 1e7];
      (c === 1 ? boundary : internal).push(A.x, A.y, B.x, B.y);
    }
    factions.push({ color: COLOR[owner], fill, boundary, internal });
  }
}

function bumpEdge(map, i, j) {
  const key = (i < j ? i : j) * 1e7 + (i < j ? j : i);
  map.set(key, (map.get(key) || 0) + 1);
}

function strokeSegs(ctx, segs) {
  ctx.beginPath();
  for (let i = 0; i < segs.length; i += 4) {
    ctx.moveTo(segs[i], segs[i + 1]);
    ctx.lineTo(segs[i + 2], segs[i + 3]);
  }
  ctx.stroke();
}

/** Territory turf fill. Call in WORLD space (after the camera transform),
 *  just above terrain. */
export function drawTerritory(ctx, zoom = 1) {
  const nodes = state.nodes;
  if (!nodes || nodes.length === 0) return;

  // One O(nodes) pass: count claimed + owners hash (rebuild trigger).
  let owned = 0, sig = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    const o = n.owner;
    if (o !== 'neutral') owned++;
    let oc = o.length * 131;
    for (let k = 0; k < o.length; k++) oc = (oc + o.charCodeAt(k)) | 0;
    sig = (sig * 31 + oc + i) | 0;
  }
  if (owned < 3) { lastSig = sig; factions = []; return; }   // nobody holds a patch yet

  const nowT = state.elapsed || 0;
  // Rebake when ownership changed AND either the debounce window elapsed OR the
  // clock went BACKWARDS. A new game/level resets state.elapsed to 0 while
  // lastBakeT still holds the prior game's large timestamp, so `nowT - lastBakeT`
  // is hugely negative and the debounce would suppress the rebake for as long as
  // the last level ran — that's why a finished level's turf lingered into the next.
  if (sig !== lastSig && (lastBakeT < 0 || nowT < lastBakeT || nowT - lastBakeT >= REBAKE_MIN_DT)) {
    rebuild(); lastSig = sig; lastBakeT = nowT;
  }
  if (!factions.length) return;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const showInternal = zoom >= INTERNAL_MIN_ZOOM;
  for (const f of factions) {
    ctx.globalAlpha = FILL_ALPHA;
    ctx.fillStyle = f.color;
    ctx.fill(f.fill);

    if (showInternal && f.internal.length) {
      ctx.globalAlpha = INTERNAL_ALPHA;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 1 / zoom;
      strokeSegs(ctx, f.internal);
    }
    if (f.boundary.length) {
      ctx.globalAlpha = BOUNDARY_ALPHA;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 2.4 / zoom;
      strokeSegs(ctx, f.boundary);
    }
  }
  ctx.restore();
}

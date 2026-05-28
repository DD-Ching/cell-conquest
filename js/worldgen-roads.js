// =====================================================
// Procedural map generation — road graph (geography-obeying).
//
// Consumes the nodes + regions laid down by worldgen.js and wires them into
// state.roads / state.adj with the SAME shape the legacy buildRoads() produces
// (so render / pathfinding / AI are untouched), plus a per-road `kind` tag:
//
//   'local'   — dense intra-region mesh (k nearest same-region neighbours)
//   'highway' — sparse inter-region backbone (MST over region centres, each
//               edge realised as the closest node pair across the two regions)
//   'bridge'  — connectivity repair edge (union-find stitch of any leftover
//               components) — kept thin/neutral.
//
// widthMul is derived the same way as legacy (endpoint degree + a seeded
// Gaussian jitter) so the existing road renderer reads it directly; highways
// get a floor so they always draw as arteries.
//
// TODO(procgen): risky long "shortcut" edges (dashed, danger-tagged) once the
// terrain-blocker pass lands — they want to cut across a barrier near a pass.
// =====================================================
import { state } from './state.js';
import { dist, segmentsIntersect } from './util.js';

const LOCAL_K = 3;

/** Box–Muller Gaussian from a seeded uniform rng (mean 0, σ 1). */
function gauss(rng) {
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function addEdge(a, b, kind, len) {
  if (a === b || state.adj.get(a).has(b)) return false;
  state.adj.get(a).add(b);
  state.adj.get(b).add(a);
  state.roads.push({ a, b, length: len, kind, widthMul: 1 });
  return true;
}

/** k nearest neighbours of node n drawn from `pool` (excludes n). */
function nearestK(n, pool, k) {
  return pool
    .filter(m => m.id !== n.id)
    .map(m => ({ id: m.id, d: dist(n, m) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k);
}

/** Union-find stitch: bridge any disconnected components by the shortest
 *  cross-component node pair, exactly like legacy buildRoads. Bounded retries. */
function bridgeComponents() {
  const { nodes } = state;
  const parent = nodes.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const r of state.roads) { const ra = find(r.a), rb = find(r.b); if (ra !== rb) parent[ra] = rb; }

  for (let safety = 0; safety < 80; safety++) {
    const comps = new Map();
    for (const n of nodes) {
      const root = find(n.id);
      if (!comps.has(root)) comps.set(root, []);
      comps.get(root).push(n);
    }
    if (comps.size <= 1) break;
    const keys = [...comps.keys()];
    let best = [Infinity, null, null];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        for (const a of comps.get(keys[i])) {
          for (const b of comps.get(keys[j])) {
            const d = dist(a, b);
            if (d < best[0]) best = [d, a, b];
          }
        }
      }
    }
    if (!best[1]) break;
    const [d, a, b] = best;
    addEdge(a.id, b.id, 'bridge', d);
    parent[find(a.id)] = find(b.id);
  }
}

/** Build state.roads + state.adj over the already-placed state.nodes/regions. */
export function generateRoads(rng) {
  const { nodes, regions } = state;
  state.roads = [];
  state.adj = new Map();
  for (const n of nodes) state.adj.set(n.id, new Set());

  // Group node ids by region for local meshing + highway endpoints.
  const byRegion = new Map();
  for (const n of nodes) {
    if (!byRegion.has(n.regionId)) byRegion.set(n.regionId, []);
    byRegion.get(n.regionId).push(n);
  }

  // 1) LOCAL mesh — connect to k nearest SAME-region neighbours so each region
  //    becomes a tight cluster. Open-plains nodes (regionId < 0) or tiny
  //    regions fall back to the global pool so they still hook in.
  for (const n of nodes) {
    const bucket = byRegion.get(n.regionId);
    const pool = (n.regionId >= 0 && bucket && bucket.length > LOCAL_K) ? bucket : nodes;
    for (const o of nearestK(n, pool, LOCAL_K)) addEdge(n.id, o.id, 'local', o.d);
  }

  // 2) HIGHWAYS — MST over region centres; each backbone edge becomes a highway
  //    between the closest node pair across the two regions. Sparse by design.
  if (regions.length > 1) {
    const regById = new Map(regions.map(r => [r.id, r]));
    const inTree = new Set([regions[0].id]);
    const rest = new Set(regions.map(r => r.id)); rest.delete(regions[0].id);
    while (rest.size) {
      let pick = [Infinity, null, null];
      for (const a of inTree) for (const b of rest) {
        const d = dist(regById.get(a), regById.get(b));
        if (d < pick[0]) pick = [d, a, b];
      }
      const [, ra, rb] = pick;
      const A = byRegion.get(ra) || [], B = byRegion.get(rb) || [];
      let pair = [Infinity, null, null];
      for (const na of A) for (const nb of B) {
        const d = dist(na, nb);
        if (d < pair[0]) pair = [d, na.id, nb.id];
      }
      if (pair[1] != null) addEdge(pair[1], pair[2], 'highway', pair[0]);
      inTree.add(rb); rest.delete(rb);
    }
  }

  // 3) CONNECTIVITY — stitch any leftover islands.
  bridgeComponents();

  // 4) Per-road width — endpoint degree drives artery vs. lane; seeded Gaussian
  //    keeps similar roads from looking identical; highways get a floor.
  for (const r of state.roads) {
    const degA = state.adj.get(r.a).size, degB = state.adj.get(r.b).size;
    const importance = 0.65 + Math.min(1, Math.max(0, (degA + degB - 3) / 6)) * 0.7;
    let w = importance + gauss(rng) * 0.12;
    if (r.kind === 'highway') w = Math.max(w, 1.25) + 0.2;
    r.widthMul = Math.max(0.5, Math.min(1.8, w));
  }
}

/** Whole-graph connectivity (BFS from node 0). */
function isConnected() {
  const { nodes, adj } = state;
  if (!nodes.length) return true;
  const seen = new Set([0]); const q = [0];
  while (q.length) { const id = q.shift(); for (const nb of adj.get(id)) if (!seen.has(nb)) { seen.add(nb); q.push(nb); } }
  return seen.size === nodes.length;
}

/** Funnel cross-barrier traffic through a few "pass" nodes. Removes every road
 *  that crosses a terrain barrier, then re-adds the SHORTEST crossings (the
 *  natural narrow points) until the graph is connected again, keeping ≥2 so a
 *  chokepoint always reads. Re-added roads become kind 'bridge' and their
 *  endpoints nodeType 'bridge'. Connectivity is guaranteed (playability beats
 *  chokepoint purity). Runs after generateRoads; needs state.barriers set. */
export function applyBarrierChokepoints() {
  const { barriers, nodes, adj } = state;
  if (!barriers || !barriers.length) return;

  const crossing = [];
  for (const r of state.roads) {
    const a = nodes[r.a], b = nodes[r.b];
    let hit = false;
    for (const bar of barriers) {
      const p = bar.points;
      for (let i = 0; i < p.length - 1; i++) {
        if (segmentsIntersect(a.x, a.y, b.x, b.y, p[i].x, p[i].y, p[i + 1].x, p[i + 1].y)) { hit = true; break; }
      }
      if (hit) break;
    }
    if (hit) crossing.push(r);
  }
  if (crossing.length < 2) return;   // can't form a meaningful chokepoint

  const crossSet = new Set(crossing);
  for (const r of crossing) { adj.get(r.a).delete(r.b); adj.get(r.b).delete(r.a); }
  state.roads = state.roads.filter(r => !crossSet.has(r));

  crossing.sort((x, y) => x.length - y.length);
  let kept = 0;
  for (const r of crossing) {
    adj.get(r.a).add(r.b); adj.get(r.b).add(r.a);
    r.kind = 'bridge';
    state.roads.push(r);
    nodes[r.a].nodeType = 'bridge';
    nodes[r.b].nodeType = 'bridge';
    if (++kept >= 2 && isConnected()) break;
  }
  if (!isConnected()) {                 // safety: re-add until fully reachable
    for (const r of crossing) {
      if (adj.get(r.a).has(r.b)) continue;
      adj.get(r.a).add(r.b); adj.get(r.b).add(r.a);
      r.kind = 'bridge'; state.roads.push(r);
      nodes[r.a].nodeType = 'bridge'; nodes[r.b].nodeType = 'bridge';
      if (isConnected()) break;
    }
  }
}

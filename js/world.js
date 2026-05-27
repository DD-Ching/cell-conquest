// =====================================================
// World generation: node placement, hub size adjustment,
// road graph (k-NN + connectivity), pathfinding.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H, N_NODES_MIN, N_NODES_MAX } from './config.js';
import { dist, pointToSegment } from './util.js';

const NODE_MARGIN = 100;
const BASE_GAP    = 80;
const N_TARGET    = (W, H) => Math.min(N_NODES_MAX, Math.max(N_NODES_MIN, Math.floor((W * H) / 130000)));
// ROAD_MAX must scale with map area, otherwise nodes spread out on a big
// map don't find neighbors within range and we end up with a forest of
// disconnected components. Heuristic: average inter-node distance is
// roughly √(area / N), so allow ~1.4× that as the road-search radius.
const ROAD_MAX    = (W, H, N) => Math.max(320, Math.ceil(Math.sqrt((W * H) / N) * 1.4));
const ROAD_K      = 3;

function pickSize(rng) {
  const r = rng();
  if (r < 0.32) return 20 + rng() * 5;
  if (r < 0.58) return 26 + rng() * 6;
  if (r < 0.77) return 33 + rng() * 7;
  if (r < 0.92) return 44 + rng() * 8;
  return 56 + rng() * 12;
}

/** Scatter passive Mars terrain features (rocks, craters, sand patches)
 *  across the world. Pure decoration — drawn under nodes/turrets so they
 *  read as ground texture, not gameplay objects. */
export function placeTerrain(rng = Math.random) {
  state.terrain = [];
  const area = WORLD_W * WORLD_H;
  // Density: about 1 feature per 18000 world-px²
  const total = Math.floor(area / 18000);
  for (let i = 0; i < total; i++) {
    const roll = rng();
    let kind;
    if (roll < 0.55)      kind = 'rock';
    else if (roll < 0.80) kind = 'crater';
    else                  kind = 'patch';
    state.terrain.push({
      x: rng() * WORLD_W,
      y: rng() * WORLD_H,
      r: kind === 'patch' ? 60 + rng() * 90 : 2 + rng() * 6,
      kind,
      shade: 0.7 + rng() * 0.6,             // per-feature brightness jitter
    });
  }
}

/** Place nodes with size-aware spacing into state.nodes. */
export function placeNodes(rng = Math.random) {
  const N = N_TARGET(WORLD_W, WORLD_H);
  state.nodes = [];
  let attempts = 0;
  // Scale the attempts ceiling with the target count — at 200 nodes the old
  // 14000 cap could exit before placing them all on the bigger map.
  const ATTEMPT_CAP = Math.max(14000, N * 300);
  while (state.nodes.length < N && attempts < ATTEMPT_CAP) {
    attempts++;
    const size = pickSize(rng);
    const x = NODE_MARGIN + rng() * (WORLD_W - NODE_MARGIN * 2);
    const y = NODE_MARGIN + rng() * (WORLD_H - NODE_MARGIN * 2);
    let ok = true;
    for (const n of state.nodes) {
      const required = BASE_GAP + n.size + size;
      if (dist({ x, y }, n) < required) { ok = false; break; }
    }
    if (ok) {
      state.nodes.push({
        id: state.nodes.length,
        x, y, size,
        owner: 'neutral',
        units: Math.floor(size * 0.85 + rng() * size * 0.55),
        capacity: Math.floor(size * 3.6),
        regenRate: size / 30,
        pulse: 0, flash: 0,
      });
    }
  }
}

/** Build k-NN road graph, fill state.roads & state.adj, ensuring connectivity. */
export function buildRoads() {
  const { nodes } = state;
  state.roads = [];
  state.adj = new Map();
  for (const n of nodes) state.adj.set(n.id, new Set());
  const roadMax = ROAD_MAX(WORLD_W, WORLD_H, nodes.length);

  // k-NN edges within roadMax
  for (const n of nodes) {
    const others = nodes
      .filter(m => m.id !== n.id)
      .map(m => ({ id: m.id, d: dist(n, m) }))
      .filter(x => x.d <= roadMax)
      .sort((a, b) => a.d - b.d)
      .slice(0, ROAD_K);
    for (const o of others) {
      if (!state.adj.get(n.id).has(o.id)) {
        state.adj.get(n.id).add(o.id);
        state.adj.get(o.id).add(n.id);
        state.roads.push({ a: n.id, b: o.id, length: o.d });
      }
    }
  }

  // Union-find connectivity, bridge by shortest cross-component edge
  const parent = nodes.map((_, i) => i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  for (const r of state.roads) {
    const ra = find(r.a), rb = find(r.b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let safety = 0; safety < 60; safety++) {
    const comps = new Map();
    for (const n of nodes) {
      const root = find(n.id);
      if (!comps.has(root)) comps.set(root, []);
      comps.get(root).push(n);
    }
    if (comps.size <= 1) break;
    let best = [Infinity, null, null];
    const keys = [...comps.keys()];
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
    const [, a, b] = best;
    state.adj.get(a.id).add(b.id);
    state.adj.get(b.id).add(a.id);
    state.roads.push({ a: a.id, b: b.id, length: best[0] });
    parent[find(a.id)] = find(b.id);
  }
}

/** Bonus size for hub nodes (degree > 3). Recomputes capacity / regen. */
export function adjustHubSizes() {
  for (const n of state.nodes) {
    const deg = state.adj.get(n.id).size;
    const bonus = Math.max(0, deg - 3) * 4;
    if (bonus <= 0) continue;
    let maxAllowed = Infinity;
    for (const m of state.nodes) {
      if (m === n) continue;
      const allowed = dist(n, m) - 60 - m.size;
      if (allowed < maxAllowed) maxAllowed = allowed;
    }
    const newSize = Math.min(n.size + bonus, maxAllowed, 75);
    if (newSize > n.size) {
      n.size = newSize;
      n.capacity = Math.floor(n.size * 3.6);
      n.regenRate = n.size / 30;
    }
  }
}

/** Dijkstra constrained to own territory (final hop may land on any owner). */
export function findPath(fromId, toId, traveler) {
  const { nodes, adj } = state;
  if (fromId === toId) return [fromId];
  const distMap = new Map(nodes.map(n => [n.id, Infinity]));
  const prev = new Map();
  distMap.set(fromId, 0);
  const queue = [{ id: fromId, d: 0 }];
  const visited = new Set();
  while (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    const { id } = queue.shift();
    if (id === toId) break;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const nb of adj.get(id)) {
      if (nb !== toId && nodes[nb].owner !== traveler) continue;
      const w = dist(nodes[id], nodes[nb]);
      const nd = distMap.get(id) + w;
      if (nd < distMap.get(nb)) {
        distMap.set(nb, nd);
        prev.set(nb, id);
        queue.push({ id: nb, d: nd });
      }
    }
  }
  if (!prev.has(toId)) return null;
  const path = [toId];
  let cur = toId;
  while (prev.has(cur)) { cur = prev.get(cur); path.unshift(cur); }
  return path;
}

/** Find topmost node at world coords. */
export function nodeAt(x, y) {
  for (const n of state.nodes) {
    if (Math.hypot(n.x - x, n.y - y) < n.size + 4) return n;
  }
  return null;
}

/** Nearest road segment to world coords (x,y) within tolerance. Returns road or null. */
export function roadAt(x, y, tol = 36) {
  let best = null, bestD = tol;
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    const d = pointToSegment(x, y, a.x, a.y, b.x, b.y);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

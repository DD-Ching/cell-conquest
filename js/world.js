// =====================================================
// World generation: node placement, hub size adjustment,
// road graph (k-NN + connectivity), pathfinding.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H, N_NODES_MIN, N_NODES_MAX } from './config.js';
import { dist, pointToSegment } from './util.js';
import { isAlly } from './alliance.js';

const NODE_MARGIN = 100;
// Minimum spacing between node rims. Tightened from 80 to 50 so 1800 nodes
// actually fit in the 12000×9000 world (average inter-node spacing at that
// density is ~245 px — with the old 80 + 2×avg-size gap the placer would
// reject most candidate spots and we'd cap out far below N_NODES_MAX).
const BASE_GAP    = 50;
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
        // Lazy-regen bookkeeping: instead of `units += rate * dt` every
        // sub-tick on every node (1200 Hz × 900 nodes), we now catch up
        // ONLY when a node is read or written. lastRegenT is the game time
        // of the most recent units-update. catchUpRegen() computes the
        // missing accrual at access time.
        lastRegenT: 0,
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

  // Per-road width multiplier — driven by endpoint connectivity (hubs grow
  // highways, peripheries grow country lanes) plus a Gaussian jitter so even
  // similarly-connected roads don't all look identical. Picks up the "city
  // outskirts" feel: the dense interior has thicker arteries, the rim has
  // thinner trails.
  for (const r of state.roads) {
    const degA = state.adj.get(r.a).size;
    const degB = state.adj.get(r.b).size;
    // Average degree typically 2-6. Map into a 0.65 (peripheral) → 1.35 (hub) range.
    const importance = 0.65 + Math.min(1, Math.max(0, (degA + degB - 3) / 6)) * 0.7;
    // Box-Muller for a true Gaussian sample (σ ≈ 0.12 around the importance)
    const u = 1 - Math.random(), v = Math.random();
    const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.12;
    r.widthMul = Math.max(0.5, Math.min(1.6, importance + gauss));
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

/** Dijkstra constrained to own-or-allied territory (final hop may land on
 *  any owner). Allied transit lets a player fleet legitimately march A → B
 *  through Lieutenant-controlled nodes — otherwise the friendly base in the
 *  middle of the front line acts as a roadblock for its own side. */
export function findPath(fromId, toId, traveler) {
  const { nodes, adj } = state;
  if (fromId === toId) return [fromId];
  // Binary min-heap Dijkstra. Was a sort-the-whole-queue-every-iteration loop
  // (O(V²·logV)) plus an O(N) distMap pre-fill per call — fine for one fleet,
  // but a perf hole when the uncapped clearBlockedRoads pathfinds to many
  // clogged roads in one tick. The heap is O(E·logV); distMap is now lazy
  // (missing ⇒ Infinity), dropping the per-call O(N) prefill. Tie-break is by
  // insertion order (`seq`), reproducing the old stable-sort pop order EXACTLY,
  // so chosen paths are identical — pure speedup, no gameplay change.
  const distMap = new Map();
  const prev = new Map();
  const visited = new Set();
  distMap.set(fromId, 0);

  const heap = [];
  let seq = 0;
  const less = (a, b) => a.d < b.d || (a.d === b.d && a.seq < b.seq);
  const hpush = (id, d) => {
    heap.push({ id, d, seq: seq++ });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
    }
  };
  const hpop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      const n = heap.length;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < n && less(heap[l], heap[s])) s = l;
        if (r < n && less(heap[r], heap[s])) s = r;
        if (s === i) break;
        const t = heap[s]; heap[s] = heap[i]; heap[i] = t; i = s;
      }
    }
    return top;
  };

  hpush(fromId, 0);
  while (heap.length) {
    const { id } = hpop();
    if (id === toId) break;
    if (visited.has(id)) continue;       // stale duplicate — already finalised
    visited.add(id);
    const dId = distMap.get(id);
    for (const nb of adj.get(id)) {
      if (nb !== toId && !isAlly(nodes[nb].owner, traveler)) continue;
      const nd = dId + dist(nodes[id], nodes[nb]);
      const cur = distMap.get(nb);
      if (cur === undefined || nd < cur) {
        distMap.set(nb, nd);
        prev.set(nb, id);
        hpush(nb, nd);
      }
    }
  }
  if (!prev.has(toId)) return null;
  const path = [toId];
  let cur = toId;
  while (prev.has(cur)) { cur = prev.get(cur); path.unshift(cur); }
  return path;
}

/** Find topmost node at world coords. The pick tolerance is widened in world
 *  units at low zoom so a 30-px node that draws as 3 on-screen pixels still
 *  has a ~8-screen-pixel click area around it. */
export function nodeAt(x, y) {
  const screenSlack = 10 / state.zoom;     // at zoom 1.0 = 10 world-px slack; at zoom 0.1 = 100
  for (const n of state.nodes) {
    if (Math.hypot(n.x - x, n.y - y) < n.size + screenSlack) return n;
  }
  return null;
}

/** Nearest road segment to world coords (x,y) within tolerance. Returns road
 *  or null. Tolerance is inflated at low zoom so thin roads at strategic
 *  zoom stay clickable for net placement / road-aware interactions. */
export function roadAt(x, y, tol = 36) {
  const adjusted = Math.max(tol, 14 / state.zoom);
  let best = null, bestD = adjusted;
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    const d = pointToSegment(x, y, a.x, a.y, b.x, b.y);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/** Lazy regen — bring a single node up to date with the current game time.
 *  Called at every site that reads or writes node.units (AI tick, HUD,
 *  render of a visible node, fleet dispatch/arrival, turret placement).
 *  Replaces the old 1200-Hz × all-nodes regen loop with on-demand work. */
let _nanHealWarned = false;
export function catchUpRegen(n) {
  // Self-heal firewall: if a node's units ever went non-finite (some upstream
  // bug divided by zero / multiplied by NaN), reset it so the corruption can't
  // persist or spread when this node next ships a fleet. Warn ONCE with enough
  // detail to chase the real source — this should never fire in normal play.
  if (!Number.isFinite(n.units)) {
    if (!_nanHealWarned) {
      _nanHealWarned = true;
      console.warn('[NaN firewall] healed non-finite node.units', { id: n.id, owner: n.owner, cap: n.capacity, regen: n.regenRate, elapsed: state.elapsed });
    }
    n.units = 0;
    n.lastRegenT = state.elapsed;
    return;
  }
  // Neutral nodes don't regen (matches the original per-tick logic).
  if (n.owner === 'neutral') { n.lastRegenT = state.elapsed; return; }
  if (n.units >= n.capacity) { n.lastRegenT = state.elapsed; return; }
  const dt = state.elapsed - (n.lastRegenT || 0);
  if (dt <= 0) return;
  n.units = Math.min(n.capacity, n.units + n.regenRate * dt);
  n.lastRegenT = state.elapsed;
}

/** Bulk version. Used at AI tick top + HUD sum, where many node reads
 *  happen back-to-back and walking the array once is cheaper than guarding
 *  every individual read. */
export function catchUpAllNodes() {
  for (const n of state.nodes) catchUpRegen(n);
}

/** Topmost non-pending enemy turret near world coords for assault / salvo
 *  targeting. Tolerance scales with zoom so a 14-px turret stays clickable
 *  at strategic zoom levels. */
export function turretAt(x, y, owner = 'player', filter = null) {
  const tol = Math.max(14, 14 / state.zoom);
  const tol2 = tol * tol;
  for (const t of state.turrets) {
    if (isAlly(t.owner, owner)) continue;        // own or ally — not attackable
    if (t.pendingEngineer) continue;
    if (filter && !filter(t)) continue;
    const dx = t.x - x, dy = t.y - y;
    if (dx * dx + dy * dy < tol2) return t;
  }
  return null;
}

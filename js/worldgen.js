// =====================================================
// Procedural map generation — geography-first orchestrator (?procgen=1).
//
// The legacy world.js scatters nodes uniformly at random, then meshes them.
// This generator instead builds the map in LAYERS so it reads like a believable
// theatre instead of a random graph:
//
//   1. Regions  — 8–15 spread-out region centres (best-candidate sampling),
//                 each with a TYPE (core / industrial / frontier / wasteland /
//                 resource / open) that sets radius, node density, node size,
//                 strategic value and danger.
//   2. Nodes    — placed by OBEYING the regions: each region scatters its quota
//                 of nodes in a centre-weighted disc (denser cores, sparse
//                 wastes), plus a thin global "open plains" scatter between
//                 regions. Spacing is respected globally so nothing overlaps.
//   3. Roads    — worldgen-roads.js: dense intra-region mesh + sparse
//                 inter-region highway backbone + connectivity stitch.
//
// Output is the SAME shape legacy gen produces — state.nodes (positional ids),
// state.roads, state.adj — so render / AI / pathfinding need no changes. Extra
// per-node metadata (regionId, nodeType) and state.regions ride along for the
// region tint + future nodeType visuals; existing code ignores them.
//
// Deterministic: a seeded PRNG (mulberry32) drives EVERY random choice, so the
// same ?seed= reproduces the same world (Risk/Stellaris-style shareable maps).
//
// TODO(procgen milestone): terrain blockers + bridge/pass chokepoints,
// region-aware faction placement, nodeType-driven node shapes. Hooks are left
// (region.value/danger, node.nodeType) so those layers can read this metadata.
// =====================================================
import { state } from './state.js';
import { dist } from './util.js';
import {
  WORLD_W, WORLD_H, N_NODES_MIN, N_NODES_MAX,
  PROCGEN_REGIONS_MIN, PROCGEN_REGIONS_MAX,
} from './config.js';
import { generateRoads } from './worldgen-roads.js';

const NODE_MARGIN = 100;
const BASE_GAP    = 50;            // matches world.js rim spacing
const OPEN_SHARE  = 0.15;          // fraction of nodes scattered between regions

// Region archetypes — `w` is the weighted-pick weight. radiusMul scales the
// region disc; density + sizeMul shape how many / how big its nodes are;
// value/danger are strategic metadata for later layers (faction placement).
const REGION_TYPES = [
  { type: 'core',       w: 2, radiusMul: 0.90, density: 1.30, sizeMul: 1.15, value: 3, danger: 1 },
  { type: 'industrial', w: 2, radiusMul: 1.00, density: 1.10, sizeMul: 1.05, value: 2, danger: 1 },
  { type: 'frontier',   w: 2, radiusMul: 1.10, density: 0.80, sizeMul: 0.90, value: 1, danger: 2 },
  { type: 'wasteland',  w: 2, radiusMul: 1.25, density: 0.55, sizeMul: 0.85, value: 1, danger: 3 },
  { type: 'resource',   w: 1, radiusMul: 0.80, density: 0.90, sizeMul: 1.05, value: 3, danger: 2 },
  { type: 'open',       w: 2, radiusMul: 1.30, density: 0.50, sizeMul: 0.90, value: 1, danger: 1 },
];

/** mulberry32 — small fast seeded PRNG returning floats in [0,1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick(arr, rng) {
  let total = 0; for (const a of arr) total += a.w;
  let r = rng() * total;
  for (const a of arr) { if ((r -= a.w) <= 0) return a; }
  return arr[arr.length - 1];
}

function targetNodeCount() {
  return Math.min(N_NODES_MAX, Math.max(N_NODES_MIN, Math.floor((WORLD_W * WORLD_H) / 130000)));
}

/** Node-size sampler — same buckets as legacy pickSize, scaled by region type. */
function nodeSize(rng, sizeMul) {
  const r = rng();
  let s;
  if (r < 0.32) s = 20 + rng() * 5;
  else if (r < 0.58) s = 26 + rng() * 6;
  else if (r < 0.77) s = 33 + rng() * 7;
  else if (r < 0.92) s = 44 + rng() * 8;
  else s = 56 + rng() * 12;
  return s * sizeMul;
}

/** Coarse nodeType label from size + region (metadata for later visuals). */
function nodeType(size, region) {
  if (region && region.type === 'resource') return 'mine';
  if (size >= 52) return 'city';
  if (size >= 38) return 'town';
  return 'outpost';
}

/** Layer 1 — region centres, spread out via best-candidate sampling and edge
 *  avoidance, each tagged with an archetype. */
function generateRegions(rng) {
  const count = PROCGEN_REGIONS_MIN +
    Math.floor(rng() * (PROCGEN_REGIONS_MAX - PROCGEN_REGIONS_MIN + 1));
  const baseR = Math.sqrt((WORLD_W * WORLD_H) / count) * 0.6;
  const regions = [];
  for (let i = 0; i < count; i++) {
    let best = null, bestScore = -1;
    for (let k = 0; k < 14; k++) {                 // 14 candidates, keep the most isolated
      const x = NODE_MARGIN + rng() * (WORLD_W - 2 * NODE_MARGIN);
      const y = NODE_MARGIN + rng() * (WORLD_H - 2 * NODE_MARGIN);
      let score = Math.min(x, y, WORLD_W - x, WORLD_H - y) * 0.5;   // bias off the map edges
      for (const r of regions) { const d = dist({ x, y }, r); if (d < score) score = d; }
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
    const t = weightedPick(REGION_TYPES, rng);
    regions.push({
      id: i, x: best.x, y: best.y, type: t.type,
      radius: baseR * t.radiusMul, density: t.density, sizeMul: t.sizeMul,
      value: t.value, danger: t.danger, quota: 0,
    });
  }
  return regions;
}

function makeNode(x, y, size, regionId, region, rng) {
  return {
    id: state.nodes.length, x, y, size, owner: 'neutral',
    units: Math.floor(size * 0.85 + rng() * size * 0.55),
    capacity: Math.floor(size * 3.6),
    regenRate: size / 30,
    pulse: 0, flash: 0, lastRegenT: 0,
    regionId, nodeType: nodeType(size, region),
  };
}

/** True if (x,y) is in-bounds and clears every already-placed node's rim. */
function spaceFree(x, y, size) {
  if (x < NODE_MARGIN || x > WORLD_W - NODE_MARGIN ||
      y < NODE_MARGIN || y > WORLD_H - NODE_MARGIN) return false;
  for (const n of state.nodes) {
    if (dist({ x, y }, n) < BASE_GAP + n.size + size) return false;
  }
  return true;
}

/** Layer 2 — nodes obeying the regions, plus a thin inter-region scatter. */
function generateNodes(rng, regions) {
  state.nodes = [];
  const N = targetNodeCount();

  // Quota per region ∝ density × area, normalised to the region share of N.
  let wSum = 0;
  for (const r of regions) { r._w = r.density * r.radius * r.radius; wSum += r._w; }
  const regionTotal = Math.round(N * (1 - OPEN_SHARE));
  for (const r of regions) r.quota = Math.max(3, Math.round(regionTotal * (r._w / wSum)));

  // Region scatter — centre-weighted disc (denser toward the centre).
  for (const r of regions) {
    let made = 0, tries = 0;
    const cap = r.quota * 60;
    while (made < r.quota && tries < cap) {
      tries++;
      const ang = rng() * Math.PI * 2;
      const rad = r.radius * Math.pow(rng(), 0.65);   // exponent < 1 packs the core
      const x = r.x + Math.cos(ang) * rad;
      const y = r.y + Math.sin(ang) * rad;
      const size = nodeSize(rng, r.sizeMul);
      if (!spaceFree(x, y, size)) continue;
      state.nodes.push(makeNode(x, y, size, r.id, r, rng));
      made++;
    }
  }

  // Open plains — sparse global scatter between regions (regionId -1).
  const openTarget = N - state.nodes.length;
  let made = 0, tries = 0;
  const cap = Math.max(2000, openTarget * 80);
  while (made < openTarget && tries < cap) {
    tries++;
    const x = NODE_MARGIN + rng() * (WORLD_W - 2 * NODE_MARGIN);
    const y = NODE_MARGIN + rng() * (WORLD_H - 2 * NODE_MARGIN);
    const size = nodeSize(rng, 0.9);
    if (!spaceFree(x, y, size)) continue;
    state.nodes.push(makeNode(x, y, size, -1, null, rng));
    made++;
  }
}

/** Quality gate — every node reachable from node 0, and we hit a sane count. */
function validateMap() {
  const { nodes, adj } = state;
  if (nodes.length < targetNodeCount() * 0.6) return false;
  const seen = new Set([0]); const q = [0];
  while (q.length) {
    const id = q.shift();
    for (const nb of adj.get(id)) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
  }
  return seen.size === nodes.length;
}

/** Generate a full world into state (nodes / roads / adj / regions). Retries a
 *  few reseeds if validation fails; the connectivity stitch makes that rare. */
export function generateWorld(seed) {
  const base = (seed >>> 0) || 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    const rng = mulberry32((base + attempt * 0x9E3779B9) >>> 0);
    const regions = generateRegions(rng);
    state.regions = regions;     // generateRoads reads state.regions for the highway MST — set FIRST
    generateNodes(rng, regions);
    generateRoads(rng);
    if (validateMap()) { state.worldSeed = base; return; }
  }
  state.worldSeed = base;   // accept the last attempt (stitched → connected anyway)
}

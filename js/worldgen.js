// =====================================================
// Procedural map generation — geography-first orchestrator (?procgen=1).
//
// "Grow a world, not a graph." The natural geography is generated FIRST
// (worldgen-terrain.js: a seeded world theme + elevation/moisture noise fields
// → sea, ridges, rivers, resource belts), and everything after OBEYS it:
//
//   0. Theme + geography  — worldgen-terrain.generateGeography / resource belts
//   1. Regions  — centres placed on BUILDABLE land (off sea + peaks), typed by
//                 the terrain/resource under them (mineral→mining, energy→
//                 industrial, rare→research, basin→city, ridge→military, …).
//   2. Nodes    — scattered only where the ground is buildable, clustered in
//                 their region; node TYPE is driven by the resource belt /
//                 terrain beneath it (mine on a mineral belt, factory on energy,
//                 research_lab on rare, …).
//   3. Roads    — worldgen-roads.js: intra-region mesh + inter-region highway
//                 backbone + connectivity stitch; rivers + mountain ridges are
//                 barriers, so crossings funnel through a few bridges/passes.
//   4. Summary  — a validation summary (state.worldSummary), logged at gen time.
//
// Output is the SAME shape legacy gen produces — state.nodes / roads / adj — so
// render / AI / pathfinding need no changes. Extra metadata (regionId, nodeType,
// value/danger/…) + state.regions / barriers / worldTheme / resourceBelts /
// geoGrid ride along for the renderer + later layers.
//
// Deterministic: one seeded mulberry32 drives EVERY choice → ?seed= reproduces
// the world; ?theme= forces a world theme.
//
// TODO(milestone 2): history events, geography-following faction borders +
// conflict-zone markers, per-pixel satellite shading, port/refinery/radar/
// airfield node types + icons.
// =====================================================
import { state } from './state.js';
import { dist, pointToSegment } from './util.js';
import {
  WORLD_W, WORLD_H, N_NODES_MIN, N_NODES_MAX,
  PROCGEN_REGIONS_MIN, PROCGEN_REGIONS_MAX,
} from './config.js';
import { generateRoads, applyBarrierChokepoints } from './worldgen-roads.js';
import { makeRegionName, makePlaceName } from './tactical-theme.js';
import { pickWorldTheme, generateGeography, generateResourceBelts } from './worldgen-terrain.js';

const NODE_MARGIN = 100;
const BASE_GAP    = 50;            // matches world.js rim spacing
const OPEN_SHARE  = 0.15;          // fraction of nodes scattered between regions
const BARRIER_CORRIDOR = 220;      // keep nodes this far off a river/ridge so the
                                   // barrier sits in a gap → few, clean crossings

// Per-type region stats (radius/density/size + strategic metadata). The TYPE
// itself is now chosen by geography (regionTypeFor); this table only supplies
// the numbers once a type is known. `wfb` weights the plain-terrain fallback.
const REGION_STATS = {
  city:            { radiusMul: 0.90, density: 1.35, sizeMul: 1.15, value: 3, danger: 1, wfb: 2 },
  industrial_zone: { radiusMul: 1.00, density: 1.10, sizeMul: 1.05, value: 2, danger: 1, wfb: 2 },
  mining_zone:     { radiusMul: 0.85, density: 0.95, sizeMul: 1.00, value: 3, danger: 2, wfb: 1 },
  military_base:   { radiusMul: 0.80, density: 0.70, sizeMul: 1.20, value: 3, danger: 2, wfb: 1 },
  frontier:        { radiusMul: 1.15, density: 0.70, sizeMul: 0.90, value: 1, danger: 2, wfb: 2 },
  wasteland:       { radiusMul: 1.30, density: 0.50, sizeMul: 0.85, value: 1, danger: 3, wfb: 2 },
  research_site:   { radiusMul: 0.75, density: 0.60, sizeMul: 1.10, value: 3, danger: 2, wfb: 1 },
};
const FALLBACK_TYPES = Object.keys(REGION_STATS);

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

function weightedFallbackType(rng) {
  let total = 0; for (const k of FALLBACK_TYPES) total += REGION_STATS[k].wfb;
  let r = rng() * total;
  for (const k of FALLBACK_TYPES) { if ((r -= REGION_STATS[k].wfb) <= 0) return k; }
  return FALLBACK_TYPES[FALLBACK_TYPES.length - 1];
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

/** Min distance from (x,y) to any barrier polyline (rivers + ridges). */
function distToBarriers(x, y) {
  let best = Infinity;
  for (const bar of state.barriers) {
    const p = bar.points;
    for (let i = 0; i < p.length - 1; i++) {
      const d = pointToSegment(x, y, p[i].x, p[i].y, p[i + 1].x, p[i + 1].y);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Choose a region archetype from the geography under (x,y). */
function regionTypeFor(rng, x, y, geo, res) {
  const r = res.resourceAt(x, y);
  if (r === 'mineral') return 'mining_zone';
  if (r === 'energy')  return 'industrial_zone';
  if (r === 'rare')    return 'research_site';
  if (distToBarriers(x, y) < BARRIER_CORRIDOR * 2.2) return 'military_base';  // chokepoint country
  const t = geo.terrainAt(x, y);
  if (t === 'basin' || t === 'fertile') return 'city';
  if (t === 'wasteland') return rng() < 0.5 ? 'wasteland' : 'frontier';
  return weightedFallbackType(rng);
}

/** nodeType from the resource/terrain beneath it, then region fallback. Kept
 *  within the rendered icon set (mine/factory/research_lab/fortress/city/town/
 *  outpost/bridge); spec extras (port/refinery/radar/…) wait for milestone 2. */
function nodeTypeFor(size, region, geo, res, x, y) {
  const r = res.resourceAt(x, y);
  if (r === 'mineral') return 'mine';
  if (r === 'rare')    return 'research_lab';
  if (r === 'energy')  return 'factory';
  if (region) {
    switch (region.type) {
      case 'mining_zone':     return 'mine';
      case 'industrial_zone': return 'factory';
      case 'military_base':   return size >= 44 ? 'fortress' : 'outpost';
      case 'research_site':   return 'research_lab';
      case 'city':            return size >= 52 ? 'city' : (size >= 38 ? 'town' : 'outpost');
    }
  }
  return size >= 44 ? 'town' : 'outpost';
}

/** Layer 1 — region centres on buildable land, typed by geography. */
function generateRegions(rng, geo, res) {
  const count = PROCGEN_REGIONS_MIN +
    Math.floor(rng() * (PROCGEN_REGIONS_MAX - PROCGEN_REGIONS_MIN + 1));
  const baseR = Math.sqrt((WORLD_W * WORLD_H) / count) * 0.6;
  const regions = [];
  const usedNames = new Set();
  for (let i = 0; i < count; i++) {
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < 20; k++) {                 // candidates: isolated + buildable
      const x = NODE_MARGIN + rng() * (WORLD_W - 2 * NODE_MARGIN);
      const y = NODE_MARGIN + rng() * (WORLD_H - 2 * NODE_MARGIN);
      if (!geo.buildableAt(x, y)) continue;         // never centre a region in sea / on a peak
      let score = Math.min(x, y, WORLD_W - x, WORLD_H - y) * 0.5;   // off the edges
      for (const r of regions) { const d = dist({ x, y }, r); if (d < score) score = d; }
      // mild pull toward habitable ground (basins/fertile read as "settled")
      const t = geo.terrainAt(x, y);
      if (t === 'basin' || t === 'fertile') score *= 1.15;
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
    if (!best) {                                    // fallback: any in-bounds point
      best = { x: NODE_MARGIN + rng() * (WORLD_W - 2 * NODE_MARGIN), y: NODE_MARGIN + rng() * (WORLD_H - 2 * NODE_MARGIN) };
    }
    const type = regionTypeFor(rng, best.x, best.y, geo, res);
    const st = REGION_STATS[type];
    regions.push({
      id: i, x: best.x, y: best.y, type,
      radius: baseR * st.radiusMul, density: st.density, sizeMul: st.sizeMul,
      value: st.value, danger: st.danger, quota: 0,
      name: makeRegionName(rng, usedNames),
    });
  }
  return regions;
}

function makeNode(x, y, size, regionId, region, geo, res, rng) {
  const nt = nodeTypeFor(size, region, geo, res, x, y);
  return {
    id: state.nodes.length, x, y, size, owner: 'neutral',
    units: Math.floor(size * 0.85 + rng() * size * 0.55),
    capacity: Math.floor(size * 3.6),
    regenRate: size / 30,
    pulse: 0, flash: 0, lastRegenT: 0,
    regionId, nodeType: nt,
    terrainType: geo.terrainAt(x, y),
    resourceType: res.resourceAt(x, y),
    value:      region ? region.value : 1,
    danger:     region ? region.danger : 1,
    defense:    nt === 'fortress' ? 2 : 1,
    production: nt === 'factory' ? 1.3 : nt === 'mine' ? 1.2 : 1.0,
    supply:     1,
  };
}

/** In-bounds, on buildable ground, off the barrier corridor, clear of rims. */
function spaceFree(x, y, size, geo) {
  if (x < NODE_MARGIN || x > WORLD_W - NODE_MARGIN ||
      y < NODE_MARGIN || y > WORLD_H - NODE_MARGIN) return false;
  if (!geo.buildableAt(x, y)) return false;          // sea / peak → no settlement
  if (distToBarriers(x, y) < BARRIER_CORRIDOR) return false;
  for (const n of state.nodes) {
    if (dist({ x, y }, n) < BASE_GAP + n.size + size) return false;
  }
  return true;
}

/** Layer 2 — nodes obeying regions + terrain, plus a thin inter-region scatter. */
function generateNodes(rng, regions, geo, res) {
  state.nodes = [];
  const N = targetNodeCount();

  let wSum = 0;
  for (const r of regions) { r._w = r.density * r.radius * r.radius; wSum += r._w; }
  const regionTotal = Math.round(N * (1 - OPEN_SHARE));
  for (const r of regions) r.quota = Math.max(3, Math.round(regionTotal * (r._w / wSum)));

  for (const r of regions) {
    let made = 0, tries = 0;
    const cap = r.quota * 80;
    while (made < r.quota && tries < cap) {
      tries++;
      const ang = rng() * Math.PI * 2;
      const rad = r.radius * Math.pow(rng(), 0.65);   // pack the core
      const x = r.x + Math.cos(ang) * rad;
      const y = r.y + Math.sin(ang) * rad;
      const size = nodeSize(rng, r.sizeMul);
      if (!spaceFree(x, y, size, geo)) continue;
      state.nodes.push(makeNode(x, y, size, r.id, r, geo, res, rng));
      made++;
    }
  }

  // Open plains — sparse global scatter; biased toward rivers/resources so the
  // "wilderness" still has logic (settlements cling to water + ore).
  const openTarget = N - state.nodes.length;
  let made = 0, tries = 0;
  const cap = Math.max(3000, openTarget * 120);
  while (made < openTarget && tries < cap) {
    tries++;
    const x = NODE_MARGIN + rng() * (WORLD_W - 2 * NODE_MARGIN);
    const y = NODE_MARGIN + rng() * (WORLD_H - 2 * NODE_MARGIN);
    const size = nodeSize(rng, 0.9);
    if (!spaceFree(x, y, size, geo)) continue;
    // light habitability bias: near a river or resource is always accepted;
    // bare wasteland is accepted only sometimes, so the open field thins out
    // away from anything worth settling.
    const nearWater = distToBarriers(x, y) < BARRIER_CORRIDOR * 2.5;
    const onResource = !!res.resourceAt(x, y);
    if (!nearWater && !onResource && rng() < 0.4) continue;
    state.nodes.push(makeNode(x, y, size, -1, null, geo, res, rng));
    made++;
  }
}

/** Give the MAJOR nodes a settlement name (Helix City, Iron Works, Pale Gate…),
 *  baked into node.name. Deliberately SPARSE — like a real atlas, only the
 *  places that anchor the map get a name; the swarm of minor outposts stay
 *  nameless dots until you select them. Sizeable typed POIs + big hubs qualify.
 *  (Faction CAPITALS are tagged later in main.js from these nodes; a capital
 *  picked from a sizeable node already carries a name. Sizes here are pre-
 *  adjustHubSizes, so the thresholds are a touch lower than the final render's.)
 *  Deterministic: seeded rng + stable node order → same map, same names, and the
 *  render-worker mirror (which gets node.name in the snapshot) matches. */
const _NAMED_TYPES = new Set(['city', 'fortress', 'factory', 'mine', 'research_lab']);
function nameMajorNodes(rng) {
  const used = new Set();
  for (const n of state.nodes) {
    // Sparse, atlas-like: only sizeable typed POIs + genuinely big hubs. Sizes
    // here are PRE-adjustHubSizes, so the bars sit a bit under the final render
    // thresholds; tuned to land ~70-90 names on a default 830-node map, not 200+.
    const major = (_NAMED_TYPES.has(n.nodeType) && n.size >= 40) || n.size >= 52;
    if (major) n.name = makePlaceName(rng, n.nodeType, used);
  }
}

/** Name a node on demand (used by main.js to guarantee every faction CAPITAL
 *  carries a name, even if it was a smaller node before promotion). Idempotent —
 *  keeps any existing name. Uses Math.random (capitals are picked post-gen, off
 *  the seeded stream), which is fine: capital names need only be unique, not
 *  reproducible. `usedNames` collects current names to avoid collisions. */
export function ensureNodeName(n) {
  if (n.name) return n.name;
  const used = new Set();
  for (const m of state.nodes) if (m.name) used.add(m.name);
  n.name = makePlaceName(Math.random, n.nodeType, used);
  return n.name;
}

/** Quality gate — every node reachable from node 0, sane count. */
function validateMap() {
  const { nodes, adj } = state;
  if (nodes.length < targetNodeCount() * 0.5) return false;
  const seen = new Set([0]); const q = [0];
  while (q.length) {
    const id = q.shift();
    for (const nb of adj.get(id)) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
  }
  return seen.size === nodes.length;
}

/** Build + log the validation/summary object (spec §12). */
function buildSummary() {
  const kinds = { local: 0, highway: 0, bridge: 0 };
  for (const r of state.roads) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  const belts = { mineral: 0, energy: 0, rare: 0 };
  for (const b of state.resourceBelts) belts[b.kind] = (belts[b.kind] || 0) + 1;
  const types = {};
  for (const n of state.nodes) types[n.nodeType] = (types[n.nodeType] || 0) + 1;
  // connectivity
  const seen = new Set([0]); const q = [0];
  while (q.length) { const id = q.shift(); for (const nb of state.adj.get(id)) if (!seen.has(nb)) { seen.add(nb); q.push(nb); } }
  const summary = {
    theme: state.worldTheme.name, seed: state.worldSeed,
    regions: state.regions.length, nodes: state.nodes.length,
    roads: kinds, chokepoints: kinds.bridge,
    rivers: state.barriers.filter(b => b.kind === 'river').length,
    ridges: state.barriers.filter(b => b.kind === 'mountain').length,
    resourceBelts: belts, nodeTypes: types,
    connected: seen.size === state.nodes.length ? 'all' : `${seen.size}/${state.nodes.length}`,
  };
  state.worldSummary = summary;
  console.log('[worldgen] %s (seed %d): %d regions, %d nodes, ' +
    'roads L%d/H%d/B%d, %d chokepoints, belts m%d/e%d/r%d, %s connected',
    summary.theme, summary.seed, summary.regions, summary.nodes,
    kinds.local, kinds.highway, kinds.bridge, summary.chokepoints,
    belts.mineral, belts.energy, belts.rare, summary.connected);
  return summary;
}

/** Generate a full world into state. Retries a few reseeds if validation
 *  fails; the connectivity stitch + barrier surgery keep failures rare.
 *  `themeKey` (from ?theme=) optionally forces the world theme. */
export function generateWorld(seed, themeKey) {
  const base = (seed >>> 0) || 1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const rng = mulberry32((base + attempt * 0x9E3779B9) >>> 0);

    // 0 — theme + natural geography + resources (the world, before settlement)
    const theme = pickWorldTheme(rng, themeKey);
    const geo = generateGeography(rng, theme);
    const res = generateResourceBelts(rng, theme, geo);
    state.worldTheme    = theme;
    state.resourceBelts = res.belts;
    state.geoGrid = { GW: geo.GW, GH: geo.GH, seaLevel: geo.seaLevel, ridgeLevel: geo.ridgeLevel, elev: Array.from(geo.elev) };
    // Rivers + mountain ridges become the chokepoint barriers.
    state.barriers = [...geo.rivers, ...geo.ridges];

    // 1-3 — regions → nodes → roads, all obeying the geography
    const regions = generateRegions(rng, geo, res);
    state.regions = regions;     // generateRoads reads state.regions for the highway MST
    generateNodes(rng, regions, geo, res);
    nameMajorNodes(rng);         // settlement names on the major nodes (atlas layer)
    generateRoads(rng);
    applyBarrierChokepoints();   // cull cross-barrier edges down to a few passes

    if (validateMap()) { state.worldSeed = base; buildSummary(); return; }
  }
  state.worldSeed = base;        // accept the last attempt (stitched → connected anyway)
  buildSummary();
}

/** Region-aware faction starts: one capital per DISTINCT region, each with
 *  viable expansion (degree ≥ 2), spread out via farthest-point sampling seeded
 *  by region strategic value. Returns up to `k` node ids; caller fills any
 *  shortfall with its own fallback. Only meaningful after generateWorld. */
export function pickRegionStarts(k) {
  const { nodes, adj, regions } = state;
  if (!regions.length) return [];
  const capPerRegion = new Map();
  for (const n of nodes) {
    if (n.owner !== 'neutral' || n.regionId < 0) continue;
    if (adj.get(n.id).size < 2) continue;
    const cur = capPerRegion.get(n.regionId);
    if (!cur || adj.get(n.id).size > adj.get(cur.id).size ||
        (adj.get(n.id).size === adj.get(cur.id).size && n.size > cur.size)) {
      capPerRegion.set(n.regionId, n);
    }
  }
  const regById = new Map(regions.map(r => [r.id, r]));
  const cands = [...capPerRegion.values()]
    .sort((a, b) => regById.get(b.regionId).value - regById.get(a.regionId).value);
  if (!cands.length) return [];
  const chosen = [cands[0]];
  const pool = cands.slice(1);
  while (chosen.length < k && pool.length) {
    let bestIdx = 0, bestD = -1;
    for (let i = 0; i < pool.length; i++) {
      let minD = Infinity;
      for (const c of chosen) { const d = dist(pool[i], c); if (d < minD) minD = d; }
      if (minD > bestD) { bestD = minD; bestIdx = i; }
    }
    chosen.push(pool.splice(bestIdx, 1)[0]);
  }
  return chosen.map(n => n.id);
}

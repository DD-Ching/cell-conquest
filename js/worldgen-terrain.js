// =====================================================
// Procgen v2 — natural-geography layer (the "grow a world" foundation).
//
// Generates the NATURAL world FIRST, so everything after it obeys geography:
//   1. World theme   — a seeded climate/setting (red desert, dried ocean,
//                      fractured mountain, …) that scales feature densities and
//                      supplies the palette + name style.
//   2. Elevation +   — two seeded value-noise (fBm) fields on a coarse grid.
//      moisture         Derived thresholds give sea level + ridge level.
//   3. Derived       — rivers (gradient-descent down the elevation field),
//      features         mountain ridges (crest-walk along high elevation),
//                       and resource belts (mineral on ridges, energy in
//                       basins, rare in the deep wastes).
//
// worldgen.js consults this to PLACE regions/nodes/roads on buildable ground
// (off the sea + off the peaks) and to TYPE nodes by the resource under them.
// Everything is driven by one seeded PRNG, so a ?seed= reproduces the world.
//
// Output split: the transient `geo` object carries sampler FUNCTIONS used only
// during generation (not serialisable). The serialisable bits the renderer +
// worker need (theme, river/ridge polylines, resource belts, a small elevation
// grid) are written onto `state` by worldgen.js.
//
// TODO(milestone 2): history events, geography-following faction borders,
// per-pixel satellite shading from the elevation grid, water-crossing bridges.
// =====================================================
import { WORLD_W, WORLD_H } from './config.js';

// ---- World themes -------------------------------------------------
// Each theme scales how much of each natural feature appears + a palette
// (bg + low/mid/high terrain bands + water + accent) and a name-style key.
export const WORLD_THEMES = {
  red_desert: {
    name: 'Red Desert Frontier', nameStyle: 'mars',
    mountainDensity: 0.9, waterDensity: 0.12, wastelandDensity: 1.3, resourceRichness: 0.9, ruinDensity: 0.7,
    pal: { bg: '#1c0f08', lo: '#3a2113', mid: '#5a3018', hi: '#7d4a28', water: '#33271a', accent: '#c8743c' },
  },
  dried_ocean: {
    name: 'Dried Ocean Basin', nameStyle: 'mars',
    mountainDensity: 0.5, waterDensity: 0.06, wastelandDensity: 1.0, resourceRichness: 1.2, ruinDensity: 0.9,
    pal: { bg: '#14110a', lo: '#2c2616', mid: '#473b20', hi: '#6b5630', water: '#243024', accent: '#b9a45c' },
  },
  fractured_mountain: {
    name: 'Fractured Mountain Colony', nameStyle: 'rock',
    mountainDensity: 1.7, waterDensity: 0.18, wastelandDensity: 0.8, resourceRichness: 1.25, ruinDensity: 0.6,
    pal: { bg: '#100e12', lo: '#241f28', mid: '#3c3340', hi: '#6a5a70', water: '#1f2a3a', accent: '#9a7fc0' },
  },
  crater_belt: {
    name: 'Industrial Crater Belt', nameStyle: 'industrial',
    mountainDensity: 0.7, waterDensity: 0.08, wastelandDensity: 1.1, resourceRichness: 1.45, ruinDensity: 1.0,
    pal: { bg: '#16120c', lo: '#2e2616', mid: '#4a3a1e', hi: '#6e5526', water: '#28281c', accent: '#d09a3c' },
  },
  ruined_megacity: {
    name: 'Ruined Megacity Zone', nameStyle: 'urban',
    mountainDensity: 0.5, waterDensity: 0.16, wastelandDensity: 1.2, resourceRichness: 0.85, ruinDensity: 1.6,
    pal: { bg: '#121116', lo: '#262430', mid: '#3e3a4a', hi: '#5e5868', water: '#222a36', accent: '#c06a72' },
  },
  polar_corridor: {
    name: 'Polar Mining Corridor', nameStyle: 'rock',
    mountainDensity: 1.1, waterDensity: 0.3, wastelandDensity: 0.9, resourceRichness: 1.5, ruinDensity: 0.5,
    pal: { bg: '#0e1116', lo: '#1e2630', mid: '#34414e', hi: '#5a6c7c', water: '#2a4254', accent: '#7fb6d0' },
  },
  river_civilization: {
    name: 'Canal Civilization', nameStyle: 'mars',
    mountainDensity: 0.6, waterDensity: 0.42, wastelandDensity: 0.6, resourceRichness: 1.0, ruinDensity: 0.8,
    pal: { bg: '#12130e', lo: '#26301c', mid: '#3c4a26', hi: '#5e6e34', water: '#1f3a3e', accent: '#5fb0a0' },
  },
  war_scar: {
    name: 'Orbital War Scar', nameStyle: 'industrial',
    mountainDensity: 0.8, waterDensity: 0.14, wastelandDensity: 1.45, resourceRichness: 1.0, ruinDensity: 1.45,
    pal: { bg: '#160f0c', lo: '#2c1c14', mid: '#48301e', hi: '#6a4226', water: '#2a221a', accent: '#cc6a44' },
  },
};

const THEME_KEYS = Object.keys(WORLD_THEMES);

/** Pick a world theme. `forced` (from ?theme=) wins if it names a real theme;
 *  otherwise a seeded choice. */
export function pickWorldTheme(rng, forced) {
  if (forced && WORLD_THEMES[forced]) return { key: forced, ...WORLD_THEMES[forced] };
  const key = THEME_KEYS[Math.floor(rng() * THEME_KEYS.length)];
  return { key, ...WORLD_THEMES[key] };
}

// ---- Seeded value-noise field (fBm) -------------------------------
const GW = 110, GH = 84;                 // lattice resolution (cheap: ~9k cells)

/** One octave of value noise on a wxh lattice of seeded randoms, returned as a
 *  Float64Array of size GW*GH bilinearly upsampled from the lattice. */
function octave(rng, w, h) {
  const lat = new Float64Array(w * h);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const out = new Float64Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    const fy = gy / (GH - 1) * (h - 1);
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let gx = 0; gx < GW; gx++) {
      const fx = gx / (GW - 1) * (w - 1);
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = lat[y0 * w + x0], b = lat[y0 * w + x1];
      const c = lat[y1 * w + x0], d = lat[y1 * w + x1];
      // smoothstep interpolation → soft, organic fields
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const top = a + (b - a) * sx, bot = c + (d - c) * sx;
      out[gy * GW + gx] = top + (bot - top) * sy;
    }
  }
  return out;
}

/** Summed-octave fBm field, normalised to [0,1]. */
function fbm(rng, octs) {
  const field = new Float64Array(GW * GH);
  let amp = 1, sum = 0;
  for (let o = 0; o < octs.length; o++) {
    const lat = octs[o];
    const oc = octave(rng, lat, lat);
    for (let i = 0; i < field.length; i++) field[i] += oc[i] * amp;
    sum += amp; amp *= 0.5;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < field.length; i++) { field[i] /= sum; if (field[i] < lo) lo = field[i]; if (field[i] > hi) hi = field[i]; }
  const span = (hi - lo) || 1;
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - lo) / span;
  return field;
}

/** Bilinear sample of a GW×GH field at world coords. */
function sampleField(field, x, y) {
  const fx = Math.max(0, Math.min(1, x / WORLD_W)) * (GW - 1);
  const fy = Math.max(0, Math.min(1, y / WORLD_H)) * (GH - 1);
  const x0 = Math.floor(fx), x1 = Math.min(GW - 1, x0 + 1), tx = fx - x0;
  const y0 = Math.floor(fy), y1 = Math.min(GH - 1, y0 + 1), ty = fy - y0;
  const a = field[y0 * GW + x0], b = field[y0 * GW + x1];
  const c = field[y1 * GW + x0], d = field[y1 * GW + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

const gx2wx = (gx) => gx / (GW - 1) * WORLD_W;
const gy2wy = (gy) => gy / (GH - 1) * WORLD_H;

// ---- Rivers: descend the elevation gradient from a wet peak --------
function traceRiver(elev, startGx, startGy) {
  const pts = [];
  let gx = startGx, gy = startGy;
  for (let step = 0; step < 200; step++) {
    pts.push({ x: gx2wx(gx), y: gy2wy(gy) });
    // lowest 8-neighbour
    let bgx = gx, bgy = gy, best = elev[gy * GW + gx];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || nx >= GW || ny < 0 || ny >= GH) continue;
      const e = elev[ny * GW + nx];
      if (e < best) { best = e; bgx = nx; bgy = ny; }
    }
    if (bgx === gx && bgy === gy) break;             // local minimum (lake) → stop
    gx = bgx; gy = bgy;
    if (gx <= 0 || gx >= GW - 1 || gy <= 0 || gy >= GH - 1) { pts.push({ x: gx2wx(gx), y: gy2wy(gy) }); break; }
  }
  // Decimate to a smooth ~every-4th-cell polyline.
  const out = [];
  for (let i = 0; i < pts.length; i += 4) out.push(pts[i]);
  if (out.length && out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out.length >= 2 ? out : null;
}

// ---- Ridges: walk the crest along high elevation -------------------
function traceRidge(elev, peakGx, peakGy, ridgeLevel, used) {
  // From the peak, walk in the two highest directions, staying on the crest.
  function walk(dirSign) {
    const pts = [];
    let gx = peakGx, gy = peakGy, px = -dirSign, py = 0;
    for (let step = 0; step < 80; step++) {
      const key = gy * GW + gx;
      pts.push({ x: gx2wx(gx), y: gy2wy(gy) }); used.add(key);
      // highest neighbour that isn't a sharp reversal of travel
      let bgx = -1, bgy = -1, best = -1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || nx >= GW || ny < 0 || ny >= GH) continue;
        if (dx === -px && dy === -py) continue;       // don't immediately backtrack
        if (used.has(ny * GW + nx)) continue;
        const e = elev[ny * GW + nx];
        if (e > best) { best = e; bgx = nx; bgy = ny; }
      }
      if (bgx < 0 || best < ridgeLevel * 0.9) break;
      px = bgx - gx; py = bgy - gy; gx = bgx; gy = bgy;
    }
    return pts;
  }
  const left = walk(-1), right = walk(1);
  const line = left.reverse().concat(right.slice(1));
  return line.length >= 3 ? line : null;
}

/** Generate the natural geography. Returns a transient `geo` with sampler
 *  functions + serialisable feature arrays. `state` storage is done by the
 *  caller (worldgen.js). */
export function generateGeography(rng, theme) {
  // Elevation: more octaves at higher mountainDensity → rougher, peakier.
  const elev = fbm(rng, theme.mountainDensity > 1.2 ? [3, 6, 12, 24] : [3, 6, 12]);
  const moist = fbm(rng, [4, 9]);

  // Mountains rise with mountainDensity (lower ridge threshold → more peaks).
  const ridgeLevel = Math.max(0.55, 0.80 - (theme.mountainDensity - 1) * 0.12);
  // Sea/dry-basin level rises with waterDensity.
  const seaLevel = 0.10 + theme.waterDensity * 0.45;

  const elevAt  = (x, y) => sampleField(elev, x, y);
  const moistAt = (x, y) => sampleField(moist, x, y);

  // terrainAt → coarse class used for typing + render.
  function terrainAt(x, y) {
    const e = elevAt(x, y);
    if (e < seaLevel) return 'water';
    if (e > ridgeLevel) return 'mountain';
    const m = moistAt(x, y);
    if (e < seaLevel + 0.10) return 'basin';          // low + flat → fertile basin
    if (m < 0.32) return 'wasteland';                  // dry highlands
    if (m > 0.66) return 'fertile';
    return 'plain';
  }
  // Buildable = on land, off the steep peaks (a small margin each side).
  const buildableAt = (x, y) => {
    const e = elevAt(x, y);
    return e >= seaLevel + 0.015 && e <= ridgeLevel - 0.02;
  };

  // --- Rivers: from the wettest mid/high cells, descend to sea/edge. ---
  const rivers = [];
  const riverSeeds = [];
  for (let gy = 2; gy < GH - 2; gy++) for (let gx = 2; gx < GW - 2; gx++) {
    const e = elev[gy * GW + gx], m = moist[gy * GW + gx];
    if (e > seaLevel + 0.25 && e < ridgeLevel + 0.05 && m > 0.7) riverSeeds.push({ gx, gy, score: m * e });
  }
  riverSeeds.sort((a, b) => b.score - a.score);
  const riverTarget = theme.waterDensity > 0.25 ? 3 : 2;
  for (const s of riverSeeds) {
    if (rivers.length >= riverTarget) break;
    // space river sources apart
    let tooClose = false;
    for (const r of rivers) { const p = r.points[0]; if (Math.hypot(p.x - gx2wx(s.gx), p.y - gy2wy(s.gy)) < WORLD_W * 0.2) tooClose = true; }
    if (tooClose) continue;
    const line = traceRiver(elev, s.gx, s.gy);
    if (line) rivers.push({ kind: 'river', points: line });
  }

  // --- Ridges: from the highest unused peaks, crest-walk a range line. ---
  const ridges = [];
  const peaks = [];
  for (let gy = 1; gy < GH - 1; gy++) for (let gx = 1; gx < GW - 1; gx++) {
    if (elev[gy * GW + gx] > ridgeLevel) peaks.push({ gx, gy, e: elev[gy * GW + gx] });
  }
  peaks.sort((a, b) => b.e - a.e);
  const used = new Set();
  const ridgeTarget = theme.mountainDensity > 1.2 ? 3 : 2;
  for (const p of peaks) {
    if (ridges.length >= ridgeTarget) break;
    if (used.has(p.gy * GW + p.gx)) continue;
    const line = traceRidge(elev, p.gx, p.gy, ridgeLevel, used);
    if (line) ridges.push({ kind: 'mountain', points: line });
  }

  return {
    theme, seaLevel, ridgeLevel,
    GW, GH, elev, moist,                 // grids (serialisable; caller may store a copy)
    elevAt, moistAt, terrainAt, buildableAt,
    rivers, ridges,
  };
}

// ---- Resource belts: mineral on ridges, energy in basins, rare deep ----
/** Place a few resource belts seeded by geography. Returns plain objects
 *  {kind,x,y,r} + a resourceAt(x,y) sampler. */
export function generateResourceBelts(rng, theme, geo) {
  const belts = [];
  const beltR = Math.min(WORLD_W, WORLD_H) * 0.14;
  const richness = theme.resourceRichness;

  // Mineral belts hug the mountain ridges (mining country).
  for (const r of geo.ridges) {
    if (rng() > 0.55 * richness) continue;
    const p = r.points[Math.floor(r.points.length / 2)];
    belts.push({ kind: 'mineral', x: p.x, y: p.y, r: beltR });
  }
  // Energy fields sit in low basins / dry seas.
  let energyN = Math.round((1 + rng() * 1.5) * richness);
  for (let i = 0; i < energyN; i++) {
    for (let tries = 0; tries < 20; tries++) {
      const x = WORLD_W * (0.1 + rng() * 0.8), y = WORLD_H * (0.1 + rng() * 0.8);
      if (geo.terrainAt(x, y) === 'basin' || geo.elevAt(x, y) < geo.seaLevel + 0.12) {
        belts.push({ kind: 'energy', x, y, r: beltR * 0.85 }); break;
      }
    }
  }
  // Rare-earth in the deep wastes (high danger, far from the wet basins).
  if (rng() < 0.8 * richness) {
    for (let tries = 0; tries < 30; tries++) {
      const x = WORLD_W * (0.1 + rng() * 0.8), y = WORLD_H * (0.1 + rng() * 0.8);
      if (geo.terrainAt(x, y) === 'wasteland') { belts.push({ kind: 'rare', x, y, r: beltR * 0.7 }); break; }
    }
  }

  const resourceAt = (x, y) => {
    let best = null, bestD = Infinity;
    for (const b of belts) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < b.r && d < bestD) { bestD = d; best = b.kind; }
    }
    return best;
  };
  return { belts, resourceAt };
}

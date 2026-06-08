// =====================================================
// Procgen tactical-map art — satellite-style terrain ground layer.
//
// Active when the geography-first generator ran (state.regions non-empty);
// legacy maps draw nothing. Renders the macro "sci-fi reconnaissance map"
// BENEATH the faction turf wash / grid / roads / units, from the procgen-v2
// natural-geography data (state.geoGrid / worldTheme / barriers / resourceBelts):
//
//   • A static BAKED offscreen (rebuilt only when the world changes) carries
//     everything that never moves: the world-theme base, a SATELLITE elevation
//     shade upsampled from the coarse geoGrid (water basins → lowlands →
//     highlands → peaks in the theme palette, with a cheap west-light
//     hillshade), per-region tint, resource-belt hints, and the river/ridge
//     features. One drawImage per frame — cheap even at 40×.
//   • Per frame we add only the region NAME labels, faded out as you zoom in.
//
// Falls back gracefully: no geoGrid (e.g. an old worker snapshot) → a flat dark
// wash instead of the elevation shade, everything else unchanged.
//
// Worker-safe: render.js calls this in both contexts; the render snapshot ships
// regions / barriers / worldTheme / resourceBelts / worldSeed, and geoGrid via
// the one-shot terrain message. Buffer uses OffscreenCanvas off the main thread.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';
import { REGION_TINT, rgba } from './tactical-theme.js';
import { bakeContours, contourLevels } from './map-cartography.js';

const TEX_MAX = 1400;                  // baked map long side (px) — fixed, world-size independent
let buf = null, bufW = 0, bufH = 0, scale = 1, bakedSig = null;

const DEFAULT_PAL = { bg: '#140d09', lo: '#2c1d12', mid: '#48301c', hi: '#6c4a28', water: '#26201a', accent: '#c8743c' };
const BELT_COL = { mineral: '#caa24a', energy: '#4ab0a0', rare: '#b06ad0' };

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h; return c;
  }
  return new OffscreenCanvas(w, h);
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const cl = (v) => v < 0 ? 0 : v > 255 ? 255 : v | 0;

function sig() {
  return `${state.worldSeed}|${state.regions.length}|${state.worldTheme ? state.worldTheme.key : '-'}|${state.geoGrid ? 1 : 0}|${WORLD_W}x${WORLD_H}`;
}

/** Satellite elevation shade — colour each geoGrid cell by elevation band in
 *  the theme palette, with a cheap west-facing hillshade, then upscale smoothly
 *  across the whole buffer. */
function bakeElevation(c, gg, pal) {
  const { GW, GH, elev, seaLevel } = gg;
  const lo = hex(pal.lo), mid = hex(pal.mid), hi = hex(pal.hi), water = hex(pal.water);
  // Sun-lit peak band: a brightened hi so the highest crests catch light and the
  // map gains a clear top-of-relief read (snow/rock-lit ridgelines), one more
  // tonal step past `hi` so the elevation ramp spans water → low → high → PEAK.
  const peak = [cl(hi[0] * 1.5 + 34), cl(hi[1] * 1.5 + 30), cl(hi[2] * 1.5 + 26)];
  const tmp = makeCanvas(GW, GH);
  const tctx = tmp.getContext('2d');
  const id = tctx.createImageData(GW, GH);
  for (let i = 0; i < GW * GH; i++) {
    const e = elev[i];
    let col;
    if (e < seaLevel) {
      // Deeper water reads darker, and the deep end is pushed down so basins
      // actually look like sunken water, not just slightly-darker ground.
      const wt = Math.max(0, e / Math.max(0.001, seaLevel));
      col = lerp(lerp(water, [0, 0, 0], 0.35), lerp(water, lo, 0.5), wt);
    } else {
      // 4-band ramp with the mid→high split pushed earlier so highlands cover
      // more of the map and peaks get their own lit band → far more separation
      // between lowland basin and mountain than the old flat lo↔mid↔hi.
      const t = (e - seaLevel) / (1 - seaLevel);          // 0..1 above sea
      if (t < 0.45)      col = lerp(lo,  mid,  t / 0.45);
      else if (t < 0.78) col = lerp(mid, hi,  (t - 0.45) / 0.33);
      else               col = lerp(hi,  peak, (t - 0.78) / 0.22);
    }
    // NW-light hillshade. Sampled over a TWO-cell stencil (not 1) so the slope
    // signal is big enough to read once upsampled + veiled, then amplified hard
    // and clamped. This is what turns the soft gradient into legible relief —
    // sunward (NW) faces brighten, leeward (SE) faces fall into shadow.
    const x = i % GW, yy = (i / GW) | 0;
    const xl = x > 1 ? x - 2 : 0, xr = x < GW - 2 ? x + 2 : GW - 1;
    const yu = yy > 1 ? yy - 2 : 0, yd = yy < GH - 2 ? yy + 2 : GH - 1;
    const eL = elev[yy * GW + xl], eR = elev[yy * GW + xr];
    const eU = elev[yu * GW + x],  eD = elev[yd * GW + x];
    let sh = 1 + (eL - eR) * 4.4 + (eU - eD) * 2.4;
    if (sh < 0.5) sh = 0.5; else if (sh > 1.7) sh = 1.7;   // clamp: no crushed blacks / blown highlights
    const k = i * 4;
    id.data[k] = cl(col[0] * sh); id.data[k + 1] = cl(col[1] * sh); id.data[k + 2] = cl(col[2] * sh); id.data[k + 3] = 255;
  }
  tctx.putImageData(id, 0, 0);
  c.imageSmoothingEnabled = true;
  c.drawImage(tmp, 0, 0, WORLD_W, WORLD_H);              // c is world-scaled → fills buffer, smooth
}

/** Bake the static tactical-map ground (world coords via a scale transform). */
function bakeTacticalMap() {
  scale = TEX_MAX / Math.max(WORLD_W, WORLD_H);
  bufW = Math.max(1, Math.round(WORLD_W * scale));
  bufH = Math.max(1, Math.round(WORLD_H * scale));
  buf = makeCanvas(bufW, bufH);
  const c = buf.getContext('2d');
  c.clearRect(0, 0, bufW, bufH);
  c.save();
  c.scale(scale, scale);

  const theme = state.worldTheme;
  const pal = (theme && theme.pal) || DEFAULT_PAL;

  // 1) Theme base + satellite elevation shade (or flat wash fallback).
  c.fillStyle = pal.bg;
  c.fillRect(0, 0, WORLD_W, WORLD_H);
  if (state.geoGrid && state.geoGrid.elev) bakeElevation(c, state.geoGrid, pal);
  // Command-map veil over the terrain — kept THIN so the elevation shade +
  // contour lines below still read (the old 0.22 veil flattened the map into a
  // near-uniform field; that emptiness is what made it look like a graph). Now
  // that the relief is stronger (4-band ramp + amplified hillshade) the veil is
  // thinned further so the mountains/valleys carry the image.
  c.fillStyle = 'rgba(8, 6, 12, 0.08)';
  c.fillRect(0, 0, WORLD_W, WORLD_H);

  // 1b) Topographic contour lines + coastline (marching squares from geoGrid).
  //     The single biggest "this is a map" signal: faint elevation isolines
  //     across the whole theatre, plus a brighter shore where terrain dips
  //     below sea level. Bake-time only — see map-cartography.js.
  if (state.geoGrid && state.geoGrid.elev) {
    const gg = state.geoGrid;
    // Minor contours — the fine topographic web (close spacing, thin + faint).
    bakeContours(c, gg, {
      levels: contourLevels(gg.seaLevel, 0.07),
      color: 'rgba(236, 214, 176, 1)', lineWidth: 7, alpha: 0.14,
    });
    // Index contours — every ~3rd level drawn bolder, the way a real topo map
    // thickens its labelled lines. This is what makes the relief read.
    bakeContours(c, gg, {
      levels: contourLevels(gg.seaLevel, 0.21),
      color: 'rgba(246, 226, 190, 1)', lineWidth: 13, alpha: 0.28,
    });
    // Coastline — the seaLevel iso, bright + thick, where the world has water.
    if (gg.seaLevel > 0.04) {
      bakeContours(c, gg, {
        levels: [gg.seaLevel],
        color: pal.water || '#3a6f8a', lineWidth: 36, alpha: 0.5,
      });
    }
  }

  // 2) Region zones — light tint + faint contour rings (sector identity).
  for (const r of state.regions) {
    const col = REGION_TINT[r.type] || '#6a6a78';
    const g = c.createRadialGradient(r.x, r.y, 0, r.x, r.y, r.radius);
    g.addColorStop(0, rgba(col, 0.18));
    g.addColorStop(0.55, rgba(col, 0.08));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(r.x, r.y, r.radius, 0, Math.PI * 2); c.fill();
    c.strokeStyle = rgba(col, 0.11);
    c.lineWidth = 2.5;
    for (let k = 1; k <= 3; k++) {
      c.beginPath(); c.arc(r.x, r.y, r.radius * (0.32 + 0.22 * k), 0, Math.PI * 2); c.stroke();
    }
  }

  // 2b) DISTRICT street grid — built-up region types (city / industrial / military)
  //     get a faint rotated block-grid clipped to their core, so a dense node
  //     cluster reads as a SETTLEMENT (city blocks / industrial yards) instead of
  //     a tangle of graph edges. Bake-time only; per-region angle + type spacing
  //     keep districts distinct. Under the roads/nodes layers → texture, not clutter.
  for (const r of state.regions) {
    if (r.type !== 'city' && r.type !== 'industrial_zone' && r.type !== 'military_base') continue;
    const col = REGION_TINT[r.type] || '#6a6a78';
    const core = r.radius * 0.6;                  // grid only fills the built core
    const ang = (r.id * 0.7) % (Math.PI / 2);     // seeded-ish per region so they don't align
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const spacing = r.type === 'industrial_zone' ? 110 : r.type === 'military_base' ? 150 : 82;
    c.save();
    c.beginPath(); c.arc(r.x, r.y, core, 0, Math.PI * 2); c.clip();
    c.strokeStyle = rgba(col, r.type === 'city' ? 0.14 : 0.10);
    c.lineWidth = 2.5;
    for (let fam = 0; fam < 2; fam++) {           // two perpendicular line families = blocks
      const ux = fam === 0 ? cos : -sin, uy = fam === 0 ? sin : cos;
      const px = -uy, py = ux;
      for (let s = -core; s <= core; s += spacing) {
        const ox = r.x + px * s, oy = r.y + py * s;
        c.beginPath();
        c.moveTo(ox - ux * core, oy - uy * core);
        c.lineTo(ox + ux * core, oy + uy * core);
        c.stroke();
      }
    }
    c.restore();
  }

  // 3) Resource belts — faint kind-coloured haze (mineral/energy/rare).
  for (const b of state.resourceBelts) {
    const col = BELT_COL[b.kind] || '#999';
    const g = c.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, rgba(col, 0.13));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(b.x, b.y, b.r, 0, Math.PI * 2); c.fill();
  }

  // 4) Craters — a few seeded ruin-pocks (themed density), for texture.
  const rng = mulberry32(((state.worldSeed || 1) ^ 0x9e3779b9) >>> 0);
  const ruin = theme ? (theme.ruinDensity || 1) : 1;
  const craters = Math.round((WORLD_W * WORLD_H) / 9e6 * ruin);
  for (let i = 0; i < craters; i++) {
    const x = rng() * WORLD_W, y = rng() * WORLD_H, rr = 110 + rng() * 240;
    c.fillStyle = 'rgba(8, 5, 4, 0.28)';
    c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(200, 150, 100, 0.10)';
    c.lineWidth = 3;
    c.beginPath(); c.arc(x, y, rr * 0.95, 0, Math.PI * 2); c.stroke();
  }

  // 5) Natural features — rivers as bright water channels, mountain ridges as
  //    dark crest silhouettes with a lit top edge. These are the real procgen
  //    barriers, so they line up with the bridge/pass chokepoints.
  for (const bar of state.barriers) {
    const p = bar.points;
    if (!p || p.length < 2) continue;
    c.lineCap = 'round'; c.lineJoin = 'round';
    const trace = () => { c.beginPath(); c.moveTo(p[0].x, p[0].y); for (let i = 1; i < p.length; i++) c.lineTo(p[i].x, p[i].y); };
    if (bar.kind === 'river') {
      trace(); c.strokeStyle = rgba(pal.water, 0.55);      c.lineWidth = 80; c.stroke();
      trace(); c.strokeStyle = 'rgba(120, 170, 210, 0.55)'; c.lineWidth = 30; c.stroke();
      trace(); c.strokeStyle = 'rgba(180, 215, 235, 0.45)'; c.lineWidth = 8;  c.stroke();
    } else {                                  // 'mountain' / 'canyon'
      trace(); c.strokeStyle = 'rgba(14, 9, 7, 0.55)';   c.lineWidth = 130; c.stroke();
      trace(); c.strokeStyle = 'rgba(70, 52, 36, 0.50)'; c.lineWidth = 64;  c.stroke();
      trace(); c.strokeStyle = 'rgba(206, 170, 120, 0.30)'; c.lineWidth = 6; c.stroke();
    }
    c.lineCap = 'butt'; c.lineJoin = 'miter';
  }

  c.restore();
  bakedSig = sig();
}

/** Bottom-layer tactical ground + sector-name labels. Call in WORLD space. */
export function drawProcgen(ctx, zoom) {
  if (!state.regions || !state.regions.length) return;   // legacy gen → nothing
  if (bakedSig !== sig() || !buf) bakeTacticalMap();
  ctx.drawImage(buf, 0, 0, WORLD_W, WORLD_H);

  // Sector names — ATLAS behaviour. Three rules make this read like a real map
  // instead of a pile of overlapping text:
  //   1. SIZE BY IMPORTANCE — big/high-value sectors get a big name, small ones
  //      a small name (importance ≈ radius + strategic value).
  //   2. REVEAL BY ZOOM — the biggest sectors show even at full-theatre overview;
  //      smaller ones only appear as you zoom in (like a city showing at country
  //      scale but a town only when you lean in). Then ALL fade out once you're
  //      close enough that the per-node settlement labels take over.
  //   3. NO OVERLAP — labels are placed biggest-first; any that would collide
  //      with an already-placed (more important) one is skipped this frame.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = (4 / zoom) + 'px';
  const { vL, vT, vR, vB } = state._view;
  // Rank biggest-first so important names win the collision contest.
  const ranked = state.regions
    .filter(r => r.name)
    .map(r => ({ r, imp: (r.radius || 600) * 0.014 + (r.value || 1) * 3.5 }))   // ≈ 10–34
    .sort((a, b) => b.imp - a.imp);
  const placed = [];                       // screen-space bboxes drawn so far
  for (const { r, imp } of ranked) {
    // Importance → the zoom at which this name STARTS showing. imp 34 → ~0.07
    // (overview); imp 8 → ~0.62 (must lean in). Linear between.
    const showZoom = 0.62 - Math.min(0.55, ((imp - 8) / 26) * 0.55);
    if (zoom < showZoom) continue;
    if (r.x < vL || r.x > vR || r.y < vT || r.y > vB) continue;   // off-screen cull
    const f = (13 + imp) / zoom;                                  // world font px (≈ 23–47 screen)
    ctx.font = `600 ${f}px -apple-system, system-ui, sans-serif`;
    const txt = r.name.toUpperCase();
    // Screen-space bbox for the collision test (+ margin for the letter-spacing
    // that measureText doesn't fully account for).
    const sx = (r.x - state.cameraX) * zoom, sy = (r.y - state.cameraY) * zoom;
    const hw = (ctx.measureText(txt).width * 0.5 + 10);
    const hh = (f * zoom * 0.5 + 5);
    let collide = false;
    for (const p of placed) {
      if (Math.abs(sx - p.x) < hw + p.hw && Math.abs(sy - p.y) < hh + p.hh) { collide = true; break; }
    }
    if (collide) continue;
    placed.push({ x: sx, y: sy, hw, hh });
    // Fade in over a small band above showZoom; fade out as you zoom way in.
    const fadeIn  = Math.min(1, (zoom - showZoom) / 0.12 + 0.25);
    const fadeOut = Math.max(0, Math.min(1, (0.95 - zoom) / 0.3));
    const a = 0.6 * fadeIn * fadeOut;
    if (a <= 0.02) continue;
    const aMul = Math.min(1.25, 0.8 + imp / 40);                  // big names pop more
    ctx.lineWidth = 4 / zoom;
    ctx.strokeStyle = `rgba(0, 0, 0, ${a * 0.85})`;
    ctx.strokeText(txt, r.x, r.y);
    ctx.fillStyle = `rgba(220, 212, 196, ${Math.min(0.62, a * aMul)})`;
    ctx.fillText(txt, r.x, r.y);
  }
  ctx.restore();
}

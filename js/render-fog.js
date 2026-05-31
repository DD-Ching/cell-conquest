// =====================================================
// Fog of war — render layer.
//
// Paints a dark veil over the world from the vision grid fog.js maintains.
// Three tiers per cell: unseen → near-opaque shroud, explored (seen but not
// currently visible) → half-dark "remembered" dim, visible → fully clear.
//
// Technique: rasterise the coarse gw×gh grid into a 1-px-per-cell offscreen
// buffer's ImageData (a dark RGBA whose ALPHA encodes the tier), then blit it
// scaled up to the full world rect with image smoothing on — the GPU's bilinear
// upscale gives soft fog edges for free, no per-pixel blur. The buffer is tiny
// (~110×82 at default cell size) so rebuilding its ImageData each frame is
// trivial (<0.1 ms).
//
// Drawn inside the world transform as the last world-space layer, so it veils
// terrain + entities uniformly; owned/visible areas sit at alpha 0 so the
// player's turf stays crisp. Render-only + outcome-neutral — see fog.js.
//
// Works in both the main thread and the render worker (OffscreenCanvas when
// present, else a DOM canvas — same dual-context helper render-territory uses).
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';

// Veil colour — deep Mars-night blue-black. Alpha is set per pixel.
const VEIL_R = 8, VEIL_G = 7, VEIL_B = 13;
const ALPHA_UNSEEN   = 236;   // /255 ≈ 0.93 — near-black shroud
const ALPHA_EXPLORED = 130;   // /255 ≈ 0.51 — remembered, dimmed

let _buf = null, _bufCtx = null, _img = null, _bufW = 0, _bufH = 0;

function makeBuffer(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

/** Paint the fog veil. No-op unless fog is actively revealing (playing phase). */
export function drawFog(ctx, zoom) {
  if (!state.fogReveal) return;
  const f = state.fog;
  if (!f) return;
  const gw = f.gw, gh = f.gh, seen = f.seen, vis = f.vis;

  // (Re)allocate the raster buffer to match the grid.
  if (!_buf || _bufW !== gw || _bufH !== gh) {
    _buf = makeBuffer(gw, gh);
    _bufCtx = _buf.getContext('2d');
    _img = _bufCtx.createImageData(gw, gh);
    _bufW = gw; _bufH = gh;
    // Pre-fill the constant RGB; only alpha changes per frame.
    const d = _img.data;
    for (let i = 0; i < gw * gh; i++) {
      d[i * 4] = VEIL_R; d[i * 4 + 1] = VEIL_G; d[i * 4 + 2] = VEIL_B;
    }
  }

  // Encode tiers into the alpha channel.
  const d = _img.data;
  const n = gw * gh;
  for (let i = 0; i < n; i++) {
    const a = vis[i] ? 0 : (seen[i] ? ALPHA_EXPLORED : ALPHA_UNSEEN);
    d[i * 4 + 3] = a;
  }
  _bufCtx.putImageData(_img, 0, 0);

  // Blit scaled to the world rect with smoothing → soft fog edges.
  const prevSmooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(_buf, 0, 0, gw, gh, 0, 0, WORLD_W, WORLD_H);
  ctx.imageSmoothingEnabled = prevSmooth;
}

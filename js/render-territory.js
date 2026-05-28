// =====================================================
// Territory floor tint — late-game turf shading.
//
// Paints a soft, faction-coloured wash on the GROUND beneath connected
// friendly nodes so an established empire reads as owned turf (the "領土"
// feel). Sits at the very bottom of the world layers (just above terrain,
// below the hex grid / roads / units) so it tints the floor without ever
// covering gameplay elements.
//
// Cheap by construction:
//   • Baked once into a small FIXED-size offscreen buffer (≤ TERRITORY_TEX_MAX
//     on the long side). Memory is independent of WORLD size — the 12000×9000
//     theatre costs the same few MB as a tiny arena. Re-baked ONLY when
//     ownership changes (a cheap per-frame owners-hash detects this).
//   • Per frame we just blit that buffer, upscaled, under one globalAlpha.
//     The bilinear upscale is what turns the low-res node blobs into a soft
//     territory wash. When the wash is invisible (early/mid game) we early-out
//     after a single O(nodes) hash pass.
//
// "後期漸漸的安定之後才會變" — the wash is gated on how settled the game is:
// the fade is driven by the fraction of the map that's been claimed
// (TERRITORY_FADE_START → FULL). Early/mid game shows nothing; as neutrals get
// eaten and the board stabilises, each faction's turf fades in. The proxy
// self-calibrates to any game length or speed.
//
// Worker-safe: render.js calls drawTerritory() in BOTH the main thread and the
// render worker. Both have state.nodes / state.adj and a populated COLOR map
// (the worker mirrors it from the snapshot), and the offscreen buffer uses
// OffscreenCanvas when `document` is absent (worker) or a detached <canvas>
// otherwise.
// =====================================================
import { state } from './state.js';
import { COLOR } from './factions.js';
import { dist } from './util.js';
import {
  WORLD_W, WORLD_H, TERRITORY_TEX_MAX, TERRITORY_MAX_ALPHA,
  TERRITORY_FADE_START, TERRITORY_FADE_FULL,
  TERRITORY_NODE_R_MUL, TERRITORY_EDGE_W_MUL,
} from './config.js';

let buf = null, bufCtx = null;   // offscreen bake buffer + its 2D context
let bufW = 0, bufH = 0, scale = 1;
let lastSig = -1;                // owners-hash of the last bake (re-bake trigger)

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h; return c;
  }
  return new OffscreenCanvas(w, h);
}

/** (Re)create the bake buffer sized to the current world, capped on the long
 *  side so memory stays independent of WORLD dims. Forces a re-bake when the
 *  buffer is rebuilt (e.g. a preset changed the world between games). */
function ensureBuffer() {
  scale = TERRITORY_TEX_MAX / Math.max(WORLD_W, WORLD_H);
  const w = Math.max(1, Math.round(WORLD_W * scale));
  const h = Math.max(1, Math.round(WORLD_H * scale));
  if (buf && bufW === w && bufH === h) return;
  buf = makeCanvas(w, h);
  bufCtx = buf.getContext('2d');
  bufW = w; bufH = h;
  lastSig = -1;
}

/** Paint each faction's turf into the low-res buffer at FULL opacity (the
 *  per-frame blit applies the fade). Thick connectors along same-owner
 *  adjacency edges + a disc at every owned node → a solid blob the upscale
 *  softens into territory. */
function bake() {
  bufCtx.clearRect(0, 0, bufW, bufH);
  bufCtx.lineCap = 'round';
  bufCtx.lineJoin = 'round';

  // Self-calibrate footprint size off the median same-owner edge length so the
  // wash fills inter-node gaps at any density. (adj is shipped to the worker;
  // state.roads is not — iterate adjacency, each undirected edge once.)
  let sumLen = 0, nLen = 0;
  for (const [id, nbrs] of state.adj) {
    const a = state.nodes[id];
    if (!a || a.owner === 'neutral') continue;
    for (const nb of nbrs) {
      if (nb <= id) continue;
      const b = state.nodes[nb];
      if (!b || b.owner !== a.owner) continue;
      sumLen += dist(a, b); nLen++;
    }
  }
  const medLen = nLen ? sumLen / nLen : 400;

  // Connectors first (under the discs).
  bufCtx.lineWidth = Math.max(1, medLen * TERRITORY_EDGE_W_MUL * scale);
  for (const [id, nbrs] of state.adj) {
    const a = state.nodes[id];
    if (!a || a.owner === 'neutral') continue;
    const col = COLOR[a.owner];
    if (!col) continue;
    for (const nb of nbrs) {
      if (nb <= id) continue;
      const b = state.nodes[nb];
      if (!b || b.owner !== a.owner) continue;
      bufCtx.strokeStyle = col;
      bufCtx.beginPath();
      bufCtx.moveTo(a.x * scale, a.y * scale);
      bufCtx.lineTo(b.x * scale, b.y * scale);
      bufCtx.stroke();
    }
  }

  // Discs at each owned node.
  for (const n of state.nodes) {
    if (!n || n.owner === 'neutral') continue;
    const col = COLOR[n.owner];
    if (!col) continue;
    bufCtx.fillStyle = col;
    bufCtx.beginPath();
    bufCtx.arc(n.x * scale, n.y * scale,
               Math.max(1, (medLen * TERRITORY_NODE_R_MUL + n.size) * scale),
               0, Math.PI * 2);
    bufCtx.fill();
  }
}

/** Bottom-layer territory wash. Call in WORLD space (after the camera
 *  transform), just above terrain. Near-free until the late game. */
export function drawTerritory(ctx) {
  const nodes = state.nodes;
  if (!nodes || nodes.length === 0 || !state.adj) return;

  // One O(nodes) pass: claimed fraction (fade driver) + owners hash (re-bake
  // trigger). Neutrals don't count as claimed.
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
  const t = (owned / nodes.length - TERRITORY_FADE_START)
          / (TERRITORY_FADE_FULL - TERRITORY_FADE_START);
  const fade = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (fade <= 0.001) return;            // early/mid game — nothing to draw

  ensureBuffer();
  if (sig !== lastSig) { bake(); lastSig = sig; }

  ctx.save();
  ctx.globalAlpha = fade * TERRITORY_MAX_ALPHA;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buf, 0, 0, WORLD_W, WORLD_H);
  ctx.restore();
}

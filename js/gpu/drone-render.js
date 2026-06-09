// =====================================================
// Instanced WebGPU drone render — the GPU half of P1 ("drones render on GPU").
// See PERF_ROADMAP.md (v2).
//
// The ENTIRE swarm is drawn in ONE instanced draw call straight from the SoA
// position buffers (drone-buffers.js) — no per-drone JS canvas work at all. A
// delta-wing triangle is generated in the vertex shader from the per-vertex
// corner index; per-instance data (posX, posY, heading, owner) is read from the
// storage buffers by instance_index. This is what lets the count be UNBOUNDED:
// adding a drone is a buffer write, never a JS draw call (過癮).
//
// It draws onto a SEPARATE transparent <canvas> stacked over the 2D game canvas
// (#game), so the existing 2D renderer is completely untouched — when this path
// is active the JS drone layer (drawDroneFleets) just early-returns, and if the
// GPU path is off or fails the 2D layer keeps drawing exactly as before. Same
// opt-in / fail-safe discipline as Shift+W / Y / U (see CLAUDE.md).
//
// Coordinates: the delta-wing offsets are in WORLD units (so drones scale with
// zoom like the 2D sprites). world -> screen = (world - camera) * zoom, then
// screen -> clip in the vertex shader from a small camera uniform.
// =====================================================

import { getDevice, isGpuReady } from './gpu-device.js';
import { state } from '../state.js';
import { COLOR } from '../factions.js';
import { ownerKey } from '../wasm-bridge.js';

let canvas = null;          // the overlay <canvas> (transparent, pointer-events:none)
let ctx = null;             // its GPUCanvasContext
let format = null;          // preferred swap-chain format
let pipeline = null;
let camBuf = null;          // uniform: cameraX, cameraY, zoom, _, viewW, viewH, _, _
let colorBuf = null;        // storage: per-ownerKey vec4 color table
let colorCap = 0;           // current color-table capacity (elements)
let _initing = false;
let _failed = false;        // a hard failure (e.g. no webgpu context) → stay on CPU render
let _active = false;        // true once the pipeline is live and we're drawing

/** Is the GPU drone render path live this frame? drawDroneFleets() checks this
 *  and early-returns so the swarm isn't drawn twice. */
export function gpuDronesRendered() { return _active; }

// ---- The shader: one delta-wing triangle per instance ----------------------
// vertex_index 0=nose, 1=left wing, 2=right wing — local offsets in world px,
// matching the 2D low-LOD delta-wing (nose 14 fwd, wings 10 back ± 9). Rotated
// by the drone heading, placed at its world pos, then mapped to clip space.
const SHADER = /* wgsl */`
struct Cam {
  cam   : vec2<f32>,   // cameraX, cameraY (world)
  zoom  : f32,
  _pad0 : f32,
  view  : vec2<f32>,   // viewport W, H (px)
  _pad1 : vec2<f32>,
};
@group(0) @binding(0) var<uniform> cam : Cam;
@group(0) @binding(1) var<storage, read> posX    : array<f32>;
@group(0) @binding(2) var<storage, read> posY    : array<f32>;
@group(0) @binding(3) var<storage, read> heading : array<f32>;
@group(0) @binding(4) var<storage, read> owner   : array<u32>;
@group(0) @binding(5) var<storage, read> colors  : array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> flags   : array<u32>;

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0)       col : vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VsOut {
  var out : VsOut;
  // Dead/detonated drones (ALIVE bit clear) collapse off-screen — clipped, not
  // drawn. Lets the GPU-resident pool keep dead slots without them lingering.
  if ((flags[ii] & 1u) == 0u) {
    out.pos = vec4<f32>(100.0, 100.0, 100.0, 1.0);
    out.col = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }
  // Local delta-wing in world px (x = forward, y = lateral).
  var local : vec2<f32>;
  if (vi == 0u)      { local = vec2<f32>( 14.0,  0.0); }   // nose
  else if (vi == 1u) { local = vec2<f32>(-10.0,  9.0); }   // left wing
  else               { local = vec2<f32>(-10.0, -9.0); }   // right wing

  let h = heading[ii];
  let c = cos(h); let s = sin(h);
  let rot = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  let world = vec2<f32>(posX[ii], posY[ii]) + rot;
  let screen = (world - cam.cam) * cam.zoom;        // px from top-left
  // px -> clip: x in [-1,1] (right+), y in [-1,1] (up+, so flip screen-y)
  let clip = vec2<f32>(screen.x / cam.view.x * 2.0 - 1.0,
                       1.0 - screen.y / cam.view.y * 2.0);

  out.pos = vec4<f32>(clip, 0.0, 1.0);
  let o = owner[ii];
  out.col = select(vec4<f32>(1.0, 1.0, 1.0, 1.0), colors[o], o < arrayLength(&colors));
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  return in.col;        // opaque body; alphaMode 'premultiplied' lets gaps show the 2D canvas
}`;

function ensureCanvas() {
  if (canvas) return true;
  if (typeof document === 'undefined' || !state.canvas) return false;
  canvas = document.createElement('canvas');
  canvas.id = 'gpu-overlay';
  // Stacked exactly over #game; never eats pointer input. No z-index so it
  // paints above the (non-positioned) game canvas but below the positioned HUD
  // panels / lobby / tutorial that come later in the DOM.
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
  state.canvas.insertAdjacentElement('afterend', canvas);
  syncSize();
  return true;
}

function syncSize() {
  if (!canvas) return;
  // Match the 2D canvas's CSS-pixel backing store (resize() in main.js uses
  // innerWidth/Height with no DPR scaling) so world coords line up 1:1.
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function init() {
  if (pipeline || _initing || _failed) return;
  _initing = true;
  try {
    if (!ensureCanvas()) { _failed = true; return; }
    ctx = canvas.getContext('webgpu');
    if (!ctx) { console.warn('[gpu] no webgpu canvas context — drones stay on CPU render'); _failed = true; return; }
    const dev = getDevice();
    format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device: dev, format, alphaMode: 'premultiplied' });

    const module = dev.createShaderModule({ code: SHADER });
    pipeline = dev.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    camBuf = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    console.log('[gpu] drone render pipeline ready — instanced delta-wings straight from the SoA buffers (P1a)');
  } catch (e) {
    console.warn('[gpu] drone render init failed — CPU render fallback', e);
    _failed = true;
  } finally {
    _initing = false;
  }
}

// Owner color table (vec4 per ownerKey). Tiny (<= ~7 owners); rebuilt each frame
// so a faction re-roll / new game is always reflected. ally1 aliases to player
// in ownerKey() so the Lieutenant's drones inherit the player's blue.
let _colorScratch = null;
function uploadColors(dev) {
  let maxIdx = 0;
  const entries = [];
  for (const name in COLOR) {
    const idx = ownerKey(name);
    entries.push([idx, COLOR[name]]);
    if (idx > maxIdx) maxIdx = idx;
  }
  const n = maxIdx + 1;
  if (!_colorScratch || _colorScratch.length < n * 4) _colorScratch = new Float32Array(n * 4);
  const t = _colorScratch;
  t.fill(1, 0, n * 4);                            // default white for any gap
  for (const [idx, hex] of entries) {
    t[idx * 4]     = parseInt(hex.slice(1, 3), 16) / 255;
    t[idx * 4 + 1] = parseInt(hex.slice(3, 5), 16) / 255;
    t[idx * 4 + 2] = parseInt(hex.slice(5, 7), 16) / 255;
    t[idx * 4 + 3] = 1;
  }
  if (colorCap < n) {
    if (colorBuf) colorBuf.destroy();
    colorBuf = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    colorCap = n;
  }
  dev.queue.writeBuffer(colorBuf, 0, t, 0, n * 4);
}

/** Draw one or more swarms, each in a single instanced call, onto the overlay.
 *  `swarms` = [{ buffers, count }] where `buffers` has posX/posY/heading/owner
 *  GPUBuffers (the drone-buffers.js SoA set, the GPU-resident swarm set, …) and
 *  `count` is its live instance count. One render pass clears the overlay then
 *  draws every swarm. No-op + leaves the CPU path drawing if GPU isn't ready. */
export function renderGPUDrones(swarms) {
  if (!isGpuReady() || _failed) { _active = false; return; }
  if (!pipeline) { init(); if (!pipeline) { _active = false; return; } }
  _active = true;                       // we own the drone layer now (drawDroneFleets early-returns)
  syncSize();
  const dev = getDevice();

  // Camera uniform — must match the 2D render transform exactly.
  const cam = new Float32Array([state.cameraX, state.cameraY, state.zoom, 0,
                                state.W || innerWidth, state.H || innerHeight, 0, 0]);
  dev.queue.writeBuffer(camBuf, 0, cam);
  uploadColors(dev);

  const enc = dev.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: ctx.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 },   // transparent — the 2D world shows through
      loadOp: 'clear', storeOp: 'store',
    }],
  });
  pass.setPipeline(pipeline);
  for (const sw of swarms) {
    if (!sw || !sw.buffers || sw.count <= 0) continue;
    const b = sw.buffers;
    // Bind group rebuilt every frame so a buffer regrow (new GPUBuffer identity)
    // is picked up transparently — one bind group, one draw, no per-drone cost.
    const bind = dev.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: camBuf } },
        { binding: 1, resource: { buffer: b.posX } },
        { binding: 2, resource: { buffer: b.posY } },
        { binding: 3, resource: { buffer: b.heading } },
        { binding: 4, resource: { buffer: b.owner } },
        { binding: 5, resource: { buffer: colorBuf } },
        { binding: 6, resource: { buffer: b.flags } },
      ],
    });
    pass.setBindGroup(0, bind);
    pass.draw(3, sw.count);             // 3 verts (delta-wing), `count` instances
  }
  pass.end();
  dev.queue.submit([enc.finish()]);
}

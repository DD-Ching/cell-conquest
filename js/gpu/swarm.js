// =====================================================
// GPU-RESIDENT drone swarm — the core of P1 ("unlimited drones IS the point").
// See PERF_ROADMAP.md (v2).
//
// These drones live ONLY on the GPU. There is no JS object per drone, so the
// count is genuinely UNBOUNDED — spawning a drone is a buffer write, flying it
// is one compute invocation, drawing it is one instance. None of it scales with
// a per-drone CPU cost, which is exactly why the swarm can be 100k+ and stay
// smooth (the whole reason the roadmap commits to WebGPU instead of caps).
//
// State is struct-of-arrays GPU buffers (mirrors drone-buffers.js): position,
// heading, the target it flies toward, owner (for colour), and a flags word
// (alive bit). Capacity GROWS ×1.5 on overflow and NEVER caps. The movement
// compute pass is a faithful WGSL port of drones.js `steerDrone` — bounded
// turn-radius banking, so the swarm curves and (against a fixed target) spirals
// into an orbiting vortex instead of snapping straight. Targeting / impact stay
// CPU-assigned for now (P1c wires arrival events back); P2+ move those on-GPU.
//
// Everything here is a no-op until isGpuReady() (?gpu=1 AND the self-test passed)
// — same opt-in / fail-safe discipline as the rest of the GPU path.
// =====================================================

import { getDevice, isGpuReady } from './gpu-device.js';
import { DRONE_SPEED, DRONE_TURN_RADIUS } from '../config.js';
import { ownerKey } from '../wasm-bridge.js';

export const SW_FLAG_ALIVE = 1 << 0;

const F32_FIELDS = ['posX', 'posY', 'heading', 'tgtX', 'tgtY'];
const U32_FIELDS = ['owner', 'flags'];
const ALL_FIELDS = [...F32_FIELDS, ...U32_FIELDS];

let cap = 0;                 // per-field element capacity
let count = 0;              // high-water mark of slots in use (dead slots included)
const gbuf = {};            // field -> GPUBuffer (the live, GPU-owned state)
let movePipeline = null;
let simBuf = null;          // uniform: dt, speed, turnR, count
const _stage = {};          // field -> CPU staging typed array for spawn batches

function mkBuffer(dev, bytes) {
  return dev.createBuffer({
    size: Math.max(16, bytes),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
}

// Grow capacity to >= n, PRESERVING the GPU-resident state (the GPU has been
// integrating positions, so we copy the live [0,count) range into the new,
// larger buffers instead of dropping it). ×1.5 growth, never a cap.
function ensureCapacity(n) {
  if (n <= cap) return;
  const dev = getDevice();
  let c = cap || 8192;
  while (c < n) c = Math.ceil(c * 1.5);
  const old = { ...gbuf };
  const oldCount = count;
  const enc = (cap > 0 && oldCount > 0) ? dev.createCommandEncoder() : null;
  for (const f of ALL_FIELDS) {
    const nb = mkBuffer(dev, c * 4);
    if (enc && old[f]) enc.copyBufferToBuffer(old[f], 0, nb, 0, oldCount * 4);
    gbuf[f] = nb;
  }
  if (enc) dev.queue.submit([enc.finish()]);
  for (const f of ALL_FIELDS) if (old[f]) old[f].destroy();
  cap = c;
  console.log(`[gpu] swarm capacity grown → ${c} (${(ALL_FIELDS.length * c * 4 / 1048576).toFixed(1)}MB, NO cap)`);
}

function stageArr(field, n) {
  const F32 = F32_FIELDS.includes(field);
  let a = _stage[field];
  if (!a || a.length < n) { a = F32 ? new Float32Array(n) : new Uint32Array(n); _stage[field] = a; }
  return a;
}

/** Spawn a batch of GPU-resident drones. `list` items: {x, y, heading, tgtX,
 *  tgtY, owner}. Appends at the high-water mark, growing if needed. Returns the
 *  new total slot count. No-op (returns count) unless the GPU path is armed. */
export function spawnSwarm(list) {
  if (!isGpuReady() || !list || list.length === 0) return count;
  const dev = getDevice();
  const n = list.length;
  ensureCapacity(count + n);
  const a = {};
  for (const f of ALL_FIELDS) a[f] = stageArr(f, n);
  for (let i = 0; i < n; i++) {
    const d = list[i];
    a.posX[i] = d.x; a.posY[i] = d.y;
    a.heading[i] = (d.heading !== undefined) ? d.heading : Math.atan2(d.tgtY - d.y, d.tgtX - d.x);
    a.tgtX[i] = d.tgtX; a.tgtY[i] = d.tgtY;
    a.owner[i] = ownerKey(d.owner || 'player');
    a.flags[i] = SW_FLAG_ALIVE;
  }
  // Upload only the appended [count, count+n) slice of each field buffer.
  for (const f of ALL_FIELDS) dev.queue.writeBuffer(gbuf[f], count * 4, a[f], 0, n);
  count += n;
  return count;
}

// ---- Movement compute pass — faithful WGSL port of drones.js steerDrone ------
// turnR = clamp(d*0.7, TURN_R*0.3, TURN_R); maxTurn = (SPEED/turnR)*dt; bank the
// heading by the clamped angular delta, then advance along heading by SPEED*dt.
// Against a fixed target a drone overshoots and arcs back — the orbit emerges.
const MOVE_SHADER = /* wgsl */`
struct Sim { dt : f32, speed : f32, turnR : f32, count : u32 };
@group(0) @binding(0) var<uniform> sim : Sim;
@group(0) @binding(1) var<storage, read_write> posX    : array<f32>;
@group(0) @binding(2) var<storage, read_write> posY    : array<f32>;
@group(0) @binding(3) var<storage, read_write> heading : array<f32>;
@group(0) @binding(4) var<storage, read>       tgtX    : array<f32>;
@group(0) @binding(5) var<storage, read>       tgtY    : array<f32>;
@group(0) @binding(6) var<storage, read>       flags   : array<u32>;

const PI : f32 = 3.14159265359;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= sim.count) { return; }
  if ((flags[i] & 1u) == 0u) { return; }      // dead slot — skip

  let x = posX[i]; let y = posY[i];
  let dx = tgtX[i] - x; let dy = tgtY[i] - y;
  let d = max(sqrt(dx * dx + dy * dy), 1.0);

  var h = heading[i];
  var dh = atan2(dy, dx) - h;
  if (dh > PI) { dh = dh - 2.0 * PI; } else if (dh < -PI) { dh = dh + 2.0 * PI; }

  let turnR = clamp(d * 0.7, sim.turnR * 0.3, sim.turnR);
  let maxTurn = (sim.speed / turnR) * sim.dt;
  dh = clamp(dh, -maxTurn, maxTurn);
  h = h + dh;

  posX[i] = x + cos(h) * sim.speed * sim.dt;
  posY[i] = y + sin(h) * sim.speed * sim.dt;
  heading[i] = h;
}`;

function initMove(dev) {
  if (movePipeline) return;
  const module = dev.createShaderModule({ code: MOVE_SHADER });
  movePipeline = dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  simBuf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  console.log('[gpu] swarm movement pipeline ready — steerDrone banking on GPU (P1b)');
}

/** Advance every live swarm drone by `dt` game-seconds on the GPU. One compute
 *  dispatch for the whole swarm. No-op when the GPU path is off or empty. */
export function stepSwarm(dt) {
  if (!isGpuReady() || count === 0) return;
  const dev = getDevice();
  initMove(dev);
  // Clamp the per-step dt so a 40× hitch frame can't teleport drones through a
  // half-turn; matches the sim's MAX_SUBDT bound. (One step/frame is plenty
  // smooth for the swarm; sub-stepping can come later if needed.)
  const sdt = Math.min(dt, 0.1);
  dev.queue.writeBuffer(simBuf, 0, new Float32Array([sdt, DRONE_SPEED, DRONE_TURN_RADIUS, 0]));
  // count is a u32 in the struct's 4th slot — write it as a uint view.
  dev.queue.writeBuffer(simBuf, 12, new Uint32Array([count]));
  const bind = dev.createBindGroup({
    layout: movePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: simBuf } },
      { binding: 1, resource: { buffer: gbuf.posX } },
      { binding: 2, resource: { buffer: gbuf.posY } },
      { binding: 3, resource: { buffer: gbuf.heading } },
      { binding: 4, resource: { buffer: gbuf.tgtX } },
      { binding: 5, resource: { buffer: gbuf.tgtY } },
      { binding: 6, resource: { buffer: gbuf.flags } },
    ],
  });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(movePipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(Math.ceil(count / 64));
  pass.end();
  dev.queue.submit([enc.finish()]);
}

/** Retarget the WHOLE swarm to a single point (one buffer fill, not per-drone).
 *  The command-layer "strike group" handle in miniature — see the roadmap. */
export function setSwarmTarget(tx, ty) {
  if (!isGpuReady() || count === 0) return;
  const dev = getDevice();
  const fx = new Float32Array(count).fill(tx);
  const fy = new Float32Array(count).fill(ty);
  dev.queue.writeBuffer(gbuf.tgtX, 0, fx, 0, count);
  dev.queue.writeBuffer(gbuf.tgtY, 0, fy, 0, count);
}

/** The buffer set drone-render.js draws from (posX/posY/heading/owner present). */
export function swarmBuffers() { return gbuf; }
/** Live slot high-water mark (instances the renderer + compute walk). */
export function swarmCount() { return count; }
/** Reset the swarm (new game). Keeps the allocated buffers, drops the count. */
export function resetSwarm() { count = 0; }

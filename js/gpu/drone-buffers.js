// =====================================================
// Drone state as STRUCT-OF-ARRAYS GPU storage buffers — the CPU↔GPU boundary.
// See PERF_ROADMAP.md (v2): the boundary IS the design problem, not the shaders.
//
// Why SoA (one GPU buffer per field) and not AoS (one buffer of structs):
//   * coalesced GPU memory access — a compute pass that only touches x/y reads
//     two tight contiguous buffers instead of striding over a fat struct,
//   * each field uploads independently — P1 can re-upload only the fields the
//     CPU still owns (e.g. freshly-spawned target assignments) and leave the
//     GPU-owned ones (position/heading once movement is on GPU) untouched.
//
// Capacity GROWS, never caps (×1.5 on overflow) — unlimited drones is the
// whole point (過癮). P0 defines the layout + the CPU→GPU packer + a readback
// verifier; it does NOT run in the hot loop yet (that's P1). Everything here
// is a no-op unless isGpuReady() (i.e. ?gpu=1 AND the self-test passed).
// =====================================================

import { getDevice, isGpuReady } from './gpu-device.js';
import { state } from '../state.js';
import { ownerKey } from '../wasm-bridge.js';   // alias-aware faction → u8 (ally1≡player)

// targetKind enum — mirror of the JS string union ('turret'|'node'|'fleet'|null).
export const TK_NONE = 0, TK_TURRET = 1, TK_NODE = 2, TK_FLEET = 3;
// flags bitfield (room to grow: add bits, never renumber).
export const FLAG_ALIVE = 1 << 0, FLAG_LOITER = 1 << 1;

// Field groups by element type. The buffer is raw bytes either way; the type
// only governs the CPU-side staging array + how WGSL reinterprets it.
const F32_FIELDS = ['posX', 'posY', 'heading', 'hp', 'spawnT', 'tgtX', 'tgtY'];
const U32_FIELDS = ['owner', 'targetKind', 'flags', 'id'];
const I32_FIELDS = ['targetId'];               // -1 sentinel ⇒ no target; WGSL bitcasts u32→i32
const ALL_FIELDS = [...F32_FIELDS, ...U32_FIELDS, ...I32_FIELDS];

let cap = 0;                                   // current per-field element capacity
let count = 0;                                 // live drones in the last sync
const gbuf = {};                               // field name -> GPUBuffer
const cpu = {};                                // field name -> CPU staging typed array

function mkBuffer(dev, bytes) {
  return dev.createBuffer({
    // min 16 B keeps a zero-drone alloc legal; STORAGE for compute, COPY_DST
    // for writeBuffer uploads, COPY_SRC so readback/verify can copy out.
    size: Math.max(16, bytes),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
}

function allocate(n) {
  const dev = getDevice();
  cap = n;
  const make = (fields, Ctor) => {
    for (const f of fields) {
      cpu[f] = new Ctor(n);
      if (gbuf[f]) gbuf[f].destroy();
      gbuf[f] = mkBuffer(dev, n * 4);
    }
  };
  make(F32_FIELDS, Float32Array);
  make(U32_FIELDS, Uint32Array);
  make(I32_FIELDS, Int32Array);
  console.log(`[gpu] drone buffers (re)allocated — capacity ${n} (${(ALL_FIELDS.length * n * 4 / 1048576).toFixed(1)}MB across ${ALL_FIELDS.length} SoA buffers)`);
}

/** Grow capacity to hold at least n drones. No-op when GPU is off or n fits. */
export function ensureCapacity(n) {
  if (!isGpuReady()) return;
  if (n <= cap) return;
  let c = cap || 4096;
  while (c < n) c = Math.ceil(c * 1.5);
  allocate(c);
}

/** Pack every drone in state.fleets into the SoA staging arrays and upload to
 *  the GPU buffers. Returns the drone count. No-op (returns 0) when GPU is off.
 *  This is the CPU→GPU half of the boundary; P1 wires it into the loop. */
export function syncDronesToGPU() {
  if (!isGpuReady()) return 0;
  const fleets = state.fleets;
  let n = 0;
  for (let i = 0; i < fleets.length; i++) if (fleets[i].kind === 'drone') n++;
  ensureCapacity(n);
  count = n;
  if (n === 0) return 0;

  const { posX, posY, heading, hp, spawnT, tgtX, tgtY,
          owner, targetKind, flags, id, targetId } = cpu;
  let k = 0;
  for (let i = 0; i < fleets.length; i++) {
    const f = fleets[i];
    if (f.kind !== 'drone') continue;
    posX[k] = f.x; posY[k] = f.y;
    heading[k] = f.heading || 0;
    hp[k] = f.hp;
    spawnT[k] = f.spawnT || 0;
    tgtX[k] = f.tx; tgtY[k] = f.ty;
    owner[k] = ownerKey(f.owner);
    targetKind[k] = f.targetKind === 'turret' ? TK_TURRET
                  : f.targetKind === 'node'   ? TK_NODE
                  : f.targetKind === 'fleet'  ? TK_FLEET : TK_NONE;
    targetId[k] = (f.targetId === undefined || f.targetId === null) ? -1 : (f.targetId | 0);
    flags[k] = FLAG_ALIVE | (f._loitering ? FLAG_LOITER : 0);
    id[k] = f._id >>> 0;
    k++;
  }

  const dev = getDevice();
  // writeBuffer with a TypedArray: dataOffset/size are in ELEMENTS. Upload only
  // the populated prefix [0,n) — the tail of the buffer is stale but unread.
  for (const fld of ALL_FIELDS) dev.queue.writeBuffer(gbuf[fld], 0, cpu[fld], 0, n);
  return n;
}

/** Drones uploaded in the last syncDronesToGPU(). */
export function gpuDroneCount() { return count; }

/** The live GPUBuffer map (field name -> GPUBuffer) for compute passes (P1+). */
export function gpuBuffers() { return gbuf; }

/** Read one field's [0,n) prefix back to the CPU. async. Diagnostic / verify
 *  use — real passes read back only compact event buffers, never full fields. */
export async function readbackField(name, n) {
  if (!isGpuReady() || !gbuf[name] || n <= 0) return null;
  const dev = getDevice();
  const bytes = n * 4;
  const rb = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyBufferToBuffer(gbuf[name], 0, rb, 0, bytes);
  dev.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const Ctor = F32_FIELDS.includes(name) ? Float32Array
             : I32_FIELDS.includes(name) ? Int32Array : Uint32Array;
  const out = new Ctor(rb.getMappedRange().slice(0));
  rb.unmap();
  rb.destroy();
  return out;
}

/** End-to-end boundary check against LIVE game data: pack the current drones,
 *  read posX back, and confirm every uploaded x matches the JS fleet object.
 *  Proves the real CPU→GPU→CPU round trip (not just the synthetic self-test).
 *  Returns a small report object; logs PASS/FAIL. Call via window.__gpu.verify(). */
export async function verifyRoundTrip() {
  if (!isGpuReady()) { console.warn('[gpu] verify: GPU not ready'); return { ok: false, reason: 'not-ready' }; }
  const n = syncDronesToGPU();
  if (n === 0) { console.log('[gpu] verify: 0 drones airborne — spawn some (press H / let factories run), then retry'); return { ok: true, n: 0 }; }
  const back = await readbackField('posX', n);
  // Re-walk the drones in the SAME order syncDronesToGPU packed them.
  const fleets = state.fleets;
  let k = 0, bad = 0, firstBad = -1;
  for (let i = 0; i < fleets.length && k < n; i++) {
    if (fleets[i].kind !== 'drone') continue;
    if (Math.abs(back[k] - fleets[i].x) > 1e-3) { bad++; if (firstBad < 0) firstBad = k; }
    k++;
  }
  const ok = bad === 0;
  console.log(`[gpu] verify round-trip: ${n} drones, ${ok ? 'PASS ✓ all posX match' : `FAIL ✗ ${bad} mismatched (first @${firstBad})`}`);
  return { ok, n, bad, firstBad };
}

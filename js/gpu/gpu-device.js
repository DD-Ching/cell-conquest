// =====================================================
// WebGPU device bridge — P0 foundation for the GPU drone-sim rewrite.
// See PERF_ROADMAP.md (v2). This is the GPU analogue of wasm-bridge.js:
//
//   * lazy + OPT-IN: nothing runs unless the URL has ?gpu=1
//   * fail-safe: if WebGPU is missing / the adapter is denied / the device
//     is lost / the self-test fails, we DISABLE the GPU path and the game
//     keeps running on the existing CPU sim — zero behaviour change.
//   * callers gate on isGpuReady(); until the device finishes initialising
//     (a few ms after page load) every system stays on its CPU path.
//
// P0 scope = FOUNDATION ONLY. This module does NOT touch the sim. It just:
//   1. detects WebGPU + requests an adapter/device,
//   2. runs a compute ROUND-TRIP self-test (write buffer → dispatch shader →
//      copy → mapAsync readback → verify) so we KNOW the whole toolchain —
//      shader compile, bind groups, dispatch, readback — works in THIS
//      browser before P1+ build real passes on top of it,
//   3. allocates the drone struct-of-arrays buffers (drone-buffers.js).
//
// Later phases (P1 movement+render, P2 hunt, P3 combat, P4 impact) add WGSL
// compute passes over the buffers defined in drone-buffers.js. Default-on
// where supported flips ON only once P1 proves drones fly on GPU — until
// then it stays behind the flag, exactly like the Shift+W / Y / U experiments.
// =====================================================

let device = null;
let adapter = null;
let _ready = false;
let _loading = false;
let _supported = null;                       // tri-state: null=unknown
let _enabled = (typeof location !== 'undefined') &&
               new URLSearchParams(location.search).get('gpu') === '1';

/** Did the user ask for the GPU path (?gpu=1)? Distinct from "is it ready" —
 *  this stays true while the device is still initialising. */
export function gpuRequested() { return _enabled; }

/** The hard gate every GPU call site checks. False ⇒ run the CPU path. */
export function isGpuReady() { return _enabled && _ready && device !== null; }

/** The live GPUDevice (or null). Only valid when isGpuReady(). */
export function getDevice() { return device; }

/** Feature-detect WebGPU without side effects (safe to call before loadGPU). */
export function gpuSupported() {
  if (_supported !== null) return _supported;
  _supported = (typeof navigator !== 'undefined' && !!navigator.gpu);
  return _supported;
}

/** Lazy init — mirrors loadWasm(). Idempotent; never throws (catches and
 *  falls back to CPU). Call once at boot; safe even without ?gpu=1 (it just
 *  logs that the path is off and returns). */
export async function loadGPU() {
  if (!_enabled) { console.log('[gpu] disabled (add ?gpu=1 to the URL to enable)'); return; }
  if (device || _loading) return;
  if (!gpuSupported()) {
    console.warn('[gpu] navigator.gpu missing — WebGPU unsupported in this browser; CPU fallback only');
    _enabled = false;
    return;
  }
  _loading = true;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      console.warn('[gpu] requestAdapter returned null — CPU fallback only');
      _enabled = false;
      return;
    }
    device = await adapter.requestDevice();
    // If the device is ever lost (driver reset, tab backgrounded too long,
    // OOM) drop straight back to the CPU sim instead of running on a dead
    // device. _enabled stays false so we don't thrash trying to re-init.
    device.lost.then((info) => {
      console.warn('[gpu] device lost —', info.reason, info.message, '— reverting to CPU sim');
      device = null; _ready = false; _enabled = false;
    });
    // Surface validation / OOM errors loudly instead of corrupting silently.
    if (device.addEventListener) {
      device.addEventListener('uncapturederror', (e) =>
        console.error('[gpu] uncaptured error:', e.error && e.error.message || e));
    }
    const lim = device.limits;
    console.log(`[gpu] device ready — maxStorageBuffer ${(lim.maxStorageBufferBindingSize / 1048576) | 0}MB, ` +
                `maxWorkgroupsPerDim ${lim.maxComputeWorkgroupsPerDimension}, ` +
                `maxInvocations ${lim.maxComputeInvocationsPerWorkgroup}`);

    const ok = await selfTest(device);
    if (ok) {
      _ready = true;
      console.log('[gpu] self-test PASS ✓ — compute round-trip verified; GPU path ARMED (foundation only — no sim passes yet, P0)');
    } else {
      _ready = false; _enabled = false;
      console.error('[gpu] self-test FAIL ✗ — disabling GPU path, CPU fallback only');
    }
  } catch (e) {
    console.warn('[gpu] init failed — CPU fallback only', e);
    device = null; _ready = false; _enabled = false;
  } finally {
    _loading = false;
  }
}

// ---- Compute round-trip self-test -----------------------------------------
// Proves the ENTIRE machinery P1-P4 depend on: storage buffer create +
// writeBuffer upload, shader module compile, compute pipeline (layout:'auto'),
// bind group, command encoder, dispatch, buffer-to-buffer copy, MAP_READ
// readback, and mapAsync. data[i] = i  ->  shader  ->  expect i*2+1.
async function selfTest(dev) {
  let work = null, read = null;
  try {
    const N = 256, BYTES = N * 4;
    const seed = new Uint32Array(N);
    for (let i = 0; i < N; i++) seed[i] = i;

    work = dev.createBuffer({
      size: BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(work, 0, seed);

    const module = dev.createShaderModule({ code: /* wgsl */`
      @group(0) @binding(0) var<storage, read_write> data : array<u32>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        let i = gid.x;
        if (i >= arrayLength(&data)) { return; }
        data[i] = data[i] * 2u + 1u;
      }`,
    });
    const pipeline = dev.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bind = dev.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: work } }],
    });

    read = dev.createBuffer({ size: BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    enc.copyBufferToBuffer(work, 0, read, 0, BYTES);
    dev.queue.submit([enc.finish()]);

    await read.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(read.getMappedRange().slice(0));
    read.unmap();

    for (let i = 0; i < N; i++) {
      if (out[i] !== i * 2 + 1) {
        console.error(`[gpu] self-test mismatch @${i}: got ${out[i]}, want ${i * 2 + 1}`);
        return false;
      }
    }
    return true;
  } catch (e) {
    console.error('[gpu] self-test threw', e);
    return false;
  } finally {
    if (work) work.destroy();
    if (read) read.destroy();
  }
}

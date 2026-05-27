// =====================================================
// WASM bridge — lazy-loads the Rust-compiled `cell_sim` wasm module and
// exposes a small JS-friendly API. Callers gate on `isWasmReady()` and
// fall back to pure-JS paths until the wasm finishes loading (1-2 frames
// at most after page load).
//
// All wasm functions expect packed typed arrays (Float32 / Uint8) instead
// of the rich JS state objects. The packing happens here so call sites
// don't need to know wasm exists.
// =====================================================

let wasm = null;
let loading = false;

export function isWasmReady() {
  return wasm !== null;
}

export async function loadWasm() {
  if (wasm || loading) return;
  loading = true;
  try {
    // wasm-pack --target web outputs an ES module with a default-export
    // init function that fetches + instantiates the .wasm binary.
    const mod = await import('../wasm/pkg/cell_sim.js');
    await mod.default();
    wasm = mod;
    console.log('[wasm] cell_sim loaded');
  } catch (e) {
    console.warn('[wasm] load failed — JS fallback only', e);
  } finally {
    loading = false;
  }
}

// Faction owner strings ('red', 'blue', 'neutral', ...) → small u8 indices
// so they pack into Uint8Array. The mapping is built lazily and stable for
// the session — once an owner gets index k it keeps index k until reload.
const _ownerIdx = new Map();
export function ownerKey(o) {
  let v = _ownerIdx.get(o);
  if (v === undefined) {
    v = _ownerIdx.size;
    _ownerIdx.set(o, v);
  }
  return v;
}

/** Batch drone hunt-target lookup. For each drone, returns the index into
 *  `grounds` of the nearest enemy ground fleet within detectR (or -1).
 *  Returns null when wasm isn't ready; caller should fall back to JS. */
export function wasmDroneHuntTargets(drones, grounds, detectR2) {
  if (!wasm) return null;
  if (drones.length === 0 || grounds.length === 0) {
    return new Int32Array(drones.length).fill(-1);
  }
  // Pack drone arrays
  const dx = new Float32Array(drones.length);
  const dy = new Float32Array(drones.length);
  const downer = new Uint8Array(drones.length);
  for (let i = 0; i < drones.length; i++) {
    dx[i] = drones[i].x;
    dy[i] = drones[i].y;
    downer[i] = ownerKey(drones[i].owner);
  }
  // Pack ground arrays
  const gx = new Float32Array(grounds.length);
  const gy = new Float32Array(grounds.length);
  const gowner = new Uint8Array(grounds.length);
  for (let i = 0; i < grounds.length; i++) {
    gx[i] = grounds[i].x;
    gy[i] = grounds[i].y;
    gowner[i] = ownerKey(grounds[i].owner);
  }
  return wasm.drone_hunt_targets(dx, dy, downer, gx, gy, gowner, detectR2);
}

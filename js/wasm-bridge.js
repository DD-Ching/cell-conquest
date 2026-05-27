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

/** Apply per-tick tank fleet damage. Returns new units values aligned with
 *  the input `groundFleets` array order; caller writes them back and tests
 *  the < 0.5 kill threshold. tankDpsPerTick should already be multiplied
 *  by dt before calling. Returns null when wasm isn't ready. */
export function wasmTankDamageFleets(tankTurrets, groundFleets, tankRadiusSq, tankDpsPerTick) {
  if (!wasm) return null;
  if (tankTurrets.length === 0 || groundFleets.length === 0) return null;
  const tx = new Float32Array(tankTurrets.length);
  const ty = new Float32Array(tankTurrets.length);
  const to = new Uint8Array(tankTurrets.length);
  for (let i = 0; i < tankTurrets.length; i++) {
    tx[i] = tankTurrets[i].x;
    ty[i] = tankTurrets[i].y;
    to[i] = ownerKey(tankTurrets[i].owner);
  }
  const fx = new Float32Array(groundFleets.length);
  const fy = new Float32Array(groundFleets.length);
  const fo = new Uint8Array(groundFleets.length);
  const fu = new Float32Array(groundFleets.length);
  const fd = new Uint8Array(groundFleets.length);
  for (let i = 0; i < groundFleets.length; i++) {
    fx[i] = groundFleets[i].x;
    fy[i] = groundFleets[i].y;
    fo[i] = ownerKey(groundFleets[i].owner);
    fu[i] = groundFleets[i].units;
    fd[i] = groundFleets[i]._dead ? 1 : 0;
  }
  return wasm.tank_damage_fleets(tx, ty, to, fx, fy, fo, fu, fd, tankRadiusSq, tankDpsPerTick);
}

/** Apply AA saturation damage across all drones for one sim tick. Returns a
 *  Float32Array of post-tick hp values aligned with the input `drones` array
 *  order. Caller copies each value back into the drone object's hp field.
 *  Returns null when wasm isn't ready or there's nothing to do. */
export function wasmAaApplyDamage(aaTurrets, drones, aaRadiusSq, aaDps, dt) {
  if (!wasm) return null;
  if (aaTurrets.length === 0 || drones.length === 0) return null;
  // Pack AAs (only active ones — caller pre-filters)
  const ax = new Float32Array(aaTurrets.length);
  const ay = new Float32Array(aaTurrets.length);
  const ao = new Uint8Array(aaTurrets.length);
  for (let i = 0; i < aaTurrets.length; i++) {
    ax[i] = aaTurrets[i].x;
    ay[i] = aaTurrets[i].y;
    ao[i] = ownerKey(aaTurrets[i].owner);
  }
  // Pack drones
  const dx = new Float32Array(drones.length);
  const dy = new Float32Array(drones.length);
  const do_ = new Uint8Array(drones.length);
  const dhp = new Float32Array(drones.length);
  for (let i = 0; i < drones.length; i++) {
    dx[i] = drones[i].x;
    dy[i] = drones[i].y;
    do_[i] = ownerKey(drones[i].owner);
    dhp[i] = drones[i].hp;
  }
  return wasm.aa_apply_damage(ax, ay, ao, dx, dy, do_, dhp, aaRadiusSq, aaDps, dt);
}

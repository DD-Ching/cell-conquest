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
let _enabled = true;

export function isWasmReady() {
  return _enabled && wasm !== null;
}

/** Debug toggle — Shift+W in main.js flips this so you can A/B compare
 *  JS vs WASM paths live without reloading. Returns the new state. */
export function toggleWasm() {
  _enabled = !_enabled;
  console.log(`[wasm] ${_enabled ? 'ENABLED' : 'DISABLED (JS fallback)'}`);
  return _enabled;
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
// so they pack into Uint8Array. Allies share an index — this is the trick
// that lets wasm functions keep their cheap `if (owner_a == owner_b) skip`
// check while still respecting the alliance registry: ally1's drones look
// like player drones from wasm's POV, so AA/Tank fire skips them.
const _ownerIdx = new Map();
function aliasOwner(o) {
  // Hard-coded for the single player↔ally1 pact. If we ever add a more
  // dynamic alliance system, drive this from alliance.js.
  if (o === 'ally1') return 'player';
  return o;
}
export function ownerKey(o) {
  const canonical = aliasOwner(o);
  let v = _ownerIdx.get(canonical);
  if (v === undefined) {
    v = _ownerIdx.size;
    _ownerIdx.set(canonical, v);
  }
  return v;
}

// ---- Reusable packing buffers ----------------------------------------------
// The 3 wasm packers below run once per sub-step (up to ~20×/frame at high
// time-scale) over hundreds of entities. Allocating fresh Float32Array/Uint8Array
// on every call was a major GC source. Instead we keep grow-only scratch buffers
// keyed by a slot name and hand wasm-bindgen a subarray(0,n) view — the copy into
// wasm linear memory is unavoidable, but the JS-side allocation churn is gone.
// Values packed and results returned are byte-identical to the old fresh-array path.
const _f32 = new Map();
const _u8 = new Map();
function bufF32(slot, n) {
  let a = _f32.get(slot);
  if (!a || a.length < n) { a = new Float32Array(n); _f32.set(slot, a); }
  return a;
}
function bufU8(slot, n) {
  let a = _u8.get(slot);
  if (!a || a.length < n) { a = new Uint8Array(n); _u8.set(slot, a); }
  return a;
}
// Exact-length handle for the wasm call: the whole buffer when it's already the
// right size (steady state → zero allocation), else a cheap subarray view.
const view = (a, n) => (a.length === n ? a : a.subarray(0, n));

/** Batch drone hunt-target lookup. For each drone, returns the index into
 *  `grounds` of the nearest enemy ground fleet within detectR (or -1).
 *  Returns null when wasm isn't ready; caller should fall back to JS. */
export function wasmDroneHuntTargets(drones, grounds, detectR2) {
  if (!wasm) return null;
  const nd = drones.length, ng = grounds.length;
  if (nd === 0 || ng === 0) return new Int32Array(nd).fill(-1);
  // Pack drone arrays
  const dx = bufF32('hdx', nd), dy = bufF32('hdy', nd), downer = bufU8('hdo', nd);
  for (let i = 0; i < nd; i++) {
    dx[i] = drones[i].x; dy[i] = drones[i].y; downer[i] = ownerKey(drones[i].owner);
  }
  // Pack ground arrays
  const gx = bufF32('hgx', ng), gy = bufF32('hgy', ng), gowner = bufU8('hgo', ng);
  for (let i = 0; i < ng; i++) {
    gx[i] = grounds[i].x; gy[i] = grounds[i].y; gowner[i] = ownerKey(grounds[i].owner);
  }
  return wasm.drone_hunt_targets(
    view(dx, nd), view(dy, nd), view(downer, nd),
    view(gx, ng), view(gy, ng), view(gowner, ng), detectR2);
}

/** Apply per-tick tank fleet damage. Returns new units values aligned with
 *  the input `groundFleets` array order; caller writes them back and tests
 *  the < 0.5 kill threshold. tankDpsPerTick should already be multiplied
 *  by dt before calling. Returns null when wasm isn't ready. */
export function wasmTankDamageFleets(tankTurrets, groundFleets, tankRadiusSq, tankDpsPerTick) {
  if (!wasm) return null;
  if (tankTurrets.length === 0 || groundFleets.length === 0) return null;
  const nt = tankTurrets.length, nf = groundFleets.length;
  const tx = bufF32('ttx', nt), ty = bufF32('tty', nt), to = bufU8('tto', nt);
  for (let i = 0; i < nt; i++) {
    tx[i] = tankTurrets[i].x; ty[i] = tankTurrets[i].y; to[i] = ownerKey(tankTurrets[i].owner);
  }
  const fx = bufF32('tfx', nf), fy = bufF32('tfy', nf), fo = bufU8('tfo', nf);
  const fu = bufF32('tfu', nf), fd = bufU8('tfd', nf);
  for (let i = 0; i < nf; i++) {
    fx[i] = groundFleets[i].x; fy[i] = groundFleets[i].y; fo[i] = ownerKey(groundFleets[i].owner);
    fu[i] = groundFleets[i].units; fd[i] = groundFleets[i]._dead ? 1 : 0;
  }
  return wasm.tank_damage_fleets(
    view(tx, nt), view(ty, nt), view(to, nt),
    view(fx, nf), view(fy, nf), view(fo, nf), view(fu, nf), view(fd, nf),
    tankRadiusSq, tankDpsPerTick);
}

/** Apply AA saturation damage across all drones for one sim tick. Returns a
 *  Float32Array of post-tick hp values aligned with the input `drones` array
 *  order. Caller copies each value back into the drone object's hp field.
 *  Returns null when wasm isn't ready or there's nothing to do. */
export function wasmAaApplyDamage(aaTurrets, drones, aaRadiusSq, aaDps, dt) {
  if (!wasm) return null;
  if (aaTurrets.length === 0 || drones.length === 0) return null;
  // Pack AAs (only active ones — caller pre-filters)
  const na = aaTurrets.length, nd = drones.length;
  const ax = bufF32('aax', na), ay = bufF32('aay', na), ao = bufU8('aao', na);
  for (let i = 0; i < na; i++) {
    ax[i] = aaTurrets[i].x; ay[i] = aaTurrets[i].y; ao[i] = ownerKey(aaTurrets[i].owner);
  }
  // Pack drones
  const dx = bufF32('adx', nd), dy = bufF32('ady', nd), do_ = bufU8('ado', nd), dhp = bufF32('adhp', nd);
  for (let i = 0; i < nd; i++) {
    dx[i] = drones[i].x; dy[i] = drones[i].y; do_[i] = ownerKey(drones[i].owner); dhp[i] = drones[i].hp;
  }
  return wasm.aa_apply_damage(
    view(ax, na), view(ay, na), view(ao, na),
    view(dx, nd), view(dy, nd), view(do_, nd), view(dhp, nd),
    aaRadiusSq, aaDps, dt);
}

// =====================================================
// Cell Conquest — hot-loop simulation in Rust → WebAssembly.
//
// First POC port: drone hunt-target scan. For every drone, find the nearest
// enemy ground fleet within DRONE_DETECT_R. This is a tight inner loop that
// runs ~30 drones × ~50 fleets × ~1200 sim Hz at high time-scale, where JS
// engine call overhead and number-type boxing become a real cost.
//
// Data exchange: JS encodes flat Float32 / Uint8 arrays of (drone_x[],
// drone_y[], drone_owner_idx[], ground_x[], ground_y[], ground_owner_idx[])
// and passes them in. We return a Vec<i32> of "nearest enemy index per
// drone" (-1 if none). JS then applies the resulting hunt-target update
// itself — keeping wasm purely computational.
//
// Owner encoding: JS faction strings ('red', 'blue', ...) are mapped to
// small u8 indices by the JS caller before encoding. We don't care what
// the indices mean here, only that "same value == same faction".
// =====================================================

use wasm_bindgen::prelude::*;

/// For each drone, return the index of the nearest enemy ground fleet whose
/// squared distance is below `detect_r2`. Returns -1 for drones with no
/// valid target in range.
///
/// All input slices live in JS memory; wasm-bindgen passes them in via the
/// shared linear-memory buffer without an extra copy. Output is a single
/// Vec<i32> (length = drone count).
#[wasm_bindgen]
pub fn drone_hunt_targets(
    drone_x: &[f32],
    drone_y: &[f32],
    drone_owner: &[u8],
    ground_x: &[f32],
    ground_y: &[f32],
    ground_owner: &[u8],
    detect_r2: f32,
) -> Vec<i32> {
    let n = drone_x.len();
    let m = ground_x.len();
    let mut out = vec![-1i32; n];

    // No spatial grid in this POC — brute force is fast enough at the
    // entity counts we hit (and we want a clean apples-to-apples speedup
    // measurement vs JS's already-gridded path). Adding a grid here would
    // reduce inner work further if we ever push entity counts higher.
    for i in 0..n {
        let owner = drone_owner[i];
        let dxi = drone_x[i];
        let dyi = drone_y[i];
        let mut best_d2 = detect_r2;
        let mut best_idx: i32 = -1;
        for j in 0..m {
            if ground_owner[j] == owner {
                continue;
            }
            let dx = ground_x[j] - dxi;
            let dy = ground_y[j] - dyi;
            let d2 = dx * dx + dy * dy;
            if d2 < best_d2 {
                best_d2 = d2;
                best_idx = j as i32;
            }
        }
        out[i] = best_idx;
    }
    out
}

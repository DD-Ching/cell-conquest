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

use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const GRID_CELL: f32 = 250.0;

/// Spatial grid built in Rust memory. Same scheme as the JS-side grid in
/// main.simulate(): cellKey = floor(x/CELL) * 10000 + floor(y/CELL) maps to
/// the list of ground-fleet indices inside that cell. Rebuilt per call.
fn build_ground_grid(gx: &[f32], gy: &[f32]) -> HashMap<i32, Vec<u32>> {
    let mut grid: HashMap<i32, Vec<u32>> = HashMap::with_capacity(gx.len());
    for j in 0..gx.len() {
        let cx = (gx[j] / GRID_CELL).floor() as i32;
        let cy = (gy[j] / GRID_CELL).floor() as i32;
        let key = cx * 10000 + cy;
        grid.entry(key).or_default().push(j as u32);
    }
    grid
}

/// For each drone, return the index of the nearest enemy ground fleet
/// whose squared distance is below `detect_r2`. Returns -1 when no valid
/// target is in range. Uses an internal spatial grid so the inner loop
/// touches only ground fleets in the drone's local cell window.
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
    if m == 0 || n == 0 {
        return out;
    }

    let grid = build_ground_grid(ground_x, ground_y);
    let range = (detect_r2.sqrt() / GRID_CELL).ceil() as i32;

    for i in 0..n {
        let owner = drone_owner[i];
        let dxi = drone_x[i];
        let dyi = drone_y[i];
        let cx0 = (dxi / GRID_CELL).floor() as i32;
        let cy0 = (dyi / GRID_CELL).floor() as i32;
        let mut best_d2 = detect_r2;
        let mut best_idx: i32 = -1;
        for cx in (cx0 - range)..=(cx0 + range) {
            for cy in (cy0 - range)..=(cy0 + range) {
                if let Some(bucket) = grid.get(&(cx * 10000 + cy)) {
                    for &j in bucket {
                        let ju = j as usize;
                        if ground_owner[ju] == owner {
                            continue;
                        }
                        let dx = ground_x[ju] - dxi;
                        let dy = ground_y[ju] - dyi;
                        let d2 = dx * dx + dy * dy;
                        if d2 < best_d2 {
                            best_d2 = d2;
                            best_idx = j as i32;
                        }
                    }
                }
            }
        }
        out[i] = best_idx;
    }
    out
}

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

/// Apply per-tick AA damage to drones using the saturation rule:
///   each AA splits its DPS evenly across every enemy drone in range.
/// Builds a spatial grid of DRONES (vs ground fleets in `drone_hunt_targets`),
/// then per AA queries the local cell window and accumulates damage.
///
/// Inputs: AA positions + owners + radius². Drones positions + owners + hp.
/// Returns a fresh Vec<f32> of the same length as drone_hp with the post-tick
/// hp values. JS replaces each drone.hp from the returned array.
///
/// Tracers (visual-only) are NOT spawned from Rust — JS can add them back
/// stochastically with a simpler "per active AA" sweep if it wants the
/// visual; saving the cross-language calls for the every-frame draw layer.
#[wasm_bindgen]
pub fn aa_apply_damage(
    aa_x: &[f32],
    aa_y: &[f32],
    aa_owner: &[u8],
    drone_x: &[f32],
    drone_y: &[f32],
    drone_owner: &[u8],
    drone_hp: &[f32],
    aa_radius_sq: f32,
    aa_dps: f32,
    dt: f32,
) -> Vec<f32> {
    let n = drone_x.len();
    let mut new_hp = drone_hp.to_vec();
    if aa_x.is_empty() || n == 0 {
        return new_hp;
    }

    // Build drone grid keyed by AA's cell-window search.
    let mut grid: HashMap<i32, Vec<u32>> = HashMap::with_capacity(n);
    for j in 0..n {
        let cx = (drone_x[j] / GRID_CELL).floor() as i32;
        let cy = (drone_y[j] / GRID_CELL).floor() as i32;
        grid.entry(cx * 10000 + cy).or_default().push(j as u32);
    }
    let range = (aa_radius_sq.sqrt() / GRID_CELL).ceil() as i32;
    let mut in_range: Vec<u32> = Vec::with_capacity(32);

    for i in 0..aa_x.len() {
        let owner = aa_owner[i];
        let ax = aa_x[i];
        let ay = aa_y[i];
        let cx0 = (ax / GRID_CELL).floor() as i32;
        let cy0 = (ay / GRID_CELL).floor() as i32;
        in_range.clear();
        for cx in (cx0 - range)..=(cx0 + range) {
            for cy in (cy0 - range)..=(cy0 + range) {
                if let Some(bucket) = grid.get(&(cx * 10000 + cy)) {
                    for &j in bucket {
                        let ju = j as usize;
                        if drone_owner[ju] == owner {
                            continue;
                        }
                        let dx = drone_x[ju] - ax;
                        let dy = drone_y[ju] - ay;
                        if dx * dx + dy * dy <= aa_radius_sq {
                            in_range.push(j);
                        }
                    }
                }
            }
        }
        if in_range.is_empty() {
            continue;
        }
        // Saturation: DPS split across all drones currently in this AA's bubble.
        let dps_per = aa_dps / in_range.len() as f32;
        let delta = dps_per * dt;
        for &j in in_range.iter() {
            new_hp[j as usize] -= delta;
        }
    }
    new_hp
}

/// Apply per-tick tank damage to ground fleets. Each tank chips at every
/// enemy fleet inside its range — no saturation split (unlike AA, tanks
/// do full DPS to every target simultaneously). Returns new units array
/// aligned with input. JS tests post-tick `units < 0.5` to mark kills.
#[wasm_bindgen]
pub fn tank_damage_fleets(
    tank_x: &[f32],
    tank_y: &[f32],
    tank_owner: &[u8],
    fleet_x: &[f32],
    fleet_y: &[f32],
    fleet_owner: &[u8],
    fleet_units: &[f32],
    fleet_dead: &[u8],            // 1 = already dead this tick, skip
    tank_radius_sq: f32,
    tank_dps_per_tick: f32,       // pre-multiplied: TANK_DPS * 0.6 * dt
) -> Vec<f32> {
    let n = fleet_x.len();
    let mut new_units = fleet_units.to_vec();
    if tank_x.is_empty() || n == 0 {
        return new_units;
    }

    // Build ground-fleet grid (ignoring already-dead ones).
    let mut grid: HashMap<i32, Vec<u32>> = HashMap::with_capacity(n);
    for j in 0..n {
        if fleet_dead[j] != 0 {
            continue;
        }
        let cx = (fleet_x[j] / GRID_CELL).floor() as i32;
        let cy = (fleet_y[j] / GRID_CELL).floor() as i32;
        grid.entry(cx * 10000 + cy).or_default().push(j as u32);
    }
    let range = (tank_radius_sq.sqrt() / GRID_CELL).ceil() as i32;

    for i in 0..tank_x.len() {
        let owner = tank_owner[i];
        let tx = tank_x[i];
        let ty = tank_y[i];
        let cx0 = (tx / GRID_CELL).floor() as i32;
        let cy0 = (ty / GRID_CELL).floor() as i32;
        for cx in (cx0 - range)..=(cx0 + range) {
            for cy in (cy0 - range)..=(cy0 + range) {
                if let Some(bucket) = grid.get(&(cx * 10000 + cy)) {
                    for &j in bucket {
                        let ju = j as usize;
                        if fleet_owner[ju] == owner {
                            continue;
                        }
                        let dx = fleet_x[ju] - tx;
                        let dy = fleet_y[ju] - ty;
                        if dx * dx + dy * dy > tank_radius_sq {
                            continue;
                        }
                        new_units[ju] -= tank_dps_per_tick;
                    }
                }
            }
        }
    }
    new_units
}

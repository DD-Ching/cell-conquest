/* tslint:disable */
/* eslint-disable */

/**
 * Apply per-tick AA damage to drones using the saturation rule:
 *   each AA splits its DPS evenly across every enemy drone in range.
 * Builds a spatial grid of DRONES (vs ground fleets in `drone_hunt_targets`),
 * then per AA queries the local cell window and accumulates damage.
 *
 * Inputs: AA positions + owners + radius². Drones positions + owners + hp.
 * Returns a fresh Vec<f32> of the same length as drone_hp with the post-tick
 * hp values. JS replaces each drone.hp from the returned array.
 *
 * Tracers (visual-only) are NOT spawned from Rust — JS can add them back
 * stochastically with a simpler "per active AA" sweep if it wants the
 * visual; saving the cross-language calls for the every-frame draw layer.
 */
export function aa_apply_damage(aa_x: Float32Array, aa_y: Float32Array, aa_owner: Uint8Array, drone_x: Float32Array, drone_y: Float32Array, drone_owner: Uint8Array, drone_hp: Float32Array, aa_radius_sq: number, aa_dps: number, dt: number): Float32Array;

/**
 * For each drone, return the index of the nearest enemy ground fleet
 * whose squared distance is below `detect_r2`. Returns -1 when no valid
 * target is in range. Uses an internal spatial grid so the inner loop
 * touches only ground fleets in the drone's local cell window.
 */
export function drone_hunt_targets(drone_x: Float32Array, drone_y: Float32Array, drone_owner: Uint8Array, ground_x: Float32Array, ground_y: Float32Array, ground_owner: Uint8Array, detect_r2: number): Int32Array;

/**
 * Apply per-tick tank damage to ground fleets. Each tank chips at every
 * enemy fleet inside its range — no saturation split (unlike AA, tanks
 * do full DPS to every target simultaneously). Returns new units array
 * aligned with input. JS tests post-tick `units < 0.5` to mark kills.
 */
export function tank_damage_fleets(tank_x: Float32Array, tank_y: Float32Array, tank_owner: Uint8Array, fleet_x: Float32Array, fleet_y: Float32Array, fleet_owner: Uint8Array, fleet_units: Float32Array, fleet_dead: Uint8Array, tank_radius_sq: number, tank_dps_per_tick: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly aa_apply_damage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => void;
    readonly drone_hunt_targets: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => void;
    readonly tank_damage_fleets: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

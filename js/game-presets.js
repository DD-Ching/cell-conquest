// =====================================================
// Game-mode presets — `?preset=skirmish|standard|long|kingofthehill`.
//
// Pattern (mirrors `?renderWorker=1`):
//   1. main.js parses ?preset=NAME at boot.
//   2. main.js calls applyPreset(name) BEFORE newGame().
//   3. applyPreset mutates the small set of `let`-exported constants in
//      config.js that govern world size + node count. Because ES modules
//      use live bindings, every consumer (world.js, camera.js, render-*,
//      main.js's own `import { WORLD_W }`) picks up the new value the
//      next time it reads the import — no need to plumb args anywhere.
//
// Why not pass a preset object through newGame()? Half the consumers
// (camera clamp, minimap remap, render-world frustum, scorch buffer
// alloc, …) read the constants at call sites scattered across 7 modules.
// Mutating four bindings vs. plumbing four arguments through ~30 sites
// is the smaller diff by an order of magnitude.
//
// Known limitations
//   - render-worker.js is loaded into its OWN module graph (a worker is
//     a separate JS realm), so its WORLD_W/WORLD_H imports are frozen at
//     the values config.js had when the worker booted. If the user
//     combines `?preset=long&renderWorker=1`, the worker's scorch
//     OffscreenCanvas will be sized for the DEFAULT world, not the
//     preset's. Detected at applyPreset() — we log a warning and
//     continue (the game still runs; only the worker scorch buffer is
//     off).
//   - ai-worker.js does NOT import WORLD_W/N_NODES_*, so it's unaffected.
//   - Once a preset is applied, it's sticky for the rest of the session.
//     R-to-restart uses the same constants. To reset, drop the URL flag
//     and reload.
//
// Adding a new preset: extend the PRESETS table below. To override a
// DIFFERENT config constant, switch its export in config.js from `const`
// to `let` and add a setter; then update the preset entries here.
// =====================================================
import {
  WORLD_W, WORLD_H, N_NODES_MIN, N_NODES_MAX,
  setWorldDims, setNodeRange,
} from './config.js';

// Each preset is a partial override: missing keys keep the config.js
// default. `standard` is identity (no-op) so applyPreset('standard') is
// safe and explicit. Values are chosen by scaling around the current
// 12000×9000 / 700–900-node defaults.
const PRESETS = {
  // No-op. Documents the "do nothing" branch explicitly.
  standard: {},

  // Small, fast: ~5-min skirmish on a single screen-worth of world.
  // Few enough nodes that the player can keep the whole map in their head.
  skirmish: {
    WORLD_W: 1800,
    WORLD_H: 1400,
    N_NODES_MIN: 12,
    N_NODES_MAX: 18,
  },

  // Sprawling theatre: half the linear scale of the default but DENSER
  // node-per-area so cross-map travel matters AND there's lots to fight
  // over. ~60-80 nodes on a 6000×4500 map ≈ one node per 340k px²
  // (vs. default's 180k px²/node — a bit sparser, intentional for
  // longer travel times).
  long: {
    WORLD_W: 6000,
    WORLD_H: 4500,
    N_NODES_MIN: 60,
    N_NODES_MAX: 80,
  },

  // King-of-the-Hill: medium map with DENSE node packing around a
  // (TODO) forced central super-hub. For this unit, we ship the
  // dense-medium scaffolding; the "one giant central hub" gameplay
  // needs hooks in world.js's adjustHubSizes / placeNodes which we
  // intentionally don't touch here.
  // TODO(next): add `centralHub: true` to PRESETS and a corresponding
  // post-placeNodes pass in world.js that grafts an oversized node at
  // (WORLD_W/2, WORLD_H/2), then re-runs road k-NN.
  kingofthehill: {
    WORLD_W: 4500,
    WORLD_H: 3500,
    N_NODES_MIN: 30,
    N_NODES_MAX: 40,
  },
};

/** Apply a preset by name. No-op (and silent) for missing/unknown
 *  presets so `?preset=` typos don't crash boot — just falls back to
 *  the config.js defaults. Returns the name of the preset that was
 *  actually applied (or 'standard' if nothing matched). */
export function applyPreset(name) {
  const key = String(name || 'standard').toLowerCase();
  const preset = PRESETS[key];
  if (!preset) {
    console.log(`[preset] unknown preset "${name}" — using standard defaults`);
    return 'standard';
  }
  // Standard = identity; nothing to do, but still log so the player
  // sees confirmation when they pass ?preset=standard explicitly.
  if (key === 'standard' || Object.keys(preset).length === 0) {
    console.log('[preset] standard (no overrides)');
    return 'standard';
  }
  // Dim overrides go through the setter so the let binding actually
  // re-binds (a direct assignment from this module wouldn't reach
  // config.js's binding).
  const newW = preset.WORLD_W ?? WORLD_W;
  const newH = preset.WORLD_H ?? WORLD_H;
  if (newW !== WORLD_W || newH !== WORLD_H) setWorldDims(newW, newH);
  const newMin = preset.N_NODES_MIN ?? N_NODES_MIN;
  const newMax = preset.N_NODES_MAX ?? N_NODES_MAX;
  if (newMin !== N_NODES_MIN || newMax !== N_NODES_MAX) setNodeRange(newMin, newMax);
  // Warn if the user combined a world-dim preset with the render
  // worker — render-worker.js's module graph is frozen separately and
  // won't see the dim change. Game still runs; scorch buffer is just
  // sized wrong.
  const wantWorker = typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('renderWorker') === '1';
  if (wantWorker && (newW !== 12000 || newH !== 9000)) {
    console.warn('[preset] WORLD dims overridden AND ?renderWorker=1 — ' +
      'the render worker\'s scorch buffer will be sized for defaults, ' +
      'not the preset. Drop ?renderWorker=1 for fully consistent behavior.');
  }
  console.log(
    `[preset] ${key}: WORLD ${newW}×${newH}, nodes ${newMin}-${newMax}`,
  );
  return key;
}

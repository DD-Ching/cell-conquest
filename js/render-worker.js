// =====================================================
// Render Worker — owns the OffscreenCanvas and runs the world-render
// pipeline off the main thread. Late-game render cost (800 nodes, ~300
// turrets, ~600 drones, thousands of particles) used to compete with sim
// for the main-thread budget; offloading to a worker lets sim + render
// run in parallel, dropping frame time to ≈ max(sim, render) instead of
// sum.
//
// Lifecycle:
//   1. Bridge transfers the game canvas via transferControlToOffscreen.
//      We stash it in state.canvas / state.ctx so the existing render
//      modules find it where they expect.
//   2. Bridge sends `loadAssets` so the worker pulls its own ImageBitmap
//      copies of the sprite PNGs (Workers have no Image global, so
//      sprites.js dispatches between Image() and createImageBitmap()
//      automatically).
//   3. Bridge sends `terrain` once after newGame — the terrain array is
//      generated on main thread (random rocks/craters/sand) but baked
//      here so state.bakedTerrain lives in worker memory.
//   4. Every frame, bridge sends a `snapshot` with all the live data
//      render() reads. We hydrate state and call render() exactly like
//      the main-thread path would.
//
// HUD / minimap / mouse input all stay main-thread; the worker only
// owns the world canvas. groundScorch is created HERE (worker-owned)
// since spawnScorch events ride along in the snapshot.
//
// NB: workers get a SEPARATE module-graph instance of every import —
// `state` here is independent from the main thread's `state`.
// =====================================================
import { state } from './state.js';
import { render, bakeTerrain, makeSnow, updateSnow, updateParticles } from './render.js';
import { loadAssets } from './sprites.js';
import { WORLD_W, WORLD_H } from './config.js';

const GRID_CELL = 250;

/** Set up the worker-side groundScorch canvas (matches main.js newGame
 *  setup). spawnScorch and bake-on-expire happen in the snapshot stream:
 *  bridge ships any new scorches each frame so they accumulate here. */
function ensureGroundScorch() {
  if (state.groundScorch) return;
  state.groundScorch = new OffscreenCanvas(Math.floor(WORLD_W / 2), Math.floor(WORLD_H / 2));
  state.groundScorchCtx = state.groundScorch.getContext('2d');
}

/** Apply the per-frame snapshot to the worker's state mirror. We don't
 *  rebuild caches here (turretById etc.) — render() doesn't query them,
 *  it iterates the raw arrays. */
function hydrate(snap) {
  state.elapsed   = snap.elapsed;
  state.paused    = snap.paused;
  state.cameraX   = snap.cameraX;
  state.cameraY   = snap.cameraY;
  state.zoom      = snap.zoom;
  state.W         = snap.W;
  state.H         = snap.H;
  state.timeScale = snap.timeScale;

  state.nodes     = snap.nodes;
  state.adj       = new Map(snap.adj.map(([id, neighbors]) => [id, new Set(neighbors)]));
  state.turrets   = snap.turrets;
  state.fleets    = snap.fleets;
  state.roads     = snap.roads;
  state.edgeData  = new Map(snap.edgeData);

  state.particles = snap.particles;
  state.dust      = snap.dust;
  state.tracers   = snap.tracers;
  state.shells    = snap.shells;
  state.scorches  = snap.scorches;

  // UI state for overlays (drag preview, placement preview, salvo marker)
  state.selectedIds = new Set(snap.selectedIds);
  state.drag        = snap.drag;
  state.placeMode   = snap.placeMode;
  state.holdFire    = snap.holdFire;
  state.salvoTarget = snap.salvoTarget;
  state.mousePos    = snap.mousePos;
  state.painting    = snap.painting;

  // Rebuild the turretGrid the way main.js simulate() does — drawTurrets'
  // aim-scan uses state.turretGrid + state.groundFleetGrid to find targets
  // for tank/artillery aim, and we want those visuals to match main.
  state.turretGrid.clear();
  for (const t of state.turrets) {
    const gKey = Math.floor(t.x / GRID_CELL) * 10000 + Math.floor(t.y / GRID_CELL);
    let gBucket = state.turretGrid.get(gKey);
    if (!gBucket) { gBucket = []; state.turretGrid.set(gKey, gBucket); }
    gBucket.push(t);
  }
  state.groundFleetGrid.clear();
  for (const f of state.fleets) {
    if (f.kind === 'drone') continue;
    const fKey = Math.floor(f.x / GRID_CELL) * 10000 + Math.floor(f.y / GRID_CELL);
    let bucket = state.groundFleetGrid.get(fKey);
    if (!bucket) { bucket = []; state.groundFleetGrid.set(fKey, bucket); }
    bucket.push(f);
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      // Take ownership of the transferred OffscreenCanvas. The main thread's
      // <canvas id="game"> still exists in the DOM (for event binding) but
      // its drawing surface now lives here.
      state.canvas = msg.canvas;
      state.ctx    = state.canvas.getContext('2d');
      state.canvas.width  = msg.W;
      state.canvas.height = msg.H;
      state.W = msg.W;
      state.H = msg.H;
      loadAssets();
      ensureGroundScorch();
      // Build dust now — needs state.W / state.H.
      makeSnow();
      self.postMessage({ type: 'ready' });
      return;
    }

    case 'resize': {
      state.W = msg.W;
      state.H = msg.H;
      if (state.canvas) {
        state.canvas.width  = msg.W;
        state.canvas.height = msg.H;
      }
      makeSnow();
      return;
    }

    case 'terrain': {
      // Main thread shipped state.terrain (generated by placeTerrain). Try
      // to bake on the worker; if bakeTerrain in the cached render-atmosphere
      // module hits `document is not defined` (older module not picked up due
      // to browser cache pinning the static import chain), we just skip. The
      // ground renders as a plain backdrop without rocks/craters — a small
      // visual sacrifice for MVP.
      state.terrain = msg.terrain;
      try { bakeTerrain(); }
      catch (e) { console.warn('[render-worker] bakeTerrain skipped:', e.message); }
      return;
    }

    case 'newGame': {
      // Reset worker-side scorch / dust / particles before the first snapshot
      // of the new game arrives.
      state.scorches = [];
      state.particles = [];
      if (state.groundScorchCtx) {
        state.groundScorchCtx.clearRect(0, 0, state.groundScorch.width, state.groundScorch.height);
      }
      makeSnow();
      return;
    }

    case 'frame': {
      hydrate(msg.snapshot);
      // Step ambient particles + dust ourselves — these are visual-only,
      // so the worker can advance them without main-thread coordination.
      // (Main thread still maintains its own copies for the case where
      // user toggles worker render off; harmless duplicate work.)
      updateParticles(msg.dt || 0);
      updateSnow(msg.dt || 0);
      render();
      return;
    }
  }
}

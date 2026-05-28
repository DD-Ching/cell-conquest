// =====================================================
// Main-thread proxy for the Render Worker.
//
// What stays main-thread:
//   - HUD (DOM rows for faction roster + timer/zoom/speed/perf)
//   - Minimap (small dedicated canvas, cheap)
//   - Input handling (pointer events on the <canvas> element — even after
//     transferControlToOffscreen the DOM node still exists, so listeners
//     keep firing)
//   - sim / AI / combat / drones — completely unchanged
//
// What moves to the worker:
//   - The world canvas — terrain, scorches, roads, wrecks, nets, shells,
//     tracers, fleet trails, range rings, nodes, turrets, troop columns,
//     drone sprites, particles, drag preview, salvo marker, top-layer
//     node labels.
//
// Per-frame protocol: main thread builds a slim snapshot of everything
// render() reads and postMessages it. The worker hydrates + renders. The
// snapshot is shallow-cloned (structuredClone via postMessage) — at ~800
// nodes + ~300 turrets + ~600 fleets + ~1000 particles late-game the
// payload sits around 80–150 KB, ~3–10 ms to clone, vs. the ~30 ms of
// canvas work we save by moving render off main.
//
// `transferControlToOffscreen` is one-way: once called, the main canvas
// can't be drawn on again. We capture both <canvas> elements on enable;
// disable currently requires a page reload (a TODO if it becomes
// painful).
// =====================================================
import { state } from './state.js';
import {
  sliceNodes, sliceTurrets, sliceFleets, sliceAdj, sliceEdgeData,
} from './snapshot-utils.js';

let worker = null;
let workerReady = false;
let enabled = false;
let pendingTerrain = false;
let lastFrameT = 0;

/** Has the canvas been transferred to the worker? Returns true as soon as
 *  enable() succeeds (BEFORE the worker has finished init). Main loop uses
 *  this to know "skip render() — main no longer owns the canvas". */
export function isEnabled() { return enabled; }
/** Worker has finished init + first frame can be dispatched. Different
 *  signal from isEnabled — that's the canvas-ownership flag. */
export function isReady() { return enabled && workerReady; }

function onWorkerMessage(e) {
  if (e.data && e.data.type === 'ready') workerReady = true;
}

/** Turn the worker on. ONE-WAY: the main game canvas is transferred and
 *  can't be drawn on by main thread again. Returns true on success. */
export function enable() {
  if (enabled) return true;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ||
      typeof state.canvas.transferControlToOffscreen !== 'function') {
    console.warn('[render-worker] browser lacks OffscreenCanvas support');
    return false;
  }
  try {
    worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (err) => {
      // Worker crashed. We CAN'T fall back to main-thread render because
      // transferControlToOffscreen is one-way — the main canvas has no
      // drawable context anymore. Keep `enabled` true so main skips
      // render(), but clear `workerReady` so snapshots stop queueing.
      // The screen freezes on the last rendered frame; user sees the
      // console error and reloads.
      console.error('[render-worker] crashed (reload to recover):', err.message);
      workerReady = false;
    };
    const offscreen = state.canvas.transferControlToOffscreen();
    worker.postMessage({
      type: 'init',
      canvas: offscreen,
      W: state.W, H: state.H,
    }, [offscreen]);
    enabled = true;
    state.renderInWorker = true;
    pendingTerrain = true;        // ship terrain on next frame, once it's baked
    return true;
  } catch (e) {
    console.error('[render-worker] enable failed:', e);
    worker = null; enabled = false; state.renderInWorker = false;
    return false;
  }
}

/** Forward a resize so the worker resizes its OffscreenCanvas. Main thread
 *  doesn't update canvas.width/height itself once transferred. */
export function notifyResize(W, H) {
  if (!enabled || !worker) return;
  worker.postMessage({ type: 'resize', W, H });
}

/** Called from newGame after placeTerrain so the worker bakes its copy. */
export function notifyNewGame() {
  if (!enabled || !worker) return;
  worker.postMessage({ type: 'newGame' });
  pendingTerrain = true;
}

/** Build the per-frame snapshot. Slim by design — only what render()
 *  actually reads. Skips heavy state (turretById caches, fleetById, etc.
 *  which render() doesn't query). The per-entity slicing rules live in
 *  snapshot-utils.js so this bridge + ai-worker-bridge share the same
 *  field-picking logic. Render needs all neutrals (they're drawn) so we
 *  pass includeNeutral: true (the default). */
function buildSnapshot() {
  return {
    elapsed:   state.elapsed,
    paused:    state.paused,
    timeScale: state.timeScale,
    cameraX:   state.cameraX,
    cameraY:   state.cameraY,
    zoom:      state.zoom,
    W:         state.W,
    H:         state.H,

    nodes:    sliceNodes(state.nodes),
    adj:      sliceAdj(state.adj),
    turrets:  sliceTurrets(state.turrets),
    fleets:   sliceFleets(state.fleets),
    roads:    state.roads,
    edgeData: sliceEdgeData(state.edgeData, 'render'),

    particles: state.particles,
    dust:      state.dust,
    dustFar:   state.dustFar,         // background parallax dust layer
    weather:   state.weather,         // Mars weather state (main thread owns the lerp)
    tracers:   state.tracers,
    shells:    state.shells,
    scorches:  state.scorches,

    selectedIds: Array.from(state.selectedIds),
    drag:        state.drag,
    placeMode:   state.placeMode,
    holdFire:    state.holdFire,
    salvoTarget: state.salvoTarget,
    mousePos:    state.mousePos,
    painting:    state.painting,
  };
}

/** Called from the main loop EVERY frame instead of render(). Posts a
 *  fresh snapshot to the worker so it can render. */
export function tickFrame() {
  // Gate on workerReady too — until the worker reports ready, our snapshot
  // is just queueing in the postMessage buffer. Main loop already gated on
  // isEnabled() (canvas transferred) so we know main isn't rendering.
  if (!enabled || !workerReady) return;
  const now = performance.now();
  const dt = lastFrameT ? (now - lastFrameT) / 1000 : 0;
  lastFrameT = now;

  // Ship terrain once it's baked. The terrain array is what placeTerrain
  // generates; the worker re-bakes the texture from it.
  if (pendingTerrain && state.terrain && state.terrain.length > 0) {
    worker.postMessage({ type: 'terrain', terrain: state.terrain });
    pendingTerrain = false;
  }

  worker.postMessage({ type: 'frame', snapshot: buildSnapshot(), dt });
}

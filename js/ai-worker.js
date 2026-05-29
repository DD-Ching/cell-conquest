// =====================================================
// Web Worker — runs aiTick off the main thread.
//
// Lifecycle (see AI_WORKER_BLUEPRINT.md):
//   1. Main thread posts a `tick` message every ~100 ms with a snapshot of
//      sim state (nodes, turrets, fleets, adj, AI control state, …) and
//      the list of owners the worker should tick this batch.
//   2. Worker hydrates its private `state` mirror (this module has its own
//      module instance of state.js — separate from the main thread's),
//      rebuilds derived per-tick caches (turretById / turretsByOwner /
//      turretsByType / inboundDronesByTarget / strippedOwners) the same
//      way main.js's simulate() does, and calls aiTick for each owner.
//   3. Every effect (sendFleet / placeTurretAt / …) goes through the
//      ctx.* facade injected by ai-effects.js: each call mutates the
//      worker's local mirror AND pushes an action descriptor into
//      ctx.actions. We collect all owners' actions, plus the post-tick
//      AI control-state, and post the bundle back.
//   4. Bridge re-applies actions against the main thread's authoritative
//      state via the real sendFleet/etc.
//
// The worker NEVER touches the DOM. It imports state.js, ai.js, and the
// transitive deps (fleets, engineering, drones, nn). nn.js's DOM-touching
// code only runs inside nnLoad(), which the worker never calls, so the
// import is safe. We also skip NN owners (their tick stays main-thread).
// =====================================================
import { state } from './state.js';
import { inboundKey } from './util.js';
import { aiTick } from './ai.js';
import { resetAlliances, setAlly } from './alliance.js';
import { factionStats, AIS } from './factions.js';

const GRID_CELL = 250;

/** Replace this module's `state.*` collections with the snapshot's data.
 *  Pure copy — no derived caches yet, those are rebuilt in rebuildCaches(). */
function hydrate(snap) {
  state.elapsed = snap.elapsed;

  // --- Nodes (rebuild as plain objects; adj is rebuilt below) ---
  state.nodes = snap.nodes;

  // Adjacency: arrays in transit, Sets in memory (matches main.js).
  state.adj = new Map();
  for (const [id, neighbors] of snap.adj) {
    state.adj.set(id, new Set(neighbors));
  }

  state.turrets = snap.turrets;
  state.fleets  = snap.fleets;
  state.roads   = snap.roads;

  state.edgeData = new Map(snap.edgeData);

  // AI control state — assign-into-existing so any stale entries are
  // overwritten cleanly. Sets/objects are fresh from postMessage.
  state.aiHoldFire    = snap.aiHoldFire;
  state.aiSalvoT0     = snap.aiSalvoT0;
  state.aiSalvoTarget = snap.aiSalvoTarget;
  state.aiFocus       = snap.aiFocus;
  state.aiTimers      = snap.aiTimers;
  state.aiMetrics     = snap.aiMetrics;
  state.strippedOwners = new Set(snap.strippedOwners);

  // Faction roster — AIS / factionStats can change mid-game when a base
  // is delegated to the lieutenant (ally1 self-registers). Mirror these
  // arrays/objects in-place so the worker's imports see the same membership
  // the main thread saw at snapshot time.
  AIS.length = 0;
  for (const a of snap.AIS) AIS.push(a);
  for (const id of Object.keys(snap.factionStats)) {
    factionStats[id] = snap.factionStats[id];
  }
  // Alliances: rebuild so isAlly() returns the right answer in worker context.
  resetAlliances();
  for (const [a, b] of snap.alliances) setAlly(a, b);
}

/** Rebuild the per-tick lookup caches that aiTick reads through.
 *  Mirrors the top-of-simulate() block in main.js. */
function rebuildCaches() {
  state.turretById.clear();
  state.turretsByOwner.clear();
  state.turretsByType.clear();
  state.turretGrid.clear();
  for (const t of state.turrets) {
    state.turretById.set(t.id, t);
    let oBucket = state.turretsByOwner.get(t.owner);
    if (!oBucket) { oBucket = []; state.turretsByOwner.set(t.owner, oBucket); }
    oBucket.push(t);
    let tBucket = state.turretsByType.get(t.type);
    if (!tBucket) { tBucket = []; state.turretsByType.set(t.type, tBucket); }
    tBucket.push(t);
    const gKey = Math.floor(t.x / GRID_CELL) * 10000 + Math.floor(t.y / GRID_CELL);
    let gBucket = state.turretGrid.get(gKey);
    if (!gBucket) { gBucket = []; state.turretGrid.set(gKey, gBucket); }
    gBucket.push(t);
  }
  state.fleetById.clear();
  state.droneGrid.clear();
  state.groundFleetGrid.clear();
  state.droneCountByOwner.clear();
  state.inboundDronesByTarget.clear();
  for (const f of state.fleets) {
    state.fleetById.set(f._id, f);
    const fKey = Math.floor(f.x / GRID_CELL) * 10000 + Math.floor(f.y / GRID_CELL);
    if (f.kind === 'drone') {
      let bucket = state.droneGrid.get(fKey);
      if (!bucket) { bucket = []; state.droneGrid.set(fKey, bucket); }
      bucket.push(f);
      state.droneCountByOwner.set(f.owner, (state.droneCountByOwner.get(f.owner) || 0) + 1);
      if (f.targetKind && f.targetId !== undefined) {
        const tKey = inboundKey(f.targetKind, f.targetId);
        state.inboundDronesByTarget.set(tKey, (state.inboundDronesByTarget.get(tKey) || 0) + 1);
      }
    } else {
      let bucket = state.groundFleetGrid.get(fKey);
      if (!bucket) { bucket = []; state.groundFleetGrid.set(fKey, bucket); }
      bucket.push(f);
    }
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    // No persistent state needed yet — each tick rehydrates fully. Kept as
    // a hook so the bridge can ship constants later (e.g. NN_OWNERS) without
    // protocol changes.
    self.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type !== 'tick') return;

  const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

  hydrate(msg.snapshot);
  rebuildCaches();

  // Collect actions from every owner the bridge asked us to tick.
  // ai.aiTick returns the actions array populated by the effects facade.
  const allActions = [];
  for (const owner of msg.tickOwners) {
    const actions = aiTick(owner, msg.dt);
    if (actions && actions.length) {
      for (const a of actions) allActions.push(a);
    }
  }

  const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

  self.postMessage({
    type: 'actions',
    actions: allActions,
    // Echo back AI control state — the worker mutated these in its mirror
    // and the main thread needs to mirror the changes so its own copy stays
    // authoritative for the next snapshot round-trip.
    aiHoldFire:    state.aiHoldFire,
    aiSalvoT0:     state.aiSalvoT0,
    aiSalvoTarget: state.aiSalvoTarget,
    aiFocus:       state.aiFocus,
    aiTimers:      state.aiTimers,
    aiMetrics:     state.aiMetrics,
    workerMs:      t1 - t0,
  });
};

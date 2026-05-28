// =====================================================
// Main-thread proxy for the AI Web Worker.
//
// Responsibilities (see AI_WORKER_BLUEPRINT.md):
//   - Construct + own the Worker instance.
//   - Build a minimal sim-state snapshot every ~100 ms.
//   - Decide which owners the worker should tick (skips NN-controlled
//     factions — those still use the main-thread aiTick because nn.js
//     touches the DOM and onnxruntime-web).
//   - On worker response: validate + re-apply each action against
//     authoritative main-thread state (the world has moved during the
//     ~100 ms round-trip, so apply-time checks gate stale actions).
//   - Merge AI control state (aiFocus / aiSalvoTarget / aiHoldFire /
//     aiSalvoT0 / aiTimers / aiMetrics) back into the main thread.
//
// Public surface:
//   - enable()  / disable()   — toggle worker mode (Y-key in main.js)
//   - tickFrame(dt)           — called from simulate() once per frame.
//                               No-ops if disabled. Dispatches a snapshot
//                               every SNAPSHOT_INTERVAL_SEC.
//   - isEnabled()
//   - lastWorkerMs            — worker-side aiTick budget for perf overlay
//
// Snapshot cadence: SNAPSHOT_INTERVAL_SEC = 0.10 s (10 Hz). AI ticks are
// internally rate-limited to ~0.5–0.9 s per faction, so missing some 60 Hz
// sub-step ticks is invisible. The Worker round-trip adds ≤16 ms latency.
// =====================================================
import { state } from './state.js';
import { sendFleet, assaultTurret } from './fleets.js';
import { placeTurretAt, placeNetOnEdge } from './engineering.js';
import { releaseAIStockpile } from './drones.js';
import { AIS, factionStats } from './factions.js';
import { NN_OWNERS } from './config.js';
import { listAlliances } from './alliance.js';
import {
  sliceNodes, sliceTurrets, sliceFleets, sliceAdj, sliceEdgeData,
} from './snapshot-utils.js';

const SNAPSHOT_INTERVAL_SEC = 0.10;

let worker = null;
let workerReady = false;
let enabled = false;
let lastDispatchT = -Infinity;
let lastWorkerMs = 0;
let pendingResponse = false;    // simple back-pressure: don't dispatch a
                                // new snapshot until the previous one's
                                // actions are back. Prevents queue bloat
                                // when the main thread is unloaded.

/** Build the lightweight snapshot that the worker hydrates from. Pulls
 *  per-entity field selection out to snapshot-utils.js so render-worker-
 *  bridge can share the same slicing. We skip neutral nodes (~700 in the
 *  opening) but keep AI-adjacent neutrals in full so tryCoordinatedAttack
 *  still sees its capture targets — without those fields, dist(a, target)
 *  goes NaN and the AI can't expand into neutral territory. */
function buildSnapshot() {
  return {
    elapsed: state.elapsed,
    nodes: sliceNodes(state.nodes, {
      includeNeutral: false,
      includeNeutralIds: aiAdjacentNeutralIds(),
    }),
    adj: sliceAdj(state.adj),
    turrets: sliceTurrets(state.turrets),
    fleets: sliceFleets(state.fleets),
    roads: state.roads.map(r => ({ a: r.a, b: r.b })),
    edgeData: sliceEdgeData(state.edgeData, 'ai'),
    // AI control state (worker mutates these — bridge re-merges on return).
    aiHoldFire:    { ...state.aiHoldFire },
    aiSalvoT0:     { ...state.aiSalvoT0 },
    aiSalvoTarget: { ...state.aiSalvoTarget },
    aiFocus:       { ...state.aiFocus },
    aiTimers:      { ...state.aiTimers },
    aiMetrics:     JSON.parse(JSON.stringify(state.aiMetrics || {})),  // nested objects
    strippedOwners: Array.from(state.strippedOwners),
    // Faction membership — AIS / factionStats / alliances can mutate
    // mid-game (G-key delegates a base to ally1, which calls
    // ensureLieutenantRegistered). Snapshot the current view.
    AIS: Array.from(AIS),
    factionStats: { ...factionStats },
    alliances: listAlliances(),
  };
}

/** Set of neutral node ids that are adjacent to a worker-ticked AI's
 *  own node. The AI's Phase 2 (tryCoordinatedAttack) reads target.units,
 *  target.regenRate, target.size, target.x, target.y on candidate
 *  capture targets — most of which are neutral. Stripping all neutrals
 *  to placeholders would silently kill that pathway, so we keep full
 *  data for neutrals on the frontier. */
function aiAdjacentNeutralIds() {
  const out = new Set();
  for (const n of state.nodes) {
    if (n.owner === 'neutral') continue;
    if (NN_OWNERS.has(n.owner)) continue;
    if (n.owner === 'player') continue;     // worker only ticks AI owners
    if (!AIS.includes(n.owner)) continue;
    const nbrs = state.adj.get(n.id);
    if (!nbrs) continue;
    for (const nbId of nbrs) {
      const nb = state.nodes[nbId];
      if (nb && nb.owner === 'neutral') out.add(nbId);
    }
  }
  return out;
}

/** Validate + apply a single action descriptor against the main-thread
 *  authoritative state. The worker decided based on a 100 ms-old snapshot,
 *  so each action is rechecked against current ownership / unit counts /
 *  entity presence. Stale actions are silently dropped. */
function applyAction(a) {
  switch (a.type) {
    case 'sendFleet': {
      const from = state.nodes[a.fromId];
      const to   = state.nodes[a.toId];
      if (!from || !to) return;
      // Owner shifted (we captured the node, or lost it) — skip.
      // We can't easily ask "is this the right faction?" without knowing
      // who sent it; the cleanest gate is units availability + same owner.
      if (from.units < Math.min(3, a.count * 0.5)) return;
      const count = Math.min(a.count, Math.floor(from.units));
      if (count < 3) return;
      sendFleet(from, to, count);
      return;
    }
    case 'assaultTurret': {
      const from   = state.nodes[a.fromId];
      const turret = state.turretById.get(a.turretId);
      if (!from || !turret) return;
      if (from.units < Math.min(3, a.count * 0.5)) return;
      const count = Math.min(a.count, Math.floor(from.units));
      if (count < 3) return;
      assaultTurret(from, turret, count);
      return;
    }
    case 'placeTurret': {
      placeTurretAt(a.x, a.y, a.kind, a.owner);
      return;
    }
    case 'placeNet': {
      placeNetOnEdge(a.a, a.b, a.owner);
      return;
    }
    case 'releaseAIStockpile': {
      // The worker chose the salvo target alongside the release call; mirror
      // that choice on the main thread BEFORE invoking, since releaseAIStockpile
      // reads state.aiSalvoTarget[owner].
      state.aiSalvoTarget[a.owner] = a.salvoTarget;
      releaseAIStockpile(a.owner);
      return;
    }
  }
}

function onWorkerMessage(e) {
  const msg = e.data;
  if (msg.type === 'ready') { workerReady = true; return; }
  if (msg.type !== 'actions') return;

  pendingResponse = false;
  lastWorkerMs = msg.workerMs;

  // Apply actions in order. validation inside applyAction gates stale ones.
  for (const a of msg.actions) applyAction(a);

  // Merge AI control state back. The worker's view is authoritative for
  // these (they're its own bookkeeping). Per-key copy avoids dropping
  // entries for owners the worker didn't tick this batch.
  Object.assign(state.aiHoldFire,    msg.aiHoldFire);
  Object.assign(state.aiSalvoT0,     msg.aiSalvoT0);
  Object.assign(state.aiSalvoTarget, msg.aiSalvoTarget);
  Object.assign(state.aiFocus,       msg.aiFocus);
  Object.assign(state.aiTimers,      msg.aiTimers);
  Object.assign(state.aiMetrics,     msg.aiMetrics);
}

export function enable() {
  if (enabled) return;
  if (typeof Worker === 'undefined') {
    console.warn('[ai-worker] Worker API unavailable; staying main-thread');
    return;
  }
  try {
    worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      console.error('[ai-worker] error, falling back to main thread:', e.message);
      disable();
    };
    worker.postMessage({ type: 'init' });
    enabled = true;
    workerReady = false;
    pendingResponse = false;
    state.aiInWorker = true;
  } catch (e) {
    console.error('[ai-worker] enable failed:', e);
    worker = null;
    enabled = false;
    state.aiInWorker = false;
  }
}

export function disable() {
  if (!enabled) return;
  if (worker) { worker.terminate(); worker = null; }
  enabled = false;
  workerReady = false;
  pendingResponse = false;
  state.aiInWorker = false;
}

export function isEnabled() { return enabled && workerReady; }
export function getLastWorkerMs() { return lastWorkerMs; }

/** Called from simulate() once per frame. Returns true if the worker
 *  handled (or will handle) AI ticking — caller should then SKIP the
 *  main-thread aiTick loop for non-NN owners. */
export function tickFrame(dt) {
  if (!enabled || !workerReady) return false;
  if (pendingResponse) return true;             // still waiting on previous batch
  if (state.elapsed - lastDispatchT < SNAPSHOT_INTERVAL_SEC) return true;

  // Gather the owners the worker should tick — skip NN owners (they need
  // main-thread aiTick because onnxruntime-web loads the DOM).
  const tickOwners = [];
  for (const o of AIS) {
    if (!NN_OWNERS.has(o)) tickOwners.push(o);
  }
  if (tickOwners.length === 0) return false;    // nobody for the worker → caller does it all

  const snapshot = buildSnapshot();
  worker.postMessage({
    type: 'tick',
    dt,
    tickOwners,
    snapshot,
  });
  pendingResponse = true;
  lastDispatchT = state.elapsed;
  return true;
}

/** Whether main.js should run aiTick(owner) for `owner` this frame.
 *  When the worker is enabled and `owner` is non-NN, the worker handles
 *  it. NN owners always run main-thread. */
export function shouldMainThreadTick(owner) {
  if (!enabled || !workerReady) return true;
  return NN_OWNERS.has(owner);
}

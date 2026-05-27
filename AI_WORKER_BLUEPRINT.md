# Web Worker for AI Tick — Blueprint

Goal: move `aiTick(owner)` for every faction off the main thread so the render loop and sim sub-steps aren't blocked while the AI thinks. AI ticks are already rate-limited (~0.5–0.9 s per faction), so 1-frame round-trip latency through the worker is invisible.

## Architecture

```
main thread                                   worker thread
-----------                                   --------------
simulate() ──► (every N sim ticks)
   serialize lightweight snapshot ──postMessage──►  ai-worker.js
                                                     │
                                                     ├─ rebuild local mirror
                                                     ├─ for each owner in AIS:
                                                     │     if dueAt(owner) <= now:
                                                     │        actions += aiTick(owner)
                                                     │
   ◄─postMessage── { actions: [...] }                │
   for a of actions: apply(a)                        │
```

The worker owns the AI clock. Main thread is the authority on world state but only sends snapshots; the worker returns *intents* (actions) that the main thread re-validates and executes through existing helpers (`sendFleet`, `placeTurretAt`, etc.).

## Files to add

- `js/ai-worker.js` — worker entrypoint. Loads its own mirror of `state`, hosts `aiTick` (extracted form), produces an action queue per message. No DOM, no `window`, no canvas.
- `js/ai-worker-bridge.js` — main-thread proxy. Owns the `Worker` instance, the snapshot serializer, the action applier, and the dispatch cadence.

## Files to modify

- `js/main.js` — replace the per-tick `for (const ai of AIS) aiTick(ai, subDt)` block with `aiWorkerBridge.maybeDispatch()` and `aiWorkerBridge.drainActions()` at the top of `simulate()`.
- `js/ai.js` — extract `aiTick` into a worker-safe shape:
  - Pure functions only, all reads through a passed-in `state` mirror.
  - No imports of render/HUD/DOM modules.
  - Replace direct `sendFleet(...)` / `placeTurretAt(...)` calls with `actions.push({ type:'sendFleet', ... })`.
  - Keep the existing main-thread `aiTick` shim that calls the same core for now, behind a flag, so we can A/B.

## Snapshot schema (main → worker)

Minimal, transferable. Use plain objects (or Float32Arrays if perf demands).

```js
{
  tick: number,                  // monotonic, lets worker dedupe
  elapsed: number,
  nodes: [                       // one entry per node
    { id, x, y, owner, units, capacity, regenRate, kind, adj: [ids] }
  ],
  turrets: [
    { id, owner, type, x, y, hp, hpMax, active, progress }
  ],
  fleets: [
    { id, owner, kind, x, y, vx, vy, units, targetKind, targetId }
  ],
  roads: [ { a, b, hasNet, wreckCount } ],
  factionStats,                  // small, copy once on init then diff
  alliances: [[a,b], ...],       // flat pairs
  aiHoldFire, aiSalvoTarget,     // per-owner control state
  aiFocus,                       // worker writes back updates inside actions
}
```

Dispatch cadence: send a snapshot every ~6 frames (≈100 ms at 60 fps). Worker drives its own per-faction `dueAt` timers off `elapsed`.

## Action schema (worker → main)

```js
[ { type: 'sendFleet',  owner, fromId, toId, count, kind } ,
  { type: 'placeTurret', owner, kind, x, y, anchorNodeId } ,
  { type: 'setHoldFire', owner, value } ,
  { type: 'setSalvoTarget', owner, target } ,
  { type: 'setFocus', owner, nodeId } ,
  { type: 'releaseSalvo', owner } ]
```

Main-thread applier maps each `type` to the existing function. Re-validate cheaply (owner still owns `fromId`, target still exists) — the world has moved since the snapshot.

## State sync options

1. **postMessage snapshots (recommended for v1).** No header changes, works on `python -m http.server`. ~5–20 KB per snapshot, 10 Hz → trivial.
2. **SharedArrayBuffer.** Faster but requires COOP/COEP headers — Python's static server can't set them, would need Express or Vite. Defer until snapshot cost shows up in a profile.

## Things to pass once at init

- `AIS`, `FACTIONS`, `factionStats`, `NN_OWNERS`
- Tunables: `FACTORY_MAX_STOCKPILE`, `DRONE_CAP_PER_FACTION`, `TARGET_DRONE_CAP`, AA/tank/artillery ranges
- WORLD_W / WORLD_H, GRID_CELL

Send via a single `{ type: 'init', payload: {...} }` message before the first snapshot.

## What the worker does NOT need

- WASM (`cell_sim`). `aiTick` does not call wasm — wasm is invoked from combat/drones on the main thread. Keep wasm main-thread only.
- Render/HUD modules.
- Mouse/keyboard input state. (`holdFire`, `salvoTarget` are toggled by main-thread input and shipped over in the snapshot.)

## Subordinate (ally1)

Comes along for free: `aiTick` already runs for `ally1` via the existing loop. The worker just iterates `AIS` (which now includes `ally1` after `ensureLieutenantRegistered`).

## Rollout

1. Land bridge + worker skeleton with a feature flag `state.aiInWorker = false`. Main-thread path unchanged.
2. Extract `aiTick` core into a pure function that takes `(state, owner, dt)` and returns `actions[]`. Main-thread caller wraps it and applies actions inline.
3. Wire the worker to call the same core. Validate parity in a single-faction smoke test (record actions from both paths on the same seed; diff).
4. Flip the flag, observe frame-time perf overlay (`state._perfFrameMs` / `_perfSimMs`).
5. Remove the main-thread fallback once stable.

## Open questions to resolve while implementing

- How to handle `state.aiTimers` (per-owner cooldowns)? Worker owns them; main thread doesn't read them.
- Drone salvo release on the worker side: the actual fleet spawn still happens on main thread via the action queue; worker just emits `releaseSalvo`.
- If a snapshot lands while the worker is mid-tick, queue or drop? Drop — newer snapshot wins.

// =====================================================
// Effects facade for AI phases.
//
// Why: the phase modules (ai-build / ai-tactical / ai-strategic) used to
// import sendFleet/assaultTurret/placeTurretAt/placeNetOnEdge/releaseAIStockpile
// directly. That worked for the main-thread aiTick, but blocks the Worker
// port: when aiTick runs in a Worker, every side-effecting call must
// (1) mutate the WORKER's state mirror so subsequent phases in the same
// tick read consistent state, AND (2) record an action so the main thread
// can re-apply against its authoritative state.
//
// makeEffects(actions) returns a bundle that does BOTH. The same bundle
// works in main-thread context (where the recorded actions are simply
// ignored — mutations are already applied to the live state) and in
// Worker context (where actions are shipped back via postMessage).
//
// See AI_WORKER_BLUEPRINT.md.
// =====================================================
import { sendFleet, assaultTurret } from './fleets.js';
import { placeTurretAt, placeNetOnEdge } from './engineering.js';
// NOTE: releaseAIStockpile is gone — AI factories no longer stockpile drones
// (the hold-fire state machine dead-locked busy empires at the stockpile cap).
// Factory production is a single authority now in drones.runFactoryProduction.

/** Build an effects bundle whose calls mutate state via the real functions
 *  AND push a descriptor to `actions`. Phase code uses ctx.sendFleet(...)
 *  instead of importing sendFleet directly. */
export function makeEffects(actions) {
  return {
    sendFleet(from, to, count) {
      sendFleet(from, to, count);
      actions.push({ type: 'sendFleet', fromId: from.id, toId: to.id, count });
    },
    assaultTurret(from, turret, count) {
      const r = assaultTurret(from, turret, count);
      actions.push({ type: 'assaultTurret', fromId: from.id, turretId: turret.id, count });
      return r;
    },
    placeTurretAt(x, y, kind, owner) {
      const placed = placeTurretAt(x, y, kind, owner);
      if (placed) actions.push({ type: 'placeTurret', x, y, kind, owner });
      return placed;
    },
    placeNetOnEdge(a, b, owner) {
      const placed = placeNetOnEdge(a, b, owner);
      if (placed) actions.push({ type: 'placeNet', a, b, owner });
      return placed;
    },
  };
}

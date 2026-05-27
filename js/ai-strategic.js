// =====================================================
// AI strategic phase — drone-salvo hold-fire / release.
//
// Mirrors the player's Hold-Fire trick (H, click target, H again): factories
// stockpile drones rather than trickle them out one-by-one, then release the
// whole batch as a saturation strike that overwhelms AA walls.
//
// State machine, per owner:
//   - aiHoldFire[owner]   : true while stockpiling
//   - aiSalvoT0[owner]    : timestamp stockpile began (for max-age release)
//   - aiSalvoTarget[owner]: fixed lock-on chosen at release time
//   - aiFocus[owner]      : strategic node focus from Phase 2 (combined arms)
//
// Returns true if the salvo released this tick OR if stockpiling state
// changed (to honour the one-action-per-tick budget like the other phases).
// =====================================================
import { state } from './state.js';
import { isAlly } from './alliance.js';
import { releaseAIStockpile } from './drones.js';
import { FACTORY_MAX_STOCKPILE } from './config.js';

/** Maintain the hold-fire / release state machine for `owner`. Returns true
 *  if the salvo fired this tick. */
export function tryDroneSalvo(ctx) {
  const { owner, myNodes, farBehind } = ctx;

  // Pull from the owner-bucketed Map and filter by type/active inline instead
  // of scanning the entire turret array.
  const myFactories = [];
  const myTurretsAll = state.turretsByOwner.get(owner) || [];
  for (const t of myTurretsAll) {
    if (t.type === 'factory' && t.active) myFactories.push(t);
  }

  if (state.aiHoldFire[owner]) {
    // Once stockpiling, check release conditions every tick regardless of
    // current factory count — if a factory got blown up mid-stockpile we
    // still want to fire whatever we have rather than hoarding forever.
    const stocked    = myFactories.reduce((s, t) => s + (t.dronesReady || 0), 0);
    const fullCount  = myFactories.filter(t => (t.dronesReady || 0) >= FACTORY_MAX_STOCKPILE).length;
    const aged       = state.elapsed - (state.aiSalvoT0[owner] || 0);
    const lostMass   = myFactories.length < 2 && stocked > 0;
    // Release condition: enough mass to matter, aged-out, or lost factories.
    if (fullCount >= 2 || stocked >= 10 || aged > 35 || lostMass) {
      // First preference: aim at the strategic focus (the hub Phase 2 is
      // currently grinding into). Drone salvo + ground wave hit the same
      // point in the same beat → combined arms. Drop focus if stale/captured.
      let target = null, targetVal = 0;
      const focus = state.aiFocus[owner];
      if (focus) {
        const fNode = state.nodes[focus.targetId];
        const focusAge = state.elapsed - (focus.since || 0);
        if (fNode && !isAlly(fNode.owner, owner) && focusAge < 20) {
          target = { kind: 'node', id: fNode.id, x: fNode.x, y: fNode.y };
          targetVal = Infinity;       // lock — don't override below
        } else {
          state.aiFocus[owner] = null;
        }
      }
      const cx = myFactories.length
        ? myFactories.reduce((s, t) => s + t.x, 0) / myFactories.length
        : myNodes[0].x;
      const cy = myFactories.length
        ? myFactories.reduce((s, t) => s + t.y, 0) / myFactories.length
        : myNodes[0].y;
      for (const t of state.turrets) {
        if (!t.active) continue;
        if (isAlly(t.owner, owner) || t.owner === 'neutral') continue;
        const dx = t.x - cx, dy = t.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > 700 * 700) continue;       // gate before sqrt
        const d = Math.sqrt(d2);
        let v = 1.0;
        if (t.type === 'tank')           v = 3.0;
        else if (t.type === 'factory')   v = 2.8;
        else if (t.type === 'artillery') v = 2.2;
        else if (t.type === 'antiair')   v = 1.8;
        v *= 1 / (1 + d / 300);
        if (v > targetVal) {
          targetVal = v;
          target = { kind: 'turret', id: t.id, x: t.x, y: t.y };
        }
      }
      state.aiSalvoTarget[owner] = target;
      releaseAIStockpile(owner);
      state.aiHoldFire[owner] = false;
      return true;
    }
  } else if (myFactories.length >= 2 && !farBehind) {
    // Not stockpiling yet — start now. (Skipping when behind keeps drone
    // pressure flowing instead of disappearing for 25s.)
    state.aiHoldFire[owner] = true;
    state.aiSalvoT0[owner] = state.elapsed;
  }
  return false;
}

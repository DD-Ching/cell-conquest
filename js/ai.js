// =====================================================
// Per-tick AI orchestrator. Heuristic v3.
//
// The aiTick body that used to be 670 lines now does three things:
//   1. NN dispatch (for owners listed in NN_OWNERS) — short-circuits early.
//   2. Builds `ctx` once: situation analysis (saturation, aggression,
//      anti-turtle, far-behind) plus a few helper closures shared by every
//      downstream phase (incomingTo, attackerAvail, turretThreatTo,
//      isExposedToEnemyTank).
//   3. Calls phase functions in priority order, stopping at the first one
//      that returns true (the one-action-per-tick budget the monolithic
//      version enforced via early `return` statements).
//
// Phase order is BEHAVIOURALLY IDENTICAL to the old monolithic code:
//   build turret → build net → defend → drone salvo → assault turret →
//   coordinated attack → reinforce frontline → overflow dump.
//
// Where each phase lives:
//   ai-build.js     — tryBuildTurret, tryBuildNet
//   ai-tactical.js  — tryDefend, tryAssaultTurrets, tryCoordinatedAttack,
//                     tryReinforceFrontline, tryOverflowDump
//   ai-strategic.js — tryDroneSalvo
//
// This shape is also the Worker-port form (see AI_WORKER_BLUEPRINT.md):
// every phase already takes a ctx object and returns true/false, so the
// Worker version just swaps direct sendFleet calls for action-queue pushes.
// =====================================================
import { state } from './state.js';
import { NN_OWNERS } from './config.js';
import { catchUpAllNodes } from './world.js';
import { sendFleet } from './fleets.js';
import { nnDecide, nnActionFor, isNNReady } from './nn.js';
import { buildContext } from './ai-context.js';
import { tryBuildTurret, tryBuildNet } from './ai-build.js';
import {
  tryDefend, tryAssaultTurrets, tryCoordinatedAttack,
  tryReinforceFrontline, tryOverflowDump,
} from './ai-tactical.js';
// NOTE: the AI drone-salvo hold-fire phase (ai-strategic.tryDroneSalvo) is GONE.
// It ran a per-owner stockpile state machine gated behind the one-action-per-tick
// budget, so a busy empire never reached the release step and its factories sat
// pinned at FACTORY_MAX_STOCKPILE forever (the "NPC factory stuck at 20" bug).
// Factory production is now a single authority in drones.runFactoryProduction
// (continuous rolling waves for AI — same throughput, can't dead-lock).
import { relieveSaturation, clearBlockedRoads } from './ai-logistics.js';

/** Tick one AI. Returns the actions array (empty when nothing happened).
 *  In main-thread mode the actions array is harmlessly ignored — every
 *  effect already mutated live state. In Worker mode the bridge ships the
 *  array back so the main thread can re-apply the effects on its
 *  authoritative state. See AI_WORKER_BLUEPRINT.md. */
export function aiTick(owner, dt) {
  state.aiTimers[owner] -= dt;
  if (state.aiTimers[owner] > 0) return [];
  // NN player decides every ~0.3s (matches training cadence); heuristic is
  // ~0.5–0.9s so the AI stays responsive in tempo with the player's clicks.
  state.aiTimers[owner] = NN_OWNERS.has(owner)
    ? (0.25 + Math.random() * 0.15)
    : (0.5 + Math.random() * 0.4);

  // ---- NN-controlled faction: apply cached action, dispatch async inference for next tick ----
  // NN dispatch always runs main-thread (the Worker doesn't load onnxruntime).
  // This branch's sendFleet call is direct (not via ctx) — fine, since the
  // Worker bridge skips NN owners and delegates them to the main-thread aiTick.
  if (NN_OWNERS.has(owner) && isNNReady()) {
    const a = nnActionFor(owner);
    nnDecide(owner);            // async; fills nnLastAction for the next tick
    if (a) {
      const from = state.nodes[a.src], to = state.nodes[a.dst];
      if (from && to && from.owner === owner && from.units >= 2 && from.id !== to.id) {
        sendFleet(from, to, Math.floor(from.units / 2));
      }
    }
    return [];
  }

  const myNodes = state.nodes.filter(n => n.owner === owner);
  if (myNodes.length === 0) return [];
  // Lazy regen: bring every node up to date once so subsequent reads of
  // n.units / n.capacity see fresh values. One pass beats sprinkling
  // catchUp around the dozen places below that read units.
  catchUpAllNodes();

  // ===== Situation analysis + shared context (see ai-context.js) =====
  // buildContext does the once-per-tick situation read (saturation, aggression,
  // anti-turtle, far-behind, eliminationOwners) and wires up the shared helper
  // closures + effects bundle, returning the `ctx` every phase consumes.
  const ctx = buildContext(owner, myNodes);
  const actions = ctx.actions;

  // ===== Bounded anti-saturation (always runs, not part of the one-action
  // budget) ===== Every FULL node either expands into an affordable adjacent
  // enemy/neutral or feeds its surplus toward the front — capped per tick so a
  // big empire never sits idle-full yet can't spawn a fleet storm. The focused
  // tactical decision still fires below.
  relieveSaturation(ctx);

  // ===== Road maintenance (always runs, not part of the one-action budget)
  // ===== Dispatch engineers to clear wreck-clogged supply roads that
  // tryBuildNet leaves untouched (interior + maxed-net edges). Capped per tick
  // + de-duped against engineers already en route.
  clearBlockedRoads(ctx);

  // ===== Phase dispatch — first true return is the action this tick =====
  // Order matches the old monolithic body's early-return sequence exactly.
  // Whichever phase returns true populated ctx.actions via the effects
  // bundle; we return that array regardless of which phase fired.
  if (tryBuildTurret(ctx))         return actions;
  if (tryBuildNet(ctx))            return actions;
  if (tryDefend(ctx))              return actions;
  if (tryAssaultTurrets(ctx))      return actions;
  if (tryCoordinatedAttack(ctx))   return actions;
  if (tryReinforceFrontline(ctx))  return actions;
  if (tryOverflowDump(ctx))        return actions;
  return actions;
}

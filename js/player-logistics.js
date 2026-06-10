// =====================================================
// Player-side saturation relief — the "don't let my army rot in one node" pass.
//
// The enemy AI and the player's Lieutenant (ally1) already auto-disperse a
// stuffed node every tick (ai.aiTick → relieveSaturation), because they're in
// the AIS roster. The player's OWN nodes never run aiTick, so before this pass a
// player who manually dumped their whole army into one node got nothing: the
// node sat pinned, its regen halted (world.catchUpRegen stops at capacity), and
// the surplus did nothing. The player asked for the opposite — a manually
// over-stuffed node should rapidly EXPAND / capture / feed its surplus forward
// on its own (擴張・佔領・自動自發), never idle.
//
// So we run the SAME relieveSaturation engine for owner='player', but only on
// genuinely over-stuffed nodes (PLAYER_RELIEF_THRESHOLD ≥ 1.0× capacity), so a
// deliberate sub-capacity garrison the player is massing stays under their
// direct control and is NOT auto-launched. Above capacity a node is wasting its
// regen anyway, which is the exact case the player wants drained.
//
// IMPORTANT: this only moves node.units (ground garrisons). The H-key hold-fire
// drone stockpile is a SEPARATE pool (drone entities / dronesReady, never
// node.units — see drones.js) and is untouched by this pass.
//
// Cheap: a per-cadence timer + an O(playerNodes) "any node over capacity?" gate
// short-circuits before the heavier buildContext, so in normal play (nothing
// over-stuffed) this costs one array scan per cadence and nothing else.
// =====================================================
import { state } from './state.js';
import { buildContext } from './ai-context.js';
import { relieveSaturation } from './ai-logistics.js';

const PLAYER_RELIEF_THRESHOLD = 1.0;   // ×capacity: only disperse nodes at/over their natural ceiling
const PLAYER_RELIEF_PERIOD    = 0.2;   // game-seconds between passes (fast, but not every frame)

export function relievePlayerSaturation(dt) {
  // Scripted levels own their own pacing — don't auto-shuffle the player's army
  // mid-lesson (matches checkVictory's tutorial gate).
  if (state.tutorial || state.gameOver) return;

  state._playerReliefTimer = (state._playerReliefTimer || 0) - dt;
  if (state._playerReliefTimer > 0) return;
  state._playerReliefTimer = PLAYER_RELIEF_PERIOD;

  // Cheap gate: bail unless at least one player node is actually over-stuffed.
  let anyStuffed = false;
  const playerNodes = [];
  for (const n of state.nodes) {
    if (n.owner !== 'player') continue;
    playerNodes.push(n);
    if (n.units >= n.capacity * PLAYER_RELIEF_THRESHOLD) anyStuffed = true;
  }
  if (!anyStuffed || playerNodes.length < 1) return;

  const ctx = buildContext('player', playerNodes);
  ctx.reliefThreshold = PLAYER_RELIEF_THRESHOLD;   // only act on over-stuffed player nodes
  relieveSaturation(ctx);
}

// =====================================================
// Subordinate / lieutenant faction. The player's allied AI commander.
//
// Single source of truth for everything ally1-related:
//   - faction definition (id, name, colour)
//   - self-registration into the live factions registry (AIS / COLOR /
//     GLOW / FACTIONS / factionStats) — robust to factions.js cache
//   - mutual non-aggression pact with the player
//   - G-key delegation: transfers a player base to ally1 (and back)
//
// Adding ally2 / ally3 in the future = cloning this module with a new id.
// The enemy-faction roster in factions.js doesn't need to know we exist.
// =====================================================
import { state } from './state.js';
import { AIS, COLOR, GLOW, FACTIONS, factionStats, hexToRgba } from './factions.js';
import { setAlly } from './alliance.js';
import { buildHUD } from './render-hud.js';

const LIEUTENANT_DEF = { id: 'ally1', name: 'Lieutenant', color: '#e6c062' };

/** Idempotent: make sure the lieutenant faction is fully registered in
 *  every live binding. Called from main.newGame after rollFactions, and
 *  again on the first G-press as a safety net so a stale cached
 *  factions.js can't leave ally1 half-registered. */
export function ensureLieutenantRegistered() {
  let added = false;
  if (!AIS.includes('ally1')) { AIS.push('ally1'); added = true; }
  if (!COLOR.ally1) {
    COLOR.ally1 = LIEUTENANT_DEF.color;
    GLOW.ally1  = hexToRgba(LIEUTENANT_DEF.color, 0.40);
    added = true;
  }
  if (!FACTIONS.find(f => f.id === 'ally1')) {
    // Insert right after the player so HUD ordering reads naturally.
    const playerIdx = FACTIONS.findIndex(f => f.id === 'player');
    FACTIONS.splice(playerIdx + 1, 0, LIEUTENANT_DEF);
    added = true;
  }
  if (!factionStats.ally1) {
    factionStats.ally1 = { strength: 1.0, aggressionMul: 1.0, buildChanceMul: 1.0 };
    added = true;
  }
  // Mutual non-aggression pact. setAlly is symmetric + idempotent.
  setAlly('player', 'ally1');
  // If we mutated FACTIONS we need to rebuild the HUD DOM rows so the
  // lieutenant gets its own line + the DOM refs the updateHUD cache uses.
  if (added) buildHUD();
}

/** G-key handler. With selectedIds non-empty, delegates the whole
 *  selection in one keystroke; otherwise falls back to the hovered node.
 *  Direction (delegate vs revoke) is driven by the FIRST eligible node
 *  in the batch so the whole group flips the same way. */
export function toggleDelegationAt(hoveredNode) {
  ensureLieutenantRegistered();

  // Gather the targets. selectedIds wins; hovered is the single-node fallback.
  let batch = [];
  if (state.selectedIds && state.selectedIds.size > 0) {
    for (const id of state.selectedIds) {
      const n = state.nodes[id];
      if (n && (n.owner === 'player' || n.owner === 'ally1')) batch.push(n);
    }
  }
  if (batch.length === 0 && hoveredNode) {
    if (hoveredNode.owner === 'player' || hoveredNode.owner === 'ally1') batch.push(hoveredNode);
  }
  if (batch.length === 0) return 0;

  // Same direction for the whole batch (avoids the toggle-half / toggle-half
  // mess that single-node toggles cause when selection is mixed).
  const direction = batch[0].owner === 'player' ? 'ally1' : 'player';
  let flipped = 0;
  for (const n of batch) {
    if (n.owner === direction) continue;   // already that side
    n.owner = direction;
    n.flash = Math.max(n.flash, 0.6);
    n.lastRegenT = state.elapsed;          // fresh regen baseline for new owner
    flipped++;
  }
  return flipped;
}

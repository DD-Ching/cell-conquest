// =====================================================
// Subordinate AI integration. The "lieutenant" is a real faction
// ('ally1') with its own AI brain — the same aiTick() the enemy
// factions use. This file is a thin shim that:
//
//   1. Transfers a base's ownership when the player presses G over it
//      (player ↔ ally1 toggle).
//   2. Does NOT run a tick of its own — the main loop already calls
//      aiTick('ally1', dt) because 'ally1' is in the AIS list from
//      factions.rollFactions.
//
// Player and ally1 are registered as mutual allies (factions.js calls
// setAlly), so the existing isAlly()-aware combat / AI / drone code
// naturally treats them as non-aggressive toward each other.
// =====================================================
import { state } from './state.js';

/** G-key handler — flip a single node between player and lieutenant
 *  control. Capture by an enemy clears the flag (handled in
 *  fleets.arriveAt where the owner change happens). */
export function toggleDelegation(node) {
  if (!node) return false;
  if (node.owner === 'player') {
    node.owner = 'ally1';
    node.flash = Math.max(node.flash, 0.6);
    node.lastRegenT = state.elapsed;       // fresh regen baseline for the new owner
    return true;
  }
  if (node.owner === 'ally1') {
    node.owner = 'player';
    node.flash = Math.max(node.flash, 0.6);
    node.lastRegenT = state.elapsed;
    return true;
  }
  return false;
}

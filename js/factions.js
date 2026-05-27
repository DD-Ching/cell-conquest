// =====================================================
// Faction roster + per-game randomized lineup.
// Each game picks 1-4 AI opponents from the pool (so 2-5 total players
// including you), each with a random "strength" multiplier that affects
// their aggression and build rate. Mars Front colors are warm rust /
// sand to fit the planet's palette.
// =====================================================

export function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Master pool. AI opponents drawn from this; player is always 'player'.
const AI_POOL = [
  { id: 'red',     name: 'Crimson',  color: '#ff6678' },
  { id: 'gold',    name: 'Ochre',    color: '#ffb343' },
  { id: 'cyan',    name: 'Cyan',     color: '#5cffd6' },
  { id: 'magenta', name: 'Violet',   color: '#d56cff' },
  { id: 'lime',    name: 'Lime',     color: '#a8e060' },
];
const PLAYER_DEF  = { id: 'player',  name: 'You',     color: '#5cb3ff' };
const NEUTRAL_DEF = { id: 'neutral', name: 'Neutral', color: '#a08574' };
// Subordinate / ally faction registration lives in subordinate.js — see
// ensureLieutenantRegistered(). This keeps the enemy / player / neutral
// roster here pure and lets ally factions be added without editing this file.

// Live bindings — mutated in place by rollFactions so other modules
// keep their imports valid. Initial values are placeholders until the
// first rollFactions() call (which main.js runs at boot).
export const AIS = [];
export const COLOR = {};
export const GLOW = {};
export const FACTIONS = [];

/** Per-faction behavior multipliers. strength=1.0 is baseline; higher
 *  means more aggressive + builds faster. Player is always 1.0. */
export const factionStats = {};

import { resetAlliances } from './alliance.js';

/** Roll a new lineup. Called from newGame() before world placement.
 *  Resets alliances + enemy rosters. Ally / subordinate factions are
 *  registered by their own modules (see subordinate.ensureLieutenantRegistered)
 *  AFTER this runs. */
export function rollFactions() {
  AIS.length = 0;
  for (const k of Object.keys(COLOR))   delete COLOR[k];
  for (const k of Object.keys(GLOW))    delete GLOW[k];
  for (const k of Object.keys(factionStats)) delete factionStats[k];
  FACTIONS.length = 0;
  resetAlliances();

  // Pick 1-4 AIs (so total active = 2-5 with player)
  const nAI = 1 + Math.floor(Math.random() * 4);
  const shuffled = [...AI_POOL].sort(() => Math.random() - 0.5);
  for (let i = 0; i < nAI; i++) AIS.push(shuffled[i].id);

  // Display order: player first, then enemy AIs, then neutral.
  // Ally factions insert themselves between player and AIs via their own
  // ensure* registration (see subordinate.js).
  const enemyDefs = AIS.map(id => AI_POOL.find(f => f.id === id));
  const active = [PLAYER_DEF, ...enemyDefs, NEUTRAL_DEF];
  for (const f of active) {
    COLOR[f.id] = f.color;
    GLOW[f.id]  = hexToRgba(f.color, f.id === 'neutral' ? 0.18 : 0.40);
    FACTIONS.push(f);
  }

  // Random behavior multipliers per AI; player is baseline.
  factionStats.player = { strength: 1.0, aggressionMul: 1.0, buildChanceMul: 1.0 };
  for (const id of AIS) {
    const strength = 0.85 + Math.random() * 0.35;   // 0.85 – 1.20
    factionStats[id] = {
      strength,
      // Stronger factions push harder and build faster
      aggressionMul:    0.85 + (strength - 0.85) * 1.5,   // 0.85 – 1.375
      buildChanceMul:   0.85 + (strength - 0.85) * 1.5,
    };
  }
}

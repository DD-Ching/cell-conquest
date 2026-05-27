// =====================================================
// Faction roster + per-game randomized lineup.
// Each game picks 1-4 AI opponents from the pool (so 2-5 total players
// including you), each with a random "strength" multiplier that affects
// their aggression and build rate. Mars Front colors are warm rust /
// sand to fit the planet's palette.
// =====================================================

function hexToRgba(hex, a) {
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
// Subordinate AI — always-present friendly faction. Player toggles bases
// over to it with the G key. Same AI brain as enemies (aiTick) but the
// alliance registry treats player ↔ ally1 as mutually non-aggressive.
const ALLY1_DEF   = { id: 'ally1',   name: 'Lieutenant 🤖', color: '#e6c062' };
const NEUTRAL_DEF = { id: 'neutral', name: 'Neutral', color: '#a08574' };

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

import { resetAlliances, setAlly } from './alliance.js';

/** Roll a new lineup. Called from newGame() before world placement. */
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
  // Lieutenant (ally1) is always in the AI loop. Starts with 0 bases
  // — only gets nodes when the player delegates one with G.
  AIS.push('ally1');

  // Build the active faction list in display order: player, ally1, AIs, neutral
  const enemyDefs = AIS.filter(id => id !== 'ally1').map(id => AI_POOL.find(f => f.id === id));
  const active = [PLAYER_DEF, ALLY1_DEF, ...enemyDefs, NEUTRAL_DEF];
  for (const f of active) {
    COLOR[f.id] = f.color;
    GLOW[f.id]  = hexToRgba(f.color, f.id === 'neutral' ? 0.18 : 0.40);
    FACTIONS.push(f);
  }

  // Random behavior multipliers per AI; player + ally1 are baseline.
  factionStats.player = { strength: 1.0, aggressionMul: 1.0, buildChanceMul: 1.0 };
  factionStats.ally1  = { strength: 1.0, aggressionMul: 1.0, buildChanceMul: 1.0 };
  for (const id of AIS) {
    if (id === 'ally1') continue;
    const strength = 0.85 + Math.random() * 0.35;   // 0.85 – 1.20
    factionStats[id] = {
      strength,
      // Stronger factions push harder and build faster
      aggressionMul:    0.85 + (strength - 0.85) * 1.5,   // 0.85 – 1.375
      buildChanceMul:   0.85 + (strength - 0.85) * 1.5,
    };
  }
  // Mutual non-aggression pact between you and your lieutenant.
  setAlly('player', 'ally1');
}

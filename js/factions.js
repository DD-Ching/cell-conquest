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
import { activeTheme } from './themes.js';
import { state } from './state.js';

/** Roll a new lineup. Called from newGame() before world placement.
 *  Resets alliances + enemy rosters. Ally / subordinate factions are
 *  registered by their own modules (see subordinate.ensureLieutenantRegistered)
 *  AFTER this runs.
 *
 *  Visual skin (palette / name pool / glow strength) comes from the
 *  active theme — see themes.js. Default = `mars`, which restores the
 *  exact original palette + name pool. Override via `?theme=NAME` URL
 *  param. IDs are theme-invariant so any id-keyed system (NN_OWNERS,
 *  alliance pacts, persisted state) keeps working across themes. */
export function rollFactions() {
  AIS.length = 0;
  for (const k of Object.keys(COLOR))   delete COLOR[k];
  for (const k of Object.keys(GLOW))    delete GLOW[k];
  for (const k of Object.keys(factionStats)) delete factionStats[k];
  FACTIONS.length = 0;
  resetAlliances();

  const theme = activeTheme();

  // Build a theme-skinned copy of the AI pool. Both palette and namePool
  // are applied positionally; AI_POOL itself is left untouched so a
  // re-roll without reload picks up the same theme cleanly.
  const themedPool = AI_POOL.map((f, i) => ({
    id:    f.id,
    name:  theme.namePool[i % theme.namePool.length],
    color: theme.palette[i % theme.palette.length],
  }));

  // Opponent count: state.numOpponents pins it (default 1 = a clean 1v1, set at
  // boot). 0/undefined falls back to the original random 1-4 (so total active =
  // 2-5 with player) — used by ?opponents=random.
  const nAI = state.numOpponents
    ? Math.max(1, Math.min(AI_POOL.length, state.numOpponents))
    : 1 + Math.floor(Math.random() * 4);
  let pool = [...themedPool].sort(() => Math.random() - 0.5);
  // Fixed-count games make Crimson (red) the primary antagonist — on-brand with
  // the "Mars Front · Crimson Sector" framing, so a default 1v1 is always
  // "You vs Crimson". The random mode (?opponents=random) keeps the pure roll.
  if (state.numOpponents) {
    pool = [themedPool.find(f => f.id === 'red'), ...pool.filter(f => f.id !== 'red')];
  }
  for (let i = 0; i < nAI; i++) AIS.push(pool[i].id);

  // Display order: player first, then enemy AIs, then neutral.
  // Ally factions insert themselves between player and AIs via their own
  // ensure* registration (see subordinate.js).
  // Player + neutral colours are theme-invariant — the player anchor
  // needs to read the same regardless of skin so muscle memory carries.
  const enemyDefs = AIS.map(id => themedPool.find(f => f.id === id));
  const active = [PLAYER_DEF, ...enemyDefs, NEUTRAL_DEF];
  for (const f of active) {
    COLOR[f.id] = f.color;
    const alpha = (f.id === 'neutral') ? 0.18
                : (f.id === 'player')  ? 0.40
                : theme.glowMul;
    GLOW[f.id]  = hexToRgba(f.color, alpha);
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

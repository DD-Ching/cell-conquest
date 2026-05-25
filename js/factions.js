// =====================================================
// Faction roster + color tables.
// AIS is the list of AI-controlled faction ids (player excluded).
// =====================================================

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export const FACTIONS = [
  { id: 'player',  name: 'You',     color: '#5cb3ff' },
  { id: 'red',     name: 'Crimson', color: '#ff6678' },
  { id: 'green',   name: 'Verdant', color: '#79e58c' },
  { id: 'amber',   name: 'Amber',   color: '#ffa844' },
  { id: 'neutral', name: 'Neutral', color: '#8694ad' },
];

export const COLOR = Object.fromEntries(FACTIONS.map(f => [f.id, f.color]));
export const GLOW = Object.fromEntries(
  FACTIONS.map(f => [f.id, hexToRgba(f.color, f.id === 'neutral' ? 0.18 : 0.4)])
);
export const AIS = ['red', 'green', 'amber'];

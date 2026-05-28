// =====================================================
// Faction theme presets — swap palette/glow/name pool at boot.
//
// A theme is a *visual* skin over the AI faction roster: it overrides
// the per-faction `color` (and the corresponding GLOW), the display
// `name` shown in HUD / titles, and the GLOW alpha multiplier. Faction
// IDs ('red', 'gold', 'cyan', 'magenta', 'lime') stay constant so that
// id-keyed systems (NN_OWNERS, alliance pacts, save-state, AI behaviour
// tables) keep working unchanged.
//
// Design choice: PLAYER colour ('#5cb3ff') stays fixed across all
// themes. The player anchor needs to read the same regardless of skin
// so muscle memory carries; only enemy AIs re-skin. (Lieutenant inherits
// the player colour automatically — see subordinate.js.)
//
// Activated via URL: ?theme=ice-mars or ?theme=alien-biome. Unknown or
// missing value falls back to `mars` — the original look, so the
// default boot path is a no-op vs. before this file existed.
//
// Kept dependency-free (no factions.js import) to avoid a circular
// reference — factions.js imports *us*.
// =====================================================

export const THEMES = {
  // Original Mars Front palette. Listed first + as the fallback so any
  // typo / missing query lands here, preserving the no-theme look.
  mars: {
    palette: ['#ff6678', '#ffb343', '#5cffd6', '#d56cff', '#a8e060'],
    glowMul: 0.40,
    namePool: ['Crimson', 'Ochre', 'Cinnabar', 'Sienna', 'Rust', 'Vermilion'],
  },
  // Frozen Mars — blue/cyan ice palette. Slightly higher glow because
  // cool hues read dimmer than warm ones on the dust-haze background.
  'ice-mars': {
    palette: ['#a8d8ff', '#7cc4ff', '#5fb0ff', '#92e0ff', '#c8e8ff', '#7ed8ff'],
    glowMul: 0.50,
    namePool: ['Frost', 'Glacier', 'Snowline', 'Frostbite', 'Permafrost', 'Tundra'],
  },
  // Alien-biome — saturated bio greens / pinks / cyans, a more vivid
  // look. Even higher glow boost to sell the bioluminescent feel.
  'alien-biome': {
    palette: ['#a8ff88', '#88ffaa', '#88ddff', '#dd88ff', '#ff88dd', '#ffaa88'],
    glowMul: 0.55,
    namePool: ['Verdant', 'Spore', 'Hyphae', 'Bloom', 'Symbiote', 'Mycelium'],
  },
};

/** Look up a theme by name, falling back to `mars`. Safe to call with
 *  any value (null / undefined / unknown string). */
export function getTheme(name) {
  return THEMES[name] || THEMES.mars;
}

/** Read the active theme from the URL `?theme=` param. Returns the
 *  full theme object (palette + glowMul + namePool). Defaults to mars
 *  when the param is missing / unrecognized. Designed to be called
 *  once at boot from rollFactions(); cheap enough to call again. */
export function activeTheme() {
  try {
    const name = new URLSearchParams(window.location.search).get('theme');
    return getTheme(name);
  } catch {
    // SSR / non-browser callers (tests, workers without location).
    return THEMES.mars;
  }
}


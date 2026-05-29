// =====================================================
// Tactical map art-direction — shared style data + helpers.
//
// Central home for the "dark sci-fi command map" look: the muted per-region
// terrain palette and the seeded region-name generator. Kept tiny and
// dependency-free so both the generator (worldgen.js — bakes names into the
// map) and the renderers (render-procgen / render-territory) can import it.
//
// Faction COLORs stay vivid (units must read); this module only governs the
// MAP layer — region tint, frontline borders, labels — which leans muted so
// colour is spent on what matters (borders, majors, frontlines).
// =====================================================

// Muted terrain hues per region archetype. These read as GROUND, not faction
// ownership — desaturated so the dark field stays the dominant tone.
export const REGION_TINT = {
  city:            '#5d6f93',
  industrial_zone: '#9a6c3a',
  mining_zone:     '#b08a3a',
  military_base:   '#9a4f49',
  frontier:        '#8a7a58',
  wasteland:       '#5e463e',
  research_site:   '#3c8c8c',
};

// Region-name pools → "Prefix Feature" (Ash Basin, Redline Corridor, …). Gives
// the map a sense of place. Combined + deduped with the seeded worldgen rng so
// the same seed always yields the same names.
const NAME_PREFIX = [
  'Ash', 'Cinder', 'Iron', 'Rust', 'Crimson', 'Dustfall', 'Helix', 'Meridian',
  'Valles', 'Northern', 'Redline', 'Pale', 'Hollow', 'Umber', 'Ochre', 'Basalt',
  'Sable', 'Ferro', 'Scoria', 'Vermil', 'Cobalt', 'Obsidian',
];
const NAME_FEATURE = [
  'Basin', 'Scar', 'Flats', 'Corridor', 'Wastes', 'Gate', 'Sector', 'Ridge',
  'Approach', 'Ruins', 'Expanse', 'Reach', 'Span', 'Crater', 'Shelf', 'Divide',
  'Fields', 'Verge', 'Pass', 'Hollow',
];

/** Deterministic "Prefix Feature" name from a seeded rng; dedupes via `used`. */
export function makeRegionName(rng, used) {
  for (let tries = 0; tries < 50; tries++) {
    const n = NAME_PREFIX[Math.floor(rng() * NAME_PREFIX.length)] + ' ' +
              NAME_FEATURE[Math.floor(rng() * NAME_FEATURE.length)];
    if (!used.has(n)) { used.add(n); return n; }
  }
  return 'Sector ' + (used.size + 1);
}

/** "#rrggbb" + alpha → rgba() string. */
export function rgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Darken a "#rrggbb" toward black by factor f∈[0,1] → rgba() string. */
export function darken(hex, f, a = 1) {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * (1 - f));
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * (1 - f));
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * (1 - f));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

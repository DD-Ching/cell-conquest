// =====================================================
// Fog of war — vision grid + reveal compute.
//
// "Grow the light, not the dark." A coarse uniform grid spans the world; each
// cell is either unseen (never revealed → drawn black), explored (seen once,
// not currently in vision → drawn dimmed), or visible (in a friendly unit's
// vision right now → drawn clear). render-fog.js paints the veil from this
// grid; this module only OWNS the data + the recompute.
//
// Two flat Uint8Arrays of gw*gh, indexed [cy*gw + cx]:
//   seen — sticky. Once a cell is revealed it stays explored for the match.
//   vis  — transient. Cleared + rebuilt every recompute from the current set
//          of friendly (player-allied) nodes + fleets.
//
// Player fog is RENDER-ONLY and outcome-neutral: the sim never consults it.
// The AI gets a separate, cheaper visibility gate in ai-context.js (Pillar 3).
//
// Cost control: recompute is throttled to ~8 Hz on REAL time (FOG_RECOMPUTE_MS)
// so game speed doesn't multiply it, and each source stamps only the cells in
// its disc's bounding box. Drones use a small radius so a 1000-drone swarm
// doesn't blow the budget.
// =====================================================
import { state } from './state.js';
import {
  WORLD_W, WORLD_H, FOG_CELL, FOG_RECOMPUTE_MS,
  VISION_CAPITAL, VISION_NODE, VISION_FLEET, VISION_DRONE,
} from './config.js';
import { isAlly } from './alliance.js';

/** Allocate (or resize) the fog grid for the current world dimensions. Cheap
 *  no-op once allocated at the right size. */
export function ensureFog() {
  const cell = FOG_CELL;
  const gw = Math.ceil(WORLD_W / cell);
  const gh = Math.ceil(WORLD_H / cell);
  const f = state.fog;
  if (f && f.gw === gw && f.gh === gh) return f;
  state.fog = {
    gw, gh, cell,
    seen: new Uint8Array(gw * gh),
    vis:  new Uint8Array(gw * gh),
  };
  return state.fog;
}

/** Wipe explored + visible memory (new game). */
export function resetFog() {
  const f = ensureFog();
  f.seen.fill(0);
  f.vis.fill(0);
  state._fogLastT = 0;
}

/** Stamp a filled disc of radius `r` (world px) centred at (wx,wy) into `vis`
 *  (and `seen` if markSeen). Iterates only the disc's cell bounding box. */
function stampDisc(f, wx, wy, r, markSeen) {
  const cell = f.cell, gw = f.gw, gh = f.gh;
  const cx = wx / cell, cy = wy / cell, cr = r / cell;
  const x0 = Math.max(0, Math.floor(cx - cr));
  const x1 = Math.min(gw - 1, Math.ceil(cx + cr));
  const y0 = Math.max(0, Math.floor(cy - cr));
  const y1 = Math.min(gh - 1, Math.ceil(cy + cr));
  const cr2 = cr * cr;
  for (let gy = y0; gy <= y1; gy++) {
    const dy = gy + 0.5 - cy;
    const row = gy * gw;
    for (let gx = x0; gx <= x1; gx++) {
      const dx = gx + 0.5 - cx;
      if (dx * dx + dy * dy <= cr2) {
        const idx = row + gx;
        f.vis[idx] = 1;
        if (markSeen) f.seen[idx] = 1;
      }
    }
  }
}

/** Recompute the player's visibility. Self-gates: returns immediately unless
 *  fog is active (playing phase) and the throttle window has elapsed. Pass
 *  force=true to bypass the throttle (e.g. right after spawn commit). */
export function recomputeFog(force = false) {
  if (!state.fogReveal) return;
  const now = performance.now();
  if (!force && now - state._fogLastT < FOG_RECOMPUTE_MS) return;
  state._fogLastT = now;

  const f = ensureFog();
  f.vis.fill(0);
  // Friendly nodes (player + Lieutenant) reveal a town/HQ radius.
  for (const n of state.nodes) {
    if (!isAlly(n.owner, 'player')) continue;
    stampDisc(f, n.x, n.y, n.nodeType === 'capital' ? VISION_CAPITAL : VISION_NODE, true);
  }
  // Friendly fleets reveal a smaller mobile bubble (drones tiniest — many).
  for (const fl of state.fleets) {
    if (!isAlly(fl.owner, 'player')) continue;
    stampDisc(f, fl.x, fl.y, fl.kind === 'drone' ? VISION_DRONE : VISION_FLEET, true);
  }
}

/** Is world point (wx,wy) currently visible to the player? Returns true when
 *  fog is inactive (spawnSelect / disabled) so callers default to "shown". */
export function fogVisibleAt(wx, wy) {
  const f = state.fog;
  if (!f || !state.fogReveal) return true;
  const gx = (wx / f.cell) | 0, gy = (wy / f.cell) | 0;
  if (gx < 0 || gy < 0 || gx >= f.gw || gy >= f.gh) return false;
  return f.vis[gy * f.gw + gx] === 1;
}

/** Has world point (wx,wy) ever been explored? True when fog is inactive. */
export function fogSeenAt(wx, wy) {
  const f = state.fog;
  if (!f || !state.fogReveal) return true;
  const gx = (wx / f.cell) | 0, gy = (wy / f.cell) | 0;
  if (gx < 0 || gy < 0 || gx >= f.gw || gy >= f.gh) return false;
  return f.seen[gy * f.gw + gx] === 1;
}

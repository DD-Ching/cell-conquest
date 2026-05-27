// =====================================================
// Render orchestrator. Sets up frustum + LOD on state._view / state._lod,
// then calls each layer in painter order. Layer implementations live in:
//
//   render-hud.js          DOM: faction roster, timer, speed, zoom
//   render-atmosphere.js   background, dust, terrain, scorches, particles, tracers
//   render-world.js        roads, nets, wrecks, shells, range rings, fleet trails,
//                            placement preview, salvo marker, drag preview, minimap,
//                            hold-fire banner
//   render-entities.js     nodes, turrets, troop fleets, drone fleets, top-layer labels
//
// Anything visible on screen lives in one of those files. This file is
// only orchestration — never add layer logic here.
//
// Public API (re-exported from sub-modules so main.js keeps a single import):
//   render(), renderMinimap(), buildHUD(), updateHUD(),
//   makeSnow(), updateSnow(), updateParticles()
// =====================================================
import { state } from './state.js';

import { buildHUD, updateHUD } from './render-hud.js';
import {
  makeSnow, updateSnow, updateParticles,
  drawBackground, drawTerrain, drawScorches, drawWorldBoundary,
  drawTracers, drawParticles,
} from './render-atmosphere.js';
import {
  drawRoads, drawWreckPiles, drawNets, drawShells,
  drawFleetTrails, drawRangeRings,
  drawPlacementPreview, drawSalvoMarker, drawHoldFireBanner,
  drawDragPreview, renderMinimap,
} from './render-world.js';
import {
  drawNodes, drawTurrets, drawTroopFleets, drawDroneFleets,
  drawNodeLabelsOnTop,
} from './render-entities.js';

// Re-export the public API. main.js still does `import { ... } from './render.js'`.
export { buildHUD, updateHUD };
export { makeSnow, updateSnow, updateParticles };
export { renderMinimap };

export function render() {
  const ctx = state.ctx, W = state.W, H = state.H, zoom = state.zoom;
  const now = performance.now();

  // Frustum bounds in WORLD space — every layer culls entities outside this
  // box before drawing. A generous margin (200 px) handles sprites whose
  // pivot is just off-screen but whose body still leaks into view.
  const vM = 200;
  state._view = {
    vL: state.cameraX - vM,
    vT: state.cameraY - vM,
    vR: state.cameraX + W / zoom + vM,
    vB: state.cameraY + H / zoom + vM,
  };
  // Level-of-Detail tier based on zoom. Bigger maps mean more zoom-out time,
  // and at small sprite sizes the detail doesn't read anyway — skipping it
  // is free perf with no visible loss.
  //   3 = full detail (zoom in close)
  //   2 = medium (skip the smallest decorations + tracers/particles)
  //   1 = pixel-quality (skip individual fleet sprites — render whole columns
  //                       as one colored shape; skip rocks, active scorches,
  //                       fleet trails, range rings, drone HP bars)
  state._lod = zoom >= 1.0 ? 3 : zoom >= 0.6 ? 2 : 1;

  // Screen-space background (no world transform)
  drawBackground(ctx, W, H);

  // World space ------------------------------------------------
  ctx.save();
  ctx.scale(zoom, zoom);
  ctx.translate(-state.cameraX, -state.cameraY);

  drawTerrain(ctx, zoom);
  drawScorches(ctx, zoom, now);
  drawWorldBoundary(ctx, zoom);
  drawRoads(ctx, zoom);
  drawWreckPiles(ctx, zoom);
  drawNets(ctx, zoom);
  drawShells(ctx, zoom);
  drawTracers(ctx, zoom);
  drawFleetTrails(ctx, zoom);
  drawRangeRings(ctx, zoom);
  drawNodes(ctx, zoom, now);
  drawTurrets(ctx, zoom, now);
  drawPlacementPreview(ctx, zoom, now);
  drawTroopFleets(ctx, zoom);
  drawDroneFleets(ctx, zoom, now);
  drawParticles(ctx, zoom);
  if (state.drag && state.drag.moved) drawDragPreview(ctx, zoom);
  drawSalvoMarker(ctx, zoom, now);
  // Always-on-top: node unit counts. Massed troop columns or drone swarms
  // parked on a node would otherwise completely hide the number.
  drawNodeLabelsOnTop(ctx, zoom);

  ctx.restore();
  // --- end world space ----------------------------------------

  drawHoldFireBanner(ctx, W, now);
}

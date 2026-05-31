// =====================================================
// Render orchestrator. Sets up frustum + LOD on state._view / state._lod,
// then calls each layer in painter order. Layer implementations live in:
//
//   render-hud.js          DOM: faction roster, timer, speed, zoom
//   render-atmosphere.js   background, dust (2 parallax layers), terrain, hex
//                            grid, scorches, weather haze, particles, tracers,
//                            heat haze, vignette
//   render-territory.js    bottom-layer faction turf wash (fades in late-game)
//   render-procgen.js      procgen region tint + river/canyon barrier shapes
//   render-world.js        roads, nets, wrecks, shells, range rings, fleet trails
//   render-overlays.js     placement preview, salvo marker, hold-fire banner,
//                            home indicators, drag preview
//   render-minimap.js      bottom-right strategic minimap
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
  makeSnow, updateSnow, updateParticles, bakeTerrain,
  drawBackground, drawTerrain, drawScorches, drawWorldBoundary,
  drawTracers, drawParticles,
  drawHexGrid, drawWeatherHaze, drawHeatHaze, drawVignette,
} from './render-atmosphere.js';
import {
  drawRoads, drawWreckPiles, drawNets, drawShells,
  drawFleetTrails, drawRangeRings,
} from './render-world.js';
import {
  drawPlacementPreview, drawSalvoMarker, drawHoldFireBanner,
  drawDragPreview, drawHomeIndicators, drawSpawnSelect,
} from './render-overlays.js';
import { renderMinimap } from './render-minimap.js';
import {
  drawNodes, drawTurrets, drawTroopFleets, drawDroneFleets,
  drawNodeLabelsOnTop,
} from './render-entities.js';
import { drawTerritory } from './render-territory.js';
import { drawTerritoryBorders } from './render-borders.js';
import { drawProcgen } from './render-procgen.js';
import { drawFog } from './render-fog.js';

// Re-export the public API. main.js still does `import { ... } from './render.js'`.
export { buildHUD, updateHUD };
export { makeSnow, updateSnow, updateParticles, bakeTerrain };
export { renderMinimap };

export function render() {
  // Lazy-init the 2D context. Main.js intentionally defers getContext('2d')
  // so the Render Worker bridge can call transferControlToOffscreen first
  // (transfer fails on a canvas that already has a 2D context). If we got
  // here with no ctx, worker render is NOT in play and we own the canvas.
  if (!state.ctx) state.ctx = state.canvas.getContext('2d');
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
  drawProcgen(ctx, zoom);              // procgen tactical ground: dark wash + region zones + craters + barriers + sector labels
  drawTerritory(ctx);                  // faction turf wash on top of the dark field
  drawHexGrid(ctx, zoom);              // faint tactical-map watermark over terrain
  drawScorches(ctx, zoom, now);
  drawWeatherHaze(ctx, zoom);         // full-screen rust murk before units recede in
  drawWorldBoundary(ctx, zoom);
  drawRoads(ctx, zoom, now);
  drawWreckPiles(ctx, zoom);
  drawNets(ctx, zoom);
  drawShells(ctx, zoom);
  drawTracers(ctx, zoom);
  drawHeatHaze(ctx, zoom, now);       // combat shimmer over fresh-tracer hotspots
  drawFleetTrails(ctx, zoom);
  drawRangeRings(ctx, zoom);
  drawNodes(ctx, zoom, now);
  drawTurrets(ctx, zoom, now);
  drawPlacementPreview(ctx, zoom, now);
  drawTroopFleets(ctx, zoom);
  drawDroneFleets(ctx, zoom, now);
  drawParticles(ctx, zoom);
  if (state.drag && state.drag.moved) drawDragPreview(ctx, zoom);
  drawSpawnSelect(ctx, zoom, now);    // opening "choose your town" rings (no-op once playing)
  drawSalvoMarker(ctx, zoom, now);
  // Always-on-top: node unit counts. Massed troop columns or drone swarms
  // parked on a node would otherwise completely hide the number.
  drawNodeLabelsOnTop(ctx, zoom);

  // Fog of war veil — LAST world-space layer so it shrouds terrain + entities +
  // labels uniformly. Visible/owned areas sit at alpha 0 (crisp); only enemy /
  // unexplored ground is darkened. No-op until the game is playing.
  drawFog(ctx, zoom);

  ctx.restore();
  // --- end world space ----------------------------------------

  // Screen-space vignette: dark corners framing the world. Above everything
  // except the HUD, so it must sit after the world restore + before the banner.
  drawVignette(ctx, W, H);
  drawHoldFireBanner(ctx, W, now);
  // Orientation aid — edge arrows to your bases, but ONLY when none is on
  // screen (you've lost track of your territory). Auto-hides otherwise.
  drawHomeIndicators(ctx, W, H, now);
}

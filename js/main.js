// =====================================================
// Entry point. Wires DOM, builds first game, runs main loop,
// hooks input. All cross-module orchestration lives here.
// =====================================================
import { state } from './state.js';
import {
  WORLD_W, WORLD_H, PAN_SPEED, EDGE_PAN_SPEED, EDGE_PAN_MARGIN,
} from './config.js';
import { AIS, COLOR, rollFactions, factionStats } from './factions.js';
import { dist, formatTime, inboundKey } from './util.js';
import { clampCamera } from './camera.js';
import {
  placeNodes, placeTerrain, buildRoads, adjustHubSizes, findPath,
} from './world.js';
import { sendFleet, simulateFleets } from './fleets.js';
import { isAlly } from './alliance.js';
import {
  resetEngineering,
  updateBuildings, updateTracers, updateScorches,
} from './engineering.js';
import { updateAntiAir, updateTanks, updateArtillery, updateShells } from './combat.js';
import { updateDrones, runFactoryProduction } from './drones.js';
import { aiTick } from './ai.js';
import * as aiBridge from './ai-worker-bridge.js';
import * as renderBridge from './render-worker-bridge.js';
import { ensureLieutenantRegistered } from './subordinate.js';
import { nnLoad, nnResetGame } from './nn.js';
import {
  buildHUD, updateHUD, render,
  makeSnow, updateSnow, updateParticles, bakeTerrain,
} from './render.js';
import { loadAssets } from './sprites.js';
import { loadWasm } from './wasm-bridge.js';
import { applyPreset } from './game-presets.js';
import { generateWorld, pickRegionStarts } from './worldgen.js';
import { initAudio, updateAudio } from './audio.js';
// Input layer (pointer / wheel / keyboard listeners + HUD auto-fade) lives in
// its own module now. main.js calls attachInput() once at boot and reuses
// updateHudFade() to prime panel opacity in newGame().
import { attachInput, updateHudFade } from './input.js';

// =====================================================
// DOM bootstrap & resize
// =====================================================
state.canvas  = document.getElementById('game');
// Minimap removed — it re-plotted every node + every fleet/drone each frame
// (hundreds of draws at late game) for little tactical value. The element is
// gone from the DOM; state.minimap stays null and all minimap code paths are
// guarded on it.
state.minimap = document.getElementById('minimap');   // null now
state.mctx    = state.minimap ? state.minimap.getContext('2d') : null;
// The world canvas's 2D context is created LAZILY (see initWorldCtx). If
// the URL has ?renderWorker=1 we transfer the canvas to the render worker
// BEFORE anything calls getContext('2d') on it (transferControlToOffscreen
// errors out on canvases that already have a 2D context locked in).
function initWorldCtx() {
  if (state.ctx || state.renderInWorker) return;
  state.ctx = state.canvas.getContext('2d');
}
const wantRenderWorker = new URLSearchParams(location.search).get('renderWorker') === '1';

function resize() {
  state.W = innerWidth;
  state.H = innerHeight;
  // When the render worker owns the canvas (transferControlToOffscreen has
  // moved drawing into the worker), setting canvas.width on the main side
  // has no effect on the drawing buffer — the worker's OffscreenCanvas owns
  // dimensions. Setting width also creates a 2D context implicitly, which
  // would PREVENT transferControlToOffscreen later. So we skip it whenever
  // worker render is in play (current OR pending).
  if (!renderBridge.isEnabled() && !state.renderInWorker && !wantRenderWorker) {
    state.canvas.width  = innerWidth;
    state.canvas.height = innerHeight;
  }
  renderBridge.notifyResize(state.W, state.H);
  if (state.minimap) {
    const MM_W = Math.min(240, Math.max(140, Math.floor(state.W * 0.16)));
    const MM_H = Math.floor(MM_W * (WORLD_H / WORLD_W));
    state.minimap.width = MM_W;
    state.minimap.height = MM_H;
    state.minimap.style.width = MM_W + 'px';
    state.minimap.style.height = MM_H + 'px';
  }
  clampCamera();
}
addEventListener('resize', () => { resize(); makeSnow(); });

// =====================================================
// Game lifecycle
// =====================================================
export function newGame() {
  nnResetGame();
  // Roll the lineup (2-5 factions including you), each AI with a random
  // strength multiplier. Rebuild the HUD to reflect the new roster.
  rollFactions();
  ensureLieutenantRegistered();    // ally1 joins the lineup (zero bases until G-press)
  buildHUD();
  // Initial pass with a "mouse far away" coordinate — under the inverted
  // fade rule this leaves every panel at full opacity (readable). Panels
  // start fading only once the cursor approaches them.
  updateHudFade(-9999, -9999);
  state.fleets = [];
  state.particles = [];
  state.selectedIds.clear();
  state.gameOver = false;
  // Tell the render worker (if active) to reset its scorch buffer + dust
  // before the first frame snapshot of the new game arrives.
  renderBridge.notifyNewGame();
  document.getElementById('message').style.display = 'none';
  state.startTime = performance.now();
  state.elapsed = 0;
  // Reset Mars weather alongside the clock — lastChangeT is measured against
  // state.elapsed, so leaving it stale would freeze the weather machine (and
  // any in-progress sandstorm) for minutes into the new game.
  state.weather.intensity = 0;
  state.weather.target = 0;
  state.weather.lastChangeT = 0;
  state.aiTimers = {};
  // Short opening window — AI starts land-grabbing almost immediately so the
  // player can't quietly take every neutral while the AI sleeps.
  for (const ai of AIS) state.aiTimers[ai] = 1.5 + Math.random() * 1.0;
  makeSnow();

  // World gen
  placeTerrain();
  bakeTerrain();          // one-time bake — every frame thereafter is a single drawImage
  if (state.procgen) {
    // Geography-first generator (regions → nodes → roads). Replaces the legacy
    // scatter+mesh; outputs the same state.nodes/roads/adj shape. An unpinned
    // seed re-rolls each new game (fresh map on R); ?seed=N pins it (replayable).
    if (!state.seedPinned) state.worldSeed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    generateWorld(state.worldSeed, state.worldThemeKey);
  } else {
    placeNodes();
    buildRoads();
  }
  adjustHubSizes();

  // Faction starts. Procgen: one capital per DISTINCT high-value region, spread
  // out + with viable expansion (worldgen.pickRegionStarts) so each faction has
  // a geographic identity instead of a random corner. Legacy gen — or any
  // shortfall — falls back to farthest-point from already-placed starts. Stats
  // are applied identically regardless of how the node was chosen.
  // Skip 'ally1' — the Lieutenant is YOUR AI, not a separate faction. It starts
  // with zero bases; the player grows it by pressing G to delegate.
  const factionOwners = ['player', ...AIS].filter(o => o !== 'ally1');
  const placed = [];
  function applyCapitalStats(node, owner) {
    const fs = factionStats[owner];
    const strength = fs ? fs.strength : 1.0;
    node.owner     = owner;
    node.units     = Math.floor(48 * strength);
    node.size      = Math.floor(38 * (0.92 + (strength - 1) * 0.35));
    node.capacity  = Math.floor(145 * strength);
    node.regenRate = 1.5 * (0.88 + (strength - 1) * 0.6);
    node.nodeType  = 'capital';   // HQ double-ring tactical icon (both gen modes)
  }
  function pickFarNode() {
    let best = null, bestD = -1;
    for (const n of state.nodes) {
      if (n.owner !== 'neutral') continue;
      let minD;
      if (placed.length === 0) minD = dist(n, { x: WORLD_W / 2, y: WORLD_H / 2 });
      else { minD = Infinity; for (const o of placed) { const d = dist(n, o); if (d < minD) minD = d; } }
      if (minD > bestD) { bestD = minD; best = n; }
    }
    return best;
  }
  const regionStarts = state.procgen ? pickRegionStarts(factionOwners.length) : [];
  factionOwners.forEach((owner, i) => {
    let node = (regionStarts[i] != null) ? state.nodes[regionStarts[i]] : null;
    if (!node || node.owner !== 'neutral') node = pickFarNode();
    if (node) { applyCapitalStats(node, owner); placed.push(node); }
  });

  // Center on player
  const playerStart = state.nodes.find(n => n.owner === 'player');
  if (playerStart) {
    state.cameraX = playerStart.x - state.W / (2 * state.zoom);
    state.cameraY = playerStart.y - state.H / (2 * state.zoom);
    clampCamera();
  }

  resetEngineering();
  state.lastTime = performance.now();
}
// Expose for HTML button (Play Again)
window.newGame = newGame;

function checkVictory() {
  if (state.gameOver) return;
  const owners = new Set(state.nodes.map(n => n.owner));
  for (const f of state.fleets) owners.add(f.owner);
  owners.delete('neutral');
  // "Your side" = any owner allied with the player (player + Lieutenant
  // are on the same side). Defeat only triggers when NO ally of yours
  // owns a node or in-flight fleet — delegating every base to the
  // Lieutenant must NOT end the game.
  let yoursAlive = false;
  let enemyAlive = false;
  for (const o of owners) {
    if (isAlly(o, 'player')) yoursAlive = true;
    else                     enemyAlive = true;
  }
  if (!yoursAlive)      endGame(false, 'Your forces have been wiped out.');
  else if (!enemyAlive) endGame(true,  `Total domination in ${formatTime(state.elapsed)}.`);
}

function endGame(win, sub) {
  state.gameOver = true;
  const m = document.getElementById('message');
  const title = document.getElementById('msg-title');
  title.textContent = win ? 'Victory' : 'Defeat';
  // Use the warm-toned accent palette for both — feels consistent with the rest of the UI.
  title.style.color = win ? '#ffd066' : '#ff6678';
  title.style.textShadow = win
    ? '0 0 24px rgba(255, 200, 90, 0.55)'
    : '0 0 24px rgba(255, 100, 110, 0.55)';
  document.getElementById('msg-sub').textContent = sub;
  // Cinematic split: victory / defeat get distinct entrance, glow, and CTA
  // styling via these classes. Always strip the other class first so back-to-back
  // game-overs don't inherit the previous outcome's flavor.
  m.classList.remove(win ? 'defeat' : 'victory');
  m.classList.add(win ? 'victory' : 'defeat');
  // Force the CSS entrance animation to replay on every show
  m.style.display = 'none';
  void m.offsetHeight;        // trigger reflow
  m.style.display = 'block';
}

// =====================================================
// Main loop
// =====================================================
function simulate(dt, combatDt = dt) {
  // Refresh id-lookup caches once per tick — every downstream system can do
  // O(1) state.turretById.get(id) / state.fleetById.get(id) instead of an
  // O(N) array.find. (Splices during this tick may leave deleted entries
  // in the map; consumers gate on falsy result, which is the same check
  // they already did before.)
  state.turretById.clear();
  // Reuse bucket arrays across rebuilds — zero each instead of dropping it
  // (.clear() churns GC ×20/frame at fast-forward). Contents are still rebuilt
  // every sub-step so freshness is identical; an empty bucket that lingers for a
  // now-unoccupied owner/type/cell reads the same as an absent key — every
  // consumer uses `.get()||[]` or guards n===0 (see drones.rebuildLoiterCenters).
  for (const b of state.turretsByOwner.values()) b.length = 0;
  for (const b of state.turretsByType.values()) b.length = 0;
  for (const b of state.turretGrid.values()) b.length = 0;
  const GRID_CELL = 250;
  for (const t of state.turrets) {
    state.turretById.set(t.id, t);
    let oBucket = state.turretsByOwner.get(t.owner);
    if (!oBucket) { oBucket = []; state.turretsByOwner.set(t.owner, oBucket); }
    oBucket.push(t);
    let tBucket = state.turretsByType.get(t.type);
    if (!tBucket) { tBucket = []; state.turretsByType.set(t.type, tBucket); }
    tBucket.push(t);
    const gKey = Math.floor(t.x / GRID_CELL) * 10000 + Math.floor(t.y / GRID_CELL);
    let gBucket = state.turretGrid.get(gKey);
    if (!gBucket) { gBucket = []; state.turretGrid.set(gKey, gBucket); }
    gBucket.push(t);
  }
  state.fleetById.clear();
  state.droneCountByOwner.clear();
  state.inboundDronesByTarget.clear();
  // Bucket maps: zero-and-reuse the arrays (see turret grids above).
  for (const b of state.droneGrid.values()) b.length = 0;
  for (const b of state.groundFleetGrid.values()) b.length = 0;
  for (const f of state.fleets) {
    state.fleetById.set(f._id, f);
    const fKey = Math.floor(f.x / GRID_CELL) * 10000 + Math.floor(f.y / GRID_CELL);
    if (f.kind === 'drone') {
      let bucket = state.droneGrid.get(fKey);
      if (!bucket) { bucket = []; state.droneGrid.set(fKey, bucket); }
      bucket.push(f);
      // Per-owner active-drone tally for the factory production cap.
      state.droneCountByOwner.set(f.owner, (state.droneCountByOwner.get(f.owner) || 0) + 1);
      // Inbound-per-target tally so the target picker can avoid overkill.
      if (f.targetKind && f.targetId !== undefined) {
        const tKey = inboundKey(f.targetKind, f.targetId);
        state.inboundDronesByTarget.set(tKey, (state.inboundDronesByTarget.get(tKey) || 0) + 1);
      }
    } else {
      let bucket = state.groundFleetGrid.get(fKey);
      if (!bucket) { bucket = []; state.groundFleetGrid.set(fKey, bucket); }
      bucket.push(f);
    }
  }

  // Stripped-owner tally: an owner is "stripped" (not worth dumping a suicide
  // salvo into) when they have ZERO active production turrets AND low total
  // units — a crippled faction that regen-and-dies; ground troops mop it up.
  // The drone SPAWN/SALVO pickers consult this set (in-flight drones commit
  // and never re-check it — see droneTargetExists).
  //
  // HYSTERESIS: a single units<60 threshold made the flag CHATTER as a
  // dying base regened across the line, which flip-flopped each new wave's
  // target. Two-band sticky test instead: cross DOWN below STRIP_LO to
  // become stripped, climb UP past STRIP_HI to recover. Between the bands
  // the previous state holds, so a base oscillating around ~60 keeps a
  // steady classification and the AI's attack focus stops thrashing.
  {
    const activeTurretsByOwner = new Map();
    for (const t of state.turrets) {
      if (!t.active) continue;
      activeTurretsByOwner.set(t.owner, (activeTurretsByOwner.get(t.owner) || 0) + 1);
    }
    const unitsByOwner = new Map();
    for (const n of state.nodes) {
      if (n.owner === 'neutral') continue;
      unitsByOwner.set(n.owner, (unitsByOwner.get(n.owner) || 0) + n.units);
    }
    const STRIP_LO = 45, STRIP_HI = 90;
    const prev = state.strippedOwners;
    const next = new Set();
    for (const [owner, units] of unitsByOwner) {
      const noProduction = (activeTurretsByOwner.get(owner) || 0) === 0;
      if (!noProduction) continue;                 // has a factory/turret → real threat
      const wasStripped = prev.has(owner);
      // sticky band: stay in prior state between LO and HI.
      if (wasStripped ? units < STRIP_HI : units < STRIP_LO) next.add(owner);
    }
    state.strippedOwners = next;
  }

  // Visual decays only. Unit regen is now LAZY — see world.catchUpRegen.
  // Owned nodes accrue on-demand at every read/write site (AI tick, HUD
  // sum, render of visible node, sendFleet, arriveAt) so the per-sub-tick
  // ALL-nodes regen pass goes away. At 1200 Hz × 900 nodes that pass was
  // ~1.08M ops/sec; lazy refresh runs at ~14 Hz aggregate (AI + HUD).
  for (const n of state.nodes) {
    if (n.pulse > 0) n.pulse -= dt * 1.6;
    if (n.flash > 0) n.flash -= dt * 2.5;
  }
  updateBuildings(dt);
  // Combat phases gate on combatDt: when the caller passes 0 we skip the
  // whole damage pass for this sub-step. Movement / production / drone
  // updates still run every sub-step so the world doesn't visually stutter.
  // DPS × dt is preserved because the active combat ticks use a doubled dt.
  if (combatDt > 0) {
    updateAntiAir(combatDt);
    updateTanks(combatDt);
    updateArtillery(combatDt);
    updateShells(combatDt);
  }
  updateDrones(dt);
  simulateFleets(dt);
}

function loop() {
  const now = performance.now();
  const realDt = Math.min(0.05, (now - state.lastTime) / 1000);
  state.lastTime = now;
  const gameDt = realDt * state.timeScale;

  if (!state.gameOver) {
    // Camera input
    const sp = 1 / state.zoom;
    if (state.panKeys.up)    state.cameraY -= PAN_SPEED * realDt * sp;
    if (state.panKeys.down)  state.cameraY += PAN_SPEED * realDt * sp;
    if (state.panKeys.left)  state.cameraX -= PAN_SPEED * realDt * sp;
    if (state.panKeys.right) state.cameraX += PAN_SPEED * realDt * sp;
    if (state.mouseScreen.x >= 0 && state.mouseScreen.y >= 0 &&
        state.mouseScreen.x < state.W && state.mouseScreen.y < state.H) {
      if (state.mouseScreen.x < EDGE_PAN_MARGIN) state.cameraX -= EDGE_PAN_SPEED * realDt * sp;
      else if (state.mouseScreen.x > state.W - EDGE_PAN_MARGIN) state.cameraX += EDGE_PAN_SPEED * realDt * sp;
      if (state.mouseScreen.y < EDGE_PAN_MARGIN) state.cameraY -= EDGE_PAN_SPEED * realDt * sp;
      else if (state.mouseScreen.y > state.H - EDGE_PAN_MARGIN) state.cameraY += EDGE_PAN_SPEED * realDt * sp;
    }
    clampCamera();
  }

  state.mousePos.x = state.mouseScreen.x / state.zoom + state.cameraX;
  state.mousePos.y = state.mouseScreen.y / state.zoom + state.cameraY;
  if (state.drag && !state.middlePan) {
    state.drag.x = state.mousePos.x;
    state.drag.y = state.mousePos.y;
  }

  if (!state.gameOver && !state.paused) {
    // Sub-step count is derived from a SAFE maximum dt, not a fixed cap, so a
    // faster gear never enlarges the per-step dt past the value the sim is
    // proven stable at. 20× worst case (realDt pegged at 0.05) was subDt 0.1
    // and combat dt 0.2 — rock solid — so we hold every speed to that bound.
    // 40× on a hitching frame (gameDt 2.0) therefore runs up to 20 sub-steps
    // of 0.1 rather than 10 of 0.2 (the latter blew unit counts to NaN). On a
    // smooth 60 fps frame it's only ~7 sub-steps — the count scales with real
    // frame time, so fast frames stay cheap and slow frames stay numerically
    // safe. Capped at 20 so a pathological hitch can't explode the budget.
    const MAX_SUBDT = 0.1;
    const subSteps = Math.max(1, Math.min(20, Math.ceil(gameDt / MAX_SUBDT)));
    const subDt = gameDt / subSteps;
    // Combat decimation at high time-scale: damage passes run every Nth
    // sub-step with N×dt, while movement / production / drone updates still
    // run every step. Same DPS × game-time, ~half the combat work at 10×+.
    const combatDecimate = subSteps >= 4 ? 2 : 1;
    const simT0 = performance.now();
    // Cosmetic VFX advance ONCE per frame, BEFORE the sub-steps spawn this
    // frame's new puffs — so every fresh particle / tracer / scorch still
    // renders at least one frame at full brightness (even at 40×, where gameDt
    // can exceed a puff's sub-second lifetime) before it ages next frame.
    // Linear aging makes one gameDt step identical to N subDt steps, and VFX are
    // never read by sim / AI / pathing. Previously these ran INSIDE the loop —
    // up to 20×/frame at fast-forward — for zero visual benefit.
    updateParticles(gameDt);
    updateTracers(gameDt);
    updateScorches(gameDt);
    for (let s = 0; s < subSteps; s++) {
      const runCombat = (s % combatDecimate === 0);
      simulate(subDt, runCombat ? subDt * combatDecimate : 0);
      // AI tick: when the worker is enabled, it handles every owner except
      // NN-controlled factions (NN still needs main-thread access to
      // onnxruntime + DOM). Worker maintains its own ~100 ms snapshot
      // cadence — tickFrame is cheap when nothing's due.
      aiBridge.tickFrame(subDt);
      for (const ai of AIS) {
        if (aiBridge.shouldMainThreadTick(ai)) aiTick(ai, subDt);
      }
    }
    // Drone-factory production runs ONCE per frame at game-time rate (not per
    // sub-step). It's the single authority for build/hold/launch across every
    // owner — see drones.runFactoryProduction. Runs after the sub-step loop so
    // the per-tick caches it reads (droneCountByOwner, turretGrid, inbound) are
    // freshly built. DF_PRODUCTION_T (5 s) >> one frame's gameDt even at 40×, so
    // once-per-frame keeps the exact production cadence the per-sub-step version
    // had, with far fewer launch-decision points (less bursty).
    runFactoryProduction(gameDt);
    state._perfSimMs[state._perfIdx] = performance.now() - simT0;
    state.elapsed += gameDt;
    checkVictory();
  }
  // Record real-frame duration into the rolling perf buffer regardless of
  // pause / gameOver (so the HUD keeps updating with FPS even when paused).
  state._perfFrameMs[state._perfIdx] = realDt * 1000;
  state._perfIdx = (state._perfIdx + 1) % state._perfFrameMs.length;
  updateSnow(realDt);
  updateAudio(realDt);     // drone-swarm buzz + AA gunfire, spatialised by the live view
  updateHUD();
  // World canvas: either the worker renders it OR we do it locally on the
  // main thread. The worker owns the canvas after transferControlToOffscreen
  // so we must NOT call render() once it's enabled (the local main canvas
  // is no longer drawable). HUD + minimap stay main-thread regardless.
  if (renderBridge.isEnabled()) {
    renderBridge.tickFrame();
  } else {
    render();
  }
  requestAnimationFrame(loop);
}

// =====================================================
// Boot
// =====================================================
// Preset MUST be applied first — resize() reads WORLD_W/WORLD_H for the
// minimap aspect ratio, and every downstream module (world.js node
// placement, camera clamp, scorch buffer alloc) imports those values too.
// ESM live bindings carry the new values to importers automatically once
// applyPreset mutates the `let` exports in config.js.
const presetName = new URLSearchParams(location.search).get('preset');
applyPreset(presetName);

// Procedural map generation — now the DEFAULT (geography-first generator + the
// tactical command-map art). ?procgen=0 falls back to the legacy world.js
// scatter+mesh. ?seed=N pins a deterministic, replayable map (otherwise each new
// game rolls a fresh seed).
const _mapParams = new URLSearchParams(location.search);
state.procgen = _mapParams.get('procgen') !== '0';
const _seedParam = _mapParams.get('seed');
state.seedPinned = _seedParam != null;
if (state.seedPinned) state.worldSeed = parseInt(_seedParam, 10) >>> 0;
// ?world=<theme> forces a world climate/setting (red_desert, dried_ocean,
// fractured_mountain, crater_belt, ruined_megacity, polar_corridor,
// river_civilization, war_scar). Distinct from the faction ?theme= palette.
state.worldThemeKey = _mapParams.get('world') || null;

// Render worker MUST be enabled before resize() (which would otherwise
// touch canvas.width and before initWorldCtx() gets called by anything).
// We do it first when the URL flag is set.
if (wantRenderWorker) {
  renderBridge.enable();
}
resize();
attachInput();
initAudio();            // arm Web Audio (context starts on first click/key — autoplay policy)
loadAssets();           // try to load PNGs from assets/; sprites fall back to primitives
loadWasm();             // lazy-load Rust hot loops; drones.js falls back to JS until ready
newGame();              // rolls factions, builds HUD, generates world
loop();
nnLoad();

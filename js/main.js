// =====================================================
// Entry point. Wires DOM, builds first game, runs main loop,
// hooks input. All cross-module orchestration lives here.
// =====================================================
import { state } from './state.js';
import {
  WORLD_W, WORLD_H, PAN_SPEED, EDGE_PAN_SPEED, EDGE_PAN_MARGIN, SPEEDS,
  NET_PICK_R,
} from './config.js';
import { AIS, COLOR, rollFactions, factionStats } from './factions.js';
import { dist, formatTime } from './util.js';
import { clampCamera, zoomBy } from './camera.js';
import {
  placeNodes, placeTerrain, buildRoads, adjustHubSizes, findPath, nodeAt, roadAt, turretAt,
} from './world.js';
import { sendFleet, assaultTurret, simulateFleets } from './fleets.js';
import { isAlly } from './alliance.js';
import {
  resetEngineering, placeTurretAt, placeNetOnEdge,
  updateBuildings, updateTracers, updateScorches,
} from './engineering.js';
import { updateAntiAir, updateTanks, updateArtillery, updateShells } from './combat.js';
import { updateDrones, releasePlayerStockpile } from './drones.js';
import { aiTick } from './ai.js';
import * as aiBridge from './ai-worker-bridge.js';
import { toggleDelegationAt, ensureLieutenantRegistered } from './subordinate.js';
import { nnLoad, nnResetGame } from './nn.js';
import {
  buildHUD, updateHUD, render, renderMinimap,
  makeSnow, updateSnow, updateParticles, bakeTerrain,
} from './render.js';
import { loadAssets } from './sprites.js';
import { loadWasm, toggleWasm } from './wasm-bridge.js';

// =====================================================
// DOM bootstrap & resize
// =====================================================
state.canvas  = document.getElementById('game');
state.ctx     = state.canvas.getContext('2d');
state.minimap = document.getElementById('minimap');
state.mctx    = state.minimap.getContext('2d');

function resize() {
  state.W = state.canvas.width  = innerWidth;
  state.H = state.canvas.height = innerHeight;
  const MM_W = Math.min(240, Math.max(140, Math.floor(state.W * 0.16)));
  const MM_H = Math.floor(MM_W * (WORLD_H / WORLD_W));
  state.minimap.width = MM_W;
  state.minimap.height = MM_H;
  state.minimap.style.width = MM_W + 'px';
  state.minimap.style.height = MM_H + 'px';
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
  // Start every overlay panel in the faded state — the map is what matters
  // right after a (re)start. Mouse-over un-fades each panel individually.
  updateHudFade(-9999, -9999);
  state.fleets = [];
  state.particles = [];
  state.selectedIds.clear();
  state.gameOver = false;
  document.getElementById('message').style.display = 'none';
  state.startTime = performance.now();
  state.elapsed = 0;
  state.aiTimers = {};
  // Short opening window — AI starts land-grabbing almost immediately so the
  // player can't quietly take every neutral while the AI sleeps.
  for (const ai of AIS) state.aiTimers[ai] = 1.5 + Math.random() * 1.0;
  makeSnow();

  // World gen
  placeTerrain();
  bakeTerrain();          // one-time bake — every frame thereafter is a single drawImage
  placeNodes();
  buildRoads();
  adjustHubSizes();

  // Faction starts (spread out)
  const placed = [];
  function pickFar(owner, others) {
    let best = null, bestD = -1;
    for (const n of state.nodes) {
      if (n.owner !== 'neutral') continue;
      let minD;
      if (others.length === 0) minD = dist(n, { x: WORLD_W / 2, y: WORLD_H / 2 });
      else { minD = Infinity; for (const o of others) { const d = dist(n, o); if (d < minD) minD = d; } }
      if (minD > bestD) { bestD = minD; best = n; }
    }
    if (best) {
      const fs = factionStats[owner];
      const strength = fs ? fs.strength : 1.0;
      best.owner = owner;
      best.units    = Math.floor(48 * strength);
      best.size     = Math.floor(38 * (0.92 + (strength - 1) * 0.35));
      best.capacity = Math.floor(145 * strength);
      best.regenRate = 1.5 * (0.88 + (strength - 1) * 0.6);
    }
    return best;
  }
  for (const owner of ['player', ...AIS]) {
    const n = pickFar(owner, placed);
    if (n) placed.push(n);
  }

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
  if (!owners.has('player')) endGame(false, 'Your forces have been wiped out.');
  else if (owners.size === 1) endGame(true, `Total domination in ${formatTime(state.elapsed)}.`);
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
  state.turretsByOwner.clear();
  state.turretsByType.clear();
  state.turretGrid.clear();
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
  state.droneGrid.clear();
  state.groundFleetGrid.clear();
  state.droneCountByOwner.clear();
  state.inboundDronesByTarget.clear();
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
        const tKey = f.targetKind + ':' + f.targetId;
        state.inboundDronesByTarget.set(tKey, (state.inboundDronesByTarget.get(tKey) || 0) + 1);
      }
    } else {
      let bucket = state.groundFleetGrid.get(fKey);
      if (!bucket) { bucket = []; state.groundFleetGrid.set(fKey, bucket); }
      bucket.push(f);
    }
  }

  // Stripped-owner tally: an owner is "stripped" (no longer worth a suicide
  // drone strike) when they have ZERO active production turrets AND total
  // units < 60. Those bases regen-and-die in the 10↔10 oscillation pattern —
  // dumping drones in is wasted ordnance, ground troops will mop up. The
  // suicide-drone judgment sites in drones.js consult this set.
  state.strippedOwners.clear();
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
    for (const [owner, units] of unitsByOwner) {
      if ((activeTurretsByOwner.get(owner) || 0) === 0 && units < 60) {
        state.strippedOwners.add(owner);
      }
    }
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
    // Cap sub-steps so 20× timescale doesn't blow the per-frame sim budget.
    // Above 10 substeps, each step gets a larger dt but movement granularity
    // is still well under DETOUR_LOOKAHEAD / DRONE_DETECT_R (a fleet moves
    // ≤ 9 px per sub-step even at speed 20×, so wreck detour + drone hunt
    // still work). Combat damage is dt-scaled so DPS outcome unchanged.
    const subSteps = Math.max(1, Math.min(10, Math.ceil(state.timeScale)));
    const subDt = gameDt / subSteps;
    // Combat decimation at high time-scale: damage passes run every Nth
    // sub-step with N×dt, while movement / production / drone updates still
    // run every step. Same DPS × game-time, ~half the combat work at 10×+.
    const combatDecimate = subSteps >= 4 ? 2 : 1;
    const simT0 = performance.now();
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
      updateParticles(subDt);
      updateTracers(subDt);
      updateScorches(subDt);
    }
    state._perfSimMs[state._perfIdx] = performance.now() - simT0;
    state.elapsed += gameDt;
    checkVictory();
  }
  // Record real-frame duration into the rolling perf buffer regardless of
  // pause / gameOver (so the HUD keeps updating with FPS even when paused).
  state._perfFrameMs[state._perfIdx] = realDt * 1000;
  state._perfIdx = (state._perfIdx + 1) % state._perfFrameMs.length;
  updateSnow(realDt);
  updateHUD();
  render();
  renderMinimap();
  requestAnimationFrame(loop);
}

// =====================================================
// HUD auto-fade — overlay panels dim to 0.3 opacity when the mouse is far,
// jump back to full when the mouse approaches. Lets the map stay readable
// while keeping the chrome one mouse-move away. CSS does the transition;
// this function flips the `.hud-faded` class per panel based on proximity.
// =====================================================
const HUD_FADE_IDS = ['title-strip', 'hud', 'topright', 'help', 'nn-badge'];
const HUD_TRIGGER_PAD = 60;       // px of "near enough" buffer around each panel
function updateHudFade(mx, my) {
  for (const id of HUD_FADE_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const near = mx >= r.left - HUD_TRIGGER_PAD && mx <= r.right + HUD_TRIGGER_PAD &&
                 my >= r.top  - HUD_TRIGGER_PAD && my <= r.bottom + HUD_TRIGGER_PAD;
    if (near) el.classList.remove('hud-faded');
    else      el.classList.add('hud-faded');
  }
}

// =====================================================
// Input handlers
// =====================================================
function attachInput() {
  const c = state.canvas;
  c.addEventListener('contextmenu', e => e.preventDefault());

  c.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    zoomBy(factor, e.clientX, e.clientY);
  }, { passive: false });

  c.addEventListener('mousedown', e => {
    if (e.button === 1) {
      e.preventDefault();
      state.middlePan = {
        startSX: e.clientX, startSY: e.clientY,
        startCamX: state.cameraX, startCamY: state.cameraY,
      };
      return;
    }
    if (e.button !== 0 || state.gameOver) return;
    state.mouseScreen = { x: e.clientX, y: e.clientY };
    const wx = e.clientX / state.zoom + state.cameraX;
    const wy = e.clientY / state.zoom + state.cameraY;

    // Placement mode: clicking confirms placement. Drag to PAINT a row of them.
    // Shift held at release keeps the mode active for the next placement.
    // 'net' targets road segments (per-edge); other types target world points.
    if (state.placeMode) {
      const type = state.placeMode.type;
      const byOwner = state.placeMode.byOwner;
      // First placement at the click point
      if (type === 'net') {
        const r = roadAt(wx, wy, NET_PICK_R);
        if (r) placeNetOnEdge(r.a, r.b, byOwner);
      } else {
        placeTurretAt(wx, wy, type, byOwner);
      }
      // Start paint state so dragging lays more along the path
      state.painting = {
        type, byOwner,
        lastX: wx, lastY: wy,
        step: type === 'net' ? 30 : 40,    // world-px between drag placements
        placedEdges: new Set(),
      };
      return;
    }

    const n = nodeAt(wx, wy);
    state.drag = {
      startX: wx, startY: wy, x: wx, y: wy,
      originNode: n, mode: 'pending', moved: false,
      shift: e.shiftKey, ctrl: e.metaKey || e.ctrlKey,
    };
  });

  c.addEventListener('mousemove', e => {
    state.mouseScreen = { x: e.clientX, y: e.clientY };
    updateHudFade(e.clientX, e.clientY);
    if (state.middlePan) {
      state.cameraX = state.middlePan.startCamX - (e.clientX - state.middlePan.startSX) / state.zoom;
      state.cameraY = state.middlePan.startCamY - (e.clientY - state.middlePan.startSY) / state.zoom;
      clampCamera();
      return;
    }
    // Drag-paint: while in placeMode and the mouse is held, lay down more
    // placements at fixed intervals along the drag path.
    if (state.painting) {
      const wx = e.clientX / state.zoom + state.cameraX;
      const wy = e.clientY / state.zoom + state.cameraY;
      const dx = wx - state.painting.lastX;
      const dy = wy - state.painting.lastY;
      const d = Math.hypot(dx, dy);
      const step = state.painting.step;
      if (d >= step) {
        const ux = dx / d, uy = dy / d;
        const steps = Math.floor(d / step);
        for (let i = 1; i <= steps; i++) {
          const px = state.painting.lastX + ux * step * i;
          const py = state.painting.lastY + uy * step * i;
          if (state.painting.type === 'net') {
            const r = roadAt(px, py, NET_PICK_R);
            if (r) {
              const ek = r.a < r.b ? `${r.a}_${r.b}` : `${r.b}_${r.a}`;
              if (!state.painting.placedEdges.has(ek)) {
                if (placeNetOnEdge(r.a, r.b, state.painting.byOwner)) {
                  state.painting.placedEdges.add(ek);
                }
              }
            }
          } else {
            placeTurretAt(px, py, state.painting.type, state.painting.byOwner);
          }
        }
        state.painting.lastX += ux * step * steps;
        state.painting.lastY += uy * step * steps;
      }
      return;
    }
    if (!state.drag) return;
    state.drag.x = e.clientX / state.zoom + state.cameraX;
    state.drag.y = e.clientY / state.zoom + state.cameraY;
    if (!state.drag.moved) {
      const dx = state.drag.x - state.drag.startX;
      const dy = state.drag.y - state.drag.startY;
      const thresh = 25 / (state.zoom * state.zoom);
      if (dx * dx + dy * dy > thresh) {
        state.drag.moved = true;
        // Drag from EITHER a player node OR a Lieutenant node = command-send.
        // The Lieutenant is conceptually the player's AI; player retains
        // override authority. Fleet owner remains the source-node owner
        // (ally1's drag → ally1's fleet → combat behaves the same).
        if (state.drag.originNode && isAlly(state.drag.originNode.owner, 'player')) state.drag.mode = 'send';
        else if (!state.drag.originNode) state.drag.mode = 'box';
        else state.drag.mode = 'none';
      }
    }
  });

  c.addEventListener('mouseup', e => {
    if (e.button === 1 && state.middlePan) { state.middlePan = null; return; }
    // End drag-paint. Shift held at release keeps place mode active so you
    // can immediately start another row without re-pressing Q/T/F/C/N.
    if (state.painting) {
      if (!e.shiftKey) state.placeMode = null;
      state.painting = null;
      return;
    }
    if (e.button !== 0 || !state.drag) return;
    if (state.gameOver) { state.drag = null; return; }
    const wx = e.clientX / state.zoom + state.cameraX;
    const wy = e.clientY / state.zoom + state.cameraY;
    const d = state.drag;
    if (!d.moved) {
      // Hold-Fire mode: a click on an enemy turret or enemy/neutral node
      // designates it as the salvo target. On H release, the whole stockpile
      // converges on this single point.
      if (state.holdFire) {
        const picked = turretAt(wx, wy, 'player');
        if (picked) {
          state.salvoTarget = { kind: 'turret', id: picked.id, x: picked.x, y: picked.y };
          state.drag = null;
          return;
        }
        if (d.originNode && !isAlly(d.originNode.owner, 'player')) {
          state.salvoTarget = { kind: 'node', id: d.originNode.id, x: d.originNode.x, y: d.originNode.y };
          state.drag = null;
          return;
        }
      }
      if (!d.originNode) {
        if (!d.shift && !d.ctrl) state.selectedIds.clear();
      } else if (isAlly(d.originNode.owner, 'player')) {
        // Player + Lieutenant nodes are selectable / command-able from the
        // player's UI (the Lieutenant is the player's AI agent — same side).
        if (d.ctrl) {
          if (state.selectedIds.has(d.originNode.id)) state.selectedIds.delete(d.originNode.id);
          else state.selectedIds.add(d.originNode.id);
        } else {
          state.selectedIds.clear();
          state.selectedIds.add(d.originNode.id);
        }
      }
    } else if (d.mode === 'send') {
      const releaseNode = nodeAt(wx, wy);
      // First check: did we release on an enemy turret? → assault dispatch.
      // Pending sites (engineer en route) are dirt placeholders, not real
      // structures — can't assault what isn't there yet. turretAt() handles
      // both the pendingEngineer filter and zoom-aware pick tolerance.
      const targetTurret = turretAt(wx, wy, 'player');
      const sources = state.selectedIds.has(d.originNode.id)
        ? [...state.selectedIds].map(id => state.nodes[id]).filter(nd => nd && isAlly(nd.owner, 'player'))
        : [d.originNode];
      if (targetTurret) {
        for (const from of sources) {
          if (!from || !isAlly(from.owner, 'player') || from.units < 2) continue;
          const amt = d.shift ? Math.floor(from.units) : Math.floor(from.units / 2);
          assaultTurret(from, targetTurret, amt);
        }
      } else if (releaseNode && releaseNode.id !== d.originNode.id) {
        for (const from of sources) {
          if (!from || !isAlly(from.owner, 'player') || from.id === releaseNode.id || from.units < 2) continue;
          const amt = d.shift ? Math.floor(from.units) : Math.floor(from.units / 2);
          sendFleet(from, releaseNode, amt);
        }
      }
    } else if (d.mode === 'box') {
      if (!d.shift && !d.ctrl) state.selectedIds.clear();
      const x1 = Math.min(d.startX, wx), x2 = Math.max(d.startX, wx);
      const y1 = Math.min(d.startY, wy), y2 = Math.max(d.startY, wy);
      for (const nd of state.nodes) {
        // Box-select pulls in both player and Lieutenant nodes (same side).
        if (isAlly(nd.owner, 'player') && nd.x >= x1 && nd.x <= x2 && nd.y >= y1 && nd.y <= y2) {
          state.selectedIds.add(nd.id);
        }
      }
    }
    state.drag = null;
  });

  c.addEventListener('dblclick', () => {
    state.selectedIds.clear();
    // Double-click selects ALL friendly bases (player + Lieutenant).
    for (const n of state.nodes) if (isAlly(n.owner, 'player')) state.selectedIds.add(n.id);
  });

  c.addEventListener('mouseleave', () => {
    state.mouseScreen = { x: -999, y: -999 };
  });

  addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'arrowup')    { state.panKeys.up = true; e.preventDefault(); }
    if (k === 's' || k === 'arrowdown')  { state.panKeys.down = true; e.preventDefault(); }
    if (k === 'a' || k === 'arrowleft')  { state.panKeys.left = true; e.preventDefault(); }
    if (k === 'd' || k === 'arrowright') { state.panKeys.right = true; e.preventDefault(); }
    if (e.key === 'Escape') { state.selectedIds.clear(); state.placeMode = null; state.salvoTarget = null; state.painting = null; }
    if (k === 'r') newGame();
    // HUD management: Tab fully hides the chrome (battle-only view); ? (or /)
    // toggles the expanded controls reference. Both keep the canvas clean
    // when the player needs the area under a panel.
    if (e.key === 'Tab')  { e.preventDefault(); document.body.classList.toggle('hud-hidden'); }
    if (e.key === '?' || e.key === '/') { e.preventDefault(); document.body.classList.toggle('help-open'); }
    // Pause toggle (Space). Sim, AI, particles, and elapsed clock freeze;
    // camera + render + HUD keep working so the player can survey + plan.
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      state.paused = !state.paused;
      document.body.classList.toggle('paused', state.paused);
    }
    // Minimap collapse (M). Toggles a body class that the CSS uses to slide
    // / hide the bottom-right minimap when the player wants that screen real
    // estate for clicking on a node hiding under it.
    if (k === 'm') {
      e.preventDefault();
      document.body.classList.toggle('minimap-hidden');
    }
    // Debug: Shift+W toggles wasm hot loops on/off so the player can A/B
    // compare the perf overlay (ms sim) between Rust and JS paths.
    if (e.shiftKey && k === 'w') {
      e.preventDefault();
      toggleWasm();
    }
    // G — transfer base(s) between you and your lieutenant. If you have
    // bases selected (box-select / Ctrl-click / Dbl-click), the whole
    // selection flips in one keystroke; otherwise just the hovered base.
    // Lieutenant is a real faction running the full enemy AI brain — you
    // two are allies, neither side attacks the other.
    if (k === 'g') {
      toggleDelegationAt(nodeAt(state.mousePos.x, state.mousePos.y));
    }
    if (e.key === '=' || e.key === '+') zoomBy(1.18, state.W / 2, state.H / 2);
    if (e.key === '-' || e.key === '_') zoomBy(1 / 1.18, state.W / 2, state.H / 2);
    if (e.key === '0') zoomBy(1 / state.zoom, state.W / 2, state.H / 2);
    if (e.key === '1') state.timeScale = SPEEDS[0];
    if (e.key === '2') state.timeScale = SPEEDS[1];
    if (e.key === '3') state.timeScale = SPEEDS[2];
    if (e.key === '4') state.timeScale = SPEEDS[3];
    if (e.key === '5') state.timeScale = SPEEDS[4];
    if (e.key === ']') {
      const i = SPEEDS.indexOf(state.timeScale);
      state.timeScale = SPEEDS[Math.min(SPEEDS.length - 1, (i < 0 ? 0 : i + 1))];
    }
    if (e.key === '[') {
      const i = SPEEDS.indexOf(state.timeScale);
      state.timeScale = SPEEDS[Math.max(0, (i < 0 ? 0 : i - 1))];
    }
    // Enter turret-placement mode: Q=Anti-Air, F=Factory, N=Net, T=Tank, C=Cannon (artillery).
    if (k === 'q' || k === 'f' || k === 'n' || k === 't' || k === 'c') {
      const type = (k === 'q') ? 'antiair' : (k === 'f') ? 'factory'
                 : (k === 'n') ? 'net'     : (k === 't') ? 'tank' : 'artillery';
      state.placeMode = { type, byOwner: 'player' };
    }
    // Hold-Fire toggle: H stockpiles drones at your factories; pressing again
    // launches the entire stockpile as one saturation salvo.
    if (k === 'h') {
      if (state.holdFire) {
        releasePlayerStockpile();
        state.holdFire = false;
      } else {
        state.holdFire = true;
      }
    }
    // AI Worker toggle: Y moves the per-faction aiTick off the main thread.
    // Main thread keeps rendering / sim / combat / drones; the worker just
    // owns AI decisions and ships back action queues. NN-controlled factions
    // stay main-thread (onnxruntime + DOM). See AI_WORKER_BLUEPRINT.md.
    if (k === 'y') {
      if (aiBridge.isEnabled()) {
        aiBridge.disable();
        console.log('[ai-worker] disabled (main-thread aiTick)');
      } else {
        aiBridge.enable();
        console.log('[ai-worker] enabled');
      }
    }
  });

  addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'arrowup')    state.panKeys.up = false;
    if (k === 's' || k === 'arrowdown')  state.panKeys.down = false;
    if (k === 'a' || k === 'arrowleft')  state.panKeys.left = false;
    if (k === 'd' || k === 'arrowright') state.panKeys.right = false;
  });

  state.minimap.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const rect = state.minimap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const wx = (mx / state.minimap.width) * WORLD_W;
    const wy = (my / state.minimap.height) * WORLD_H;
    state.cameraX = wx - (state.W / state.zoom) / 2;
    state.cameraY = wy - (state.H / state.zoom) / 2;
    clampCamera();
  });
}

// =====================================================
// Boot
// =====================================================
resize();
attachInput();
loadAssets();           // try to load PNGs from assets/; sprites fall back to primitives
loadWasm();             // lazy-load Rust hot loops; drones.js falls back to JS until ready
newGame();              // rolls factions, builds HUD, generates world
loop();
nnLoad();

// =====================================================
// Entry point. Wires DOM, builds first game, runs main loop,
// hooks input. All cross-module orchestration lives here.
// =====================================================
import { state } from './state.js';
import {
  WORLD_W, WORLD_H, PAN_SPEED, EDGE_PAN_SPEED, EDGE_PAN_MARGIN, SPEEDS,
} from './config.js';
import { AIS, COLOR } from './factions.js';
import { dist, formatTime } from './util.js';
import { clampCamera, zoomBy } from './camera.js';
import {
  placeNodes, buildRoads, adjustHubSizes, findPath, nodeAt,
} from './world.js';
import { sendFleet, simulateFleets } from './fleets.js';
import {
  resetEngineering, orderBuild,
  updateDrones, updateAntiAir, updateBuildings,
} from './engineering.js';
import { aiTick } from './ai.js';
import { nnLoad, nnResetGame } from './nn.js';
import {
  buildHUD, updateHUD, render, renderMinimap,
  makeSnow, updateSnow, updateParticles,
} from './render.js';

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
  state.fleets = [];
  state.particles = [];
  state.selectedIds.clear();
  state.gameOver = false;
  document.getElementById('message').style.display = 'none';
  state.startTime = performance.now();
  state.elapsed = 0;
  state.aiTimers = {};
  for (const ai of AIS) state.aiTimers[ai] = 4.0 + Math.random() * 2.5;
  makeSnow();

  // World gen
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
      best.owner = owner; best.units = 48; best.size = 38;
      best.capacity = 145; best.regenRate = 1.5;
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
  document.getElementById('msg-title').textContent = win ? 'Victory' : 'Defeat';
  document.getElementById('msg-title').style.color = win ? '#5cb3ff' : '#ff6678';
  document.getElementById('msg-sub').textContent = sub;
  m.style.display = 'block';
}

// =====================================================
// Main loop
// =====================================================
function simulate(dt) {
  // Regen + visual decays
  for (const n of state.nodes) {
    if (n.owner !== 'neutral') {
      n.units = Math.min(n.capacity, n.units + n.regenRate * dt);
    }
    if (n.pulse > 0) n.pulse -= dt * 1.6;
    if (n.flash > 0) n.flash -= dt * 2.5;
  }
  updateBuildings(dt);
  updateAntiAir(dt);
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

  if (!state.gameOver) {
    const subSteps = Math.max(1, Math.ceil(state.timeScale));
    const subDt = gameDt / subSteps;
    for (let s = 0; s < subSteps; s++) {
      simulate(subDt);
      for (const ai of AIS) aiTick(ai, subDt);
      updateParticles(subDt);
    }
    state.elapsed += gameDt;
    checkVictory();
  }
  updateSnow(realDt);
  updateHUD();
  render();
  renderMinimap();
  requestAnimationFrame(loop);
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
    const n = nodeAt(wx, wy);
    state.drag = {
      startX: wx, startY: wy, x: wx, y: wy,
      originNode: n, mode: 'pending', moved: false,
      shift: e.shiftKey, ctrl: e.metaKey || e.ctrlKey,
    };
  });

  c.addEventListener('mousemove', e => {
    state.mouseScreen = { x: e.clientX, y: e.clientY };
    if (state.middlePan) {
      state.cameraX = state.middlePan.startCamX - (e.clientX - state.middlePan.startSX) / state.zoom;
      state.cameraY = state.middlePan.startCamY - (e.clientY - state.middlePan.startSY) / state.zoom;
      clampCamera();
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
        if (state.drag.originNode && state.drag.originNode.owner === 'player') state.drag.mode = 'send';
        else if (!state.drag.originNode) state.drag.mode = 'box';
        else state.drag.mode = 'none';
      }
    }
  });

  c.addEventListener('mouseup', e => {
    if (e.button === 1 && state.middlePan) { state.middlePan = null; return; }
    if (e.button !== 0 || !state.drag) return;
    if (state.gameOver) { state.drag = null; return; }
    const wx = e.clientX / state.zoom + state.cameraX;
    const wy = e.clientY / state.zoom + state.cameraY;
    const d = state.drag;
    if (!d.moved) {
      if (!d.originNode) {
        if (!d.shift && !d.ctrl) state.selectedIds.clear();
      } else if (d.originNode.owner === 'player') {
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
      if (releaseNode && releaseNode.id !== d.originNode.id) {
        const sources = state.selectedIds.has(d.originNode.id)
          ? [...state.selectedIds].map(id => state.nodes[id]).filter(nd => nd && nd.owner === 'player')
          : [d.originNode];
        for (const from of sources) {
          if (!from || from.owner !== 'player' || from.id === releaseNode.id || from.units < 2) continue;
          const amt = d.shift ? Math.floor(from.units) : Math.floor(from.units / 2);
          sendFleet(from, releaseNode, amt);
        }
      }
    } else if (d.mode === 'box') {
      if (!d.shift && !d.ctrl) state.selectedIds.clear();
      const x1 = Math.min(d.startX, wx), x2 = Math.max(d.startX, wx);
      const y1 = Math.min(d.startY, wy), y2 = Math.max(d.startY, wy);
      for (const nd of state.nodes) {
        if (nd.owner === 'player' && nd.x >= x1 && nd.x <= x2 && nd.y >= y1 && nd.y <= y2) {
          state.selectedIds.add(nd.id);
        }
      }
    }
    state.drag = null;
  });

  c.addEventListener('dblclick', () => {
    state.selectedIds.clear();
    for (const n of state.nodes) if (n.owner === 'player') state.selectedIds.add(n.id);
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
    if (e.key === 'Escape') state.selectedIds.clear();
    if (k === 'r') newGame();
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
    // Build orders on selected own node: Q=Anti-Air, F=Factory, N=Net
    if (k === 'q' || k === 'f' || k === 'n') {
      const type = (k === 'q') ? 'antiair' : (k === 'f') ? 'factory' : 'net';
      for (const id of state.selectedIds) {
        const n = state.nodes[id];
        if (n && n.owner === 'player') {
          const ok = orderBuild(n, type, 'player');
          if (ok) n.flash = Math.max(n.flash, 0.4);
          break;
        }
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
buildHUD();
attachInput();
newGame();
loop();
nnLoad();

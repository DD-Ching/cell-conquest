// =====================================================
// Input layer. All pointer / wheel / keyboard listeners + the inverted
// HUD auto-fade live here, factored out of main.js (the entry module) to
// keep that file focused on boot order + the main loop. attachInput() is
// called once from main.js at boot, AFTER resize(); it wires every canvas
// and window listener exactly as before. Behaviour is unchanged from the
// in-line version — this is a pure relocation.
//
// updateHudFade() moves here too: it reacts to the live mouse position, so
// it belongs with the pointer handlers. main.js still calls it once in
// newGame() to prime panel opacity (imported back across the boundary).
// =====================================================
import { state } from './state.js';
import { NET_PICK_R, SPEEDS, MAP_MODES } from './config.js';
import { pointInPolygon } from './util.js';
import { clampCamera, zoomBy } from './camera.js';
import { nodeAt, roadAt, turretAt } from './world.js';
import { sendFleet, assaultTurret } from './fleets.js';
import { isAlly } from './alliance.js';
import { placeTurretAt, placeNetOnEdge } from './engineering.js';
import { releasePlayerStockpile } from './drones.js';
import * as aiBridge from './ai-worker-bridge.js';
import { toggleDelegationAt } from './subordinate.js';
import { toggleWasm } from './wasm-bridge.js';
import { toggleMute } from './audio.js';
// newGame lives in main.js (the entry module). Importing it here closes a
// cycle (main.js → input.js → main.js), which is safe: newGame is a hoisted
// function declaration and is only *invoked* from a listener at runtime,
// long after both module bodies have finished evaluating.
import { newGame } from './main.js';
// Tutorial progressive-unlock gates (one definition, shared with main.js +
// render-shroud.js). tutAllows(cap) → false while that capability is still
// locked in a tutorial; cameraLocked() → true while pan/zoom are frozen.
import { tutAllows, cameraLocked } from './tutorial-gate.js';
import { startTutorial } from './lobby.js';

// =====================================================
// HUD auto-fade (inverted version) — overlay panels fade OUT when the mouse
// gets near them so they don't block the world the player is reaching for.
// Mouse far away = full opacity (read the HUD). Mouse over / near = fade.
// The corners (top-left = title/HUD, top-right = timer/zoom/speed) are
// where the cursor naturally hovers during play, so they need to clear out
// of the way fastest. CSS .hud-faded handles the transition.
// =====================================================
const HUD_FADE_IDS = ['title-strip', 'hud', 'topright', 'help', 'nn-badge'];
const HUD_TRIGGER_PAD = 80;       // px buffer — start fading BEFORE the cursor
                                  // actually touches the panel
export function updateHudFade(mx, my) {
  for (const id of HUD_FADE_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const near = mx >= r.left - HUD_TRIGGER_PAD && mx <= r.right + HUD_TRIGGER_PAD &&
                 my >= r.top  - HUD_TRIGGER_PAD && my <= r.bottom + HUD_TRIGGER_PAD;
    // Inverted: near = fade (get out of the way), far = full opacity (readable).
    if (near) el.classList.add('hud-faded');
    else      el.classList.remove('hud-faded');
  }
}

// =====================================================
// Input handlers
// =====================================================
export function attachInput() {
  const c = state.canvas;
  c.addEventListener('contextmenu', e => e.preventDefault());

  c.addEventListener('wheel', e => {
    e.preventDefault();
    if (cameraLocked()) return;                 // zoom frozen during the tutorial vision-lock
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    zoomBy(factor, e.clientX, e.clientY);
  }, { passive: false });

  c.addEventListener('mousedown', e => {
    if (e.button === 1) {
      e.preventDefault();
      if (cameraLocked()) return;               // no middle-drag pan while view is locked
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
        else if (!state.drag.originNode) { state.drag.mode = 'lasso'; state.drag.points = [{ x: state.drag.startX, y: state.drag.startY }]; }
        else state.drag.mode = 'none';
      }
    }
    // Lasso: accumulate the freehand loop, throttled by a min world-space step
    // so a long sweep stays a few dozen points instead of thousands.
    if (state.drag.mode === 'lasso') {
      const pts = state.drag.points;
      const last = pts[pts.length - 1];
      const sx = state.drag.x - last.x, sy = state.drag.y - last.y;
      const minStep = 7 / state.zoom;
      if (sx * sx + sy * sy >= minStep * minStep) pts.push({ x: state.drag.x, y: state.drag.y });
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
      if (tutAllows('select')) {            // selection is gated until the tutorial 'select' lesson
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
      }
    } else if (d.mode === 'send' && tutAllows('send')) {   // sending orders gated until the 'send' lesson
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
    } else if (d.mode === 'lasso' && tutAllows('select')) {   // box/lasso select gated with 'select'
      if (!d.shift && !d.ctrl) state.selectedIds.clear();
      const pts = d.points;
      pts.push({ x: wx, y: wy });          // close the loop on the release point
      if (pts.length >= 3) {
        for (const nd of state.nodes) {
          // Lasso pulls in both player and Lieutenant nodes (same side).
          if (isAlly(nd.owner, 'player') && pointInPolygon(nd.x, nd.y, pts)) {
            state.selectedIds.add(nd.id);
          }
        }
      }
    }
    state.drag = null;
  });

  c.addEventListener('dblclick', () => {
    if (!tutAllows('select')) return;        // select-all gated with the 'select' lesson
    state.selectedIds.clear();
    // Double-click selects ALL friendly bases (player + Lieutenant).
    for (const n of state.nodes) if (isAlly(n.owner, 'player')) state.selectedIds.add(n.id);
  });

  c.addEventListener('mouseleave', () => {
    state.mouseScreen = { x: -999, y: -999 };
  });

  addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    // Pan keys frozen during the tutorial vision-lock (the 'view' lesson unlocks them).
    if (!cameraLocked()) {
      if (k === 'w' || k === 'arrowup')    { state.panKeys.up = true; e.preventDefault(); }
      if (k === 's' || k === 'arrowdown')  { state.panKeys.down = true; e.preventDefault(); }
      if (k === 'a' || k === 'arrowleft')  { state.panKeys.left = true; e.preventDefault(); }
      if (k === 'd' || k === 'arrowright') { state.panKeys.right = true; e.preventDefault(); }
    }
    if (e.key === 'Escape') { state.selectedIds.clear(); state.placeMode = null; state.salvoTarget = null; state.painting = null; }
    if (k === 'r') {
      if (state.tutorial) startTutorial();     // R during the tutorial = restart the lesson cleanly
      else if (!state.inLobby) newGame();       // R in a live game = fresh map; ignored in the lobby
    }
    // HUD management: Tab fully hides the chrome (battle-only view); ? (or /)
    // toggles the expanded controls reference. Both keep the canvas clean
    // when the player needs the area under a panel.
    if (e.key === 'Tab')  { e.preventDefault(); document.body.classList.toggle('hud-hidden'); }
    if (e.key === '?' || e.key === '/') { e.preventDefault(); document.body.classList.toggle('help-open'); }
    // Pause toggle (Space). Sim, AI, particles, and elapsed clock freeze;
    // camera + render + HUD keep working so the player can survey + plan.
    if ((e.key === ' ' || e.code === 'Space') && tutAllows('command')) {
      e.preventDefault();
      state.paused = !state.paused;
      document.body.classList.toggle('paused', state.paused);
      if (state.tutorial) state.tutorial.didPause = true;   // tutorial "you tried pause" flag
    }
    // M — mute / unmute all sound (the M key is free now the minimap is gone;
    // the bottom-right minimap canvas + its replot-every-frame cost are gone).
    if (k === 'm') {
      const m = toggleMute();
      console.log('[audio] ' + (m ? 'muted' : 'unmuted'));
    }
    // V — cycle the cartographic view mode (cinematic → strategic → detailed →
    // debug → …). Cartographic modes curve roads + demote minor nodes so the
    // map reads as terrain; debug restores the literal straight-edge graph.
    if (k === 'v') {
      const i = MAP_MODES.indexOf(state.mapMode);
      state.mapMode = MAP_MODES[(i + 1) % MAP_MODES.length];
      console.log('[map] view mode →', state.mapMode);
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
    if (k === 'g' && tutAllows('command')) {
      toggleDelegationAt(nodeAt(state.mousePos.x, state.mousePos.y));
      if (state.tutorial) state.tutorial.didG = true;       // tutorial "you tried delegate" flag
    }
    // Step-zoom keys frozen during the tutorial vision-lock.
    if (!cameraLocked()) {
      if (e.key === '=' || e.key === '+') zoomBy(1.18, state.W / 2, state.H / 2);
      if (e.key === '-' || e.key === '_') zoomBy(1 / 1.18, state.W / 2, state.H / 2);
      if (e.key === '0') zoomBy(1 / state.zoom, state.W / 2, state.H / 2);
    }
    // Speed keys are gated during the tutorial until the "speed" lesson unlocks
    // them (tutAllows → always true outside a tutorial).
    if (tutAllows('speed')) {
      if (e.key === '1') state.timeScale = SPEEDS[0];
      if (e.key === '2') state.timeScale = SPEEDS[1];
      if (e.key === '3') state.timeScale = SPEEDS[2];
      if (e.key === '4') state.timeScale = SPEEDS[3];
      if (e.key === '5') state.timeScale = SPEEDS[4];
      if (e.key === '6') state.timeScale = SPEEDS[5];   // 30× fast-forward
      if (e.key === '7') state.timeScale = SPEEDS[6];   // 40× fast-forward
      if (e.key === ']') {
        const i = SPEEDS.indexOf(state.timeScale);
        state.timeScale = SPEEDS[Math.min(SPEEDS.length - 1, (i < 0 ? 0 : i + 1))];
      }
      if (e.key === '[') {
        const i = SPEEDS.indexOf(state.timeScale);
        state.timeScale = SPEEDS[Math.max(0, (i < 0 ? 0 : i - 1))];
      }
    }
    // Enter turret-placement mode: Q=Anti-Air, F=Factory, N=Net, T=Tank, C=Cannon (artillery).
    // Gated PER UNIT TYPE during the campaign — each level unlocks its own
    // toolset (L1 none, L2 +antiair/factory/net, L3 +tank, L4 +artillery), so
    // the token is the unit-type name. Outside a campaign tutAllows is always
    // true, so normal play is unrestricted.
    if (k === 'q' || k === 'f' || k === 'n' || k === 't' || k === 'c') {
      const type = (k === 'q') ? 'antiair' : (k === 'f') ? 'factory'
                 : (k === 'n') ? 'net'     : (k === 't') ? 'tank' : 'artillery';
      if (tutAllows(type)) state.placeMode = { type, byOwner: 'player' };
    }
    // Hold-Fire toggle: H stockpiles drones at your factories; pressing again
    // launches the entire stockpile as one saturation salvo.
    if (k === 'h' && tutAllows('command')) {
      if (state.holdFire) {
        releasePlayerStockpile();
        state.holdFire = false;
      } else {
        state.holdFire = true;
      }
      if (state.tutorial) state.tutorial.didH = true;       // tutorial "you tried hold-fire" flag
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
    // Render Worker toggle: U moves the world canvas to an OffscreenCanvas
    // owned by a worker. transferControlToOffscreen has to happen BEFORE
    // anything calls getContext('2d') on the canvas, so the safe path is
    // to set ?renderWorker=1 in the URL and reload — main.js's init checks
    // the flag and skips the main-thread 2D-context creation before
    // anything else can grab it.
    if (k === 'u') {
      const u = new URL(location.href);
      if (u.searchParams.get('renderWorker') === '1') {
        u.searchParams.delete('renderWorker');
      } else {
        u.searchParams.set('renderWorker', '1');
      }
      location.href = u.toString();
    }
  });

  addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'arrowup')    state.panKeys.up = false;
    if (k === 's' || k === 'arrowdown')  state.panKeys.down = false;
    if (k === 'a' || k === 'arrowleft')  state.panKeys.left = false;
    if (k === 'd' || k === 'arrowright') state.panKeys.right = false;
  });

  // (Minimap click-to-jump removed with the minimap.)
}

// =====================================================
// Front-of-game flow: the LOBBY (home screen) + a guided TUTORIAL that unlocks
// every control ONE STEP AT A TIME on a small, hand-built training ground.
//
// Flow:  boot → lobby (sim frozen behind it) → START (fresh skirmish) or
//        TUTORIAL (training ground) → … → tutorial finishes/skips → RETURN to
//        the lobby → player presses START.
//
// The tutorial: 6-node map, a REAL enemy that fights back, and a step machine
// where the camera/vision and every input are LOCKED and revealed in order
// (see tutorial-gate.js for the lock tokens, render-shroud.js for the fog).
// Each step polls a completion condition off game state and auto-advances, so
// the player learns by doing. Finishing returns to the lobby with a short
// "training complete" beat.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';
import { DRONE_HP_AIR, DRONE_DAMAGE } from './config.js';
import { dist } from './util.js';
import { AIS, COLOR, GLOW, FACTIONS, factionStats, hexToRgba } from './factions.js';
import { clampCamera } from './camera.js';
import { resetEngineering } from './engineering.js';
import { buildHUD } from './render.js';
import { sfxVictory } from './audio.js';

const $ = (id) => document.getElementById(id);

// ---- Lobby ----------------------------------------------------------------
export function initLobby() {
  showLobby();
  $('lobby-start')?.addEventListener('click', startSkirmish);
  $('lobby-tutorial')?.addEventListener('click', startTutorial);
  $('tut-skip')?.addEventListener('click', () => finishTutorial('skipped'));
  $('tut-continue')?.addEventListener('click', () => { if (state.tutorial) state.tutorial.acked = true; });
}

/** Re-enter the lobby: freeze the sim behind it, show the menu. */
function showLobby() {
  document.body.classList.add('in-lobby');
  state.inLobby = true;
  state.paused = false;
  document.body.classList.remove('paused');
}
function hideLobby() {
  document.body.classList.remove('in-lobby');
  state.inLobby = false;
  const toast = $('lobby-toast');
  if (toast) toast.style.display = 'none';
}

/** START: leave the menu into a fresh, normal skirmish (full big map, nothing
 *  gated). Regenerates so START always gives a clean game, even after a tutorial. */
export function startSkirmish() {
  endTutorialState();
  window.newGame();
  hideLobby();
}

// ---- Tutorial scenario ----------------------------------------------------
const HQ = 0, BETA = 1, DRILL = 2, FORWARD = 3, ENEMY_HQ = 4, WORKS = 5;

/** Build the 6-node training ground. newGame() first for a full clean reset,
 *  then override nodes/roads + re-run the systems that newGame ran against the
 *  procgen graph (engineering edge cache, HUD roster). */
function buildTutorialScenario() {
  window.newGame();
  // The training-ground foe is "DDCHING" (the player's enemy is the boss himself).
  // Uses the red slot; force its display name to DDCHING for the tutorial only
  // (rollFactions rebuilds FACTIONS on the next real game, restoring Crimson).
  const enemy = 'red';
  if (!COLOR[enemy]) { COLOR[enemy] = '#ff6678'; GLOW[enemy] = hexToRgba('#ff6678', 0.5); }
  if (!factionStats[enemy]) factionStats[enemy] = { strength: 1.0, aggressionMul: 1.0, buildChanceMul: 1.0 };
  const eDef = FACTIONS.find(f => f.id === enemy);
  if (eDef) eDef.name = 'DDCHING';
  else FACTIONS.push({ id: enemy, name: 'DDCHING', color: COLOR[enemy] });

  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const defs = [
    { name: 'Aleph Base',     dx: -780, dy:  260, owner: 'player',  size: 38, units: 60, cap: true },
    { name: 'Beta Outpost',   dx: -780, dy: -300, owner: 'player',  size: 30, units: 30 },
    { name: 'Drill Site',     dx: -120, dy:  -10, owner: 'neutral', size: 26, units: 12 },
    { name: 'DDCHING Outpost', dx:  520, dy:  -10, owner: enemy,    size: 28, units: 22 },
    { name: 'DDCHING HQ',     dx: 1060, dy:  240, owner: enemy,     size: 36, units: 34, cap: true },
    { name: 'Ferrous Works',  dx:  -60, dy:  470, owner: 'neutral', size: 24, units: 14 },
  ];
  state.nodes = defs.map((d, i) => ({
    id: i, x: cx + d.dx, y: cy + d.dy, size: d.size, owner: d.owner,
    units: d.units, capacity: Math.floor(d.size * 3.6), regenRate: d.size / 30,
    pulse: 0, flash: 0, lastRegenT: 0,
    nodeType: d.cap ? 'capital' : 'town', name: d.name,
  }));
  // Roads: player core (HQ↔Beta↔Drill), the push lane Drill→Forward→EnemyHQ,
  // plus Drill→Works. Player must take Drill before reaching the enemy.
  state.adj = new Map();
  for (const n of state.nodes) state.adj.set(n.id, new Set());
  state.roads = [];
  const link = (a, b) => {
    state.adj.get(a).add(b); state.adj.get(b).add(a);
    state.roads.push({ a, b, length: dist(state.nodes[a], state.nodes[b]), kind: 'local' });
  };
  link(HQ, BETA); link(HQ, DRILL); link(BETA, DRILL);
  link(DRILL, FORWARD); link(FORWARD, ENEMY_HQ); link(DRILL, WORKS);

  // Clean ground for the lesson; clear procgen art.
  state.regions = []; state.barriers = []; state.resourceBelts = [];
  state.fleets = []; state.selectedIds.clear();
  state.gameOver = false; state.timeScale = 1; state.holdFire = false;

  // FIX: rebuild engineering edge-cache against the NEW roads (newGame ran it
  // against the procgen graph), and trim the HUD roster to this clean 1v1+ally.
  resetEngineering();
  const keep = new Set(['player', enemy, 'ally1', 'neutral']);
  for (let i = FACTIONS.length - 1; i >= 0; i--) if (!keep.has(FACTIONS[i].id)) FACTIONS.splice(i, 1);
  AIS.length = 0; AIS.push(enemy, 'ally1');
  buildHUD();

  // Keep Crimson CALM through the teaching steps (so it can't snatch the Drill
  // while the player is still reading) — the 'push' step unleashes it, and from
  // there it defends + counter-attacks for real two-way combat.
  state._tutEnemy = enemy;
  state.aiTimers[enemy] = 99999;

  // Frame the cluster and remember the framing for the pan/zoom lessons.
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const n of state.nodes) { minx = Math.min(minx, n.x); maxx = Math.max(maxx, n.x); miny = Math.min(miny, n.y); maxy = Math.max(maxy, n.y); }
  const pad = 320;
  state.zoom = Math.min(state.W / (maxx - minx + pad * 2), state.H / (maxy - miny + pad * 2), 1.2);
  state.cameraX = (minx + maxx) / 2 - state.W / (2 * state.zoom);
  state.cameraY = (miny + maxy) / 2 - state.H / (2 * state.zoom);
  clampCamera();
}

/** Enemy drone wave for the AA lesson — aimed at the player's just-built AA gun
 *  so the flak gun is guaranteed to open fire on it. */
function spawnTutorialDroneWave() {
  const enemy = state._tutEnemy || 'red';
  const aa = state.turrets.find(t => t.owner === 'player' && t.type === 'antiair');
  const tx = aa ? aa.x : state.nodes[HQ].x, ty = aa ? aa.y : state.nodes[HQ].y;
  const tId = aa ? aa.id : HQ, tKind = aa ? 'turret' : 'node';
  const src = state.nodes[ENEMY_HQ];
  for (let i = 0; i < 5; i++) {
    const ox = src.x + (i - 2) * 30, oy = src.y - 90 + (i % 2) * 30;
    state.fleets.push({
      _id: state._nextFleetId++, kind: 'drone', owner: enemy, units: 1,
      x: ox, y: oy, tx, ty, targetKind: tKind, targetId: tId,
      hp: DRONE_HP_AIR, damage: DRONE_DAMAGE, spawnT: state.elapsed,
      heading: Math.atan2(ty - oy, tx - ox),
    });
  }
}

// ---- Step machine ---------------------------------------------------------
// mode: 'ack' (Continue button) | 'key' (key chip) | 'point'/'drag' (finger at node).
// unlock: token added to state.tutorial.unlocked on ENTER (gates input + fog).
const hasTurret = (type) => state.turrets.some(t => t.owner === 'player' && t.type === type);
const STEPS = [
  { id: 'welcome', mode: 'ack',
    zh: '歡迎來到訓練場。所有操作一開始都是鎖住的 —— 一步步解鎖。準備好就按「繼續」。',
    en: 'Welcome to the training ground. Every control starts locked — unlocked one step at a time. Press Continue.',
    done: (t) => t.acked },

  { id: 'pan', mode: 'key', keys: '↑ ↓ ← →', unlock: 'view', point: HQ,
    zh: '用方向鍵(或 WASD)移動鏡頭,看看戰場。',
    en: 'Move the camera with the arrow keys (or WASD) to look around.',
    done: (t) => Math.hypot(state.cameraX - t.camStart.x, state.cameraY - t.camStart.y) > 140 },

  { id: 'zoom', mode: 'key', keys: '+ / −  (滾輪)',
    zh: '用 + / − 或滾輪縮放。把全部節點收進畫面裡。',
    en: 'Zoom with + / − or the scroll wheel — get all your nodes in frame.',
    done: (t) => Math.abs(state.zoom - t.zoomStart) > 0.06 },

  { id: 'select', mode: 'point', point: HQ, unlock: 'select',
    zh: '左鍵點你的基地「Aleph Base」= 選取它。外圈亮起代表它在聽你指揮。',
    en: 'Left-click your base, Aleph, to select it. The ring means it\'s listening.',
    done: () => state.selectedIds.size >= 1 },

  { id: 'selectall', mode: 'point', point: BETA,
    zh: '雙擊任一基地 = 一次全選你的部隊(也可以在空地拖曳框選)。試試看。',
    en: 'Double-click any base to select ALL of yours (or drag a box on empty ground). Try it.',
    done: () => state.selectedIds.size >= 2 },

  { id: 'send', mode: 'drag', point: DRILL, unlock: 'send',
    zh: '從你的基地拖曳到中立的「Drill Site」,派兵把它佔下來。',
    en: 'Drag from a base onto the neutral Drill Site to send troops and capture it.',
    done: () => state.nodes[DRILL].owner === 'player' },

  { id: 'push', mode: 'point', point: FORWARD, unlock: 'vision',
    zh: 'DDCHING 在「DDCHING Outpost」增兵了 —— 集結兵力,一次送上去攻下它。',
    en: 'DDCHING is reinforcing its outpost — mass your troops, then take it in one push.',
    onEnter: () => { state.aiTimers[state._tutEnemy] = 0; },   // unleash the enemy: combat starts here
    done: () => state.nodes[FORWARD].owner === 'player', hold: 999 },

  { id: 'build', mode: 'key', keys: 'Q', point: HQ, unlock: 'build',
    zh: 'DDCHING 要放無人機了!選一個基地,按 Q 蓋防空炮,再點地圖把它放下。',
    en: 'DDCHING is launching drones! Select a base, press Q for an anti-air gun, then click to place it.',
    done: () => hasTurret('antiair'), hold: 999 },

  { id: 'defend', mode: 'point', point: HQ,
    zh: '來了!看你的防空炮把無人機一架架打下來。',
    en: 'Here they come — watch your flak gun shred the swarm.',
    onEnter: () => spawnTutorialDroneWave(),
    done: (t) => t.waveSpawned && !state.fleets.some(f => f.kind === 'drone' && f.owner === state._tutEnemy), hold: 24 },

  { id: 'buildmore', mode: 'key', keys: 'F · T · C',
    zh: '擴充火力:F 無人機工廠、T 戰車工廠、C 火炮。三種各蓋一個。',
    en: 'More firepower — F factory, T tank works, C cannon. Build one of each.',
    done: () => hasTurret('factory') && hasTurret('tank') && hasTurret('artillery'), hold: 999 },

  { id: 'net', mode: 'key', keys: 'N',
    zh: '按 N,再點一條道路,佈署無人機攔截網 —— 保護你的補給線。',
    en: 'Press N, then click a road to lay a drone-net over your supply line.',
    done: () => { for (const e of state.edgeData.values()) if ((e.netLevel || 0) > 0) return true; return false; }, hold: 999 },

  { id: 'speed', mode: 'key', keys: '1 – 7',
    zh: '嫌太慢?按數字鍵 1–7 調整遊戲速度(試試 5)。',
    en: 'Too slow? Press 1–7 to change game speed (try 5).', unlock: 'speed',
    done: () => state.timeScale !== 1 },

  { id: 'command', mode: 'key', keys: 'G · H · Space',
    zh: '指揮工具:G 把基地交給副官 🤖、H 囤積無人機(再按一次齊射)、Space 暫停。三個都試一次。',
    en: 'Command tools — G delegate to your Lieutenant, H hold-fire drones, Space pause. Touch all three.',
    unlock: 'command',
    done: (t) => t.didG && t.didH && t.didPause },

  { id: 'final', mode: 'point', point: ENEMY_HQ,
    zh: '全部解鎖了!最後一關:攻下「DDCHING HQ」,結束這場戰鬥。',
    en: 'Everything\'s unlocked. Final step — capture DDCHING HQ to finish it.',
    done: () => state.nodes[ENEMY_HQ].owner === 'player', hold: 999 },
];

export function startTutorial() {
  hideLobby();
  buildTutorialScenario();
  state.tutorial = {
    i: 0, unlocked: new Set(),
    camStart: { x: state.cameraX, y: state.cameraY }, zoomStart: state.zoom,
    acked: false, waveSpawned: false, didG: false, didH: false, didPause: false,
  };
  $('tutorial-coach')?.classList.add('show');
  document.body.classList.add('tut-active');
  enterStep();
}

/** Clear tutorial state without touching the lobby (used by START). */
function endTutorialState() {
  state.tutorial = null;
  $('tutorial-coach')?.classList.remove('show');
  document.body.classList.remove('tut-active');
}

/** Tutorial over (completed OR skipped) → celebrate briefly, return to lobby. */
export function finishTutorial(reason) {
  if (reason === 'completed') { try { sfxVictory(); } catch (e) { /* audio may be suspended */ } }
  endTutorialState();
  const toast = $('lobby-toast');
  if (toast) {
    toast.textContent = reason === 'completed'
      ? '✓ 基礎訓練完成 — 按 START 上戰場'
      : '訓練已結束 — 控制說明都在下方。按 START 開始';
    toast.style.display = 'block';
  }
  showLobby();
}

/** Per-frame from the main loop. Advances on the step's probe (or backstop hold)
 *  and keeps the finger on its target. Also runs per-step live helpers. */
export function tutorialTick() {
  const t = state.tutorial;
  if (!t) return;
  const step = STEPS[t.i];
  if (!step) { finishTutorial('completed'); return; }

  // Live helpers: force the just-placed AA active (no 10s wait / soft-lock), and
  // mark the wave as spawned for the defend gate.
  if (step.id === 'build') {
    const aa = state.turrets.find(x => x.owner === 'player' && x.type === 'antiair');
    if (aa && !aa.active) { aa.active = true; aa.pendingEngineer = false; }
  }
  if (step.id === 'defend' && !t.waveSpawned) t.waveSpawned = true;

  const heldOut = step.hold && (performance.now() - t.shownAt) / 1000 > step.hold;
  if ((step.done && step.done(t)) || heldOut) {
    if (step.id === 'final') { finishTutorial('completed'); return; }
    t.i++;
    if (t.i >= STEPS.length) { finishTutorial('completed'); return; }
    enterStep();
  }
  positionFinger(STEPS[t.i]);
}

/** Apply a step's unlock + onEnter, reset transient state, render it. */
function enterStep() {
  const t = state.tutorial; if (!t) return;
  const step = STEPS[t.i];
  t.shownAt = performance.now();
  state.paused = false; document.body.classList.remove('paused');   // never linger paused between steps
  if (step.unlock) t.unlocked.add(step.unlock);
  if (step.onEnter) step.onEnter();
  renderStep();
}

function renderStep() {
  const t = state.tutorial; if (!t) return;
  const step = STEPS[t.i];
  const coach = $('tutorial-coach'); if (!coach) return;
  // English-first by default (the game's display language); the prominent line
  // holds English and the small subline holds the zh translation.
  coach.querySelector('.tut-zh').textContent = step.en;
  coach.querySelector('.tut-en').textContent = step.zh;
  coach.querySelector('.tut-step').textContent = `${t.i + 1} / ${STEPS.length}`;
  coach.querySelector('.tut-finger').className = 'tut-finger mode-' + step.mode;
  const chip = coach.querySelector('.tut-key');
  if (step.mode === 'key') { chip.style.display = ''; chip.textContent = step.keys; }
  else chip.style.display = 'none';
  const cont = coach.querySelector('#tut-continue');
  if (cont) cont.style.display = (step.mode === 'ack') ? '' : 'none';
}

function positionFinger(step) {
  const coach = $('tutorial-coach'); if (!coach) return;
  const finger = coach.querySelector('.tut-finger');
  const n = (step.point !== undefined) ? state.nodes[step.point] : null;
  if (n && (step.mode === 'drag' || step.mode === 'point')) {
    finger.style.display = '';
    finger.style.left = ((n.x - state.cameraX) * state.zoom) + 'px';
    finger.style.top  = ((n.y - state.cameraY) * state.zoom) + 'px';
  } else {
    finger.style.display = 'none';
  }
}

// Exposed for inline onclick fallbacks in node-conquest.html.
window.startSkirmish = startSkirmish;
window.startTutorial = startTutorial;

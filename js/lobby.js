// =====================================================
// Front-of-game flow: the LOBBY (start screen) + a guided TUTORIAL on a small,
// hand-built training ground with PROGRESSIVE UNLOCK.
//
// Lobby: a simple "training-ground" menu — START · TUTORIAL · controls. Shown
// over a frozen game at boot; either button drops you into the live sim.
//
// Tutorial: builds its OWN tiny 4-node map (not the 830-node theatre — that read
// as cheap for a first lesson) and walks a brand-new player through every core
// verb in order. Each step:
//   • shows a narrated zh/en instruction + a finger / key hint,
//   • UNLOCKS the key it teaches (build / speed keys stay locked until then —
//     state.tutorial.unlocked, read by input.js), and
//   • AUTO-ADVANCES the moment the player actually does the thing.
// The "defend" step spawns an enemy drone wave so the player sees the anti-air
// guns open fire (visible tracer rounds). Skip bails to free play anytime.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';
import { dist } from './util.js';
import { AIS, COLOR } from './factions.js';
import { DRONE_HP_AIR, DRONE_DAMAGE } from './config.js';

const $ = (id) => document.getElementById(id);

// ---- Lobby ----------------------------------------------------------------
export function initLobby() {
  document.body.classList.add('in-lobby');
  state.inLobby = true;
  $('lobby-start')?.addEventListener('click', startSkirmish);
  $('lobby-tutorial')?.addEventListener('click', startTutorial);
  $('tut-skip')?.addEventListener('click', () => endTutorial());
}

function leaveLobby() {
  document.body.classList.remove('in-lobby');
  state.inLobby = false;
}

export function startSkirmish() {
  endTutorial();
  leaveLobby();
}

// ---- Tutorial: the training-ground scenario -------------------------------
// Indices into the hand-built node list.
const PLAYER = 0, DRILL = 1, RIDGE = 2, ENEMY = 3;

/** Replace the world with a compact 4-node training ground. Calls newGame()
 *  first for a full clean reset (factions, HUD, turrets, fleets, terrain bake),
 *  then overrides nodes/roads/regions with the tiny fixed layout. */
function buildTutorialScenario() {
  window.newGame();                       // full reset + rolled factions + terrain bake
  const enemy = AIS.find(o => o !== 'ally1') || 'red';   // a real rolled AI (has COLOR + timer)

  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const defs = [
    { name: 'Aleph Base',     dx: -560, dy:   40, owner: 'player', size: 38, units: 30, cap: true },
    { name: 'Drill Site',     dx:  -40, dy:  -30, owner: 'neutral', size: 26, units: 14 },
    { name: 'Ridge Watch',    dx: -120, dy:  360, owner: 'neutral', size: 24, units: 12 },
    { name: 'Crimson Picket', dx:  560, dy:  -10, owner: enemy,    size: 36, units: 40, cap: true },
  ];
  state.nodes = defs.map((d, i) => ({
    id: i, x: cx + d.dx, y: cy + d.dy, size: d.size, owner: d.owner,
    units: d.units, capacity: Math.floor(d.size * 3.6), regenRate: d.size / 30,
    pulse: 0, flash: 0, lastRegenT: 0,
    nodeType: d.cap ? 'capital' : 'town', name: d.name,
  }));
  // Roads: player → drill → enemy, plus drill → ridge (a second town to teach
  // multi-select). Player must take the drill before he can reach the enemy.
  state.adj = new Map();
  for (const n of state.nodes) state.adj.set(n.id, new Set());
  state.roads = [];
  const link = (a, b) => {
    state.adj.get(a).add(b); state.adj.get(b).add(a);
    state.roads.push({ a, b, length: dist(state.nodes[a], state.nodes[b]), kind: 'local' });
  };
  link(PLAYER, DRILL); link(DRILL, ENEMY); link(DRILL, RIDGE);

  // Clean ground: no procgen regions / barriers / resource belts for the lesson.
  state.regions = []; state.barriers = []; state.resourceBelts = [];
  state.fleets = []; state.selectedIds.clear();
  state._turretCacheDirty = true;
  state.gameOver = false; state.timeScale = 1;
  // Keep the enemy calm during the lesson — it stirs once the player is taught.
  state.aiTimers[enemy] = 40;
  state._tutEnemy = enemy;

  // Frame the cluster.
  state.zoom = 0.92;
  state.cameraX = cx - state.W / (2 * state.zoom);
  state.cameraY = cy - state.H / (2 * state.zoom);
}

/** Spawn a small enemy drone wave aimed at the player's base so the anti-air
 *  guns open fire — the player sees the tracer rounds (and why AA matters). */
function spawnTutorialDroneWave() {
  const enemy = state._tutEnemy || 'red';
  const cap = state.nodes[PLAYER];
  const src = state.nodes[ENEMY];
  for (let i = 0; i < 6; i++) {
    const ox = src.x + (i - 3) * 26, oy = src.y - 80 + (i % 2) * 30;
    state.fleets.push({
      _id: state._nextFleetId++, kind: 'drone', owner: enemy, units: 1,
      x: ox, y: oy, tx: cap.x, ty: cap.y,
      targetKind: 'node', targetId: cap.id,
      hp: DRONE_HP_AIR, damage: DRONE_DAMAGE, spawnT: state.elapsed,
      heading: Math.atan2(cap.y - oy, cap.x - ox),
    });
  }
}

// ---- Tutorial step machine ------------------------------------------------
// Each step: instruction (zh + en) · a finger/key HINT · the key it UNLOCKS ·
// where the finger points · a done() probe polled every frame. A narrator
// prefix (薇拉, the Lieutenant) gives it a touch of story.
const STEPS = [
  {
    id: 'send', mode: 'drag', point: PLAYER,
    zh: '薇拉:歡迎來到前哨,指揮官。先派兵——拖曳「Aleph 基地」到中央的「Drill Site」。',
    en: 'Vera: Welcome to the outpost, Commander. Drag from Aleph Base to the Drill Site to send troops.',
    done: () => state.fleets.some(f => f.owner === 'player' && f.kind !== 'drone'),
  },
  {
    id: 'capture', mode: 'point', point: DRILL,
    zh: '把它拿下!持續增援,直到 Drill Site 變成我們的藍色。',
    en: 'Take it — keep pushing until the Drill Site turns blue.',
    done: () => state.nodes[DRILL].owner === 'player',
  },
  {
    id: 'select', mode: 'point', point: PLAYER,
    zh: '好指揮。雙擊任一基地 = 一次全選你的部隊(空地拖曳可框選)。試試雙擊。',
    en: 'Double-click any base to select ALL your forces (or drag on empty ground to box-select). Try a double-click.',
    done: () => state.selectedIds.size >= 2,
  },
  {
    id: 'build', mode: 'key', keys: 'Q', unlock: 'build', point: PLAYER,
    zh: '緋紅軍會放無人機。按 Q 叫出防空炮,再點基地旁的空地放下它。',
    en: 'Crimson will send drones. Press Q for an anti-air gun, then click beside your base to place it.',
    done: () => state.turrets.some(t => t.owner === 'player' && t.type === 'antiair'),
  },
  {
    id: 'defend', mode: 'point', point: PLAYER,
    zh: '來了!看你的防空炮開火,把無人機一架架打下來。',
    en: 'Incoming! Watch your flak gun open fire and shred the drones.',
    onEnter: () => spawnTutorialDroneWave(),
    done: (t) => t.waveSpawned && !state.fleets.some(f => f.kind === 'drone' && f.owner === state._tutEnemy),
    hold: 16,
  },
  {
    id: 'speed', mode: 'key', keys: '1–7', unlock: 'speed',
    zh: '戰局太慢?按數字鍵 1–7 加速(試試 5)。',
    en: 'Too slow? Press 1–7 to speed the battle up (try 5).',
    done: () => state.timeScale > 1,
  },
  {
    id: 'win', mode: 'flag',
    zh: '最後一課:攻下「Crimson Picket」就獲勝。進階鍵:G 委派副官 🤖、H 無人機齊射、? 看完整說明。放手去打,指揮官!',
    en: 'Last lesson — capture Crimson Picket to win. Advanced: G delegate · H drone salvo · ? full controls. Go get them, Commander!',
    done: () => false, hold: 9,
  },
];

export function startTutorial() {
  leaveLobby();
  buildTutorialScenario();
  state.tutorial = { i: 0, unlocked: new Set(), shownAt: performance.now(), waveSpawned: false };
  $('tutorial-coach')?.classList.add('show');
  document.body.classList.add('tut-active');
  enterStep();
}

export function endTutorial() {
  state.tutorial = null;
  $('tutorial-coach')?.classList.remove('show');
  document.body.classList.remove('tut-active');
}

/** Called every frame from the main loop. Advances on the step's probe (or a
 *  terminal hold) and keeps the finger on its target node. */
export function tutorialTick() {
  const t = state.tutorial;
  if (!t) return;
  const step = STEPS[t.i];
  if (!step) { endTutorial(); return; }
  const heldOut = step.hold && (performance.now() - t.shownAt) / 1000 > step.hold;
  if ((step.done && step.done(t)) || heldOut) {
    t.i++;
    if (t.i >= STEPS.length) { winTutorialOrEnd(); return; }
    enterStep();
  }
  positionFinger(STEPS[t.i]);
}

function winTutorialOrEnd() { endTutorial(); }

/** Apply a step's unlock + onEnter, then render it. */
function enterStep() {
  const t = state.tutorial; if (!t) return;
  const step = STEPS[t.i];
  t.shownAt = performance.now();
  if (step.unlock) t.unlocked.add(step.unlock);
  if (step.id === 'defend') t.waveSpawned = true;
  if (step.onEnter) step.onEnter();
  renderStep();
}

function renderStep() {
  const t = state.tutorial; if (!t) return;
  const step = STEPS[t.i];
  const coach = $('tutorial-coach'); if (!coach) return;
  coach.querySelector('.tut-zh').textContent = step.zh;
  coach.querySelector('.tut-en').textContent = step.en;
  coach.querySelector('.tut-step').textContent = `${t.i + 1} / ${STEPS.length}`;
  coach.querySelector('.tut-finger').className = 'tut-finger mode-' + step.mode;
  const chip = coach.querySelector('.tut-key');
  if (step.mode === 'key') { chip.style.display = ''; chip.textContent = step.keys; }
  else chip.style.display = 'none';
}

/** Pin the finger to its target node's live screen position; hide for key/flag. */
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

// Exposed for the inline onclick fallbacks in node-conquest.html.
window.startSkirmish = startSkirmish;
window.startTutorial = startTutorial;

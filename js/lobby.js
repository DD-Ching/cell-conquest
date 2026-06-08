// =====================================================
// Front-of-game flow: the LOBBY (start screen) + a guided TUTORIAL with a
// finger pointer. Kept out of main.js — main.js only calls initLobby() once at
// boot and tutorialTick() each frame (and gates the sim on state.inLobby).
//
// Lobby: a simple "training-ground" menu — START (play) · TUTORIAL (learn) · a
// controls cheat-sheet. Shown over a frozen game at boot; either button drops
// you into the live sim.
//
// Tutorial: a small step machine. Each step shows an instruction + a finger /
// key hint and auto-advances the moment the player actually performs the action
// (polled from state each frame), so you learn by doing, not by reading. A Skip
// link bails to normal play at any time.
// =====================================================
import { state } from './state.js';

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

// ---- Tutorial -------------------------------------------------------------
// Each step: instruction (zh + en), a finger/key HINT mode, and a done() probe
// polled every frame. `hold` makes a terminal step linger N seconds then clear.
const STEPS = [
  {
    id: 'send', mode: 'drag',
    zh: '拖曳你的據點 → 旁邊的城鎮,派出部隊。',
    en: 'Drag from your base to a neighbouring town to send troops.',
    done: () => state.fleets.some(f => f.owner === 'player' && f.kind !== 'drone'),
  },
  {
    id: 'capture', mode: 'point',
    zh: '攻下它!持續增援,直到城鎮變成你的藍色。',
    en: 'Capture it — keep the pressure on until the town turns blue.',
    done: (t) => playerNodeCount() > t.startNodes,
  },
  {
    id: 'build', mode: 'key', keys: 'Q',
    zh: '按 Q 蓋防空炮,再點一下地圖把它放下。',
    en: 'Press Q to build anti-air, then click the map to place it.',
    done: () => state.turrets.some(x => x.owner === 'player' && x.type === 'antiair'),
  },
  {
    id: 'speed', mode: 'key', keys: '1–7',
    zh: '按數字鍵 1–7 加速戰局(試試 5)。',
    en: 'Press 1–7 to speed the battle up (try 5).',
    done: () => state.timeScale > 1,
  },
  {
    id: 'win', mode: 'flag',
    zh: '最後一課:消滅所有敵人就獲勝。指揮官,接下來交給你了!',
    en: 'Last lesson — eliminate the enemy to win. Over to you, Commander!',
    done: () => false, hold: 7,
  },
];

export function startTutorial() {
  leaveLobby();
  state.tutorial = { i: 0, startNodes: playerNodeCount(), shownAt: performance.now() };
  // Centre the camera on the player HQ so the finger lines up with the base.
  const hq = playerHQ();
  if (hq) {
    state.zoom = 0.95;
    state.cameraX = hq.x - state.W / (2 * state.zoom);
    state.cameraY = hq.y - state.H / (2 * state.zoom);
  }
  $('tutorial-coach')?.classList.add('show');
  document.body.classList.add('tut-active');
  renderStep();
}

export function endTutorial() {
  state.tutorial = null;
  $('tutorial-coach')?.classList.remove('show');
  document.body.classList.remove('tut-active');
}

/** Called every frame from the main loop. Advances when the step's probe fires
 *  (or a terminal step's hold elapses) and keeps the finger pinned to the HQ. */
export function tutorialTick() {
  const t = state.tutorial;
  if (!t) return;
  const step = STEPS[t.i];
  if (!step) { endTutorial(); return; }

  const heldOut = step.hold && (performance.now() - t.shownAt) / 1000 > step.hold;
  if ((step.done && step.done(t)) || heldOut) {
    t.i++;
    t.shownAt = performance.now();
    if (t.i >= STEPS.length) { endTutorial(); return; }
    renderStep();
  }
  positionFinger(STEPS[t.i]);
}

function renderStep() {
  const t = state.tutorial; if (!t) return;
  const step = STEPS[t.i];
  const coach = $('tutorial-coach'); if (!coach) return;
  coach.querySelector('.tut-zh').textContent = step.zh;
  coach.querySelector('.tut-en').textContent = step.en;
  coach.querySelector('.tut-step').textContent = `${t.i + 1} / ${STEPS.length}`;
  const finger = coach.querySelector('.tut-finger');
  finger.className = 'tut-finger mode-' + step.mode;          // CSS animates per mode
  const chip = coach.querySelector('.tut-key');
  if (step.mode === 'key') { chip.style.display = ''; chip.textContent = step.keys; }
  else chip.style.display = 'none';
}

/** Pin the finger to the player HQ's live screen position for the gesture
 *  steps; hide it for key/flag steps (the key chip in the bubble teaches those). */
function positionFinger(step) {
  const coach = $('tutorial-coach'); if (!coach) return;
  const finger = coach.querySelector('.tut-finger');
  if (step.mode === 'drag' || step.mode === 'point') {
    const hq = playerHQ();
    if (hq) {
      finger.style.display = '';
      finger.style.left = ((hq.x - state.cameraX) * state.zoom) + 'px';
      finger.style.top  = ((hq.y - state.cameraY) * state.zoom) + 'px';
      return;
    }
  }
  finger.style.display = 'none';
}

// ---- helpers ----
function playerNodeCount() { let c = 0; for (const n of state.nodes) if (n.owner === 'player') c++; return c; }
function playerHQ() {
  let hq = null;
  for (const n of state.nodes) { if (n.owner !== 'player') continue; hq = n; if (n.nodeType === 'capital') break; }
  return hq;
}

// Exposed for the inline onclick fallbacks in node-conquest.html.
window.startSkirmish = startSkirmish;
window.startTutorial = startTutorial;

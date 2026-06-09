// =====================================================
// CAMPAIGN — the progressive training arc that replaces the old 14-step
// finger-pointing tutorial.
//
// Philosophy (per design direction): don't dump every mechanic at once. Teach
// the SIMPLEST thing first — march troops out and take ground — and let the
// player just play it. Each later level unlocks ONE new tool, so the arsenal
// grows one idea at a time:
//
//   L1  Take Ground   — capture only. No buildings at all.
//   L2  Air & Flak    — + drone factory, anti-air, drone-nets.
//   L3  Armor         — + tank factory.
//   L4  Bombardment   — + artillery. Full arsenal.
//   ▸ graduate → the big-map skirmish ("the arena").
//
// Mechanically each level is a tiny hand-built map vs DDCHING. We REUSE the
// tutorial gate (state.tutorial.unlocked + tutorial-gate.js) as the per-level
// lock: a level pre-unlocks exactly its toolset, so the same input.js / camera
// gates that powered the old tutorial now enforce "you don't have tanks yet".
// There is no per-step machine — a level shows a brief, then the player plays
// until DDCHING is wiped (win) or the player is (retry).
//
// Progress persists in localStorage so finished levels aren't repeated.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';
import { dist } from './util.js';
import { COLOR, GLOW, FACTIONS, factionStats, AIS, hexToRgba } from './factions.js';
import { isAlly } from './alliance.js';
import { clampCamera } from './camera.js';
import { resetEngineering } from './engineering.js';
import { buildHUD } from './render.js';
import { sfxVictory, sfxDefeat } from './audio.js';

const $ = (id) => document.getElementById(id);
const PROGRESS_KEY = 'cell.campaign.progress';   // highest unlocked level index (0-based)
const GRACE_S = 5;                                // enemy AI stays calm this long at level start

// ---- Level definitions ----------------------------------------------------
// Each level: a compact layout (player cluster left, DDCHING right, neutral
// stepping-stones between) + the exact capability tokens the player gets.
// `nodes`: {name, dx, dy from world centre, owner: 'player'|'enemy'|'neutral',
//           size, units, cap?(capital)}.  `links`: [i,j] road pairs.
// `unlock`: tokens added to state.tutorial.unlocked (gates input + camera).
//           Build tokens are unit-type names ('antiair','factory','net',
//           'tank','artillery') — input.js gates each build key on its own.
// `enemyBuilds`: false → DDCHING never constructs (keeps L1 a pure troop war).
const BASE_UI = ['view', 'select', 'send', 'vision', 'speed', 'command'];

export const LEVELS = [
  {
    id: 'l1', name: 'Take Ground',
    brief: {
      en: 'Basics — drag from a base to a target to send troops and capture it. No buildings yet: just take ground, then take DDCHING\'s HQ.',
      zh: '基礎 —— 從基地拖到目標派兵佔領。先不蓋任何東西,純粹攻城奪寨,最後拿下 DDCHING 指揮部。',
    },
    unlock: [...BASE_UI],
    enemyBuilds: false, enemyStrength: 0.7,
    nodes: [
      { name: 'Aleph Base',     dx: -760, dy:  220, owner: 'player',  size: 38, units: 64, cap: true },
      { name: 'Beta Outpost',   dx: -760, dy: -260, owner: 'player',  size: 30, units: 30 },
      { name: 'Drill Site',     dx: -140, dy:  -20, owner: 'neutral', size: 26, units: 12 },
      { name: 'DDCHING Outpost', dx: 500, dy:  -20, owner: 'enemy',   size: 28, units: 20 },
      { name: 'DDCHING HQ',     dx: 1020, dy:  220, owner: 'enemy',   size: 36, units: 30, cap: true },
    ],
    links: [[0, 1], [0, 2], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'l2', name: 'Air & Flak',
    brief: {
      en: 'New tools: Q anti-air, F drone factory, N drone-net. DDCHING now flies drones — build flak (Q) to shred them, a factory (F) to strike back, then push.',
      zh: '新工具:Q 防空炮、F 無人機工廠、N 攔截網。DDCHING 會放無人機 —— 用防空炮(Q)打下來、工廠(F)反擊,再進攻。',
    },
    unlock: [...BASE_UI, 'antiair', 'factory', 'net'],
    enemyBuilds: true, enemyStrength: 0.85,
    nodes: [
      { name: 'Aleph Base',     dx: -820, dy:  260, owner: 'player',  size: 38, units: 70, cap: true },
      { name: 'Beta Outpost',   dx: -820, dy: -280, owner: 'player',  size: 30, units: 32 },
      { name: 'Drill Site',     dx: -220, dy:  -40, owner: 'neutral', size: 26, units: 14 },
      { name: 'Ferrous Works',  dx: -160, dy:  420, owner: 'neutral', size: 24, units: 14 },
      { name: 'DDCHING Forward', dx: 420, dy: -40, owner: 'enemy',    size: 26, units: 22 },
      { name: 'DDCHING Outpost', dx: 940, dy:  -40, owner: 'enemy',   size: 30, units: 26 },
      { name: 'DDCHING HQ',     dx: 1120, dy:  340, owner: 'enemy',   size: 36, units: 32, cap: true },
    ],
    links: [[0, 1], [0, 2], [1, 2], [2, 3], [2, 4], [4, 5], [5, 6], [4, 6]],
  },
  {
    id: 'l3', name: 'Armor',
    brief: {
      en: 'New tool: T tank factory rolls out mobile tanks that grind toward the enemy. Combine flak, drones and armor to break the line.',
      zh: '新工具:T 戰車工廠會產出機動戰車,自己輾向敵人。結合防空、無人機與戰車突破防線。',
    },
    unlock: [...BASE_UI, 'antiair', 'factory', 'net', 'tank'],
    enemyBuilds: true, enemyStrength: 1.0,
    nodes: [
      { name: 'Aleph Base',     dx: -880, dy:  300, owner: 'player',  size: 40, units: 78, cap: true },
      { name: 'Beta Outpost',   dx: -880, dy: -300, owner: 'player',  size: 30, units: 34 },
      { name: 'Gamma Post',     dx: -380, dy:  440, owner: 'player',  size: 26, units: 22 },
      { name: 'Drill Site',     dx: -220, dy:  -60, owner: 'neutral', size: 26, units: 16 },
      { name: 'DDCHING Forward', dx: 380, dy: -60, owner: 'enemy',    size: 28, units: 26 },
      { name: 'DDCHING Outpost', dx: 900, dy: -60, owner: 'enemy',    size: 30, units: 30 },
      { name: 'DDCHING Works',  dx: 700, dy:  420, owner: 'enemy',    size: 28, units: 26 },
      { name: 'DDCHING HQ',     dx: 1160, dy:  360, owner: 'enemy',   size: 38, units: 36, cap: true },
    ],
    links: [[0, 1], [0, 2], [1, 3], [0, 3], [3, 4], [4, 5], [4, 6], [5, 7], [6, 7]],
  },
  {
    id: 'l4', name: 'Bombardment',
    brief: {
      en: 'Final tool: C artillery shells targets from across the map. Full arsenal unlocked — flak, drones, armor, guns. Finish DDCHING.',
      zh: '最後一件武器:C 火炮可隔著半張地圖轟炸。全套武器解鎖 —— 防空、無人機、戰車、火炮。終結 DDCHING。',
    },
    unlock: [...BASE_UI, 'antiair', 'factory', 'net', 'tank', 'artillery'],
    enemyBuilds: true, enemyStrength: 1.1,
    nodes: [
      { name: 'Aleph Base',     dx: -960, dy:  320, owner: 'player',  size: 40, units: 84, cap: true },
      { name: 'Beta Outpost',   dx: -960, dy: -320, owner: 'player',  size: 32, units: 38 },
      { name: 'Gamma Post',     dx: -420, dy:  480, owner: 'player',  size: 26, units: 24 },
      { name: 'Drill Site',     dx: -260, dy:  -80, owner: 'neutral', size: 26, units: 18 },
      { name: 'Ferrous Works',  dx: -200, dy:  -540, owner: 'neutral', size: 24, units: 16 },
      { name: 'DDCHING Forward', dx: 360, dy: -80, owner: 'enemy',    size: 28, units: 30 },
      { name: 'DDCHING Ridge',  dx: 420, dy: -560, owner: 'enemy',    size: 28, units: 28 },
      { name: 'DDCHING Outpost', dx: 900, dy: -80, owner: 'enemy',    size: 30, units: 34 },
      { name: 'DDCHING Works',  dx: 760, dy:  460, owner: 'enemy',    size: 28, units: 30 },
      { name: 'DDCHING HQ',     dx: 1220, dy:  360, owner: 'enemy',   size: 40, units: 42, cap: true },
    ],
    links: [[0, 1], [0, 2], [1, 3], [0, 3], [1, 4], [3, 5], [4, 6], [5, 7], [5, 8], [6, 7], [7, 9], [8, 9]],
  },
];

// ---- Progress (localStorage) ----------------------------------------------
export function getProgress() {
  try { return Math.max(0, Math.min(LEVELS.length, +localStorage.getItem(PROGRESS_KEY) || 0)); }
  catch (e) { return 0; }
}
function setProgress(n) {
  try { localStorage.setItem(PROGRESS_KEY, String(n)); } catch (e) { /* private mode */ }
}
/** True once the player has cleared every level (the arena is unlocked). */
export function campaignGraduated() { return getProgress() >= LEVELS.length; }

// ---- Scenario builder ------------------------------------------------------
/** Build a level's hand-made map. newGame() first (full clean reset), then
 *  override nodes/roads and re-run the systems newGame ran against the procgen
 *  graph (engineering edge cache, HUD roster) — same dance as the old tutorial. */
function buildLevelScenario(level) {
  window.newGame();

  // The foe is always DDCHING (the red slot, renamed for the campaign).
  const enemy = 'red';
  if (!COLOR[enemy]) { COLOR[enemy] = '#ff6678'; GLOW[enemy] = hexToRgba('#ff6678', 0.5); }
  factionStats[enemy] = {
    strength: level.enemyStrength, aggressionMul: level.enemyStrength,
    buildChanceMul: level.enemyBuilds ? level.enemyStrength : 0,
  };
  const eDef = FACTIONS.find(f => f.id === enemy);
  if (eDef) eDef.name = 'DDCHING';
  else FACTIONS.push({ id: enemy, name: 'DDCHING', color: COLOR[enemy] });

  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const resolve = (o) => (o === 'enemy' ? enemy : o);
  state.nodes = level.nodes.map((d, i) => ({
    id: i, x: cx + d.dx, y: cy + d.dy, size: d.size, owner: resolve(d.owner),
    units: d.units, capacity: Math.floor(d.size * 3.6), regenRate: d.size / 30,
    pulse: 0, flash: 0, lastRegenT: 0,
    nodeType: d.cap ? 'capital' : 'town', name: d.name,
  }));

  state.adj = new Map();
  for (const n of state.nodes) state.adj.set(n.id, new Set());
  state.roads = [];
  for (const [a, b] of level.links) {
    state.adj.get(a).add(b); state.adj.get(b).add(a);
    state.roads.push({ a, b, length: dist(state.nodes[a], state.nodes[b]), kind: 'local' });
  }

  // Clean ground; clear procgen art + transient combat.
  state.regions = []; state.barriers = []; state.resourceBelts = [];
  state.fleets = []; state.selectedIds.clear();
  state.gameOver = false; state.timeScale = 1; state.holdFire = false;

  resetEngineering();
  const keep = new Set(['player', enemy, 'ally1', 'neutral']);
  for (let i = FACTIONS.length - 1; i >= 0; i--) if (!keep.has(FACTIONS[i].id)) FACTIONS.splice(i, 1);
  AIS.length = 0; AIS.push(enemy, 'ally1');
  buildHUD();

  // DDCHING stays calm for a short grace so the player can read the brief and
  // make the first move; then its AI wakes and fights for real.
  state._tutEnemy = enemy;
  state.aiTimers[enemy] = GRACE_S;

  // Frame the whole cluster.
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const n of state.nodes) { minx = Math.min(minx, n.x); maxx = Math.max(maxx, n.x); miny = Math.min(miny, n.y); maxy = Math.max(maxy, n.y); }
  const pad = 360;
  state.zoom = Math.min(state.W / (maxx - minx + pad * 2), state.H / (maxy - miny + pad * 2), 1.2);
  state.cameraX = (minx + maxx) / 2 - state.W / (2 * state.zoom);
  state.cameraY = (miny + maxy) / 2 - state.H / (2 * state.zoom);
  clampCamera();
}

// ---- Level flow ------------------------------------------------------------
let onReturnToLobby = null;     // injected by lobby.js to avoid an import cycle

/** lobby.js calls this once to wire the "return to menu" callback. */
export function bindCampaign(returnToLobby) { onReturnToLobby = returnToLobby; }

/** Start the campaign at the player's current (first uncleared) level. */
export function startCampaign() {
  const idx = Math.min(getProgress(), LEVELS.length - 1);
  startLevel(idx);
}

/** Begin a specific level: build its map, set the per-level gate, show the brief. */
export function startLevel(idx) {
  const level = LEVELS[idx];
  if (!level) { graduate(); return; }
  buildLevelScenario(level);
  // Drop the lobby overlay + un-freeze the sim (it's gated on !state.inLobby).
  // Self-contained so EVERY entry path — lobby button, Next-Level, R restart —
  // reliably leaves the menu. (The old tutorial relied on lobby.hideLobby();
  // doing it here means a missing call can't strand the player behind the card.)
  document.body.classList.remove('in-lobby');
  state.inLobby = false;
  state.tutorial = {
    campaign: true, levelIdx: idx, i: 0,
    unlocked: new Set(level.unlock),
    acked: false, result: null, resultShownAt: 0,
    didG: false, didH: false, didPause: false,
  };
  $('tutorial-coach')?.classList.add('show');
  document.body.classList.add('tut-active');
  hideResult();
  showBrief(level, idx);
}

export function restartLevel() {
  if (state.tutorial?.campaign) startLevel(state.tutorial.levelIdx);
}

/** Per-frame driver (called from lobby.tutorialTick when a campaign is active).
 *  No step machine — just watch for win/loss and keep the finger on a target. */
export function campaignTick() {
  const t = state.tutorial;
  if (!t || !t.campaign) return;

  // Result already showing → wait for the player's button.
  if (t.result) return;

  // Win / loss, same ally-aware test the normal checkVictory uses.
  const owners = new Set();
  for (const n of state.nodes) if (n.owner !== 'neutral') owners.add(n.owner);
  for (const f of state.fleets) if (f.owner !== 'neutral') owners.add(f.owner);
  let yoursAlive = false, enemyAlive = false;
  for (const o of owners) { if (isAlly(o, 'player')) yoursAlive = true; else enemyAlive = true; }
  if (!enemyAlive) { endLevel(true); return; }
  if (!yoursAlive) { endLevel(false); return; }

  // L1 hint finger: point at the first capturable (non-player) node until the
  // player has taken something beyond their start.
  positionFinger();
}

function endLevel(win) {
  const t = state.tutorial;
  state.gameOver = true;                       // freeze the sim behind the result card
  try { win ? sfxVictory() : sfxDefeat(); } catch (e) { /* audio may be suspended */ }
  const idx = t.levelIdx;
  const last = idx >= LEVELS.length - 1;
  if (win) setProgress(Math.max(getProgress(), idx + 1));
  t.result = win ? (last ? 'graduate' : 'win') : 'lose';
  showResult(t.result, idx);
}

// ---- UI: brief + result reuse the #message card + coach bubble -------------
function showBrief(level, idx) {
  const coach = $('tutorial-coach'); if (!coach) return;
  coach.querySelector('.tut-zh').textContent = `Level ${idx + 1}/${LEVELS.length} · ${level.name} — ${level.brief.en}`;
  coach.querySelector('.tut-en').textContent = `第 ${idx + 1}/${LEVELS.length} 關 · ${level.brief.zh}`;
  coach.querySelector('.tut-step').textContent = `LEVEL ${idx + 1} / ${LEVELS.length}`;
  const chip = coach.querySelector('.tut-key'); if (chip) chip.style.display = 'none';
  const cont = coach.querySelector('#tut-continue');
  if (cont) { cont.style.display = 'none'; }       // brief auto-stays; no ack needed
}

function showResult(kind, idx) {
  const m = $('message'); if (!m) return;
  const title = $('msg-title'), sub = $('msg-sub');
  const btn = m.querySelector('button');
  const win = kind !== 'lose';
  title.textContent = kind === 'graduate' ? 'Training Complete' : (win ? 'Level Cleared' : 'Mission Failed');
  title.style.color = win ? '#ffd066' : '#ff6678';
  title.style.textShadow = win ? '0 0 24px rgba(255,200,90,.55)' : '0 0 24px rgba(255,100,110,.55)';
  sub.textContent = kind === 'graduate'
    ? 'You\'ve mastered the full arsenal. The arena awaits. · 你已掌握全套武器,格鬥場在等你。'
    : win ? `Level ${idx + 1} of ${LEVELS.length} cleared. · 第 ${idx + 1} 關完成。`
          : `DDCHING wiped you out. Try again. · DDCHING 把你打垮了,再來一次。`;
  if (btn) {
    btn.textContent = kind === 'graduate' ? '▶ Enter the Arena'
                    : win ? 'Next Level ▸' : '↻ Retry';
    // Replace the inline onclick=newGame() with a campaign action.
    btn.onclick = () => {
      hideResult();
      if (kind === 'graduate') { graduate(); }
      else if (win) { startLevel(idx + 1); }
      else { startLevel(idx); }
    };
  }
  m.classList.remove('victory', 'defeat');
  m.classList.add(win ? 'victory' : 'defeat');
  m.style.display = 'none'; void m.offsetHeight; m.style.display = 'block';
}

function hideResult() {
  const m = $('message');
  if (m) {
    m.style.display = 'none';
    const btn = m.querySelector('button');
    // Restore the default Play-Again behaviour for normal skirmishes.
    if (btn) btn.onclick = () => window.newGame();
  }
}

/** All levels cleared → drop straight into the arena (a fresh skirmish). Falls
 *  back to the lobby if the skirmish entry isn't wired (defensive). */
function graduate() {
  setProgress(LEVELS.length);
  endCampaignState();
  if (typeof window !== 'undefined' && window.startSkirmish) window.startSkirmish();
  else if (onReturnToLobby) onReturnToLobby('graduated');
}

/** Tear down campaign state (used by graduate + by START leaving for skirmish). */
export function endCampaignState() {
  state.tutorial = null;
  state.gameOver = false;
  hideResult();
  $('tutorial-coach')?.classList.remove('show');
  document.body.classList.remove('tut-active');
}

// ---- Finger pointer --------------------------------------------------------
function positionFinger() {
  const coach = $('tutorial-coach'); if (!coach) return;
  const finger = coach.querySelector('.tut-finger'); if (!finger) return;
  const t = state.tutorial;
  // Only on L1, only until the player owns more than their two start bases.
  const playerNodes = state.nodes.filter(n => n.owner === 'player').length;
  const startCount = (LEVELS[t.levelIdx].nodes.filter(n => n.owner === 'player').length);
  if (t.levelIdx !== 0 || playerNodes > startCount) { finger.style.display = 'none'; return; }
  const target = state.nodes.find(n => n.owner === 'neutral') || state.nodes.find(n => n.owner === state._tutEnemy);
  if (!target) { finger.style.display = 'none'; return; }
  finger.className = 'tut-finger mode-point';
  finger.style.display = '';
  finger.style.left = ((target.x - state.cameraX) * state.zoom) + 'px';
  finger.style.top = ((target.y - state.cameraY) * state.zoom) + 'px';
}

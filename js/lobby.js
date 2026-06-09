// =====================================================
// Front-of-game flow: the LOBBY (home screen).
//
// Two ways in:
//   • START    → a fresh, fully-unlocked skirmish on the big procedural map
//                ("the arena").
//   • CAMPAIGN → the progressive training arc (campaign.js): tiny hand-built
//                levels that unlock one tool at a time, ending by graduating to
//                the arena. This replaced the old single 14-step tutorial.
//
// This file is now just the lobby shell + delegation. All level logic lives in
// campaign.js; we keep the historical export names (tutorialTick, startTutorial)
// so main.js / input.js imports stay unchanged — they now drive the campaign.
// =====================================================
import { state } from './state.js';
import {
  startCampaign, campaignTick, restartLevel, bindCampaign, endCampaignState,
  getProgress, LEVELS,
} from './campaign.js';

const $ = (id) => document.getElementById(id);

export function initLobby() {
  showLobby();
  bindCampaign(returnToLobby);                 // campaign asks us to re-show the lobby on graduation
  $('lobby-start')?.addEventListener('click', startSkirmish);
  $('lobby-tutorial')?.addEventListener('click', startCampaign);
  $('tut-skip')?.addEventListener('click', abandonCampaign);
  $('tut-continue')?.addEventListener('click', () => {
    state.paused = false; document.body.classList.remove('paused');
    if (state.tutorial) state.tutorial.acked = true;
  });
  updateLobbyButtons();
}

function showLobby() {
  document.body.classList.add('in-lobby');
  state.inLobby = true;
  state.paused = false;
  document.body.classList.remove('paused');
  updateLobbyButtons();
}
function hideLobby() {
  document.body.classList.remove('in-lobby');
  state.inLobby = false;
  const toast = $('lobby-toast');
  if (toast) toast.style.display = 'none';
}

/** START: leave the menu into a fresh, fully-unlocked skirmish. */
export function startSkirmish() {
  endCampaignState();
  window.newGame();
  hideLobby();
}

/** Skip ✕ on a level → drop the campaign and go back to the menu. */
function abandonCampaign() {
  endCampaignState();
  showLobby();
}

/** campaign.js calls this (via bindCampaign) when the player graduates. */
function returnToLobby(reason) {
  const toast = $('lobby-toast');
  if (toast) {
    toast.textContent = reason === 'graduated'
      ? '✓ 訓練全部完成 — 按 START 進入格鬥場 / Training complete — START to enter the arena'
      : '訓練已結束 — 按 START 開始 / Training ended — press START';
    toast.style.display = 'block';
  }
  showLobby();
}

/** Reflect campaign progress on the lobby button. */
function updateLobbyButtons() {
  const b = $('lobby-tutorial');
  if (!b) return;
  const p = getProgress();
  b.textContent = (p >= LEVELS.length)
    ? '🎓 CAMPAIGN ✓'
    : `🎓 CAMPAIGN · L${Math.min(p + 1, LEVELS.length)}`;
}

/** Per-frame from the main loop — delegate to the campaign driver (no-op when
 *  not in a campaign level). Kept under the historical name for main.js. */
export function tutorialTick() {
  if (state.tutorial?.campaign) campaignTick();
}

/** R key: restart the current level (or, from the lobby, begin the campaign).
 *  Kept under the historical name for input.js. */
export function startTutorial() {
  if (state.tutorial?.campaign) restartLevel();
  else startCampaign();
}

// Exposed for inline onclick fallbacks in node-conquest.html.
window.startSkirmish = startSkirmish;
window.startTutorial = startTutorial;

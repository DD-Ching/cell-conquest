// =====================================================
// CrazyGames SDK facade — ads + session lifecycle.
//
// MAIN-THREAD ONLY. All CrazyGames SDK access is funneled through this one
// module so the rest of the game never touches `window.CrazyGames` directly.
// Everything degrades to a silent no-op when the SDK script is absent or the
// game runs outside the CrazyGames iframe (e.g. local `serve.py` dev, or the
// SDK being blocked) — so the game ALWAYS runs and plays identically with or
// without ads.
//
// What the SDK gives us (https://docs.crazygames.com/sdk/):
//   • game.loadingStart / loadingStop  — wrap boot/asset load
//   • game.gameplayStart / gameplayStop — bracket active play (gates ad timing
//     + powers the engagement metrics CrazyGames ranks on)
//   • game.happytime()                 — site confetti on a big win
//   • ad.requestAd('midgame'|'rewarded', cbs) — the only sanctioned ad path
//   • ad.hasAdblock()                  — game must still work when true
//
// Ad placement policy baked in here (and required by QA):
//   - Midgame ads fire ONLY at a natural break (match over → Play Again), never
//     mid-battle, never on a nav button. The SDK self-limits to 1 / 3 min.
//   - Audio is muted + the sim paused for the duration, then restored.
//   - Rewarded ads are OPTIONAL bonuses; the reward is granted ONLY on the
//     adFinished callback, never on adError, and the base game is fully
//     playable without ever watching one.
// =====================================================
import { state } from './state.js';
import { setMuted, isAudioMuted } from './audio.js';

let SDK = null;          // window.CrazyGames.SDK once init resolves
let ready = false;       // SDK present AND initialized
let adblock = false;     // best-effort adblock probe (game must work regardless)

function rawSDK() {
  return (typeof window !== 'undefined' && window.CrazyGames && window.CrazyGames.SDK) || null;
}

/** Initialize the SDK if its script loaded. Safe to await even when absent —
 *  resolves to a no-op state. Call once at boot. */
export async function initAds() {
  const s = rawSDK();
  if (!s) return;                 // script not present / blocked → stay no-op
  SDK = s;
  try {
    // v3 must be awaited before use; v2 self-initializes (init may be absent).
    if (typeof SDK.init === 'function') await SDK.init();
    ready = true;
    try { adblock = await SDK.ad.hasAdblock(); } catch { /* ignore */ }
  } catch (e) {
    ready = false;                // init failed → no-op for the session
  }
}

export function isAdsReady() { return ready; }
export function hasAdblock() { return adblock; }

// ---- Session lifecycle (cheap no-ops until ready) ----
export function loadingStart() { if (ready) try { SDK.game.loadingStart(); } catch {} }
export function loadingStop()  { if (ready) try { SDK.game.loadingStop();  } catch {} }
export function gameplayStart() { if (ready) try { SDK.game.gameplayStart(); } catch {} }
export function gameplayStop()  { if (ready) try { SDK.game.gameplayStop();  } catch {} }
export function happytime()     { if (ready) try { SDK.game.happytime();     } catch {} }

/** Mute audio + pause the sim for an ad, returning a restore() that puts both
 *  back exactly as they were. Survives the player having muted themselves. */
function silenceForAd() {
  const wasMuted  = isAudioMuted();
  const wasPaused = state.paused;
  setMuted(true);
  state.paused = true;
  return function restore() {
    setMuted(wasMuted);
    state.paused = wasPaused;
  };
}

/** Request a midgame (interstitial) ad at a natural break. `done` is ALWAYS
 *  called exactly once — on finish, on error, or immediately when no SDK — so
 *  the caller's flow (e.g. starting the next match) never stalls behind ads.
 *  Audio is muted + sim paused while the ad shows. */
export function requestMidgameAd(done) {
  const finishOnce = (() => { let did = false; return () => { if (!did) { did = true; done && done(); } }; })();
  if (!ready || !SDK.ad) { finishOnce(); return; }
  let restore = null;
  try {
    SDK.ad.requestAd('midgame', {
      adStarted:  () => { restore = silenceForAd(); },
      adFinished: () => { if (restore) restore(); finishOnce(); },
      adError:    () => { if (restore) restore(); finishOnce(); },
    });
  } catch (e) {
    if (restore) restore();
    finishOnce();
  }
}

/** Request a rewarded video. `onReward` runs ONLY if the ad completes; `onSkip`
 *  (optional) runs on error/skip/no-SDK so the UI can re-enable the button.
 *  Never grant the reward on error — that's an explicit QA rejection trigger. */
export function requestRewardedAd(onReward, onSkip) {
  if (!ready || !SDK.ad) { onSkip && onSkip(); return; }
  let restore = null;
  try {
    SDK.ad.requestAd('rewarded', {
      adStarted:  () => { restore = silenceForAd(); },
      adFinished: () => { if (restore) restore(); onReward && onReward(); },
      adError:    () => { if (restore) restore(); onSkip && onSkip(); },
    });
  } catch (e) {
    if (restore) restore();
    onSkip && onSkip();
  }
}

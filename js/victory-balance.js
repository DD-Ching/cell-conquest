// =====================================================
// Victory-balance ball physics + the growth-buff "momentum swing".
//
// Extracted from checkVictory so the win-check stays small. Each call advances
// the ball one frame on the morphing beam (天秤) and, when the ball rolls off an
// END, hands that SIDE a temporary growth boost instead of ending the match:
//
//   ball falls left  (bx ≤ −1) → YOUR side  (player + Lieutenant) grows ×BUFF
//   ball falls right (bx ≥ +1) → the rival faction grows ×BUFF
//
// The buff lasts VICTORY_BALL_RESPAWN game-seconds; during it the ball sits at
// the fallen end. When it expires the ball respawns at centre (bx=0), the buff
// clears, and the contest restarts — a recurring economy swing, not sudden death.
// The growth multiplier itself is applied in world.catchUpRegen, keyed off
// state.growthBuffOwner / state.growthBuffUntil (isAlly so a side's allies share
// it). The match still ends only by elimination (checkVictory's alive checks).
// =====================================================
import { state } from './state.js';
import {
  VICTORY_CURVE_K, VICTORY_TILT_GAIN, VICTORY_BALL_DAMP,
  VICTORY_BALL_RESPAWN,
} from './config.js';

/** Advance the ball + buff swing one frame. Returns the _victoryInfo payload
 *  render-victory.js consumes. `kv` = beam curvature, `lead` = your share −
 *  rival's, `yf`/`ef` = territory shares, `topEnemyOwner` = the strongest rival. */
export function updateBalanceBall({ vdt, kv, lead, yf, ef, topEnemyOwner }) {
  const fallen = state._ballFallen || 0;

  if (fallen !== 0) {
    // Buff window — hold the ball off the beam at the fallen end until respawn.
    if (state.elapsed >= (state._ballRespawnAt || 0)) {
      state._ballFallen = 0;
      state._ballX = 0;
      state._ballV = 0;
      state.growthBuffOwner = null;
      state.growthBuffUntil = 0;
    }
  } else {
    // Normal roll — sub-step the integration so a fast-forward frame stays stable.
    const tilt = -VICTORY_TILT_GAIN * lead;       // you lead → ball rolls to YOUR (−x) end
    const kPhys = VICTORY_CURVE_K * kv;            // >0 restoring (smile), <0 runaway (frown)
    let bx = state._ballX || 0, bv = state._ballV || 0;
    let rem = vdt;
    while (rem > 1e-4) {
      const h = Math.min(0.05, rem); rem -= h;
      const accel = -2 * kPhys * bx + tilt - VICTORY_BALL_DAMP * bv;
      bv += accel * h;
      bx += bv * h;
      if (bx > 1.25) { bx = 1.25; bv = 0; } else if (bx < -1.25) { bx = -1.25; bv = 0; }
    }
    state._ballX = bx; state._ballV = bv;

    // Fall-off → reward that side with a growth buff + schedule the respawn.
    if (bx <= -1 || bx >= 1) {
      const side = bx <= -1 ? -1 : 1;
      state._ballFallen = side;
      state._ballRespawnAt = state.elapsed + VICTORY_BALL_RESPAWN;
      state.growthBuffOwner = side < 0 ? 'player' : topEnemyOwner;
      state.growthBuffUntil = state._ballRespawnAt;
    }
  }

  const buffActive = state.elapsed < (state.growthBuffUntil || 0);
  const phase = kv > 0.25 ? 'deadlock' : kv < -0.25 ? 'suddendeath' : 'decisive';
  return {
    active: true,
    yourShare: yf, enemyShare: ef,
    ballX: state._ballX, ballV: state._ballV,
    curvature: kv, lead, phase,
    enemyOwner: topEnemyOwner,
    // Buff-swing read-outs for render-victory.js:
    ballFallen: state._ballFallen || 0,            // -1 fallen-to-you / 0 on-beam / +1 fallen-to-rival
    buffActive,
    buffSide: buffActive ? (state.growthBuffOwner === 'player' ? -1 : 1) : 0,
    respawnIn: buffActive ? Math.max(0, (state._ballRespawnAt || 0) - state.elapsed) : 0,
  };
}

// =====================================================
// Victory-balance ball physics + the growth-buff "momentum swing".
//
// The 天秤 is a FLAT, level beam (no tilt, no curvature). A ball sits on it and is
// PUSHED sideways by the territory-weight imbalance: lead = your share − rival's.
// You lead → the ball is shoved toward YOUR (left, −u) end. The ball carries real
// momentum and rolling friction; there is NO restoring force (a flat surface lets
// it rest wherever friction stops it). The LEVER ARM (beam half-length) shrinks
// over match-time, so the ball's normalized track gets shorter and the same lead
// tips it off the end sooner — the finish turns more decisive the longer it runs.
//
// When the ball rolls off an END this hands that SIDE a temporary growth boost
// instead of ending the match:
//   ball falls left  (u ≤ −1) → YOUR side  (player + Lieutenant) grows ×BUFF
//   ball falls right (u ≥ +1) → the rival faction grows ×BUFF
// Because the push follows the lead, the ball falls to the LEADING side — the buff
// is a snowball the leader earns, not a coin flip.
//
// The buff lasts VICTORY_BALL_RESPAWN game-seconds; during it the ball sits at the
// fallen end. When it expires the ball respawns at centre (u=0), the buff clears,
// and the contest restarts — a recurring economy swing, not sudden death. The
// growth multiplier itself is applied in world.catchUpRegen, keyed off
// state.growthBuffOwner / state.growthBuffUntil (isAlly so a side's allies share
// it). The match still ends only by elimination (checkVictory's alive checks).
// =====================================================
import { state } from './state.js';
import {
  VICTORY_APPEAR_MIN, VICTORY_ARM_MAX, VICTORY_ARM_MIN, VICTORY_ARM_LATE_MIN,
  VICTORY_PUSH_GAIN, VICTORY_BALL_FRICTION, VICTORY_BALL_RESPAWN,
} from './config.js';

/** Current lever arm (beam half-length, px): full at APPEAR, shrinking to the
 *  minimum by ARM_LATE_MIN. A shorter arm = a shorter track for the ball. */
function currentArm() {
  const tmin = state.elapsed / 60;
  const span = Math.max(0.001, VICTORY_ARM_LATE_MIN - VICTORY_APPEAR_MIN);
  const f = Math.max(0, Math.min(1, (tmin - VICTORY_APPEAR_MIN) / span));
  return VICTORY_ARM_MAX + (VICTORY_ARM_MIN - VICTORY_ARM_MAX) * f;
}

/** Advance the ball + buff swing one frame. Returns the _victoryInfo payload
 *  render-victory.js consumes. `lead` = your share − rival's, `yf`/`ef` =
 *  territory shares, `topEnemyOwner` = the strongest rival. */
export function updateBalanceBall({ vdt, lead, yf, ef, topEnemyOwner }) {
  const arm = currentArm();
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
    // Flat-beam push — sub-step the integration so a fast-forward frame stays stable.
    // accel(u) = −PUSH·lead·(ARM_MAX/arm) − FRICTION·v.  lead>0 (you lead) pushes the
    // ball to −u (your end). The (ARM_MAX/arm) term is the shrink amplifier: the
    // shorter the beam, the faster the same lead drives the ball across its track.
    const amp = VICTORY_ARM_MAX / arm;                 // 1 at full arm → ~2.2 when shortest
    const push = -VICTORY_PUSH_GAIN * lead * amp;      // toward the leading side
    let bx = state._ballX || 0, bv = state._ballV || 0;
    let rem = vdt;
    while (rem > 1e-4) {
      const h = Math.min(0.05, rem); rem -= h;
      const accel = push - VICTORY_BALL_FRICTION * bv;
      bv += accel * h;
      bx += bv * h;
      if (bx > 1.25) { bx = 1.25; bv = 0; } else if (bx < -1.25) { bx = -1.25; bv = 0; }
    }
    state._ballX = bx; state._ballV = bv;

    // Roll-off → reward that side with a growth buff + schedule the respawn.
    if (bx <= -1 || bx >= 1) {
      const side = bx <= -1 ? -1 : 1;
      state._ballFallen = side;
      state._ballRespawnAt = state.elapsed + VICTORY_BALL_RESPAWN;
      state.growthBuffOwner = side < 0 ? 'player' : topEnemyOwner;
      state.growthBuffUntil = state._ballRespawnAt;
    }
  }

  const buffActive = state.elapsed < (state.growthBuffUntil || 0);
  const armFrac = (arm - VICTORY_ARM_MIN) / Math.max(1, VICTORY_ARM_MAX - VICTORY_ARM_MIN);
  // Mood from how short (decisive) the arm has become, unless a buff is swinging.
  const phase = armFrac > 0.66 ? 'contested' : armFrac > 0.25 ? 'decisive' : 'suddendeath';
  return {
    active: true,
    yourShare: yf, enemyShare: ef,
    ballX: state._ballX, ballV: state._ballV,
    arm, armFrac, lead, phase,
    enemyOwner: topEnemyOwner,
    // Buff-swing read-outs for render-victory.js:
    ballFallen: state._ballFallen || 0,            // -1 fallen-to-you / 0 on-beam / +1 fallen-to-rival
    buffActive,
    buffSide: buffActive ? (state.growthBuffOwner === 'player' ? -1 : 1) : 0,
    respawnIn: buffActive ? Math.max(0, (state._ballRespawnAt || 0) - state.elapsed) : 0,
  };
}

// =====================================================
// Victory balance — a ball rolling on a FLAT, level beam (天秤), the late-game
// decider (see checkVictory + the VICTORY_* config). Drawn in SCREEN space,
// top-centre. The beam:
//
//   * stays PERFECTLY LEVEL the whole match — no tilt, no curvature,
//   * carries a WEIGHT PAN on each end whose size = that side's territory share
//     (you left, strongest rival right) — the heavier pan = the bigger block,
//   * the weight IMBALANCE is a sideways PUSH (drawn as an arrow) that rolls the
//     glowing BALL toward the leading side; whichever END it rolls off decides the
//     swing. The nearer-to-falling end flares as a danger cue.
//   * the LEVER ARM (beam half-length) SHRINKS over match-time, so the ball's track
//     visibly gets shorter and the finish turns more decisive.
//
// Reads state._victoryInfo (populated each frame by checkVictory). Self-gates on
// .active — nothing draws until the balance appears in the late game. Screen-space
// only. (Not yet wired into the render-worker snapshot — opt-in path.)
// =====================================================

import { state } from './state.js';
import { COLOR, FACTIONS } from './factions.js';
import { VICTORY_ARM_MAX } from './config.js';

const PIVOT_Y = 96, BALL_R = 11, BEAM_TH = 8;

function drawBall(ctx, x, y, glowColor, glow, roll, now) {
  // a lit sphere with a coloured bloom; two spin dots so the roll reads as rotation.
  ctx.save();
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 8 + 20 * glow * (0.7 + 0.3 * Math.sin(now * 0.012));
  const g = ctx.createRadialGradient(x - 3, y - 4, 1, x, y, BALL_R);
  g.addColorStop(0, '#fff7e6'); g.addColorStop(0.45, '#e8c98a'); g.addColorStop(1, '#7a5526');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, BALL_R, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(90,60,30,0.5)';
  for (let i = 0; i < 2; i++) {
    const a = roll + i * Math.PI;
    ctx.beginPath(); ctx.arc(x + Math.cos(a) * BALL_R * 0.5, y + Math.sin(a) * BALL_R * 0.5, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

export function drawVictoryBalance(ctx, W, H, now) {
  const info = state._victoryInfo;
  if (!info || !info.active || state.gameOver || state.inLobby || state.tutorial) return;

  const cx = W / 2;
  const FRAME = VICTORY_ARM_MAX;          // fixed frame width → the shrinking beam reads against it
  const playerColor = COLOR['player'] || '#5cb3ff';
  const enemyColor = COLOR[info.enemyOwner] || '#ff6678';
  const enemyName = (FACTIONS.find(f => f.id === info.enemyOwner) || {}).name || 'ENEMY';

  // Ease the displayed arm so the shrink reads as motion, not stepping.
  const targetArm = info.arm || VICTORY_ARM_MAX;
  state._vizArm = (state._vizArm ?? targetArm) + (targetArm - (state._vizArm ?? targetArm)) * 0.06;
  const arm = state._vizArm;
  const u = Math.max(-1, Math.min(1, info.ballX || 0));
  const leftX = cx - arm, rightX = cx + arm;

  ctx.save();
  ctx.textAlign = 'center';

  // panel bg (fixed width) + header
  ctx.fillStyle = 'rgba(10,6,3,0.45)';
  ctx.beginPath(); ctx.roundRect(cx - FRAME - 48, PIVOT_Y - 58, (FRAME + 48) * 2, 216, 12); ctx.fill();
  ctx.fillStyle = 'rgba(230,200,150,0.7)'; ctx.font = '700 11px ui-monospace, monospace';
  ctx.fillText('天秤 · S E C T O R   C O N T R O L', cx, PIVOT_Y - 42);

  // fulcrum: ground shadow + pyramid post (the level beam rests on its tip)
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(cx, PIVOT_Y + 58, 30, 7, 0, 0, Math.PI * 2); ctx.fill();
  const fg = ctx.createLinearGradient(cx, PIVOT_Y, cx, PIVOT_Y + 56);
  fg.addColorStop(0, '#caa46a'); fg.addColorStop(1, '#5a3e22'); ctx.fillStyle = fg;
  ctx.beginPath(); ctx.moveTo(cx - 15, PIVOT_Y + 56); ctx.lineTo(cx + 15, PIVOT_Y + 56);
  ctx.lineTo(cx + 4, PIVOT_Y + 2); ctx.lineTo(cx - 4, PIVOT_Y + 2); ctx.closePath(); ctx.fill();

  // flat beam — a straight horizontal bar (depth copy, then a lit gradient)
  const beam = (yoff, th, style) => {
    ctx.beginPath(); ctx.moveTo(leftX, PIVOT_Y + yoff); ctx.lineTo(rightX, PIVOT_Y + yoff);
    ctx.lineWidth = th; ctx.lineCap = 'round'; ctx.strokeStyle = style; ctx.stroke();
  };
  beam(4, BEAM_TH + 2, '#3a2814');
  const bg = ctx.createLinearGradient(leftX, 0, rightX, 0);
  bg.addColorStop(0, playerColor); bg.addColorStop(0.5, '#e8d6a8'); bg.addColorStop(1, enemyColor);
  beam(0, BEAM_TH, bg);
  ctx.fillStyle = '#e8d6a8'; ctx.beginPath(); ctx.arc(cx, PIVOT_Y, 5, 0, Math.PI * 2); ctx.fill();

  // hanging weight pans — block size = territory share (heavier side = bigger block)
  const weight = (ex, share, color) => {
    const boxW = 26, boxH = 9 + Math.max(0, Math.min(1, share)) * 46;
    ctx.strokeStyle = 'rgba(210,180,130,0.55)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(ex - 8, PIVOT_Y + 2); ctx.lineTo(ex, PIVOT_Y + 16);
    ctx.moveTo(ex + 8, PIVOT_Y + 2); ctx.lineTo(ex, PIVOT_Y + 16); ctx.stroke();
    const wy = PIVOT_Y + 16;
    const wg = ctx.createLinearGradient(0, wy, 0, wy + boxH);
    wg.addColorStop(0, color); wg.addColorStop(1, 'rgba(20,12,6,0.85)');
    ctx.fillStyle = wg;
    ctx.beginPath(); ctx.roundRect(ex - boxW / 2, wy, boxW, boxH, 4); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
  };
  weight(leftX, info.yourShare, playerColor);
  weight(rightX, info.enemyShare, enemyColor);

  // push arrow — the weight imbalance shoves the ball toward the leading side
  const lead = info.lead || 0;
  if (Math.abs(lead) > 0.01 && !info.buffActive) {
    const dir = lead > 0 ? -1 : 1;                 // lead>0 (you lead) → push to YOUR (left) end
    const col = lead > 0 ? playerColor : enemyColor;
    const ay = PIVOT_Y - 30, len = Math.min(0.9, Math.abs(lead)) * arm * 0.82 + 6;
    ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now * 0.01);
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, ay); ctx.lineTo(cx + dir * len, ay); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath();
    ctx.moveTo(cx + dir * len, ay); ctx.lineTo(cx + dir * (len - 7), ay - 4);
    ctx.lineTo(cx + dir * (len - 7), ay + 4); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // end danger flares — the end the ball is closest to rolling off pulses hot
  const endGlow = (ex, color, near) => {
    if (near <= 0.5) return;
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 16 * (near - 0.5) / 0.5 * (0.7 + 0.3 * Math.sin(now * 0.02));
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(ex, PIVOT_Y, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  };
  endGlow(rightX, enemyColor, u);
  endGlow(leftX, playerColor, -u);

  // the ball, rolling on the level beam (contact shadow + lit sphere)
  const bxs = cx + u * arm, bys = PIVOT_Y - BEAM_TH / 2 - BALL_R + 1;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(bxs, PIVOT_Y - BEAM_TH / 2 + 1, BALL_R * 0.8, 3, 0, 0, Math.PI * 2); ctx.fill();
  state._ballRoll = (state._ballRoll || 0) + (info.ballV || 0) * 0.3;
  const lean = u < -0.05 ? playerColor : u > 0.05 ? enemyColor : '#ffd066';
  drawBall(ctx, bxs, bys, lean, Math.abs(u), state._ballRoll, now);

  // share labels under each weight
  ctx.font = '700 12px ui-monospace, monospace';
  ctx.fillStyle = playerColor; ctx.fillText(`YOU ${Math.round(info.yourShare * 100)}%`, leftX, PIVOT_Y + 124);
  ctx.fillStyle = enemyColor;  ctx.fillText(`${enemyName.toUpperCase()} ${Math.round(info.enemyShare * 100)}%`, rightX, PIVOT_Y + 124);

  // momentum buff badge — the side the ball fell to grows ×1.25 until respawn
  if (info.buffActive) {
    const bx2 = info.buffSide < 0 ? leftX : rightX;
    const bc = info.buffSide < 0 ? playerColor : enemyColor;
    ctx.save(); ctx.shadowColor = bc; ctx.shadowBlur = 10 + 8 * Math.sin(now * 0.012);
    ctx.fillStyle = bc; ctx.font = '800 12px ui-monospace, monospace';
    ctx.fillText('⚡ +25% GROWTH', bx2, PIVOT_Y - 30);
    ctx.restore();
  }

  // status banner — momentum swing while a side is buffed, else the decisiveness mood
  const phase = info.buffActive
    ? { t: `MOMENTUM ${info.buffSide < 0 ? 'YOURS' : 'RIVAL'} · ${Math.ceil(info.respawnIn)}s`, c: info.buffSide < 0 ? playerColor : enemyColor, s: 0.02 }
    : info.phase === 'contested' ? { t: '⚔  CONTESTED', c: '#ffd066', s: 0.008 }
    : info.phase === 'suddendeath' ? { t: '☠  SUDDEN SWING', c: '#ff5a4a', s: 0.02 }
    : { t: '⚖  DECISIVE', c: 'rgba(255,200,120,0.95)', s: 0.012 };
  ctx.globalAlpha = 0.7 + 0.3 * Math.sin(now * phase.s);
  ctx.fillStyle = phase.c; ctx.font = '700 13px ui-monospace, monospace';
  ctx.fillText(phase.t, cx, PIVOT_Y + 146);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// =====================================================
// Victory balance — a ball rolling on a morphing beam (天秤), the late-game
// decider (see checkVictory + the VICTORY_* config). Drawn in SCREEN space,
// top-centre. The beam:
//
//   * TILTS toward whichever side holds more of the owned map (territory lead),
//   * MORPHS its curvature over match-time — a SMILE (∪) early (the ball settles
//     in the middle → deadlock, hard to decide), easing to FLAT (any lead slides
//     the ball off → decisive), then a FROWN (∩) super-late (unstable centre →
//     the ball bolts off the slightest lean → sudden death),
//   * carries a glowing BALL that rolls under the tilt; whichever END it falls
//     off decides the match. The nearer-to-falling end flares as a danger cue.
//
// Reads state._victoryInfo (populated each frame by checkVictory). Self-gates on
// .active — nothing draws until the balance appears in the late game. Screen-space
// only. (Not yet wired into the render-worker snapshot — opt-in path.)
// =====================================================

import { state } from './state.js';
import { COLOR, FACTIONS } from './factions.js';

const ARM_MAX = 200, PIVOT_Y = 96, CURVE_AMP = 42, BALL_R = 11, SAMPLES = 30;

// A point on the beam centreline. u ∈ [-1,1] along the beam; curvature kv∈[-1,1]
// (smile>0 lifts the ends, frown<0 drops them); rotated by tilt (cos/sin) about pivot.
function beamPoint(cx, ARM, kv, cos, sin, u) {
  const lx = u * ARM, ly = -kv * CURVE_AMP * (u * u);
  return { x: cx + lx * cos - ly * sin, y: PIVOT_Y + lx * sin + ly * cos };
}

function drawBall(ctx, x, y, glowColor, glow, now) {
  // contact shadow handled by caller; here: a lit sphere with a coloured bloom.
  ctx.save();
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 8 + 22 * glow * (0.7 + 0.3 * Math.sin(now * 0.012));
  const g = ctx.createRadialGradient(x - 3, y - 4, 1, x, y, BALL_R);
  g.addColorStop(0, '#fff7e6'); g.addColorStop(0.45, '#e8c98a'); g.addColorStop(1, '#7a5526');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, BALL_R, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

export function drawVictoryBalance(ctx, W, H, now) {
  const info = state._victoryInfo;
  if (!info || !info.active || state.gameOver || state.inLobby || state.tutorial) return;

  const cx = W / 2, ARM = Math.min(ARM_MAX, Math.max(130, W * 0.2));
  const playerColor = COLOR['player'] || '#5cb3ff';
  const enemyColor = COLOR[info.enemyOwner] || '#ff6678';
  const enemyName = (FACTIONS.find(f => f.id === info.enemyOwner) || {}).name || 'ENEMY';

  // Smooth the tilt + curvature so morph/tip reads as motion, not snapping.
  const targetTilt = -Math.max(-1, Math.min(1, info.lead)) * 0.40;
  state._vizTilt = (state._vizTilt || 0) + (targetTilt - (state._vizTilt || 0)) * 0.07;
  state._vizCurve = (state._vizCurve || 0) + (info.curvature - (state._vizCurve || 0)) * 0.05;
  const th = state._vizTilt, kv = state._vizCurve, cos = Math.cos(th), sin = Math.sin(th);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(10,6,3,0.45)';
  ctx.beginPath(); ctx.roundRect(cx - ARM - 48, PIVOT_Y - 58, (ARM + 48) * 2, 210, 12); ctx.fill();
  ctx.fillStyle = 'rgba(230,200,150,0.7)'; ctx.font = '700 11px ui-monospace, monospace';
  ctx.fillText('S E C T O R   C O N T R O L', cx, PIVOT_Y - 42);

  // fulcrum: ground shadow + pyramid post (the beam centre rides its tip at pivot)
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(cx, PIVOT_Y + 60, 32, 7, 0, 0, Math.PI * 2); ctx.fill();
  const fg = ctx.createLinearGradient(cx, PIVOT_Y, cx, PIVOT_Y + 58);
  fg.addColorStop(0, '#caa46a'); fg.addColorStop(1, '#5a3e22'); ctx.fillStyle = fg;
  ctx.beginPath(); ctx.moveTo(cx - 16, PIVOT_Y + 58); ctx.lineTo(cx + 16, PIVOT_Y + 58);
  ctx.lineTo(cx + 4, PIVOT_Y); ctx.lineTo(cx - 4, PIVOT_Y); ctx.closePath(); ctx.fill();

  // beam — sampled curve. darker offset copy first (depth), then a lit gradient stroke.
  const pts = [];
  for (let i = 0; i <= SAMPLES; i++) pts.push(beamPoint(cx, ARM, kv, cos, sin, -1 + (2 * i) / SAMPLES));
  const strokeBeam = (off, w, style) => {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y + off);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y + off);
    ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = style; ctx.stroke();
  };
  strokeBeam(4, 9, '#3a2814');
  const bg = ctx.createLinearGradient(pts[0].x, 0, pts[pts.length - 1].x, 0);
  bg.addColorStop(0, playerColor); bg.addColorStop(0.5, '#e8d6a8'); bg.addColorStop(1, enemyColor);
  strokeBeam(0, 7, bg);
  ctx.fillStyle = '#e8d6a8'; ctx.beginPath(); ctx.arc(cx, PIVOT_Y, 5, 0, Math.PI * 2); ctx.fill();

  // end danger flares — the end the ball is closest to falling off pulses hot
  const endGlow = (p, color, near) => {
    if (near <= 0.55) return;
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 18 * (near - 0.55) / 0.45 * (0.7 + 0.3 * Math.sin(now * 0.02));
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  };
  const bx = info.ballX || 0;   // <0 = leaning to YOU (left end) ; >0 = leaning to the rival (right end)
  endGlow(pts[pts.length - 1], enemyColor, bx);    // right end flares as the ball nears the rival's side
  endGlow(pts[0], playerColor, -bx);               // left end flares as it nears yours

  // the ball, sitting on the curve at u = ballX (with a contact shadow)
  const u = Math.max(-1, Math.min(1, bx));
  const bp = beamPoint(cx, ARM, kv, cos, sin, u);
  const tlx = ARM, tly = -2 * kv * CURVE_AMP * u, tlen = Math.hypot(tlx, tly) || 1;
  let nlx = -tly / tlen, nly = tlx / tlen; if (nly > 0) { nlx = -nlx; nly = -nly; }   // up-pointing normal
  const nx = nlx * cos - nly * sin, ny = nlx * sin + nly * cos;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(bp.x, bp.y + 2, BALL_R * 0.8, 3, 0, 0, Math.PI * 2); ctx.fill();
  const lean = u < -0.05 ? playerColor : u > 0.05 ? enemyColor : '#ffd066';
  drawBall(ctx, bp.x + nx * BALL_R, bp.y + ny * BALL_R, lean, Math.abs(u), now);

  // share labels under each end
  ctx.font = '700 12px ui-monospace, monospace';
  ctx.fillStyle = playerColor; ctx.fillText(`YOU ${Math.round(info.yourShare * 100)}%`, pts[0].x, PIVOT_Y + 92);
  ctx.fillStyle = enemyColor;  ctx.fillText(`${enemyName.toUpperCase()} ${Math.round(info.enemyShare * 100)}%`, pts[pts.length - 1].x, PIVOT_Y + 92);

  // momentum buff badge — the side the ball fell to grows ×1.25 until respawn.
  if (info.buffActive) {
    const buffEnd = info.buffSide < 0 ? pts[0] : pts[pts.length - 1];
    const buffCol = info.buffSide < 0 ? playerColor : enemyColor;
    ctx.save();
    ctx.shadowColor = buffCol; ctx.shadowBlur = 10 + 8 * Math.sin(now * 0.012);
    ctx.fillStyle = buffCol; ctx.font = '800 12px ui-monospace, monospace';
    ctx.fillText('⚡ +25% GROWTH', buffEnd.x, PIVOT_Y + 108);
    ctx.restore();
  }

  // phase banner — momentum swing while a side is buffed, else the beam mood
  const phase = info.buffActive
              ? { t: `MOMENTUM ${info.buffSide < 0 ? 'YOURS' : 'RIVAL'} · ${Math.ceil(info.respawnIn)}s`, c: info.buffSide < 0 ? playerColor : enemyColor, s: 0.02 }
              : info.phase === 'deadlock' ? { t: '⚖  DEADLOCKED', c: 'rgba(160,200,210,0.9)', s: 0.004 }
              : info.phase === 'suddendeath' ? { t: '☠  SUDDEN SWING', c: '#ff5a4a', s: 0.02 }
              : { t: '⚔  CONTESTED', c: '#ffd066', s: 0.01 };
  ctx.globalAlpha = 0.7 + 0.3 * Math.sin(now * phase.s);
  ctx.fillStyle = phase.c; ctx.font = '700 13px ui-monospace, monospace';
  ctx.fillText(phase.t, cx, PIVOT_Y + 130);
  ctx.globalAlpha = 1;
  ctx.restore();
}

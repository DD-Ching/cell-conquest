// =====================================================
// Victory balance — the tug-of-war (拔河 / 天秤) HUD for the contested-domination
// win meter (see checkVictory in main.js + the VICTORY_* config). A faux-3D
// balance beam, drawn in SCREEN space at top-centre:
//
//   * the BEAM TILTS toward whichever side currently holds more of the owned map
//     (live territory lead — the 51/49 see-saw),
//   * each PAN is a faction colour; the LEADING pan fills with glowing "energy"
//     proportional to the victory meter and pulses faster as the win nears,
//   * a COUNTDOWN ("VICTORY IN m:ss") ticks under the rig, accelerating as the
//     time-urgency multiplier ramps — the 緊迫感 / time-pressure cue.
//
// Reads state._victoryInfo (populated each frame by checkVictory). Self-gates:
// nothing draws until the meter is engaged (enough of the map claimed), so the
// early game is uncluttered and the balance appears once the race is really on.
// Screen-space only; never touches the world transform. If the render worker
// owns the canvas this isn't wired into its snapshot yet (opt-in path).
// =====================================================

import { state } from './state.js';
import { COLOR, FACTIONS } from './factions.js';

function mmss(s) {
  if (!isFinite(s)) return '--:--';
  s = Math.max(0, Math.round(s));
  const m = (s / 60) | 0, ss = s % 60;
  return `${m}:${ss < 10 ? '0' : ''}${ss}`;
}

// One pan: chains from the beam end down to a shallow faux-3D bowl that fills
// from the bottom with `fillFrac` of glowing colour; `glow` drives the bloom.
function drawPan(ctx, endX, endY, color, fillFrac, glow, now) {
  const topY = endY + 6, cY = topY + 30, rx = 24, ry = 8;
  // chains
  ctx.strokeStyle = 'rgba(220,200,160,0.5)'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(endX - 7, endY + 1); ctx.lineTo(endX - rx + 4, topY);
  ctx.moveTo(endX + 7, endY + 1); ctx.lineTo(endX + rx - 4, topY);
  ctx.stroke();
  // glowing fill rising inside the bowl (victory progress)
  if (fillFrac > 0.001) {
    const pulse = 0.7 + 0.3 * Math.sin(now * (0.004 + 0.012 * fillFrac));
    ctx.save();
    ctx.beginPath(); ctx.ellipse(endX, cY, rx, ry, 0, 0, Math.PI); ctx.lineTo(endX - rx, cY); ctx.clip();
    const lvl = cY + ry - (ry + 18) * fillFrac;
    ctx.fillStyle = color; ctx.globalAlpha = 0.35 + 0.5 * pulse;
    ctx.shadowColor = color; ctx.shadowBlur = (10 + 26 * fillFrac) * (glow ? 1 : 0.3);
    ctx.fillRect(endX - rx, lvl, rx * 2, cY + 20 - lvl);
    ctx.restore();
  }
  // bowl: bottom arc (darker) + rim ellipse (lit)
  ctx.beginPath(); ctx.ellipse(endX, cY, rx, ry, 0, 0, Math.PI);
  ctx.lineTo(endX - rx, cY); ctx.closePath();
  ctx.fillStyle = 'rgba(24,14,8,0.85)'; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.ellipse(endX, cY, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  return cY;
}

export function drawVictoryBalance(ctx, W, H, now) {
  const info = state._victoryInfo;
  if (!info || !info.engaged || state.gameOver || state.inLobby || state.tutorial) return;

  const cx = W / 2, pivotY = 90;
  const ARM = Math.min(195, Math.max(120, W * 0.2));
  const playerColor = COLOR['player'] || '#5cb3ff';
  const enemyColor = COLOR[info.enemyOwner] || '#ff6678';
  const enemyName = (FACTIONS.find(f => f.id === info.enemyOwner) || {}).name || 'ENEMY';

  // Smoothed tilt toward the leader (lead = your share − enemy share).
  const lead = Math.max(-1, Math.min(1, info.yourShare - info.enemyShare));
  const targetTilt = -lead * 0.42;                        // rad; you ahead → your (left) pan lower (visceral swing)
  state._vizTilt = (state._vizTilt || 0) + (targetTilt - (state._vizTilt || 0)) * 0.08;
  const th = state._vizTilt, dx = Math.cos(th), dy = Math.sin(th);
  const lx = cx - ARM * dx, ly = pivotY - ARM * dy;       // left  (you)
  const rx = cx + ARM * dx, ry = pivotY + ARM * dy;       // right (enemy)

  ctx.save();
  ctx.textAlign = 'center';
  // backdrop strip for legibility over the bright world
  ctx.fillStyle = 'rgba(10,6,3,0.42)';
  ctx.beginPath(); ctx.roundRect(cx - ARM - 46, pivotY - 52, (ARM + 46) * 2, 196, 12); ctx.fill();

  // title
  ctx.fillStyle = 'rgba(230,200,150,0.7)';
  ctx.font = '700 11px ui-monospace, monospace';
  ctx.fillText('S E C T O R   C O N T R O L', cx, pivotY - 36);

  // fulcrum: ground shadow + pyramid post + pivot cap
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(cx, pivotY + 56, 30, 7, 0, 0, Math.PI * 2); ctx.fill();
  const grad = ctx.createLinearGradient(cx, pivotY, cx, pivotY + 54);
  grad.addColorStop(0, '#caa46a'); grad.addColorStop(1, '#5a3e22');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.moveTo(cx - 15, pivotY + 54); ctx.lineTo(cx + 15, pivotY + 54);
  ctx.lineTo(cx + 4, pivotY); ctx.lineTo(cx - 4, pivotY); ctx.closePath(); ctx.fill();

  // beam — 3D bar: darker underside offset down, then the lit top face
  const T = 5, px = -dy, py = dx;                          // perpendicular unit
  const quad = (ox, oy, fill) => {
    ctx.beginPath();
    ctx.moveTo(lx + px * T + ox, ly + py * T + oy);
    ctx.lineTo(rx + px * T + ox, ry + py * T + oy);
    ctx.lineTo(rx - px * T + ox, ry - py * T + oy);
    ctx.lineTo(lx - px * T + ox, ly - py * T + oy);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  quad(0, 4, '#3a2814');                                   // underside (depth)
  const bgrad = ctx.createLinearGradient(lx, ly, rx, ry);
  bgrad.addColorStop(0, playerColor); bgrad.addColorStop(0.5, '#e8d6a8'); bgrad.addColorStop(1, enemyColor);
  quad(0, 0, bgrad);                                        // top face
  ctx.fillStyle = '#e8d6a8';
  ctx.beginPath(); ctx.arc(cx, pivotY, 5, 0, Math.PI * 2); ctx.fill();   // pivot cap

  // pans (leading one fills + glows by |meter|)
  const m = info.meter || 0;
  const youFill = m > 0 ? m : 0, enemyFill = m < 0 ? -m : 0;
  const youCy = drawPan(ctx, lx, ly, playerColor, youFill, info.leader === 'you', now);
  const enCy  = drawPan(ctx, rx, ry, enemyColor, enemyFill, info.leader === 'enemy', now);

  // share labels under each pan
  ctx.font = '700 12px ui-monospace, monospace';
  ctx.fillStyle = playerColor; ctx.fillText(`YOU ${Math.round(info.yourShare * 100)}%`, lx, youCy + 22);
  ctx.fillStyle = enemyColor;  ctx.fillText(`${enemyName.toUpperCase()} ${Math.round(info.enemyShare * 100)}%`, rx, enCy + 22);

  // countdown — accelerating pulse as the win nears
  const baseY = pivotY + 130;
  if (info.leader && isFinite(info.countdown)) {
    const col = info.leader === 'you' ? '#ffd066' : '#ff6678';
    const fast = info.countdown < 30 ? 0.02 : info.countdown < 90 ? 0.01 : 0.005;
    ctx.globalAlpha = 0.65 + 0.35 * Math.sin(now * fast);
    ctx.fillStyle = col; ctx.font = '700 14px ui-monospace, monospace';
    const verb = info.leader === 'you' ? 'VICTORY' : 'DEFEAT';
    ctx.fillText(`▸  ${verb} IN ${mmss(info.countdown)}  ◂`, cx, baseY);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = 'rgba(220,200,160,0.55)'; ctx.font = '700 12px ui-monospace, monospace';
    ctx.fillText('— CONTESTED —', cx, baseY);
  }
  ctx.restore();
}

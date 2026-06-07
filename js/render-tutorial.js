// =====================================================
// First-move onboarding coachmark — world-space overlay.
//
// A brand-new portal visitor doesn't know the core verb of the game: drag a
// base to a nearby town to send troops. This draws a single pulsing arrow from
// the player's HQ to the nearest neutral town, plus a "drag to send" label,
// the moment the game starts. It dismisses itself the instant the player makes
// their first send (fleets.sendFleet clears state.firstMoveHint).
//
// Pairs with config.OPENING_GRACE_SEC (the AI holds off attacking the player's
// side for the same opening window) — the grace buys the time, this teaches
// what to do with it.
//
// World-space: called from render.js INSIDE the world transform (same space as
// drawSpawnSelect), before the fog veil. Self-gates → zero cost once cleared.
// =====================================================
import { state } from './state.js';
import { COLOR } from './factions.js';

/** Nearest neutral town adjacent to `hq` on the road graph (the obvious first
 *  capture). Falls back to the nearest neutral anywhere if none is adjacent. */
function firstTarget(hq) {
  let best = null, bestD2 = Infinity;
  const adj = state.adj.get(hq.id);
  if (adj) {
    for (const nbId of adj) {
      const n = state.nodes[nbId];
      if (!n || n.owner !== 'neutral') continue;
      const dx = n.x - hq.x, dy = n.y - hq.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    }
  }
  if (best) return best;
  for (const n of state.nodes) {
    if (n.owner !== 'neutral') continue;
    const dx = n.x - hq.x, dy = n.y - hq.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = n; }
  }
  return best;
}

export function drawFirstMoveHint(ctx, zoom, now) {
  if (!state.firstMoveHint || state.phase !== 'playing') return;
  // The player's HQ (the town they just committed to). One player node at the
  // very start; if they've somehow already expanded, any owned node anchors it.
  let hq = null;
  for (const n of state.nodes) {
    if (n.owner !== 'player') continue;
    hq = n;
    if (n.nodeType === 'capital') break;
  }
  if (!hq) return;
  const target = firstTarget(hq);
  if (!target) return;

  const pc = COLOR.player || '#5cb3ff';
  const pulse = 0.5 + 0.5 * Math.sin(now / 300);
  ctx.save();

  // --- Pulsing ring on the suggested first capture ---
  const tR = (target.size || 24) + 14 + pulse * 12;
  ctx.globalAlpha = 0.45 + 0.4 * pulse;
  ctx.strokeStyle = pc;
  ctx.lineWidth = 3 / zoom;
  ctx.beginPath(); ctx.arc(target.x, target.y, tR, 0, Math.PI * 2); ctx.stroke();

  // --- Marching-dash arrow HQ -> target ---
  const ang = Math.atan2(target.y - hq.y, target.x - hq.x);
  const startX = hq.x + Math.cos(ang) * ((hq.size || 30) + 10);
  const startY = hq.y + Math.sin(ang) * ((hq.size || 30) + 10);
  const tipX = target.x - Math.cos(ang) * ((target.size || 24) + 12);
  const tipY = target.y - Math.sin(ang) * ((target.size || 24) + 12);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = pc;
  ctx.lineWidth = 3 / zoom;
  ctx.shadowColor = pc;
  ctx.shadowBlur = 8 / zoom;
  ctx.setLineDash([10 / zoom, 8 / zoom]);
  ctx.lineDashOffset = -(now / 28) % (18 / zoom);   // dashes crawl toward the town
  ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(tipX, tipY); ctx.stroke();
  ctx.setLineDash([]);
  // arrowhead
  const ah = 16 / zoom;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ah * Math.cos(ang - 0.45), tipY - ah * Math.sin(ang - 0.45));
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ah * Math.cos(ang + 0.45), tipY - ah * Math.sin(ang + 0.45));
  ctx.stroke();
  ctx.shadowBlur = 0;

  // --- Instruction label, above the HQ (world-space, scales with zoom like
  // the spawn-select names) ---
  const lx = hq.x, ly = hq.y - (hq.size || 30) - 16 / zoom;
  ctx.globalAlpha = 0.9 + 0.1 * pulse;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = pc;
  ctx.font = `bold ${15 / zoom}px ui-monospace, monospace`;
  ctx.fillText('▶  拖曳據點到城鎮派兵', lx, ly - 16 / zoom);
  ctx.globalAlpha = 0.7;
  ctx.font = `${11 / zoom}px ui-monospace, monospace`;
  ctx.fillStyle = '#cfe6ff';
  ctx.fillText('Drag your base to a town to send troops', lx, ly);

  ctx.restore();
}

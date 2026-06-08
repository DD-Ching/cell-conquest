// =====================================================
// render-shroud.js — TUTORIAL-ONLY vision lock ("视野锁起来").
//
// A screen-space dark veil over the whole canvas with soft circular holes
// punched (globalCompositeOperation 'destination-out') around each player-owned
// node, so the brand-new player only sees the area near their own territory.
// The reveal radius GROWS as the tutorial advances, and the veil disappears the
// instant the 'vision' lesson unlocks — or in any non-tutorial game (the guard
// returns early). No fog-of-war state model: it reads live node positions + the
// camera transform already on `state`. Screen-space → perfect circles at any
// zoom, sits above the world but under the vignette/HUD.
// =====================================================
import { state } from './state.js';
import { isAlly } from './alliance.js';
import { visionLocked } from './tutorial-gate.js';

const BASE_REVEAL = 240;     // screen-px hole around an owned node at step 0
const PER_STEP_REVEAL = 64;  // each step widens the spotlight (vision "opening up")
const VEIL_ALPHA = 0.84;     // darkness of the shroud (0..1)
const FEATHER = 0.42;        // inner solid fraction; the rest fades to transparent

export function drawShroud(ctx, W, H) {
  if (!visionLocked()) return;                         // inert outside the locked window
  const reveal = BASE_REVEAL + PER_STEP_REVEAL * (state.tutorial.i || 0);

  ctx.save();
  // 1) Dark veil over the whole screen.
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(6, 4, 10, ${VEIL_ALPHA})`;
  ctx.fillRect(0, 0, W, H);

  // 2) Punch a soft hole around every player-owned (or allied) node. Same
  //    world->screen formula render() / the tutorial finger use, so it lines up.
  ctx.globalCompositeOperation = 'destination-out';
  for (const n of state.nodes) {
    if (!isAlly(n.owner, 'player')) continue;
    const sx = (n.x - state.cameraX) * state.zoom;
    const sy = (n.y - state.cameraY) * state.zoom;
    const r = reveal + (n.size || 0) * state.zoom;
    if (sx < -r || sy < -r || sx > W + r || sy > H + r) continue;   // off-screen cull
    const g = ctx.createRadialGradient(sx, sy, r * FEATHER, sx, sy, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();                                        // resets composite op
}

// =====================================================
// Minimap — bottom-right strategic overview drawn to its own small canvas
// (state.mctx). Roads + faction-coloured nodes/fleets + a fading combat-heat
// layer + the camera frustum box. Split out of render-world.js.
// =====================================================
import { state } from './state.js';
import { WORLD_W, WORLD_H } from './config.js';
import { COLOR } from './factions.js';

// ---- Minimap (bottom-right strategic overview) ----
export function renderMinimap() {
  const mctx = state.mctx;
  if (!mctx) return;
  // Heat overlay state — defensive init so we don't have to touch state.js.
  // TODO(combat): push points from damage/explosion sites:
  //   state.minimapHeat.points.push({ x, y, age: 0 })
  // (reset via state.minimapHeat = { points: [] } in newGame).
  state.minimapHeat ||= { points: [] };
  const mw = state.minimap.width, mh = state.minimap.height;
  mctx.clearRect(0, 0, mw, mh);
  mctx.fillStyle = 'rgba(8, 16, 30, 0.6)';
  mctx.fillRect(0, 0, mw, mh);
  const sx = mw / WORLD_W, sy = mh / WORLD_H;
  mctx.strokeStyle = 'rgba(140, 160, 195, 0.25)';
  mctx.lineWidth = 0.5;
  for (const r of state.roads) {
    const a = state.nodes[r.a], b = state.nodes[r.b];
    mctx.beginPath();
    mctx.moveTo(a.x * sx, a.y * sy);
    mctx.lineTo(b.x * sx, b.y * sy);
    mctx.stroke();
  }
  for (const n of state.nodes) {
    mctx.fillStyle = COLOR[n.owner];
    mctx.beginPath();
    mctx.arc(n.x * sx, n.y * sy, Math.max(2, n.size * sx * 0.5), 0, Math.PI * 2);
    mctx.fill();
  }
  // Faction-coloured fleet dots — small squares so they don't blur into nodes.
  for (const f of state.fleets) {
    mctx.fillStyle = COLOR[f.owner];
    mctx.fillRect(f.x * sx - 0.75, f.y * sy - 0.75, 1.5, 1.5);
  }
  // Heat dots — combat sites fade over ~3s. Cheap red specks; advance age
  // here and prune in-place so the array can't grow without bound.
  const heat = state.minimapHeat.points;
  if (heat.length > 0) {
    const HEAT_LIFE = 3000;       // ms
    const nowH = performance.now();
    let write = 0;
    for (let i = 0; i < heat.length; i++) {
      const p = heat[i];
      if (p.t0 == null) p.t0 = nowH;       // first-seen stamp
      const age = nowH - p.t0;
      if (age >= HEAT_LIFE) continue;
      const alpha = (1 - age / HEAT_LIFE) * 0.85;
      mctx.fillStyle = `rgba(255, 90, 70, ${alpha})`;
      mctx.beginPath();
      mctx.arc(p.x * sx, p.y * sy, 1.8, 0, Math.PI * 2);
      mctx.fill();
      heat[write++] = p;
    }
    heat.length = write;
  }
  mctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  mctx.lineWidth = 1.5;
  mctx.strokeRect(state.cameraX * sx, state.cameraY * sy, (state.W / state.zoom) * sx, (state.H / state.zoom) * sy);
}

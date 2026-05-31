// =====================================================
// Cartographic node layer — compact, map-like markers instead of big board-game
// token discs. This is the DEFAULT look for the cinematic / strategic / detailed
// map modes; debug mode keeps the original full "fortified compound" rendering
// (render-node-detail.js), so the chunky raw-graph view is still there for
// diagnostics.
//
// Design (Google-Maps readability logic, not its style):
//   • A node is drawn as a SMALL marker — a fraction of n.size, capped, with a
//     screen-pixel floor so it stays a pin-sized dot, not a token that fills the
//     screen when you zoom in. (n.size is unchanged — click-picking via
//     world.nodeAt still uses the real footprint, so this is render-only.)
//   • Marker scale by importance: minor outpost = tiny dot · town = small ·
//     city / typed POI = medium · capital/HQ = medium-large double ring. Only
//     HQ / capital / selected read large; everything else is subtle.
//   • Faction ownership + icon TYPE carry the meaning, not a giant number.
//   • Typed nodes get a compact symbol (square=factory · diamond=mine ·
//     hexagon=fortress · ring=city · double-ring=HQ · scan-ring=lab ·
//     side-ticks=pass), drawn AT the marker scale (not floating far outside).
//   • Interaction states layer on top: selected = pulsing ring, hovered = thin
//     bright outline, wounded = red warning ring, capture = white flash.
//
// Labels are NOT drawn here — they're a separate top-layer pass
// (render-entities.drawNodeLabelsOnTop) so they beat fleet sprites. This file
// exports cartoHoveredId() so that pass can highlight the same hovered node.
//
// Worker-safe: reads only state + COLOR (both hydrated worker-side). No DOM,
// no shadowBlur, no per-node gradient (same hot-path rules as render-node-detail).
// =====================================================
import { state } from './state.js';
import { COLOR } from './factions.js';

const TAU = Math.PI * 2;
const _MAJOR_TYPES = new Set(['capital', 'city', 'fortress', 'factory', 'mine', 'research_lab']);

/** 0 = minor outpost · 1 = sizeable town · 2 = major (owned / typed POI). */
export function importanceOf(n) {
  if (n.owner !== 'neutral') return 2;
  if (_MAJOR_TYPES.has(n.nodeType)) return 2;
  if (n.size >= 40) return 1;
  return 0;
}

// Hovered node id (under the cursor), recomputed each frame in drawNodesCarto so
// the top-layer label pass can show its value. -1 = none.
let _hoveredId = -1;
export function cartoHoveredId() { return _hoveredId; }

/** Compact marker world-radius for a node: a fraction of n.size by importance,
 *  with a screen-pixel floor (so it never vanishes) and a screen cap (so a huge
 *  capital can't balloon back into a token at close zoom). */
export function cartoMarkerR(n, zoom) {
  const imp = importanceOf(n);
  let f = 0.22;
  if (n.nodeType === 'capital') f = 0.46;
  else if (imp === 2) f = 0.34;
  else if (imp === 1) f = 0.27;
  const world = n.size * f;
  const floor = 3.0 / zoom;
  const cap = (n.nodeType === 'capital' ? 17 : imp === 2 ? 12 : 8) / zoom;
  return Math.max(floor, Math.min(world, cap > floor ? cap : world));
}

/** Compact type symbol at the marker scale (faction-tinted outline). Drawn for
 *  the typed POIs only; plain towns/outposts stay clean dots. */
function drawTypeSymbol(ctx, n, mr, col, zoom) {
  const t = n.nodeType;
  if (!t || !_MAJOR_TYPES.has(t)) return;
  const R = mr + 2.2 / zoom;
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.4 / zoom;
  switch (t) {
    case 'factory':
      ctx.strokeRect(n.x - R, n.y - R, R * 2, R * 2);
      break;
    case 'mine':
      ctx.beginPath();
      ctx.moveTo(n.x, n.y - R); ctx.lineTo(n.x + R, n.y);
      ctx.lineTo(n.x, n.y + R); ctx.lineTo(n.x - R, n.y);
      ctx.closePath(); ctx.stroke();
      break;
    case 'fortress':
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + k * (Math.PI / 3);
        const px = n.x + Math.cos(a) * R, py = n.y + Math.sin(a) * R;
        k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.stroke();
      break;
    case 'city':
      ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, TAU); ctx.stroke();
      break;
    case 'capital':
      ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(n.x, n.y, R + 2.6 / zoom, 0, TAU); ctx.stroke();
      break;
    case 'research_lab':
      ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, TAU); ctx.stroke();
      break;
  }
}

/** The cartographic node layer (LOD ≥ 2 path for non-debug map modes). */
export function drawNodesCarto(ctx, zoom, now) {
  const { vL, vT, vR, vB } = state._view;
  const mode = state.mapMode;
  // Density by zoom: at strategic overview hide minor outposts so key places +
  // terrain carry the frame; detailed/cinematic-close show everything.
  const demote = mode === 'cinematic' || mode === 'strategic';
  const hideMinors = demote && zoom < (mode === 'cinematic' ? 0.5 : 0.36);

  // Hovered node (under the cursor) — nearest visible node within its real
  // footprint. One O(visible) pass; reused by the top-layer label highlight.
  _hoveredId = -1;
  const mx = state.mousePos ? state.mousePos.x : -1e9;
  const my = state.mousePos ? state.mousePos.y : -1e9;
  let hoverBestD2 = Infinity;

  const visible = [];
  for (const n of state.nodes) {
    const m = n.size * 2;
    if (n.x + m < vL || n.x - m > vR || n.y + m < vT || n.y - m > vB) continue;
    if (hideMinors && importanceOf(n) === 0) continue;
    visible.push(n);
    const dx = n.x - mx, dy = n.y - my, d2 = dx * dx + dy * dy;
    if (d2 < n.size * n.size && d2 < hoverBestD2) { hoverBestD2 = d2; _hoveredId = n.id; }
  }

  // Pass 1 — soft footprint shadow (grounds the marker on terrain, no glow halo).
  ctx.fillStyle = 'rgba(10, 6, 3, 0.5)';
  for (const n of visible) {
    const mr = cartoMarkerR(n, zoom);
    ctx.beginPath();
    ctx.arc(n.x + 0.6 / zoom, n.y + 0.9 / zoom, mr + 1.2 / zoom, 0, TAU);
    ctx.fill();
  }

  // Pass 2 — marker body. Owned: faction fill. Neutral: muted grey, lower alpha
  // (recedes). A thin darker rim gives definition without the heavy token disc.
  for (const n of visible) {
    const owned = n.owner !== 'neutral';
    const col = COLOR[n.owner] || '#b9ad99';
    const mr = cartoMarkerR(n, zoom);
    ctx.globalAlpha = owned ? 0.95 : 0.62;
    ctx.fillStyle = owned ? col : '#9a8f7c';
    ctx.beginPath();
    ctx.arc(n.x, n.y, mr, 0, TAU);
    ctx.fill();
    // Dark center pip — keeps the marker reading as a "place" ring, not a blob.
    ctx.globalAlpha = owned ? 0.85 : 0.5;
    ctx.fillStyle = 'rgba(14, 9, 5, 0.85)';
    ctx.beginPath();
    ctx.arc(n.x, n.y, Math.max(0.6, mr * 0.42), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Pass 3 — type symbols (factory/mine/fortress/city/HQ/lab) at marker scale.
  for (const n of visible) {
    if (n.size < 18 && n.nodeType !== 'capital') continue;       // tiny → skip symbol clutter
    const col = COLOR[n.owner] || '#cfc6b6';
    drawTypeSymbol(ctx, n, cartoMarkerR(n, zoom), col, zoom);
  }

  // Pass 4 — wounded warning ring (owned, < 35% garrison). Quick "in trouble" cue.
  ctx.globalAlpha = 0.3 + 0.3 * Math.sin(now / 200);
  ctx.strokeStyle = 'rgb(255, 100, 100)';
  ctx.lineWidth = 1.4 / zoom;
  for (const n of visible) {
    if (n.owner === 'neutral') continue;
    if (n.units / n.capacity >= 0.35) continue;
    const mr = cartoMarkerR(n, zoom);
    ctx.beginPath();
    ctx.arc(n.x, n.y, mr + 3.5 / zoom, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Pass 5 — hovered: thin bright outline.
  if (_hoveredId >= 0 && !state.selectedIds.has(_hoveredId)) {
    const n = state.nodes[_hoveredId];
    const mr = cartoMarkerR(n, zoom);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1.4 / zoom;
    ctx.beginPath();
    ctx.arc(n.x, n.y, mr + 2.5 / zoom, 0, TAU);
    ctx.stroke();
  }

  // Pass 6 — selected: bright pulsing ring (faction-tinted toward white).
  if (state.selectedIds.size > 0) {
    ctx.globalAlpha = 0.6 + Math.sin(now / 180) * 0.3;
    ctx.lineWidth = 2 / zoom;
    for (const n of visible) {
      if (!state.selectedIds.has(n.id)) continue;
      const mr = cartoMarkerR(n, zoom);
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(n.x, n.y, mr + 4.5 / zoom, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Pass 7 — capture flash (one-shot white pop on ownership change).
  for (const n of visible) {
    if (n.flash <= 0) continue;
    const mr = cartoMarkerR(n, zoom);
    ctx.fillStyle = `rgba(255,255,255,${n.flash * 0.5})`;
    ctx.beginPath();
    ctx.arc(n.x, n.y, mr + 2 / zoom, 0, TAU);
    ctx.fill();
  }
}

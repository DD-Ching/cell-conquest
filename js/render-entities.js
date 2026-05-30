// =====================================================
// Game entities — the things you actually interact with: nodes, turrets,
// plus the always-on-top node count labels that get drawn last so massed
// sprites can't hide the numbers. Moving units (troop columns, drone swarms)
// live in render-fleets.js and are re-exported here so render.js can keep
// importing the whole entity layer from one place.
//
// All layers support frustum culling via state._view and LOD via state._lod.
// Sprite primitives come from sprites.js; this module is layer logic only.
// =====================================================
import { state } from './state.js';
import { ARTILLERY_INTERVAL } from './config.js';
import { COLOR, GLOW } from './factions.js';
import { catchUpRegen } from './world.js';
import {
  drawAATurret, drawTankTurret, drawFactoryTurret, drawArtilleryTurret,
} from './sprites.js';
import {
  drawNodeCompounds, drawRadarSweeps, drawNodeBuildings, drawNodeIcons,
} from './render-node-detail.js';
// Fleet layers live in render-fleets.js (split out to stay under the line cap);
// re-exported below so importers keep getting them from render-entities.js.
export { drawTroopFleets, drawDroneFleets } from './render-fleets.js';

const CELL = 250;                          // matches the spatial-grid cell size
const _warnedOwners = new Set();           // dedupe console warnings per owner
const _tintCache = new Map();              // hex → 70%-toward-white rgb string

/** Brighten a faction hex 70% toward white. Cached per hex so the selection
 *  ring doesn't re-parse on every frame. */
function tintBright(hex) {
  let s = _tintCache.get(hex);
  if (s) return s;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const m = (c) => Math.round(255 * 0.7 + c * 0.3);
  s = `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
  _tintCache.set(hex, s);
  return s;
}

// Cartographic node importance — what anchors the map vs. what's just texture.
// Majors (owned bases, typed landmarks, sizeable settlements) always read;
// minor neutral outposts recede or hide at strategic zoom in the cartographic
// modes so the map shows a skeleton of key places over terrain instead of ~800
// equal dots. PURELY VISUAL: world.nodeAt picking is unchanged, so a demoted
// node is still selectable/commandable — gameplay is identical.
const _MAJOR_TYPES = new Set(['capital', 'city', 'fortress', 'factory', 'mine', 'research_lab']);
function nodeImportance(n) {
  if (n.owner !== 'neutral') return 2;        // anything owned is a place that matters
  if (_MAJOR_TYPES.has(n.nodeType)) return 2; // typed landmark (city/fortress/mine/…)
  if (n.size >= 40) return 1;                 // a sizeable neutral settlement
  return 0;                                   // minor town / outpost / open-plains scatter
}

// ---- Nodes (fortified compounds: rim, glow, inner structures, count) ----
// Per-layer passes over the visible set so uniform-alpha layers (selection,
// wounded) set globalAlpha once per pass instead of once per node.
export function drawNodes(ctx, zoom, now) {
  const { vL, vT, vR, vB } = state._view;
  // LOW LOD: skip glow / breathing / inner buildings / flash to keep 1000+
  // visible nodes affordable. catchUpRegen is NOT called here — sim()'s AI
  // tick + HUD pass already ran catchUpAllNodes this frame.
  if (state._lod < 2) {
    // 6-screen-pixel floor so sub-pixel n.size at extreme zoom-out stays
    // visible AND clickable (nodeAt uses a zoom-aware pick tolerance).
    // Owned nodes pop (full alpha + radius); neutrals recede (smaller +
    // translucent) so the big map reads as coloured territory spreading over a
    // muted neutral field, not 830 identical dots.
    const minR = 6 / zoom;
    // Cartographic demotion (cinematic/strategic only): minor neutral outposts
    // recede, and at deep overview they hide entirely, so the geography + key
    // places carry the frame. 'detailed' / 'debug' draw every node (full info).
    const mode = state.mapMode;
    const demote = mode === 'cinematic' || mode === 'strategic';
    const hideMinors = demote && zoom < (mode === 'cinematic' ? 0.42 : 0.30);
    for (const n of state.nodes) {
      const owned = n.owner !== 'neutral';
      const minor = demote && nodeImportance(n) === 0;
      if (minor && hideMinors) continue;                  // vanish at overview
      const r = Math.max(n.size, minR) * (owned ? 1 : 0.82) * (minor ? 0.7 : 1);
      if (n.x + r < vL || n.x - r > vR || n.y + r < vT || n.y - r > vB) continue;
      ctx.globalAlpha = (owned ? 1 : 0.62) * (minor ? 0.5 : 1);
      ctx.fillStyle = COLOR[n.owner];
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(15, 8, 4, 0.6)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(2, r - 4), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  }

  // Visible set — 2.4× halo margin to keep the glow gradient inside the cull.
  const visible = [];
  for (const n of state.nodes) {
    const halo = n.size * 2.4;
    if (n.x + halo < vL || n.x - halo > vR || n.y + halo < vT || n.y - halo > vB) continue;
    visible.push(n);
  }

  // Pass 1 — glow halos (alpha baked into gradient stops).
  for (const n of visible) {
    const glow = GLOW[n.owner] || GLOW.neutral || 'rgba(160,135,116,0.3)';
    if (!GLOW[n.owner] && !_warnedOwners.has(n.owner)) {
      console.warn('[render] no GLOW for owner', n.owner, '— check rollFactions');
      _warnedOwners.add(n.owner);
    }
    const grad = ctx.createRadialGradient(n.x, n.y, n.size * 0.5, n.x, n.y, n.size * 2.4);
    grad.addColorStop(0, glow);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pass 2 — capture pulses (per-node phase ⇒ per-node alpha).
  for (const n of visible) {
    if (n.pulse <= 0) continue;
    ctx.strokeStyle = COLOR[n.owner];
    ctx.globalAlpha = n.pulse;
    ctx.lineWidth = 2 / zoom;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size + (1 - n.pulse) * 28, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Pass 3 — ambient breathing (owned nodes feel alive; phase varies per id).
  for (const n of visible) {
    if (n.owner === 'neutral') continue;
    const breath = 0.35 + 0.25 * Math.sin(now / 600 + n.id * 0.7);
    ctx.strokeStyle = COLOR[n.owner];
    ctx.globalAlpha = breath * 0.45;
    ctx.lineWidth = 1.5 / zoom;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size + 3 + breath * 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Pass 4 — selection ring. Faction-tinted toward white (reads as "yours").
  // The pulsing alpha is identical across selected nodes ⇒ set once per pass.
  if (state.selectedIds.size > 0) {
    ctx.globalAlpha = 0.65 + Math.sin(now / 180) * 0.25;
    ctx.lineWidth = 2 / zoom;
    for (const n of visible) {
      if (!state.selectedIds.has(n.id)) continue;
      ctx.strokeStyle = tintBright(COLOR[n.owner] || COLOR.neutral || '#ffffff');
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Pass 5 — wounded warning ring (< 35% capacity). Sits OUTSIDE the rim
  // at n.size+10 as a quick "in trouble" cue before the player reads the
  // HP count. Neutral nodes are skipped — they spawn well below 35% by
  // design, so the alarm would fire on every empty neutral.
  ctx.globalAlpha = 0.3 + 0.3 * Math.sin(now / 200);
  ctx.strokeStyle = 'rgb(255, 100, 100)';
  ctx.lineWidth = 1.2 / zoom;
  for (const n of visible) {
    if (n.owner === 'neutral') continue;
    if (n.units / n.capacity >= 0.35) continue;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size + 10, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Pass 6 — faction rim (with outer glow) + dark compound + inner shadow.
  // Helper folds in the rim glow (one shadowBlur sub-pass) and the radial
  // inner-shadow gradient that gives the compound depth (PR: fortified look).
  drawNodeCompounds(ctx, visible, zoom);

  // Pass 6b — radar sweep for medium+ owned nodes, under the buildings so
  // the structures paint on top of the faint sweep line.
  drawRadarSweeps(ctx, visible, zoom, now);

  // Pass 7 — central core + building ring + hub beacon + capture flash.
  drawNodeBuildings(ctx, visible, zoom, now, state.adj);

  // Pass 7b — nodeType tactical designation frames (square=factory, diamond=
  // mine, hexagon=fortress, ring=city, double-ring=HQ, scan=research). Drawn
  // before labels so the unit count reads on top of the symbol.
  drawNodeIcons(ctx, visible, zoom, now);

  // Pass 8 — labels, Lieutenant underline, engineer badge, build flash.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const n of visible) {
    // Unit count, faction-coloured (drawNodeLabelsOnTop repaints over sprites).
    ctx.fillStyle = n.owner === 'neutral' ? '#cfc6b6' : COLOR[n.owner];
    const screenFont = Math.max(15, Math.min(28, n.size * 0.85 * zoom));
    const worldFont = screenFont / zoom;
    ctx.font = `bold ${worldFont}px -apple-system, system-ui, sans-serif`;
    const unitsTxt = String(Math.floor(n.units));
    ctx.fillText(unitsTxt, n.x, n.y);
    // Lieutenant underline (typographic mark, not a separate shape).
    if (n.owner === 'ally1') {
      const half = ctx.measureText(unitsTxt).width / 2;
      const uy = n.y + worldFont * 0.45;
      ctx.strokeStyle = COLOR[n.owner];
      ctx.lineWidth = Math.max(1.4, 1.8 / zoom);
      ctx.beginPath();
      ctx.moveTo(n.x - half, uy);
      ctx.lineTo(n.x + half, uy);
      ctx.stroke();
    }
    if (n.engineers > 0) {
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${10 / zoom}px sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('🔧' + n.engineers, n.x - n.size - 4, n.y + n.size + 4);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    }
    if (n.flashBuild > 0) {
      ctx.strokeStyle = `rgba(255,220,140,${n.flashBuild})`;
      ctx.lineWidth = 2 / zoom;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size + 14 * (1 - n.flashBuild), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// ---- Turrets (sprite + aim + progress arc + HP bar + stockpile badge) ----
export function drawTurrets(ctx, zoom, now) {
  const { vL, vT, vR, vB } = state._view;
  // Low LOD: detailed sprites become invisible chunks at zoom 0.5×, so we
  // fall back to single colored primitives. SIZE-MATCHED to the original
  // sprites so the world map doesn't visually shrink when LOD kicks in
  // (AA sprite is ~51 px, tank is ~57, factory ~57, artillery ~66).
  if (state._lod < 2) {
    for (const t of state.turrets) {
      if (t.x + 35 < vL || t.x - 35 > vR || t.y + 35 < vT || t.y - 35 > vB) continue;
      if (t.pendingEngineer) ctx.globalAlpha = 0.35;
      ctx.fillStyle = t.active ? COLOR[t.owner] : COLOR[t.owner] + '88';
      if (t.type === 'antiair') {
        ctx.fillRect(t.x - 24, t.y - 24, 48, 48);                      // 48×48 square
      } else if (t.type === 'tank') {
        ctx.fillRect(t.x - 22, t.y - 18, 44, 36);                      // 44×36 chassis
      } else if (t.type === 'factory') {
        ctx.fillRect(t.x - 28, t.y - 28, 56, 56);                      // 56×56 building
      } else if (t.type === 'artillery') {
        ctx.beginPath();                                               // r=33 diamond
        ctx.moveTo(t.x, t.y - 33); ctx.lineTo(t.x + 33, t.y);
        ctx.lineTo(t.x, t.y + 33); ctx.lineTo(t.x - 33, t.y);
        ctx.closePath(); ctx.fill();
      }
      if (t.pendingEngineer) ctx.globalAlpha = 1.0;
    }
    return;
  }
  for (const t of state.turrets) {
    // Sprites span ~35 px from pivot; skip if outside view + margin.
    if (t.x + 35 < vL || t.x - 35 > vR || t.y + 35 < vT || t.y - 35 > vB) continue;
    // Pending sites (engineer en route) render as ghost placeholders — visual
    // mirror of the gameplay rule that they're not yet attackable.
    if (t.pendingEngineer) ctx.globalAlpha = 0.35;
    if (t.type === 'antiair') {
      drawAATurret(ctx, t.x, t.y, t.owner, t.active, zoom, now);
    } else if (t.type === 'tank') {
      // Aim at nearest enemy ground fleet via spatial-grid query (3×3 cells).
      let aimAngle = t.aimAngle || 0, aimD2 = Infinity;
      const cx0 = Math.floor(t.x / CELL);
      const cy0 = Math.floor(t.y / CELL);
      for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
        for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) {
          const bucket = state.groundFleetGrid.get(cx * 10000 + cy);
          if (!bucket) continue;
          for (const f of bucket) {
            if (f.owner === t.owner) continue;
            const dx = f.x - t.x, dy = f.y - t.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < aimD2) { aimD2 = d2; aimAngle = Math.atan2(dy, dx); }
          }
        }
      }
      t.aimAngle = aimAngle;
      drawTankTurret(ctx, t.x, t.y, t.owner, t.active, zoom, aimAngle, now);
    } else if (t.type === 'factory') {
      drawFactoryTurret(ctx, t.x, t.y, t.owner, t.active, zoom, now, t.prodCooldown < 1.5);
      // Stockpile badge: when Hold-Fire is on, factories accumulate drones
      if (t.dronesReady > 0) {
        ctx.fillStyle = 'rgba(255, 200, 90, 0.9)';
        ctx.beginPath();
        ctx.arc(t.x + 21, t.y - 24, 10.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0a0604';
        ctx.font = `bold ${11 / zoom}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t.dronesReady, t.x + 21, t.y - 24);
      }
    } else if (t.type === 'artillery') {
      // Aim toward nearest enemy turret via spatial grid (5×5 cells for the
      // longer artillery range). Falls back to last known aim when no enemy.
      let aimAngle = t.aimAngle || 0, aimD2 = Infinity;
      const cx0 = Math.floor(t.x / CELL);
      const cy0 = Math.floor(t.y / CELL);
      for (let cx = cx0 - 2; cx <= cx0 + 2; cx++) {
        for (let cy = cy0 - 2; cy <= cy0 + 2; cy++) {
          const bucket = state.turretGrid.get(cx * 10000 + cy);
          if (!bucket) continue;
          for (const e of bucket) {
            if (e.owner === t.owner) continue;
            const dx = e.x - t.x, dy = e.y - t.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < aimD2) { aimD2 = d2; aimAngle = Math.atan2(dy, dx); }
          }
        }
      }
      t.aimAngle = aimAngle;
      // Recent-fire flash: cooldown just reset → recoil kick
      const flash = (t.artyCooldown !== undefined && t.artyCooldown > ARTILLERY_INTERVAL - 0.25)
        ? (t.artyCooldown - (ARTILLERY_INTERVAL - 0.25)) / 0.25
        : 0;
      drawArtilleryTurret(ctx, t.x, t.y, t.owner, t.active, zoom, aimAngle, flash);
    }
    // Progress arc only when an engineer has arrived and started building;
    // pending sites show no arc (nothing's happening there yet).
    if (!t.active && !t.pendingEngineer) {
      ctx.strokeStyle = '#ffd066';
      ctx.lineWidth = 3 / zoom;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 22.5, -Math.PI / 2, -Math.PI / 2 + t.progress * Math.PI * 2);
      ctx.stroke();
    }
    // HP bar (only if damaged)
    if (t.active && t.hp < t.hpMax) {
      const bw = 39, frac = t.hp / t.hpMax;
      ctx.fillStyle = 'rgba(20,20,20,0.6)';
      ctx.fillRect(t.x - bw / 2, t.y + 24, bw, 3.5);
      ctx.fillStyle = frac > 0.5 ? '#7be57b' : frac > 0.25 ? '#ffd066' : '#ff6678';
      ctx.fillRect(t.x - bw / 2, t.y + 24, bw * frac, 3.5);
    }
    if (t.pendingEngineer) ctx.globalAlpha = 1.0;
  }
}

// ---- Always-on-top node count labels (drawn last to beat any sprite) ----
export function drawNodeLabelsOnTop(ctx, zoom) {
  const { vL, vT, vR, vB } = state._view;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Big-map declutter: at strategic zoom hundreds of per-node numbers overlap
  // into noise. Show a label only where it carries glance-value — selected,
  // a major hub (size), or a meaningful owned garrison. Everything else stays a
  // coloured dot until you zoom in. (Spec: numbers on hover / selection / high
  // zoom only.) The 0.6 cutoff matches the LOD-1 dot-mode threshold.
  const declutter = zoom < 0.6;
  // Cartographic modes hide raw unit counts harder at strategic zoom — only
  // MAJOR places (owned bases + typed landmarks) keep a number, so the overview
  // reads as a map of places, not a field of figures. detailed keeps the
  // size-based declutter; debug shows all. (Spec: numbers secondary/hidden.)
  const mode = state.mapMode;
  const cartoDemote = (mode === 'cinematic' || mode === 'strategic') && zoom < 0.6;
  for (const n of state.nodes) {
    if (n.x < vL || n.x > vR || n.y < vT || n.y > vB) continue;
    if (!state.selectedIds.has(n.id)) {
      if (cartoDemote) {
        if (nodeImportance(n) < 2) continue;
      } else if (declutter &&
          n.size < 48 && !(n.owner !== 'neutral' && n.units >= 30)) continue;
    }
    catchUpRegen(n);                         // fresh units for the top-layer label
    const screenFont = Math.max(15, Math.min(28, n.size * 0.85 * zoom));
    const worldFont = screenFont / zoom;
    ctx.font = `bold ${worldFont}px -apple-system, system-ui, sans-serif`;
    // Dark halo so the number reads on any background (troop columns,
    // scorches, bright glow). Faction colour fill on top — packed strategic
    // zoom is unreadable when every node label is white, but instantly
    // legible when each owner's nodes pop in their own hue.
    ctx.lineWidth = Math.max(2, 3 / zoom);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    const txt = String(Math.floor(n.units));
    ctx.strokeText(txt, n.x, n.y);
    ctx.fillStyle = n.owner === 'neutral' ? '#cfc6b6' : COLOR[n.owner];
    ctx.fillText(txt, n.x, n.y);
    // Auto-control underline for Lieutenant bases (same colour as label so
    // it reads as a typographic mark). Outline first for legibility against
    // bright glow / scorch backgrounds, then fill.
    if (n.owner === 'ally1') {
      const w = ctx.measureText(txt).width;
      const half = w / 2;
      const uy = n.y + worldFont * 0.45;
      ctx.lineWidth = Math.max(2.4, 3 / zoom);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.beginPath();
      ctx.moveTo(n.x - half, uy);
      ctx.lineTo(n.x + half, uy);
      ctx.stroke();
      ctx.strokeStyle = COLOR[n.owner];
      ctx.lineWidth = Math.max(1.4, 1.8 / zoom);
      ctx.beginPath();
      ctx.moveTo(n.x - half, uy);
      ctx.lineTo(n.x + half, uy);
      ctx.stroke();
    }
  }
}

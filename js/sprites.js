// =====================================================
// Top-down vehicle / turret sprites — tower-defense look.
//
// Two layers:
//  1. Programmatic canvas drawing (always works, no assets needed).
//  2. PNG asset overlay — if assets/<name>.png exists it's drawn instead
//     of the primitive. Accepts the Kenney.nl "Top-Down Tanks" and
//     "Tower Defense Top-Down" packs; see assets/README.md for filenames.
//
// Sprites do not depend on game state, only on (ctx, x, y, angle,
// owner, zoom, ...). The faction tint is applied via the owner color.
// Scale note: dimensions sit at "1.5×" — halved from a previous 3× pass
// that looked oversized on the map.
// =====================================================
import { COLOR } from './factions.js';
import { tracePath } from './road-curve.js';

const TAU = Math.PI * 2;

// ---- Asset loader ----
// Each entry: { img, ready }. When ready, draw functions blit the image
// (tinted via composite ops) instead of the programmatic primitive.
// Exported so the turret sprites (split into sprites-turrets.js) share this
// SAME live registry — loadAssets() mutates its turret_* slots in place, and
// the sibling reads them through this exported reference.
export const Asset = {};
const ASSET_FILES = [
  'tank', 'apc', 'truck',           // troop tiers
  'engineer',                       // engineer/deploy
  'drone',                          // air
  'turret_aa', 'turret_tank', 'turret_factory', 'turret_artillery',
];

export function loadAssets() {
  // Probe assets/manifest.json first so we don't spam 9 PNG requests at a
  // user who hasn't dropped sprites in yet. Manifest is a JSON array of
  // names matching ASSET_FILES; only listed names get a sprite created.
  // No manifest, no assets — game falls back to programmatic primitives.
  //
  // Context-aware loader: in a Window we use Image() (synchronous-ish via
  // event), in a Worker we use fetch + createImageBitmap (Workers have no
  // Image global). drawImage accepts both Image and ImageBitmap so all
  // downstream blit code stays identical.
  fetch('assets/manifest.json', { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .then(list => {
      if (!Array.isArray(list)) return;
      for (const name of list) {
        if (!ASSET_FILES.includes(name)) continue;
        Asset[name] = { img: null, ready: false };
        loadOne(name).then(img => {
          if (img) { Asset[name].img = img; Asset[name].ready = true; }
        });
      }
    })
    .catch(() => { /* no manifest, no assets — primitives only */ });
}

/** Window: new Image(); Worker: fetch + createImageBitmap.
 *  Returns null on any failure so the caller skips ready=true and the
 *  blit path falls back to programmatic primitives. */
function loadOne(name) {
  const url = `assets/${name}.png`;
  if (typeof Image !== 'undefined') {
    return new Promise(resolve => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }
  // Worker context — no DOM, no Image.
  return fetch(url, { cache: 'force-cache' })
    .then(r => r.ok ? r.blob() : null)
    .then(b => b ? createImageBitmap(b) : null)
    .catch(() => null);
}

/** Drop shadow — flat ellipse offset down-right of the (already
 *  translated) sprite origin. No shadowBlur — that's very expensive on
 *  canvas2d at scale; just one arc fill. Drone / troop / engineer use it. */
function _dropShadow(ctx, rx, ry, ox = 1, oy = 1, alpha = 0.3) {
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx.beginPath(); ctx.ellipse(ox, oy, rx, ry, 0, 0, TAU); ctx.fill();
}

/** Build a faction-recoloured copy of a sprite, ONCE per (sprite, tint).
 *  We DON'T paint a flat translucent slab over the art (that washes a
 *  detailed building into a featureless coloured blob). Instead we use the
 *  'color' composite: it keeps the sprite's LUMINANCE (every highlight,
 *  shadow and panel line survives) and only swaps in the faction hue +
 *  saturation. A grey Kenney structure becomes a clean blue / crimson
 *  building with all its 3-D shading intact. Cached on the asset object —
 *  ~3 faction colours × N sprites, computed once, blitted forever. */
function tintedCopy(asset, tint) {
  if (!asset._tints) asset._tints = {};
  let c = asset._tints[tint];
  if (c) return c;
  const img = asset.img;
  const W = img.width, H = img.height;
  c = (typeof document !== 'undefined')
    ? Object.assign(document.createElement('canvas'), { width: W, height: H })
    : new OffscreenCanvas(W, H);
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  // 'color' = take H+S from the fill, keep L from the sprite → recolour
  // without flattening the shading.
  cx.globalCompositeOperation = 'color';
  cx.fillStyle = tint;
  cx.fillRect(0, 0, W, H);
  // fillRect painted the whole box; clip the colour back to the sprite's
  // own alpha so the transparent surround stays transparent.
  cx.globalCompositeOperation = 'destination-in';
  cx.drawImage(img, 0, 0);
  cx.globalCompositeOperation = 'source-over';
  asset._tints[tint] = c;
  return c;
}

/** Blit a sprite, sized to fit in `size` world units. Caller has already
 *  translated and rotated. The sprite is recoloured to `tint` via the
 *  cached luminance-preserving copy (see tintedCopy). Exported so the
 *  turret sprites (sprites-turrets.js) can reuse the same blit path. */
export function blitSprite(ctx, asset, size, tint) {
  const img = asset.img;
  const w = size, h = size * (img.height / img.width);
  ctx.drawImage(tintedCopy(asset, tint), -w / 2, -h / 2, w, h);
}

// =====================================================
// Roads — thin path with edge highlights. Line widths are WORLD-space (no
// `/zoom`) so the road thickness scales with the canvas: chunky highways
// when zoomed in for tactics, hair-thin spider-web when zoomed out for
// strategic overview. `widthMul` (assigned in world.buildRoads per-edge:
// ~0.5 for outskirts, ~1.5 for hub arteries) layers natural road hierarchy
// on top.
// =====================================================
export function drawRoadStyled(ctx, a, b, blockage, zoom, widthMul = 1, kind = null, now = 0, bow = 0) {
  ctx.lineCap = 'round';
  // Dark outer (path edge). Bridges get a wider steel deck shadow so a
  // chokepoint reads even before the accent stroke. The whole road is ONE
  // path — gently bowed when `bow`≠0 (curve geometry comes from road-curve.js;
  // the caller passes the per-edge bow) — and every later stroke layer below
  // reuses it, so the curve only has to be built once.
  ctx.strokeStyle = kind === 'bridge' ? 'rgba(20, 26, 36, 0.95)' : 'rgba(38, 22, 11, 0.95)';
  ctx.lineWidth = (kind === 'bridge' ? 9.5 : 8) * widthMul;
  ctx.beginPath();
  tracePath(ctx, a.x, a.y, b.x, b.y, bow);
  ctx.stroke();
  // Inner sand fill — darker as blockage rises
  const sandAlpha = 0.92 - blockage * 0.35;
  const sandR = Math.floor(190 - 30 * blockage);
  const sandG = Math.floor(145 - 60 * blockage);
  const sandB = Math.floor(95 - 50 * blockage);
  ctx.strokeStyle = `rgba(${sandR}, ${sandG}, ${sandB}, ${sandAlpha})`;
  ctx.lineWidth = 5.5 * widthMul;
  ctx.stroke();
  // Wreckage / death-highway overlay
  if (blockage > 0.5) {
    ctx.strokeStyle = `rgba(220, 70, 35, ${Math.min(0.7, blockage * 0.85)})`;
    ctx.lineWidth = 5 * widthMul;
    ctx.setLineDash([7, 6]);             // world-space — scales with the road
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (blockage > 0.08) {
    ctx.strokeStyle = `rgba(180, 70, 35, ${blockage * 0.55})`;
    ctx.lineWidth = 3.5 * widthMul;
    ctx.stroke();
  }
  // Road-class accent (procgen). Highways read as glowing arteries (wide soft
  // amber underlay + bright dashed core); bridges/passes as bright steel spans —
  // so the supply hierarchy + chokepoints pop. Locals keep the base look. Cheap:
  // only the ~30 highway/bridge roads take the extra strokes (no shadowBlur).
  if (kind === 'highway') {
    ctx.strokeStyle = 'rgba(255, 188, 92, 0.16)';     // soft glow halo
    ctx.lineWidth = 6.5 * widthMul;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 216, 132, 0.72)';    // bright core, dashes flow
    ctx.lineWidth = 1.8 * widthMul;                   // a→b like a live supply line
    ctx.setLineDash([16, 11]);
    ctx.lineDashOffset = -(now * 0.018) % 27;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  } else if (kind === 'bridge') {
    ctx.strokeStyle = 'rgba(150, 178, 214, 0.55)';    // steel glow
    ctx.lineWidth = 5 * widthMul;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(220, 236, 255, 0.85)';    // bright deck
    ctx.lineWidth = 1.6 * widthMul;
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

// =====================================================
// Troop fleet — size-tiered: jeep / APC / tank
// =====================================================
export function drawTroopSprite(ctx, x, y, angle, units, owner, zoom) {
  const c = COLOR[owner];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (Asset.tank?.ready && units >= 40) {
    blitSprite(ctx, Asset.tank, 45, c);
  } else if (Asset.apc?.ready && units >= 12) {
    blitSprite(ctx, Asset.apc, 36, c);
  } else if (Asset.truck?.ready) {
    blitSprite(ctx, Asset.truck, 28.5, c);
  } else if (units >= 40) {
    // ---- Tank (heavy) ----
    _dropShadow(ctx, 19, 17);
    ctx.fillStyle = '#231509';
    ctx.fillRect(-18, -16.5, 36, 33);              // treads shadow
    ctx.fillStyle = c;
    ctx.fillRect(-16.5, -15, 33, 30);              // hull
    // Tread highlights
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-18, -16.5, 36, 4.5);
    ctx.fillRect(-18,  12,   36, 4.5);
    // Turret
    ctx.fillStyle = '#1a1206';
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(0, 0, 7.2, 0, TAU); ctx.fill();
    // Cannon
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(6, -2.25, 16.5, 4.5);
    ctx.fillStyle = c;
    ctx.fillRect(6, -1.05, 15, 2.1);
    _wheelDust(ctx, -18, 6);
  } else if (units >= 12) {
    // ---- APC ----
    _dropShadow(ctx, 14, 11);
    ctx.fillStyle = '#231509';
    ctx.fillRect(-13.5, -10.5, 27, 21);
    ctx.fillStyle = c;
    ctx.fillRect(-12,   -9,    24, 18);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(4.5, -4.5, 7.5, 9);                // hatch
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(5.25, -3, 6, 2.1);
    _wheelDust(ctx, -13.5, 4);
  } else {
    // ---- Jeep / light truck ----
    _dropShadow(ctx, 11, 8);
    ctx.fillStyle = '#231509';
    ctx.fillRect(-10.5, -7.5, 21, 15);
    ctx.fillStyle = c;
    ctx.fillRect(-9,    -6,   18, 12);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(0, -4.5, 6, 9);                    // cab
    ctx.fillStyle = 'rgba(180,220,255,0.5)';
    ctx.fillRect(1.05, -3, 4.5, 2.1);               // windshield
    _wheelDust(ctx, -10.5, 3);
  }
  ctx.restore();
}

/** Dust puffs behind a moving vehicle. `backX` = trailing edge (local
 *  space, negative); `spread` = band half-width. Three static dots. */
function _wheelDust(ctx, backX, spread) {
  ctx.fillStyle = 'rgba(120, 85, 55, 0.4)';
  ctx.beginPath(); ctx.arc(backX - 1.5, -spread, 1.4, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(backX - 1.5,  spread, 1.4, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(110, 78, 50, 0.22)';
  ctx.beginPath(); ctx.arc(backX - 4.5, 0,       1.2, 0, TAU); ctx.fill();
}

// =====================================================
// Engineer (and deploy) — bulldozer with blade
// =====================================================
export function drawEngineerSprite(ctx, x, y, angle, owner, zoom) {
  const c = COLOR[owner];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (Asset.engineer?.ready) {
    blitSprite(ctx, Asset.engineer, 36, c);
    ctx.restore();
    return;
  }

  // Ground drop shadow — sells the chassis sitting above the dust
  _dropShadow(ctx, 13, 11);
  // Body shadow
  ctx.fillStyle = '#231509';
  ctx.fillRect(-12, -10.5, 27, 21);
  // Safety-yellow chassis
  ctx.fillStyle = '#ffd066';
  ctx.fillRect(-10.5, -9, 22.5, 18);
  // Faction-tinted cab
  ctx.fillStyle = c;
  ctx.fillRect(-4.5, -6, 7.5, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(-3, -5.25, 6, 2.1);
  // Blade
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(10.5, -10.5, 5.25, 21);
  ctx.fillStyle = '#ffd066';
  ctx.fillRect(14.25, -9, 1.8, 18);
  ctx.restore();
}

// =====================================================
// Drone — clean isosceles triangle (top-down delta-wing silhouette).
// We're looking straight down on the surface, so the drone reads as a
// pure arrowhead with a faction-colored body and a thin dark outline.
// `trail` is an optional array of recent {x,y} world positions (oldest
// first). When supplied, a fading motion line is drawn behind the drone;
// when null/undefined the sprite behaves exactly as before. Caller
// (render-entities.js drawDroneFleets) opts in by maintaining f._trail.
// =====================================================
export function drawDroneSprite(ctx, x, y, angle, owner, zoom, time, trail) {
  const c = COLOR[owner];

  // Trail is in WORLD space — draw it before the local translate/rotate.
  if (trail) drawDroneTrail(ctx, trail, owner, zoom);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (Asset.drone?.ready) {
    blitSprite(ctx, Asset.drone, 36, c);
    ctx.restore();
    return;
  }

  // Ground drop shadow, offset down-right — drone reads as airborne
  _dropShadow(ctx, 13, 9, 1.5, 1.5, 0.35);

  // Filled isosceles triangle in faction color
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(22.5, 0);              // nose
  ctx.lineTo(-10.5, -14.25);        // back-left
  ctx.lineTo(-10.5,  14.25);        // back-right
  ctx.closePath();
  ctx.fill();

  // Dark outline for contrast against the rust ground
  ctx.strokeStyle = '#1a1206';
  ctx.lineWidth = 1.5 / zoom;
  ctx.stroke();

  // Center crease — runs nose to tail
  ctx.strokeStyle = 'rgba(255, 240, 220, 0.45)';
  ctx.lineWidth = 1.1 / zoom;
  ctx.beginPath();
  ctx.moveTo(22.5, 0);
  ctx.lineTo(-10.5, 0);
  ctx.stroke();

  // Small spinning prop hint at the back
  const spin = (time / 25) % TAU;
  ctx.strokeStyle = 'rgba(220, 220, 220, 0.55)';
  ctx.lineWidth = 1.3 / zoom;
  ctx.beginPath();
  ctx.moveTo(-10.5 + Math.cos(spin) * 3.3, Math.sin(spin) * 3.3);
  ctx.lineTo(-10.5 - Math.cos(spin) * 3.3, -Math.sin(spin) * 3.3);
  ctx.stroke();

  // Tiny orange nose marker
  ctx.fillStyle = '#ff8a3a';
  ctx.beginPath(); ctx.arc(16.5, 0, 1.8, 0, TAU); ctx.fill();

  // Wingtip running lights at the two trailing tips, faction-coloured
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(-10.5, -14.25, 1, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(-10.5,  14.25, 1, 0, TAU); ctx.fill();
  ctx.restore();
}

// =====================================================
// Drone fly trail — fading polyline through recent world positions (oldest
// first), drawn in WORLD space. drawDroneSprite calls it when given `trail`.
// =====================================================
export function drawDroneTrail(ctx, trail, owner, zoom) {
  if (!trail || trail.length < 2) return;
  const n = trail.length;
  ctx.strokeStyle = COLOR[owner];
  ctx.lineCap = 'round';
  for (let i = 1; i < n; i++) {
    const t = i / (n - 1);                 // 0 at tail, 1 at head (fade up)
    ctx.globalAlpha = 0.05 + t * 0.3;
    ctx.lineWidth = (0.6 + t * 1.2) / zoom;
    ctx.beginPath();
    ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
    ctx.lineTo(trail[i].x,     trail[i].y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

// =====================================================
// Turret sprites — AA / tank / artillery / drone-factory + idle animations
// live in sprites-turrets.js (split out when this file crossed the 500-line
// cap). They share this module's `Asset` registry + `blitSprite` helper
// (exported above). Re-exported here so importers keep importing turret draw
// functions from './sprites.js' — no caller changes needed.
// =====================================================
export {
  drawAATurret,
  drawTankTurret,
  drawArtilleryTurret,
  drawFactoryTurret,
} from './sprites-turrets.js';

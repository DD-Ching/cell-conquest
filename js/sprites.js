// =====================================================
// Top-down vehicle / turret sprites — tower-defense look.
//
// Two layers:
//  1. Programmatic canvas drawing (always works, no assets needed).
//  2. PNG asset overlay — if a file exists under assets/<name>.png it
//     will be drawn instead of the primitive. Designed to accept the
//     Kenney.nl "Top-Down Tanks" and "Tower Defense Top-Down" packs;
//     see assets/README.md for the exact filenames expected.
//
// Sprites do not depend on game state, only on (ctx, x, y, angle,
// owner, zoom, ...). The faction tint is applied via the owner color.
//
// Scale note: dimensions sit at "1.5×" of the original pre-3x sprite
// pass — i.e., halved from the previous 3× attempt because that looked
// oversized on the map.
// =====================================================
import { COLOR } from './factions.js';

const TAU = Math.PI * 2;

// ---- Asset loader ----
// Each entry: { img, ready }. When ready, draw functions blit the image
// (tinted via composite ops) instead of the programmatic primitive.
const Asset = {};
const ASSET_FILES = [
  'tank', 'apc', 'truck',           // troop tiers
  'engineer',                       // engineer/deploy
  'drone',                          // air
  'turret_aa', 'turret_tank', 'turret_factory', 'turret_artillery',
];

export function loadAssets() {
  // Probe assets/manifest.json first so we don't spam 9 PNG requests at a
  // user who hasn't dropped sprites in yet. Manifest is a JSON array of
  // names matching ASSET_FILES; only listed names get an Image() created.
  // No manifest, no assets — game falls back to programmatic primitives.
  fetch('assets/manifest.json', { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .then(list => {
      if (!Array.isArray(list)) return;
      for (const name of list) {
        if (!ASSET_FILES.includes(name)) continue;
        const img = new Image();
        Asset[name] = { img, ready: false };
        img.onload = () => { Asset[name].ready = true; };
        img.onerror = () => { /* silent — fall back to primitive */ };
        img.src = `assets/${name}.png`;
      }
    })
    .catch(() => { /* no manifest, no assets — primitives only */ });
}

/** Blit a sprite, sized to fit in `size` world units. Caller has already
 *  translated and rotated. Tinted toward `tint` via source-atop so the
 *  color stays inside the sprite's alpha mask. */
function blitSprite(ctx, asset, size, tint) {
  const img = asset.img;
  const w = size, h = size * (img.height / img.width);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = tint;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// =====================================================
// Roads — thin path with edge highlights. Line widths are WORLD-space (no
// `/zoom`) so the road thickness scales with the canvas: chunky highways
// when zoomed in for tactics, hair-thin spider-web when zoomed out for
// strategic overview. `widthMul` (assigned in world.buildRoads per-edge:
// ~0.5 for outskirts, ~1.5 for hub arteries) layers natural road hierarchy
// on top.
// =====================================================
export function drawRoadStyled(ctx, a, b, blockage, zoom, widthMul = 1) {
  ctx.lineCap = 'round';
  // Dark outer (path edge)
  ctx.strokeStyle = 'rgba(38, 22, 11, 0.95)';
  ctx.lineWidth = 8 * widthMul;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
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
  } else if (units >= 12) {
    // ---- APC ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-13.5, -10.5, 27, 21);
    ctx.fillStyle = c;
    ctx.fillRect(-12,   -9,    24, 18);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(4.5, -4.5, 7.5, 9);                // hatch
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(5.25, -3, 6, 2.1);
  } else {
    // ---- Jeep / light truck ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-10.5, -7.5, 21, 15);
    ctx.fillStyle = c;
    ctx.fillRect(-9,    -6,   18, 12);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(0, -4.5, 6, 9);                    // cab
    ctx.fillStyle = 'rgba(180,220,255,0.5)';
    ctx.fillRect(1.05, -3, 4.5, 2.1);               // windshield
  }
  ctx.restore();
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
// =====================================================
export function drawDroneSprite(ctx, x, y, angle, owner, zoom, time) {
  const c = COLOR[owner];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (Asset.drone?.ready) {
    blitSprite(ctx, Asset.drone, 36, c);
    ctx.restore();
    return;
  }

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
  ctx.restore();
}

// =====================================================
// Turret: anti-air — radar dish + rotating antenna
// =====================================================
export function drawAATurret(ctx, x, y, owner, active, zoom, time) {
  const c = active ? COLOR[owner] : '#7a6a55';

  if (Asset.turret_aa?.ready) {
    ctx.save();
    ctx.translate(x, y);
    blitSprite(ctx, Asset.turret_aa, 51, c);
    ctx.restore();
    return;
  }

  // Base
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 24,    0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(x, y, 20.25, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 10.5,  0, TAU); ctx.fill();
  // Rotating dish + antenna
  const rot = active ? (time / 700) % TAU : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  // Dish (pie slice)
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 16.5, -0.6, 0.6);
  ctx.closePath();
  ctx.fill();
  // Antenna stick
  ctx.strokeStyle = '#ffd066';
  ctx.lineWidth = 2 / zoom;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(19.5, 0);
  ctx.stroke();
  ctx.restore();
}

// =====================================================
// Turret: tank — chassis + turret + cannon
// =====================================================
export function drawTankTurret(ctx, x, y, owner, active, zoom, aimAngle = 0) {
  const c = active ? COLOR[owner] : '#7a6a55';

  if (Asset.turret_tank?.ready) {
    ctx.save();
    ctx.translate(x, y);
    blitSprite(ctx, Asset.turret_tank, 57, c);
    ctx.restore();
    return;
  }

  // Chassis (square base with tread highlights)
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 24,   y - 19.5, 48, 39);
  ctx.fillStyle = c;
  ctx.fillRect(x - 22.5, y - 18,   45, 36);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x - 24,   y - 19.5, 48, 6);
  ctx.fillRect(x - 24,   y + 13.5, 48, 6);
  // Turret + cannon
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aimAngle);
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(0, 0, 13.5, 0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(0, 0, 10.5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(6, -3.45, 28.5, 6.9);
  ctx.fillStyle = c;
  ctx.fillRect(6, -1.5,  27,   3);
  ctx.restore();
}

// =====================================================
// Turret: artillery — long barrel cannon on wheeled carriage
// =====================================================
export function drawArtilleryTurret(ctx, x, y, owner, active, zoom, aimAngle = 0, fireFlash = 0) {
  const c = active ? COLOR[owner] : '#7a6a55';

  if (Asset.turret_artillery?.ready) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(aimAngle);
    blitSprite(ctx, Asset.turret_artillery, 66, c);
    ctx.restore();
    return;
  }

  // Wheeled carriage trails (left + right wheels)
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 28.5, y - 19.5, 7.5, 40.5);
  ctx.fillRect(x + 21,   y - 19.5, 7.5, 40.5);
  // Carriage body
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 24,    0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(x, y, 20.25, 0, TAU); ctx.fill();
  // Rivets
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 8.25, 0, TAU); ctx.fill();
  // Long barrel (rotates to aim)
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aimAngle);
  // Recoil flash kick — barrel slides back briefly after firing
  const recoil = fireFlash > 0 ? -fireFlash * 7.5 : 0;
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(recoil,        -6,    52.5, 12);
  ctx.fillStyle = c;
  ctx.fillRect(recoil + 1.5,  -3.75, 49.5, 7.5);
  // Muzzle brake
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(recoil + 48, -8.25, 7.5, 16.5);
  // Muzzle flash
  if (fireFlash > 0.15) {
    ctx.fillStyle = `rgba(255, 230, 130, ${fireFlash})`;
    ctx.beginPath();
    ctx.arc(recoil + 60, 0, 8.25 * fireFlash, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// =====================================================
// Turret: drone factory — hangar with door
// =====================================================
export function drawFactoryTurret(ctx, x, y, owner, active, zoom, time, producing = false) {
  const c = active ? COLOR[owner] : '#7a6a55';

  if (Asset.turret_factory?.ready) {
    ctx.save();
    ctx.translate(x, y);
    blitSprite(ctx, Asset.turret_factory, 57, c);
    ctx.restore();
    return;
  }

  // Building outline
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 24,   y - 24,   48, 48);
  ctx.fillStyle = c;
  ctx.fillRect(x - 22.5, y - 22.5, 45, 45);
  // Hangar door (front)
  ctx.fillStyle = '#0a0604';
  ctx.fillRect(x - 13.5, y - 19.5, 28.5, 13.5);
  // Roof corrugation
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = -18; i <= 16.5; i += 7.5) {
    ctx.fillRect(x + i, y - 1.5, 2.1, 21);
  }
  // Antenna
  ctx.strokeStyle = '#3a2a18';
  ctx.lineWidth = 2 / zoom;
  ctx.beginPath();
  ctx.moveTo(x + 16.5, y - 19.5); ctx.lineTo(x + 22.5, y - 30);
  ctx.stroke();
  // Status light — pulses while active, brighter when actively producing
  const pulse = 0.6 + 0.4 * Math.sin(time / 200);
  if (active) {
    ctx.fillStyle = producing ? `rgba(155, 255, 125, ${pulse})` : `rgba(255, 200, 90, ${pulse})`;
    ctx.beginPath(); ctx.arc(x + 16.5, y - 30, 3.6, 0, TAU); ctx.fill();
  }
}

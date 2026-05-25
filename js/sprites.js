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
  for (const name of ASSET_FILES) {
    const img = new Image();
    Asset[name] = { img, ready: false };
    img.onload = () => { Asset[name].ready = true; };
    img.onerror = () => { /* silent — fall back to primitive */ };
    img.src = `assets/${name}.png`;
  }
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
// Roads — thick path with edge highlights (TD feel)
// =====================================================
export function drawRoadStyled(ctx, a, b, blockage, zoom) {
  ctx.lineCap = 'round';
  // Dark outer (path edge)
  ctx.strokeStyle = 'rgba(38, 22, 11, 0.95)';
  ctx.lineWidth = 14 / zoom;
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
  ctx.lineWidth = 10 / zoom;
  ctx.stroke();
  // Wreckage / death-highway overlay
  if (blockage > 0.5) {
    ctx.strokeStyle = `rgba(220, 70, 35, ${Math.min(0.7, blockage * 0.85)})`;
    ctx.lineWidth = 9 / zoom;
    ctx.setLineDash([7 / zoom, 6 / zoom]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (blockage > 0.08) {
    ctx.strokeStyle = `rgba(180, 70, 35, ${blockage * 0.55})`;
    ctx.lineWidth = 6 / zoom;
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
    blitSprite(ctx, Asset.tank, 90, c);
  } else if (Asset.apc?.ready && units >= 12) {
    blitSprite(ctx, Asset.apc, 72, c);
  } else if (Asset.truck?.ready) {
    blitSprite(ctx, Asset.truck, 57, c);
  } else if (units >= 40) {
    // ---- Tank (heavy) ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-36, -33, 72, 66);                 // treads shadow
    ctx.fillStyle = c;
    ctx.fillRect(-33, -30, 66, 60);                 // hull
    // Tread highlights
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-36, -33, 72, 9);
    ctx.fillRect(-36,  24, 72, 9);
    // Turret
    ctx.fillStyle = '#1a1206';
    ctx.beginPath(); ctx.arc(0, 0, 18, 0, TAU); ctx.fill();
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(0, 0, 14.4, 0, TAU); ctx.fill();
    // Cannon
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(12, -4.5, 33, 9);
    ctx.fillStyle = c;
    ctx.fillRect(12, -2.1, 30, 4.2);
  } else if (units >= 12) {
    // ---- APC ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-27, -21, 54, 42);
    ctx.fillStyle = c;
    ctx.fillRect(-24, -18, 48, 36);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(9, -9, 15, 18);                    // hatch
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(10.5, -6, 12, 4.2);
  } else {
    // ---- Jeep / light truck ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-21, -15, 42, 30);
    ctx.fillStyle = c;
    ctx.fillRect(-18, -12, 36, 24);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(0, -9, 12, 18);                    // cab
    ctx.fillStyle = 'rgba(180,220,255,0.5)';
    ctx.fillRect(2.1, -6, 9, 4.2);                  // windshield
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
    blitSprite(ctx, Asset.engineer, 72, c);
    ctx.restore();
    return;
  }

  // Body shadow
  ctx.fillStyle = '#231509';
  ctx.fillRect(-24, -21, 54, 42);
  // Safety-yellow chassis
  ctx.fillStyle = '#ffd066';
  ctx.fillRect(-21, -18, 45, 36);
  // Faction-tinted cab
  ctx.fillStyle = c;
  ctx.fillRect(-9, -12, 15, 24);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(-6, -10.5, 12, 4.2);
  // Blade
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(21, -21, 10.5, 42);
  ctx.fillStyle = '#ffd066';
  ctx.fillRect(28.5, -18, 3.6, 36);
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
    blitSprite(ctx, Asset.drone, 72, c);
    ctx.restore();
    return;
  }

  // Filled isosceles triangle in faction color
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(45, 0);                // nose
  ctx.lineTo(-21, -28.5);           // back-left
  ctx.lineTo(-21,  28.5);           // back-right
  ctx.closePath();
  ctx.fill();

  // Dark outline for contrast against the rust ground
  ctx.strokeStyle = '#1a1206';
  ctx.lineWidth = 3 / zoom;
  ctx.stroke();

  // Center crease — runs nose to tail
  ctx.strokeStyle = 'rgba(255, 240, 220, 0.45)';
  ctx.lineWidth = 2.2 / zoom;
  ctx.beginPath();
  ctx.moveTo(45, 0);
  ctx.lineTo(-21, 0);
  ctx.stroke();

  // Small spinning prop hint at the back
  const spin = (time / 25) % TAU;
  ctx.strokeStyle = 'rgba(220, 220, 220, 0.55)';
  ctx.lineWidth = 2.6 / zoom;
  ctx.beginPath();
  ctx.moveTo(-21 + Math.cos(spin) * 6.6, Math.sin(spin) * 6.6);
  ctx.lineTo(-21 - Math.cos(spin) * 6.6, -Math.sin(spin) * 6.6);
  ctx.stroke();

  // Tiny orange nose marker
  ctx.fillStyle = '#ff8a3a';
  ctx.beginPath(); ctx.arc(33, 0, 3.6, 0, TAU); ctx.fill();
  ctx.restore();
}

// =====================================================
// Turret: anti-air — radar dish + rotating antenna (~30% larger)
// =====================================================
export function drawAATurret(ctx, x, y, owner, active, zoom, time) {
  const c = active ? COLOR[owner] : '#7a6a55';

  if (Asset.turret_aa?.ready) {
    ctx.save();
    ctx.translate(x, y);
    blitSprite(ctx, Asset.turret_aa, 102, c);
    ctx.restore();
    return;
  }

  // Base
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 48, 0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(x, y, 40.5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 21, 0, TAU); ctx.fill();
  // Rotating dish + antenna
  const rot = active ? (time / 700) % TAU : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  // Dish (pie slice)
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 33, -0.6, 0.6);
  ctx.closePath();
  ctx.fill();
  // Antenna stick
  ctx.strokeStyle = '#ffd066';
  ctx.lineWidth = 4 / zoom;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(39, 0);
  ctx.stroke();
  ctx.restore();
}

// =====================================================
// Turret: tank — chassis + turret + cannon (~30% larger)
// =====================================================
export function drawTankTurret(ctx, x, y, owner, active, zoom, aimAngle = 0) {
  const c = active ? COLOR[owner] : '#7a6a55';

  if (Asset.turret_tank?.ready) {
    ctx.save();
    ctx.translate(x, y);
    blitSprite(ctx, Asset.turret_tank, 114, c);
    ctx.restore();
    return;
  }

  // Chassis (square base with tread highlights)
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 48, y - 39, 96, 78);
  ctx.fillStyle = c;
  ctx.fillRect(x - 45, y - 36, 90, 72);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x - 48, y - 39, 96, 12);
  ctx.fillRect(x - 48, y + 27, 96, 12);
  // Turret + cannon
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aimAngle);
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(0, 0, 27, 0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(0, 0, 21, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(12, -6.9, 57, 13.8);
  ctx.fillStyle = c;
  ctx.fillRect(12, -3, 54, 6);
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
    blitSprite(ctx, Asset.turret_artillery, 132, c);
    ctx.restore();
    return;
  }

  // Wheeled carriage trails (left + right wheels)
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 57, y - 39, 15, 81);
  ctx.fillRect(x + 42, y - 39, 15, 81);
  // Carriage body
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 48, 0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(x, y, 40.5, 0, TAU); ctx.fill();
  // Rivets
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 16.5, 0, TAU); ctx.fill();
  // Long barrel (rotates to aim)
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aimAngle);
  // Recoil flash kick — barrel slides back briefly after firing
  const recoil = fireFlash > 0 ? -fireFlash * 15 : 0;
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(recoil, -12, 105, 24);
  ctx.fillStyle = c;
  ctx.fillRect(recoil + 3, -7.5, 99, 15);
  // Muzzle brake
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(recoil + 96, -16.5, 15, 33);
  // Muzzle flash
  if (fireFlash > 0.15) {
    ctx.fillStyle = `rgba(255, 230, 130, ${fireFlash})`;
    ctx.beginPath();
    ctx.arc(recoil + 120, 0, 16.5 * fireFlash, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// =====================================================
// Turret: drone factory — hangar with door (~30% larger)
// =====================================================
export function drawFactoryTurret(ctx, x, y, owner, active, zoom, time, producing = false) {
  const c = active ? COLOR[owner] : '#7a6a55';

  if (Asset.turret_factory?.ready) {
    ctx.save();
    ctx.translate(x, y);
    blitSprite(ctx, Asset.turret_factory, 114, c);
    ctx.restore();
    return;
  }

  // Building outline
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 48, y - 48, 96, 96);
  ctx.fillStyle = c;
  ctx.fillRect(x - 45, y - 45, 90, 90);
  // Hangar door (front)
  ctx.fillStyle = '#0a0604';
  ctx.fillRect(x - 27, y - 39, 57, 27);
  // Roof corrugation
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = -36; i <= 33; i += 15) {
    ctx.fillRect(x + i, y - 3, 4.2, 42);
  }
  // Antenna
  ctx.strokeStyle = '#3a2a18';
  ctx.lineWidth = 4 / zoom;
  ctx.beginPath();
  ctx.moveTo(x + 33, y - 39); ctx.lineTo(x + 45, y - 60);
  ctx.stroke();
  // Status light — pulses while active, brighter when actively producing
  const pulse = 0.6 + 0.4 * Math.sin(time / 200);
  if (active) {
    ctx.fillStyle = producing ? `rgba(155, 255, 125, ${pulse})` : `rgba(255, 200, 90, ${pulse})`;
    ctx.beginPath(); ctx.arc(x + 33, y - 60, 7.2, 0, TAU); ctx.fill();
  }
}

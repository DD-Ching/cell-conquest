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
    blitSprite(ctx, Asset.tank, 30, c);
  } else if (Asset.apc?.ready && units >= 12) {
    blitSprite(ctx, Asset.apc, 24, c);
  } else if (Asset.truck?.ready) {
    blitSprite(ctx, Asset.truck, 19, c);
  } else if (units >= 40) {
    // ---- Tank (heavy) — sized ~35% larger for visibility ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-12, -11, 24, 22);                 // treads shadow
    ctx.fillStyle = c;
    ctx.fillRect(-11, -10, 22, 20);                 // hull
    // Tread highlights
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-12, -11, 24, 3);
    ctx.fillRect(-12,   8, 24, 3);
    // Turret
    ctx.fillStyle = '#1a1206';
    ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(0, 0, 4.8, 0, TAU); ctx.fill();
    // Cannon
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(4, -1.5, 11, 3);
    ctx.fillStyle = c;
    ctx.fillRect(4, -0.7, 10, 1.4);
  } else if (units >= 12) {
    // ---- APC ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-9, -7, 18, 14);
    ctx.fillStyle = c;
    ctx.fillRect(-8, -6, 16, 12);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(3, -3, 5, 6);                      // hatch
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(3.5, -2, 4, 1.4);
  } else {
    // ---- Jeep / light truck ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-7, -5, 14, 10);
    ctx.fillStyle = c;
    ctx.fillRect(-6, -4, 12, 8);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(0, -3, 4, 6);                      // cab
    ctx.fillStyle = 'rgba(180,220,255,0.5)';
    ctx.fillRect(0.7, -2, 3, 1.4);                  // windshield
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
    blitSprite(ctx, Asset.engineer, 24, c);
    ctx.restore();
    return;
  }

  // Body shadow
  ctx.fillStyle = '#231509';
  ctx.fillRect(-8, -7, 18, 14);
  // Safety-yellow chassis
  ctx.fillStyle = '#ffd066';
  ctx.fillRect(-7, -6, 15, 12);
  // Faction-tinted cab
  ctx.fillStyle = c;
  ctx.fillRect(-3, -4, 5, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(-2, -3.5, 4, 1.4);
  // Blade
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(7, -7, 3.5, 14);
  ctx.fillStyle = '#ffd066';
  ctx.fillRect(9.5, -6, 1.2, 12);
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
    blitSprite(ctx, Asset.drone, 24, c);
    ctx.restore();
    return;
  }

  // Filled isosceles triangle in faction color
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(15, 0);               // nose
  ctx.lineTo(-7, -9.5);            // back-left
  ctx.lineTo(-7,  9.5);            // back-right
  ctx.closePath();
  ctx.fill();

  // Dark outline for contrast against the rust ground
  ctx.strokeStyle = '#1a1206';
  ctx.lineWidth = 1.3 / zoom;
  ctx.stroke();

  // Center crease — runs nose to tail
  ctx.strokeStyle = 'rgba(255, 240, 220, 0.45)';
  ctx.lineWidth = 0.9 / zoom;
  ctx.beginPath();
  ctx.moveTo(15, 0);
  ctx.lineTo(-7, 0);
  ctx.stroke();

  // Small spinning prop hint at the back
  const spin = (time / 25) % TAU;
  ctx.strokeStyle = 'rgba(220, 220, 220, 0.55)';
  ctx.lineWidth = 1.1 / zoom;
  ctx.beginPath();
  ctx.moveTo(-7 + Math.cos(spin) * 2.2, Math.sin(spin) * 2.2);
  ctx.lineTo(-7 - Math.cos(spin) * 2.2, -Math.sin(spin) * 2.2);
  ctx.stroke();

  // Tiny orange nose marker
  ctx.fillStyle = '#ff8a3a';
  ctx.beginPath(); ctx.arc(11, 0, 1.2, 0, TAU); ctx.fill();
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
    blitSprite(ctx, Asset.turret_aa, 34, c);
    ctx.restore();
    return;
  }

  // Base
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 16, 0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(x, y, 13.5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.fill();
  // Rotating dish + antenna
  const rot = active ? (time / 700) % TAU : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  // Dish (pie slice)
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 11, -0.6, 0.6);
  ctx.closePath();
  ctx.fill();
  // Antenna stick
  ctx.strokeStyle = '#ffd066';
  ctx.lineWidth = 1.6 / zoom;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(13, 0);
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
    blitSprite(ctx, Asset.turret_tank, 38, c);
    ctx.restore();
    return;
  }

  // Chassis (square base with tread highlights)
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 16, y - 13, 32, 26);
  ctx.fillStyle = c;
  ctx.fillRect(x - 15, y - 12, 30, 24);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x - 16, y - 13, 32, 4);
  ctx.fillRect(x - 16, y +  9, 32, 4);
  // Turret + cannon
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aimAngle);
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(0, 0, 7, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(4, -2.3, 19, 4.6);
  ctx.fillStyle = c;
  ctx.fillRect(4, -1, 18, 2);
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
    blitSprite(ctx, Asset.turret_artillery, 44, c);
    ctx.restore();
    return;
  }

  // Wheeled carriage trails (left + right wheels)
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 19, y - 13, 5, 27);
  ctx.fillRect(x + 14, y - 13, 5, 27);
  // Carriage body
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 16, 0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(x, y, 13.5, 0, TAU); ctx.fill();
  // Rivets
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 5.5, 0, TAU); ctx.fill();
  // Long barrel (rotates to aim)
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aimAngle);
  // Recoil flash kick — barrel slides back briefly after firing
  const recoil = fireFlash > 0 ? -fireFlash * 5 : 0;
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(recoil, -4, 35, 8);
  ctx.fillStyle = c;
  ctx.fillRect(recoil + 1, -2.5, 33, 5);
  // Muzzle brake
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(recoil + 32, -5.5, 5, 11);
  // Muzzle flash
  if (fireFlash > 0.15) {
    ctx.fillStyle = `rgba(255, 230, 130, ${fireFlash})`;
    ctx.beginPath();
    ctx.arc(recoil + 40, 0, 5.5 * fireFlash, 0, TAU);
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
    blitSprite(ctx, Asset.turret_factory, 38, c);
    ctx.restore();
    return;
  }

  // Building outline
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 16, y - 16, 32, 32);
  ctx.fillStyle = c;
  ctx.fillRect(x - 15, y - 15, 30, 30);
  // Hangar door (front)
  ctx.fillStyle = '#0a0604';
  ctx.fillRect(x - 9, y - 13, 19, 9);
  // Roof corrugation
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = -12; i <= 11; i += 5) {
    ctx.fillRect(x + i, y - 1, 1.4, 14);
  }
  // Antenna
  ctx.strokeStyle = '#3a2a18';
  ctx.lineWidth = 1.6 / zoom;
  ctx.beginPath();
  ctx.moveTo(x + 11, y - 13); ctx.lineTo(x + 15, y - 20);
  ctx.stroke();
  // Status light — pulses while active, brighter when actively producing
  const pulse = 0.6 + 0.4 * Math.sin(time / 200);
  if (active) {
    ctx.fillStyle = producing ? `rgba(155, 255, 125, ${pulse})` : `rgba(255, 200, 90, ${pulse})`;
    ctx.beginPath(); ctx.arc(x + 11, y - 20, 2.4, 0, TAU); ctx.fill();
  }
}

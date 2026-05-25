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
  'turret_aa', 'turret_tank', 'turret_factory',
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
    blitSprite(ctx, Asset.tank, 22, c);
  } else if (Asset.apc?.ready && units >= 12) {
    blitSprite(ctx, Asset.apc, 18, c);
  } else if (Asset.truck?.ready) {
    blitSprite(ctx, Asset.truck, 14, c);
  } else if (units >= 40) {
    // ---- Tank (heavy) ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-9, -8, 18, 16);                 // treads shadow
    ctx.fillStyle = c;
    ctx.fillRect(-8, -7, 16, 14);                 // hull
    // Tread highlights
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-9, -8, 18, 2);
    ctx.fillRect(-9,  6, 18, 2);
    // Turret
    ctx.fillStyle = '#1a1206';
    ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, TAU); ctx.fill();
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, TAU); ctx.fill();
    // Cannon
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(3, -1.1, 8, 2.2);
    ctx.fillStyle = c;
    ctx.fillRect(3, -0.5, 7.5, 1);
  } else if (units >= 12) {
    // ---- APC ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-7, -5, 14, 10);
    ctx.fillStyle = c;
    ctx.fillRect(-6, -4, 12, 8);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(2, -2, 4, 4);                    // hatch
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(2.5, -1.5, 3, 1);
  } else {
    // ---- Jeep / light truck ----
    ctx.fillStyle = '#231509';
    ctx.fillRect(-5, -4, 10, 8);
    ctx.fillStyle = c;
    ctx.fillRect(-4, -3, 8, 6);
    ctx.fillStyle = '#1a1206';
    ctx.fillRect(0, -2, 3, 4);                    // cab
    ctx.fillStyle = 'rgba(180,220,255,0.5)';
    ctx.fillRect(0.5, -1.5, 2, 1);                // windshield
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
    blitSprite(ctx, Asset.engineer, 18, c);
    ctx.restore();
    return;
  }

  // Body shadow
  ctx.fillStyle = '#231509';
  ctx.fillRect(-6, -5, 13, 10);
  // Safety-yellow chassis
  ctx.fillStyle = '#ffd066';
  ctx.fillRect(-5, -4, 11, 8);
  // Faction-tinted cab
  ctx.fillStyle = c;
  ctx.fillRect(-2, -3, 4, 6);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(-1.5, -2.5, 3, 1);
  // Blade
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(5, -5, 2.5, 10);
  ctx.fillStyle = '#ffd066';
  ctx.fillRect(7, -4.5, 0.8, 9);
  ctx.restore();
}

// =====================================================
// Drone — delta-wing paper-airplane / Shahed-style suicide drone
// =====================================================
export function drawDroneSprite(ctx, x, y, angle, owner, zoom, time) {
  const c = COLOR[owner];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (Asset.drone?.ready) {
    blitSprite(ctx, Asset.drone, 16, c);
    ctx.restore();
    return;
  }

  // Dark outline (paper-airplane / delta wing silhouette)
  ctx.fillStyle = '#1a1206';
  ctx.beginPath();
  ctx.moveTo(9.5, 0);              // nose tip
  ctx.lineTo(-6, -5);              // back-left wing tip
  ctx.lineTo(-3.5, 0);             // tail crease
  ctx.lineTo(-6, 5);               // back-right wing tip
  ctx.closePath();
  ctx.fill();

  // Faction-tinted upper half — gives the side identification at a glance
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(8.5, 0);
  ctx.lineTo(-5, -4);
  ctx.lineTo(-3, 0);
  ctx.closePath();
  ctx.fill();

  // Center crease — paper-airplane spine
  ctx.strokeStyle = 'rgba(255, 240, 220, 0.55)';
  ctx.lineWidth = 0.7 / zoom;
  ctx.beginPath();
  ctx.moveTo(9.5, 0);
  ctx.lineTo(-3.5, 0);
  ctx.stroke();

  // Small tail propeller disc — only thing rotating, faint
  const spin = (time / 25) % TAU;
  ctx.strokeStyle = 'rgba(200, 200, 200, 0.5)';
  ctx.lineWidth = 0.8 / zoom;
  ctx.beginPath();
  ctx.moveTo(-4.5 + Math.cos(spin) * 1.4, Math.sin(spin) * 1.4);
  ctx.lineTo(-4.5 - Math.cos(spin) * 1.4, -Math.sin(spin) * 1.4);
  ctx.stroke();

  // Tiny forward indicator
  ctx.fillStyle = '#ff8a3a';
  ctx.beginPath(); ctx.arc(7, 0, 0.7, 0, TAU); ctx.fill();
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
    blitSprite(ctx, Asset.turret_aa, 20, c);
    ctx.restore();
    return;
  }

  // Base
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 9, 0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(x, y, 7.5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fill();
  // Rotating dish + antenna
  const rot = active ? (time / 700) % TAU : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  // Dish (small pie slice)
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 6, -0.6, 0.6);
  ctx.closePath();
  ctx.fill();
  // Antenna stick
  ctx.strokeStyle = '#ffd066';
  ctx.lineWidth = 1.2 / zoom;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(7, 0);
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
    blitSprite(ctx, Asset.turret_tank, 22, c);
    ctx.restore();
    return;
  }

  // Chassis (square base with tread highlights)
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 9, y - 8, 18, 16);
  ctx.fillStyle = c;
  ctx.fillRect(x - 8, y - 7, 16, 14);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x - 9, y - 8, 18, 2);
  ctx.fillRect(x - 9, y + 6, 18, 2);
  // Turret + cannon
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aimAngle);
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(0, 0, 4, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(2, -1.3, 11, 2.6);
  ctx.fillStyle = c;
  ctx.fillRect(2, -0.6, 10, 1.2);
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
    blitSprite(ctx, Asset.turret_factory, 22, c);
    ctx.restore();
    return;
  }

  // Building outline
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(x - 9, y - 9, 18, 18);
  ctx.fillStyle = c;
  ctx.fillRect(x - 8, y - 8, 16, 16);
  // Hangar door (front)
  ctx.fillStyle = '#0a0604';
  ctx.fillRect(x - 5, y - 7, 10, 5);
  // Roof corrugation
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = -7; i <= 6; i += 3) {
    ctx.fillRect(x + i, y - 1, 1, 8);
  }
  // Antenna
  ctx.strokeStyle = '#3a2a18';
  ctx.lineWidth = 1.2 / zoom;
  ctx.beginPath();
  ctx.moveTo(x + 6, y - 8); ctx.lineTo(x + 8, y - 11);
  ctx.stroke();
  // Status light — pulses while active, brighter when actively producing
  const pulse = 0.6 + 0.4 * Math.sin(time / 200);
  if (active) {
    ctx.fillStyle = producing ? `rgba(155, 255, 125, ${pulse})` : `rgba(255, 200, 90, ${pulse})`;
    ctx.beginPath(); ctx.arc(x + 6, y - 11, 1.4, 0, TAU); ctx.fill();
  }
}

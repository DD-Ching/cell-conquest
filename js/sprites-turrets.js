// =====================================================
// Turret sprites — AA / tank / artillery / drone-factory, plus their idle
// animations. Split out of sprites.js (which kept the asset loader and the
// road/troop/drone/engineer primitives) once that file crossed the 500-line
// cap.
//
// Same contract as the rest of sprites.js: these draw functions depend only
// on (ctx, x, y, owner, active, zoom, ...) — never on game state — and the
// faction tint comes in via the owner color. The PNG-asset overlay path is
// shared with sprites.js through the `Asset` registry and `blitSprite`
// helper imported below: `Asset` is the SAME live object loadAssets() mutates
// (its turret_* slots flip ready=true asynchronously), and blitSprite blits
// the cached luminance-preserving tint. No assets → programmatic primitives.
//
// Re-exported from sprites.js, so importers keep importing from './sprites.js'.
// =====================================================
import { COLOR } from './factions.js';
import { Asset, blitSprite } from './sprites.js';

const TAU = Math.PI * 2;

// =====================================================
// Turret: anti-air — twin-barrel flak autocannon on a rotating mount.
//
// (Was a Kenney PNG that read as "two upright missiles" — wrong silhouette for
// an AA GUN. Now a primitive twin-autocannon: two short elevated barrels with
// muzzle brakes sweeping the sky, which reads unambiguously as flak/AA, never a
// missile rack or a single tank cannon. The asset-overlay branch is kept so a
// purpose-drawn turret_aa.png could still override it later — but turret_aa is
// no longer in assets/manifest.json, so the primitive is the canonical look.)
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

  // Base ring + mount disc.
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 24,    0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(x, y, 20.25, 0, TAU); ctx.fill();
  // Idle brown glow ring when inactive — signals "powering up / dormant".
  if (!active) {
    ctx.strokeStyle = 'rgba(120, 80, 45, 0.35)';
    ctx.lineWidth = 1.5 / zoom;
    ctx.beginPath(); ctx.arc(x, y, 16, 0, TAU); ctx.stroke();
  }
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 11, 0, TAU); ctx.fill();

  // Rotating twin-barrel gun assembly. Slow sweep when active (scanning the
  // sky); parked at a fixed elevation when dormant.
  const rot = active ? (time / 1400) % TAU : -0.6;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  // Breech block (the gun cradle).
  ctx.fillStyle = '#241808';
  ctx.fillRect(-7, -8, 13, 16);
  ctx.fillStyle = c;
  ctx.fillRect(-5, -6.5, 9, 13);
  // Twin barrels — two parallel autocannon tubes pointing +x, each capped with
  // a muzzle brake. Two barrels is the whole "this is a flak gun" read.
  for (const off of [-4.2, 4.2]) {
    ctx.fillStyle = '#1c1206';
    ctx.fillRect(3, off - 1.7, 19, 3.4);            // barrel
    ctx.fillStyle = c;
    ctx.fillRect(20, off - 2.6, 3.2, 5.2);          // muzzle brake
  }
  // Sight nub on the breech.
  ctx.fillStyle = '#ffd066';
  ctx.beginPath(); ctx.arc(-2.5, 0, 2.2, 0, TAU); ctx.fill();
  // Active muzzle glow at the barrel tips.
  if (active) {
    ctx.fillStyle = 'rgba(255, 220, 150, 0.55)';
    for (const off of [-4.2, 4.2]) { ctx.beginPath(); ctx.arc(23, off, 1.8, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

// =====================================================
// Turret: tank — chassis + turret + cannon.
//
// Two modes, selected by `bodyAngle`:
//   • bodyAngle === null  → STATIC building (the tank FACTORY). The square
//     chassis stays axis-aligned and only the turret swivels by `aimAngle`
//     (idle ±3° sway when aimAngle===0, the "no live target" sentinel).
//   • bodyAngle = <radians> → MOBILE tank. The WHOLE hull (chassis + turret +
//     barrel) rotates as one rigid body to face travel — that's what reads as
//     "the tank is driving that way". The barrel is locked forward (no separate
//     aim), so `aimAngle` is ignored in this mode.
//
// Heading convention: bodyAngle is atan2(dy, dx) (0 = east). The primitive
// barrel points +x (east) by default, so rotate(bodyAngle) aligns it directly.
// =====================================================
export function drawTankTurret(ctx, x, y, owner, active, zoom, aimAngle = 0, time = 0, bodyAngle = null) {
  const c = active ? COLOR[owner] : '#7a6a55';
  const mobile = bodyAngle !== null;

  if (Asset.turret_tank?.ready) {
    ctx.save();
    ctx.translate(x, y);
    // Mobile: spin the whole sprite to face travel. The top-down tank PNG is
    // drawn nose-UP (−y), so map heading (0 = east) onto it with +90°.
    if (mobile) ctx.rotate(bodyAngle + Math.PI / 2);
    blitSprite(ctx, Asset.turret_tank, 57, c);
    ctx.restore();
    return;
  }

  // Primitive fallback. Draw in a translated (and, when mobile, rotated) local
  // frame so a moving tank turns as one rigid body instead of a fixed square.
  ctx.save();
  ctx.translate(x, y);
  if (mobile) ctx.rotate(bodyAngle);
  // Chassis (square base with tread highlights — treads run front-to-back)
  ctx.fillStyle = '#1a1206';
  ctx.fillRect(-24,   -19.5, 48, 39);
  ctx.fillStyle = c;
  ctx.fillRect(-22.5, -18,   45, 36);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(-24,   -19.5, 48, 6);
  ctx.fillRect(-24,    13.5, 48, 6);
  // Turret + cannon. Mobile → barrel locked forward (+x in the rotated body
  // frame). Static factory → turret swivels by aimAngle (idle sway at 0).
  const turretRot = mobile ? 0
    : (aimAngle === 0 ? 0.05 * Math.sin(time / 1300) : aimAngle);
  ctx.rotate(turretRot);
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
  // Carriage body — tilt ~2° when aim is steep to suggest elevation
  const sinAim = Math.sin(aimAngle);
  const steep = Math.abs(sinAim) > 0.7;
  if (steep) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(sinAim > 0 ? 0.035 : -0.035);
    ctx.translate(-x, -y);
  }
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 24,    0, TAU); ctx.fill();
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(x, y, 20.25, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.beginPath(); ctx.arc(x, y, 8.25, 0, TAU); ctx.fill();
  if (steep) ctx.restore();
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
  // Hangar door (front) — when producing, door cycles open/closed and a
  // warm interior glow reads through. When idle, door stays closed.
  const doorTop = y - 19.5;
  const doorMaxH = 13.5;
  if (producing) {
    // Bright interior shows through the opening
    ctx.fillStyle = 'rgba(255, 180, 80, 0.6)';
    ctx.fillRect(x - 13.5, doorTop, 28.5, doorMaxH);
    // Door height oscillates — when doorH is small, the opening is large
    const doorH = doorMaxH * (0.5 + 0.5 * Math.sin(time / 400));
    ctx.fillStyle = '#0a0604';
    ctx.fillRect(x - 13.5, doorTop + (doorMaxH - doorH), 28.5, doorH);
  } else {
    ctx.fillStyle = '#0a0604';
    ctx.fillRect(x - 13.5, doorTop, 28.5, doorMaxH);
  }
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

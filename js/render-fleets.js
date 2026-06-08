// =====================================================
// Fleet layers — moving units between nodes: ground troop columns (a leader
// trailed by a staggered column of vehicles) and drone swarms (delta-wing
// suicide craft). Split out of render-entities.js to keep that file under its
// line cap; render-entities.js re-exports these so render.js is untouched.
//
// Both layers support frustum culling via state._view and LOD via state._lod.
// Sprite primitives come from sprites.js; this module is layer logic only.
// =====================================================
import { state } from './state.js';
import { DRONE_HP_AIR } from './config.js';
import { COLOR } from './factions.js';
import {
  drawTroopSprite, drawEngineerSprite, drawDroneSprite, drawTankTurret,
} from './sprites.js';
import { curveOffsetForPoint, curveHeadingForPoint } from './road-curve.js';

/** Walk BACK along a fleet's road path by world-distance `d` from the leader's
 *  centerline position, returning the centerline point + the segment it lands on
 *  (so the caller can ride the road curve there). A column trails ≤ ~100 px, so
 *  this crosses 1-2 segments — cheap. Stays on the straight centerline; the
 *  render-only curve offset is applied by the caller. */
function backPointAlongPath(f, d) {
  let seg = f.segIdx;
  let a = state.nodes[f.path[seg]], b = state.nodes[f.path[seg + 1]];
  let segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let fromA = Math.hypot(f.x - a.x, f.y - a.y);     // leader's distance from `a`
  let rem = d;
  while (rem > fromA && seg > 0) {
    rem -= fromA;
    seg--;
    a = state.nodes[f.path[seg]]; b = state.nodes[f.path[seg + 1]];
    segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    fromA = segLen;                                 // reference point is now b (segment end)
  }
  const t = Math.max(0, fromA - rem) / segLen;      // fraction from a toward b
  return { cx: a.x + (b.x - a.x) * t, cy: a.y + (b.y - a.y) * t, a, b };
}

// ---- Ground fleets — column of vehicles trailing a leader ----
export function drawTroopFleets(ctx, zoom, now) {
  const COLUMN_MAX = 8;
  const PER_VEH = 5;
  const GAP = 13;       // px between adjacent vehicles along the column
  const { vL, vT, vR, vB } = state._view;
  // Column trails up to ~COLUMN_MAX*GAP ≈ 100 px back from the leader,
  // plus sprite half-width. 120 px margin catches partial-visible columns.
  for (const f of state.fleets) {
    if (f.kind === 'drone') continue;
    if (f.x + 120 < vL || f.x - 120 > vR || f.y + 120 < vT || f.y - 120 > vB) continue;
    // Mobile tanks: one heavy chassis facing its heading (rides the road curve
    // like any ground fleet). `units` is the tank's HP pool, so show an HP bar
    // when it's taken damage. Drawn with the same tank sprite as the factory.
    if (f.kind === 'tank') {
      let tx = f.x, ty = f.y;
      // Barrel/hull faces the TRAVEL direction. On a road segment that's the
      // curve TANGENT at the tank's position (matches the bowed road it visually
      // rides — the straight chord would point up to ~27° off near the ends).
      // Parked (sieging / idle, no forward segment) → keep the last heading,
      // which pointed at the node it arrived on, so the barrel reads as aimed
      // into the base it's shelling.
      let ang = (f.heading !== undefined) ? f.heading : 0;
      if (f.path && f.segIdx < f.path.length - 1) {
        const ca = state.nodes[f.path[f.segIdx]], cb = state.nodes[f.path[f.segIdx + 1]];
        const o = curveOffsetForPoint(ca.x, ca.y, cb.x, cb.y, ca.id, cb.id, f.x, f.y);
        tx += o.ox; ty += o.oy;
        ang = curveHeadingForPoint(ca.x, ca.y, cb.x, cb.y, ca.id, cb.id, f.x, f.y);
      }
      // Mobile tank: rotate the WHOLE hull to face travel (bodyAngle = ang).
      // Passing it in the bodyAngle slot makes drawTankTurret turn chassis +
      // barrel as one rigid body — the static factory call omits it (stays a
      // fixed building whose turret merely swivels).
      drawTankTurret(ctx, tx, ty, f.owner, true, zoom, 0, now, ang);
      const hpMax = f.hpMax || f.units || 1;
      const frac = Math.max(0, f.units) / hpMax;
      if (frac < 0.999) {
        const bw = 24;
        ctx.fillStyle = 'rgba(20,20,20,0.5)';
        ctx.fillRect(tx - bw / 2, ty + 16, bw, 3);
        ctx.fillStyle = '#ffd066';
        ctx.fillRect(tx - bw / 2, ty + 16, bw * frac, 3);
      }
      continue;
    }
    let angle = 0;
    if ((f.kind === 'deploy' || f.kind === 'assault' || f.kind === 'return') && f.offroad) {
      angle = Math.atan2(f.finalY - f.y, f.finalX - f.x);
    } else if (f.path && f.segIdx < f.path.length - 1) {
      const segB = state.nodes[f.path[f.segIdx + 1]];
      angle = Math.atan2(segB.y - f.y, segB.x - f.x);
    } else if (!f.path) {
      continue;
    }
    // Ride the painted road curve: shift the DRAW anchor by the same
    // perpendicular offset the road stroke uses (road-curve.js). Render-only —
    // f.x/f.y (the sim positions combat reads) stay on the straight centerline,
    // so this is outcome-neutral. Off-road final legs stay straight.
    let fx = f.x, fy = f.y;
    if (f.path && f.segIdx < f.path.length - 1 && !f.offroad) {
      const ca = state.nodes[f.path[f.segIdx]], cb = state.nodes[f.path[f.segIdx + 1]];
      const o = curveOffsetForPoint(ca.x, ca.y, cb.x, cb.y, ca.id, cb.id, f.x, f.y);
      fx += o.ox; fy += o.oy;
    }
    // LOW LOD: collapse the column-of-sprites into ONE oriented rect that
    // matches the visual footprint of the full column at LOD 3 (~36 px wide,
    // and as long as the column would have been — GAP*count of vehicles). So
    // the fleet doesn't visually shrink when the player zooms out.
    if (state._lod < 2) {
      const totalUnits = Math.max(1, Math.floor(f.units));
      const veh = Math.min(COLUMN_MAX, Math.max(1, Math.ceil(totalUnits / PER_VEH)));
      const len = 18 + veh * GAP;        // half-length each side ≈ leader→tail
      const wid = 18;                    // half-width matches single sprite
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const hx = cos * 18, hy = sin * 18;            // leader offset
      const bx = -cos * (len - 18), by = -sin * (len - 18); // tail offset
      const px = -sin * wid, py = cos * wid;         // perpendicular
      ctx.fillStyle = COLOR[f.owner];
      ctx.beginPath();
      ctx.moveTo(fx + hx + px, fy + hy + py);
      ctx.lineTo(fx + hx - px, fy + hy - py);
      ctx.lineTo(fx + bx - px, fy + by - py);
      ctx.lineTo(fx + bx + px, fy + by + py);
      ctx.closePath();
      ctx.fill();
      continue;
    }
    // ENGINEERS / DEPLOY: single dozer (they're individual vehicles)
    if (f.kind === 'engineer' || f.kind === 'deploy') {
      drawEngineerSprite(ctx, fx, fy, angle, f.owner, zoom);
      ctx.fillStyle = COLOR[f.owner];
      ctx.font = `bold ${12 / zoom}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('⚙', fx, fy - 18);
      continue;
    }
    // TROOPS / ASSAULT: column of vehicles FOLLOWING the (possibly curved) road.
    // Each vehicle is placed by walking back along the path by its arc-length and
    // riding the same Bézier the road is painted on — so the column hugs the bend
    // instead of sticking out straight off the road. This runs only at LOD ≥ 2
    // (zoomed in enough to see it); at overview the cheap oriented rect above is
    // used, so there's no large-scale cost. Off-road legs / path-less fleets fall
    // back to the straight tangent column.
    const totalUnits = Math.max(1, Math.floor(f.units));
    const showCount = Math.min(COLUMN_MAX, Math.max(1, Math.ceil(totalUnits / PER_VEH)));
    const perVehUnits = totalUnits / showCount;
    const onRoad = f.path && f.segIdx < f.path.length - 1 && !f.offroad;
    for (let k = 0; k < showCount; k++) {
      let vx, vy, vAng = angle;
      if (onRoad) {
        const bp = backPointAlongPath(f, k * GAP);
        const o = curveOffsetForPoint(bp.a.x, bp.a.y, bp.b.x, bp.b.y, bp.a.id, bp.b.id, bp.cx, bp.cy);
        vx = bp.cx + o.ox; vy = bp.cy + o.oy;       // read _off immediately
        vAng = curveHeadingForPoint(bp.a.x, bp.a.y, bp.b.x, bp.b.y, bp.a.id, bp.b.id, bp.cx, bp.cy);
      } else {
        vx = fx - Math.cos(angle) * (k * GAP);
        vy = fy - Math.sin(angle) * (k * GAP);
      }
      // Alternating lateral jitter, perpendicular to the LOCAL heading.
      const jitter = (k % 2 === 0 ? 1 : -1) * (k > 0 ? 1.6 : 0);
      vx += -Math.sin(vAng) * jitter; vy += Math.cos(vAng) * jitter;
      if (f.kind === 'assault') drawTroopSprite(ctx, vx, vy, vAng, Math.max(40, perVehUnits), f.owner, zoom);
      else drawTroopSprite(ctx, vx, vy, vAng, perVehUnits, f.owner, zoom);
    }
    // Total-count label above the column leader
    ctx.fillStyle = COLOR[f.owner];
    ctx.font = `bold ${12 / zoom}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(totalUnits, fx, fy - 18);
  }
}

// ---- Drones (delta-wing sprite + HP bar when damaged) ----
export function drawDroneFleets(ctx, zoom, now) {
  const { vL, vT, vR, vB } = state._view;
  // Low LOD: paint drones as oriented triangles matching the full-LOD
  // delta-wing sprite size (~28 px tip-to-tail) so the swarm doesn't
  // visually shrink when zoomed out.
  if (state._lod < 2) {
    for (const f of state.fleets) {
      if (f.kind !== 'drone') continue;
      if (f.x + 18 < vL || f.x - 18 > vR || f.y + 18 < vT || f.y - 18 > vB) continue;
      const angle = f.heading !== undefined ? f.heading : Math.atan2(f.ty - f.y, f.tx - f.x);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      // Nose 14 forward, wings 10 back ± 9 perpendicular.
      const nx =  cos * 14,           ny =  sin * 14;
      const lx = -cos * 10 - sin * 9, ly = -sin * 10 + cos * 9;
      const rx = -cos * 10 + sin * 9, ry = -sin * 10 - cos * 9;
      ctx.fillStyle = COLOR[f.owner];
      ctx.beginPath();
      ctx.moveTo(f.x + nx, f.y + ny);
      ctx.lineTo(f.x + lx, f.y + ly);
      ctx.lineTo(f.x + rx, f.y + ry);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }
  for (const f of state.fleets) {
    if (f.kind !== 'drone') continue;
    if (f.x + 35 < vL || f.x - 35 > vR || f.y + 35 < vT || f.y - 35 > vB) continue;
    const angle = f.heading !== undefined ? f.heading : Math.atan2(f.ty - f.y, f.tx - f.x);
    drawDroneSprite(ctx, f.x, f.y, angle, f.owner, zoom, now);
    if (f.hp < DRONE_HP_AIR) {
      const bw = 18, frac = Math.max(0, f.hp) / DRONE_HP_AIR;
      ctx.fillStyle = 'rgba(20,20,20,0.5)';
      ctx.fillRect(f.x - bw / 2, f.y + 12, bw, 3);
      ctx.fillStyle = '#ff6678';
      ctx.fillRect(f.x - bw / 2, f.y + 12, bw * frac, 3);
    }
  }
}

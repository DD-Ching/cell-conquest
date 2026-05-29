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
  drawTroopSprite, drawEngineerSprite, drawDroneSprite,
} from './sprites.js';

// ---- Ground fleets — column of vehicles trailing a leader ----
export function drawTroopFleets(ctx, zoom) {
  const COLUMN_MAX = 8;
  const PER_VEH = 5;
  const GAP = 13;       // px between adjacent vehicles along the column
  const { vL, vT, vR, vB } = state._view;
  // Column trails up to ~COLUMN_MAX*GAP ≈ 100 px back from the leader,
  // plus sprite half-width. 120 px margin catches partial-visible columns.
  for (const f of state.fleets) {
    if (f.kind === 'drone') continue;
    if (f.x + 120 < vL || f.x - 120 > vR || f.y + 120 < vT || f.y - 120 > vB) continue;
    let angle = 0;
    if ((f.kind === 'deploy' || f.kind === 'assault' || f.kind === 'return') && f.offroad) {
      angle = Math.atan2(f.finalY - f.y, f.finalX - f.x);
    } else if (f.path && f.segIdx < f.path.length - 1) {
      const segB = state.nodes[f.path[f.segIdx + 1]];
      angle = Math.atan2(segB.y - f.y, segB.x - f.x);
    } else if (!f.path) {
      continue;
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
      ctx.moveTo(f.x + hx + px, f.y + hy + py);
      ctx.lineTo(f.x + hx - px, f.y + hy - py);
      ctx.lineTo(f.x + bx - px, f.y + by - py);
      ctx.lineTo(f.x + bx + px, f.y + by + py);
      ctx.closePath();
      ctx.fill();
      continue;
    }
    // ENGINEERS / DEPLOY: single dozer (they're individual vehicles)
    if (f.kind === 'engineer' || f.kind === 'deploy') {
      drawEngineerSprite(ctx, f.x, f.y, angle, f.owner, zoom);
      ctx.fillStyle = COLOR[f.owner];
      ctx.font = `bold ${12 / zoom}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('⚙', f.x, f.y - 18);
      continue;
    }
    // TROOPS / ASSAULT: column of individual vehicles (1 sprite ≈ 5 units, max 8)
    const totalUnits = Math.max(1, Math.floor(f.units));
    const showCount = Math.min(COLUMN_MAX, Math.max(1, Math.ceil(totalUnits / PER_VEH)));
    const perVehUnits = totalUnits / showCount;
    const backX = -Math.cos(angle), backY = -Math.sin(angle);
    const perpX = -Math.sin(angle), perpY = Math.cos(angle);
    for (let k = 0; k < showCount; k++) {
      // Alternating lateral jitter so it doesn't look like a comb
      const jitter = (k % 2 === 0 ? 1 : -1) * (k > 0 ? 1.6 : 0);
      const vx = f.x + backX * (k * GAP) + perpX * jitter;
      const vy = f.y + backY * (k * GAP) + perpY * jitter;
      if (f.kind === 'assault') {
        drawTroopSprite(ctx, vx, vy, angle, Math.max(40, perVehUnits), f.owner, zoom);
      } else {
        drawTroopSprite(ctx, vx, vy, angle, perVehUnits, f.owner, zoom);
      }
    }
    // Total-count label above the column leader
    ctx.fillStyle = COLOR[f.owner];
    ctx.font = `bold ${12 / zoom}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(totalUnits, f.x, f.y - 18);
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
      const angle = Math.atan2(f.ty - f.y, f.tx - f.x);
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
    const angle = Math.atan2(f.ty - f.y, f.tx - f.x);
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

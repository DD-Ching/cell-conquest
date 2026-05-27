// =====================================================
// AI build phase — turret placement + drone-net upgrades.
//
// Two phases, both gated on per-tick random rolls + saturation:
//   - tryBuildTurret(ctx): AA wall → tanks → factory spam → artillery
//     per hub, weighted by hub centrality.
//   - tryBuildNet(ctx): score front-line road segments by enemy exposure,
//     concentrate upgrades on existing partial nets before starting new ones.
//
// Each phase returns true when it fired an action this tick (caller stops
// after the first true return — same "one-action-per-tick" budget the
// monolithic aiTick used). Pure positional helpers (aaWallSpot etc.) are
// kept local — they're never reused outside the build phase.
//
// `ctx` is built once per aiTick (see ai.js) and carries the situation:
//   { owner, myNodes, saturationRatio, antiTurtle, fstats,
//     isExposedToEnemyTank, AA_RADIUS, NET_LEVEL_MAX }
// =====================================================
import { state } from './state.js';
import { dist } from './util.js';
import { isAlly } from './alliance.js';
import { placeTurretAt, placeNetOnEdge, ekey } from './engineering.js';
import { AA_RADIUS, NET_LEVEL_MAX } from './config.js';

// ---- Position layout helpers (build-phase-internal) ----
// Spread AAs across the front arc to form a WALL (not a circle). Drones
// flying toward the hub get sieved by overlapping radars from multiple angles.
function aaWallSpot(n, dirX, dirY, idx) {
  const px = -dirY, py = dirX;
  // Idx 0-4 = the original 5-AA defensive wall hugging the hub. Idx 5-8 =
  // forward-pushed positions that gradually extend the line toward the
  // enemy, so as the wall thickens the AA umbrella also creeps forward.
  const layout = [
    { fwd:  70, side:    0 },   // 0: center front
    { fwd:  55, side:   80 },   // 1: right flank
    { fwd:  55, side:  -80 },   // 2: left flank
    { fwd:  30, side:  130 },   // 3: far right
    { fwd:  30, side: -130 },   // 4: far left
    { fwd: 140, side:    0 },   // 5: forward push, center
    { fwd: 125, side:   70 },   // 6: forward right
    { fwd: 125, side:  -70 },   // 7: forward left
    { fwd: 200, side:    0 },   // 8: deep push (antiTurtle only)
  ][idx % 9];
  return { x: n.x + dirX * layout.fwd + px * layout.side,
           y: n.y + dirY * layout.fwd + py * layout.side };
}
function tankSpot(n, dirX, dirY, idx) {
  const px = -dirY, py = dirX;
  const layout = [
    { fwd: 100, side:  0 },     // 0: center forward (siege)
    { fwd:  80, side: 70 },     // 1: right flank
  ][idx % 2];
  return { x: n.x + dirX * layout.fwd + px * layout.side,
           y: n.y + dirY * layout.fwd + py * layout.side };
}
function factorySpot(n, dirX, dirY, idx) {
  // BEHIND the hub, fanned out in an arc deeper each step. Stays inside our AA umbrella.
  const px = -dirY, py = dirX;
  const back = 35 + Math.floor(idx / 2) * 30;
  const side = (idx % 2 === 0 ? 1 : -1) * Math.min(15 + idx * 12, 70);
  return { x: n.x - dirX * back + px * side,
           y: n.y - dirY * back + py * side };
}
function artillerySpot(n, dirX, dirY, idx) {
  // Deep rear — artillery's range is so long it can fire from way back behind the hub.
  const px = -dirY, py = dirX;
  const back = 120 + idx * 35;
  const side = (idx % 2 === 0 ? 1 : -1) * (idx * 30);
  return { x: n.x - dirX * back + px * side,
           y: n.y - dirY * back + py * side };
}

/** Attempt one turret build this tick. Returns true if placed. */
export function tryBuildTurret(ctx) {
  const { owner, myNodes, saturationRatio, antiTurtle, fstats, isExposedToEnemyTank } = ctx;

  // Build chance scales with saturation + per-faction strength.
  const buildChance = (0.18 + saturationRatio * 0.40 + (antiTurtle ? 0.15 : 0)) * fstats.buildChanceMul;
  if (Math.random() >= buildChance) return false;
  if (myNodes.length < 2) return false;

  // Targets per hub — the player's winning playbook is: AA wall → tanks → factory spam,
  // plus long-range artillery for AOE counter-pressure against enemy clusters.
  const AA_TARGET        = antiTurtle ? 9 : 7;    // thick AA wall with forward push
  const TANK_TARGET      = 2;                     // 2 tanks for siege + flank
  const FACTORY_TARGET   = antiTurtle ? 8 : 5;    // more drone throughput
  const ARTILLERY_TARGET = antiTurtle ? 3 : 2;    // more AOE counter-pressure
  const buildMinUnits    = saturationRatio > 0.4 ? 14 : 22;

  const byHub = [...myNodes].sort((a, b) => state.adj.get(b.id).size - state.adj.get(a.id).size);

  for (const n of byHub) {
    if (n.units < buildMinUnits) continue;

    // Direction toward the nearest enemy (defines "front" vs "back")
    let toward = null, towardDist = Infinity;
    for (const en of state.nodes) {
      if (isAlly(en.owner, owner) || en.owner === 'neutral') continue;
      const d = dist(n, en);
      if (d < towardDist) { towardDist = d; toward = en; }
    }
    if (!toward) continue;          // no enemies anywhere — nothing to defend against
    const ddx = toward.x - n.x, ddy = toward.y - n.y;
    const dlen = Math.hypot(ddx, ddy) || 1;
    const dirX = ddx / dlen, dirY = ddy / dlen;

    // Survey friendly infrastructure NEAR this hub. Single pass over my own
    // turrets (via turretsByOwner) instead of 5 separate .filter() calls;
    // squared distances skip the per-check sqrt.
    let ownAAsNear = 0, ownTanksNear = 0, ownFactoriesNear = 0, ownArtilleryNear = 0;
    let aaCoversThisHub = false;
    const aaUmbrella2 = (AA_RADIUS * 0.8) * (AA_RADIUS * 0.8);
    const myTurrets = state.turretsByOwner.get(owner) || [];
    for (const t of myTurrets) {
      const dx = t.x - n.x, dy = t.y - n.y;
      const d2 = dx * dx + dy * dy;
      if (t.type === 'antiair') {
        if (d2 < 220 * 220) ownAAsNear++;
        if (d2 < aaUmbrella2) aaCoversThisHub = true;
      } else if (t.type === 'tank') {
        if (d2 < 200 * 200) ownTanksNear++;
      } else if (t.type === 'factory') {
        if (d2 < 180 * 180) ownFactoriesNear++;
      } else if (t.type === 'artillery') {
        if (d2 < 250 * 250) ownArtilleryNear++;
      }
    }

    // Try a build at one of several layout positions — if the first is blocked
    // by enemy tank range, fall through to the next. Stops the AI from giving
    // up on AA construction the moment one spot is contested.
    // Note: overlapping turrets is fine — clustered AAs = overlapping kill
    // zones, which is exactly what a real AA doctrine wants.
    function tryBuild(type, makeSpot, baseIdx, maxAttempts = 6) {
      for (let a = 0; a < maxAttempts; a++) {
        const spot = makeSpot(n, dirX, dirY, baseIdx + a);
        if (isExposedToEnemyTank(spot.x, spot.y)) continue;
        if (placeTurretAt(spot.x, spot.y, type, owner)) return true;
      }
      return false;
    }

    // ---- 1) AA WALL — keep stacking until we hit AA_TARGET ----
    // Sweep all 9 layout positions (defensive 0-4 + forward 5-8) so a
    // single blocked spot doesn't stall the wall thickening.
    if (ownAAsNear < AA_TARGET) {
      if (tryBuild('antiair', aaWallSpot, ownAAsNear, 9)) return true;
    }
    // ---- 2) Tanks — start as soon as we have at least 2 AAs ----
    if (ownAAsNear >= 2 && ownTanksNear < TANK_TARGET) {
      if (tryBuild('tank', tankSpot, ownTanksNear, 3)) return true;
    }
    // ---- 3) FACTORY SPAM — once the wall is up, mass-produce drones ----
    if (aaCoversThisHub && ownAAsNear >= 2 && ownFactoriesNear < FACTORY_TARGET) {
      if (tryBuild('factory', factorySpot, ownFactoriesNear, 4)) return true;
    }
    // ---- 4) ARTILLERY — deep rear AOE pressure ----
    if (aaCoversThisHub && ownAAsNear >= 2 && ownArtilleryNear < ARTILLERY_TARGET) {
      if (tryBuild('artillery', artillerySpot, ownArtilleryNear, 3)) return true;
    }
  }
  return false;
}

/** Upgrade a drone-net on a front-line edge. Returns true if a net was started. */
export function tryBuildNet(ctx) {
  const { owner, saturationRatio, isExposedToEnemyTank } = ctx;
  if (Math.random() >= 0.10 + saturationRatio * 0.20) return false;

  let cand = null, bestScore = -1;
  for (const r of state.roads) {
    const e = state.edgeData.get(ekey(r.a, r.b));
    if (!e) continue;
    if (e.netLevel >= NET_LEVEL_MAX) continue;
    const aN = state.nodes[r.a], bN = state.nodes[r.b];
    const aMine = aN.owner === owner, bMine = bN.owner === owner;
    if (!aMine && !bMine) continue;
    let exposure = 0;
    for (const endpoint of [aN, bN]) {
      if (endpoint.owner !== owner) continue;
      for (const nb of state.adj.get(endpoint.id)) {
        const o = state.nodes[nb].owner;
        if (o !== owner && o !== 'neutral') exposure += 1;
      }
    }
    if (exposure === 0) continue;
    // Don't send a net engineer into an enemy tank's kill zone — they'll die on approach.
    const mx = (aN.x + bN.x) / 2, my = (aN.y + bN.y) / 2;
    if (isExposedToEnemyTank(mx, my)) continue;
    // Concentration bias: prefer maxing an existing partial net to L3 before
    // starting a brand-new one. Spread-thin L1s don't stop drone swarms.
    let score = exposure * (NET_LEVEL_MAX + 1 - e.netLevel);
    score += e.netLevel * exposure * 1.8;
    if (score > bestScore) { bestScore = score; cand = r; }
  }
  return !!(cand && placeNetOnEdge(cand.a, cand.b, owner));
}

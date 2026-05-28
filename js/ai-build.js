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
import { ekey } from './engineering.js';
import { AA_RADIUS, NET_LEVEL_MAX, TANK_RADIUS } from './config.js';
// Side effects (placeTurretAt, placeNetOnEdge) come through ctx — see ai-effects.js.

// Cheap spatial scan over the uniform 250-px grid (same layout main.js
// simulate() builds and combat.js forNear walks). The per-hub doctrine read
// uses it to count nearby enemy ground fleets / turrets without an O(N) sweep.
const GRID_CELL = 250;
function forNearGrid(grid, x, y, R, fn) {
  const range = Math.ceil(R / GRID_CELL);
  const cx0 = Math.floor(x / GRID_CELL), cy0 = Math.floor(y / GRID_CELL);
  for (let cx = cx0 - range; cx <= cx0 + range; cx++)
    for (let cy = cy0 - range; cy <= cy0 + range; cy++) {
      const bucket = grid.get(cx * 10000 + cy);
      if (bucket) for (const t of bucket) fn(t);
    }
}

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
  const { owner, myNodes, saturationRatio, antiTurtle, fstats, isExposedToEnemyTank,
          placeTurretAt } = ctx;

  // Build chance scales with saturation + per-faction strength. A saturated
  // empire bleeds regen every second it sits at cap, so the more saturated we
  // are the harder we lean into construction — each build also drains
  // ENG_COST units off the top, a real sink rather than a full-node shuffle.
  const buildChance = (0.18 + saturationRatio * 0.60 + (antiTurtle ? 0.15 : 0)) * fstats.buildChanceMul;
  if (Math.random() >= buildChance) return false;
  if (myNodes.length < 2) return false;

  // SATURATION SURCHARGE: when the empire sits full (regen thrown away), raise
  // whichever per-hub ceiling the local doctrine calls for so there's ALWAYS
  // something productive to build rather than idling at cap. `satBoost` is the
  // amplifier — the actual per-hub targets are chosen INSIDE the loop from the
  // local threat read (see the DOCTRINE block). We deliberately do NOT stamp a
  // full set of every turret type at every hub: a quiet rear hub builds drones,
  // a contested hub builds tanks, etc. ("一物克一物").
  const satBoost = saturationRatio > 0.6 ? 2 : saturationRatio > 0.35 ? 1 : 0;
  const buildMinUnits = saturationRatio > 0.4 ? 14 : 22;

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

    // ---- PER-HUB DOCTRINE (一物克一物) ----
    // Read the LOCAL threat and build the counter, not a full catalogue at
    // every hub. Two cheap grid scans: enemy ground fleets right on the hub
    // (incoming assault), and enemy turrets a step ahead toward the front
    // (their fortified line). The four signals map to the four arms:
    //   • enemy node FAR        → factories: drones are the only arm that
    //                             crosses the gap to a distant enemy.
    //   • ground contact        → tanks: contest the line and buy time while
    //                             the rest of the empire masses up ("搶時間").
    //   • dense enemy buildup    → artillery: shell the cluster of buildings
    //                             flat once we've stockpiled ("囤積後轟建築").
    //   • enemy factories near   → AA wall + nets: brace for the drone swarm
    //                             ("怕無人機就大量囤積防空/防護網").
    // satBoost (saturation / stalemate) amplifies whichever counter is called
    // for — a deadlocked front mass-stockpiles the right unit.
    let groundThreat = 0;
    forNearGrid(state.groundFleetGrid, n.x, n.y, TANK_RADIUS, f => {
      if (f.owner !== owner && f.owner !== 'neutral' && !isAlly(f.owner, owner)) groundThreat++;
    });
    let enemyTurretsNear = 0, enemyFactoriesNear = 0;
    const probeX = n.x + dirX * 280, probeY = n.y + dirY * 280;
    forNearGrid(state.turretGrid, probeX, probeY, 360, t => {
      if (t.owner === owner || t.owner === 'neutral' || isAlly(t.owner, owner)) return;
      enemyTurretsNear++;
      if (t.type === 'factory') enemyFactoriesNear++;
    });

    const FAR = towardDist > 1500, NEAR = towardDist < 800;
    const groundContact   = NEAR || groundThreat > 0;
    const enemyBuiltUp    = enemyTurretsNear >= 4;
    const droneThreatened = enemyFactoriesNear > 0;

    // Lean baseline — a quiet hub does NOT get the whole catalogue.
    let AA_TARGET = 3, TANK_TARGET = 1, FACTORY_TARGET = 2, ARTILLERY_TARGET = 0;
    if (FAR) {                       // 遠方 → 無人機
      FACTORY_TARGET   = Math.max(FACTORY_TARGET, (antiTurtle ? 7 : 5) + satBoost * 2);
      AA_TARGET        = Math.max(AA_TARGET, 4 + satBoost);          // enough to cover the factories
    }
    if (groundContact) {             // 互相交戰 → 坦克
      TANK_TARGET      = Math.max(TANK_TARGET, 3 + (satBoost > 0 ? 1 : 0));
      AA_TARGET        = Math.max(AA_TARGET, 5 + satBoost);
    }
    if (enemyBuiltUp) {              // 囤積後 → 大砲轟掉建築
      ARTILLERY_TARGET = Math.max(ARTILLERY_TARGET, (antiTurtle ? 4 : 3) + (satBoost > 0 ? 1 : 0));
    }
    if (droneThreatened) {           // 怕無人機 → 防空牆 + 防護網
      AA_TARGET        = Math.max(AA_TARGET, (antiTurtle ? 10 : 8) + satBoost * 2);
    }

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
    // "銅牆鐵壁": when bracing for drones, throw up a BURST of AA in ONE tick so
    // the wall forms all at once — a lone AA built one-per-tick just gets picked
    // off before the wall ever completes. Otherwise one per tick (normal pace).
    if (ownAAsNear < AA_TARGET) {
      const burst = droneThreatened ? Math.min(4, AA_TARGET - ownAAsNear) : 1;
      let built = 0;
      for (let b = 0; b < burst; b++) {
        if (tryBuild('antiair', aaWallSpot, ownAAsNear + b, 9)) built++;
        else break;
      }
      if (built > 0) return true;
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
  const { owner, saturationRatio, isExposedToEnemyTank, placeNetOnEdge } = ctx;
  // "怕無人機就大量囤積防護網" — nets are the dedicated drone counter, so the
  // more drone factories the enemy fields the harder we lay them. One pass over
  // the typed factory bucket (cheap — far smaller than all turrets).
  let enemyFactories = 0;
  for (const t of (state.turretsByType.get('factory') || [])) {
    if (t.active && t.owner !== owner && t.owner !== 'neutral' && !isAlly(t.owner, owner)) enemyFactories++;
  }
  const droneThreat = Math.min(0.30, enemyFactories * 0.02);
  if (Math.random() >= 0.10 + saturationRatio * 0.20 + droneThreat) return false;

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

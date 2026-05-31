// =====================================================
// Shared helpers for building Worker snapshots.
//
// Both ai-worker-bridge.js and render-worker-bridge.js build a slim,
// shallow-cloned view of sim state to postMessage off the main thread.
// The two bridges historically each open-coded the per-entity field
// picking — this module pulls that logic out so the slicing rules live
// in one place.
//
// What each helper produces:
//   sliceNodes(nodes, opts)   — array of plain node objects with the
//                               fields BOTH bridges need (positional;
//                               returned[i].id === i so existing
//                               state.nodes[id] lookups work).
//   sliceTurrets(turrets)     — array of plain turret objects.
//   sliceFleets(fleets)       — array of plain fleet objects.
//   sliceAdj(adj)             — Map<id, Set<id>> serialized as
//                               [id, neighborIds[]][]. Map<num,Set<num>>
//                               via structuredClone is slow on some
//                               browser/version combos; arrays clone fast.
//   sliceEdgeData(edgeData)   — same array-of-pairs serialization for
//                               the per-road net level / charges / owner.
//
// AI-only neutral skip:
//   The AI bridge passes { includeNeutral: false } to drop the ~700
//   neutral nodes that exist before the player captures them. To keep
//   state.nodes[id] positional (worker code reads neighbors that way),
//   skipped neutrals are replaced with { id, owner: 'neutral' }
//   placeholders rather than gaps. Callers that need certain neutrals
//   (e.g. capture-target neighbors of AI nodes) supply
//   `includeNeutralIds: Set<id>` and those keep full data.
// =====================================================

/** Build a slim node object that carries every field read by either
 *  bridge's downstream consumers (AI tick + world render). */
function fullSlimNode(n) {
  return {
    id: n.id, x: n.x, y: n.y, owner: n.owner,
    units: n.units, capacity: n.capacity, regenRate: n.regenRate,
    size: n.size, kind: n.kind, lastRegenT: n.lastRegenT,
    // Procgen tactical-icon type (undefined on legacy non-capital nodes — the
    // icon pass no-ops there). Cheap string; lets the render-worker draw the
    // same nodeType designation frames.
    nodeType: n.nodeType,
    // Render-side visual state. Cheap to include and lets render-worker
    // share the same shape. Initialised on every node by world / engineering
    // setup so these are always real numbers (no undefined).
    pulse: n.pulse, flash: n.flash,
    flashBuild: n.flashBuild, engineers: n.engineers,
  };
}

/** Per-node slice. Positional — returned[i].id === i, so neighbour
 *  lookups via `state.nodes[neighborId]` keep working in worker context.
 *  Pass `{ includeNeutral: false }` to drop neutral data (AI doesn't read
 *  most of it). Pass `includeNeutralIds: Set<id>` alongside to retain
 *  full data for selected neutrals (e.g. AI capture-target neighbours).
 */
export function sliceNodes(nodes, { includeNeutral = true, includeNeutralIds = null } = {}) {
  const out = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) { out[i] = undefined; continue; }
    if (n.owner === 'neutral' && !includeNeutral &&
        !(includeNeutralIds && includeNeutralIds.has(n.id))) {
      // Placeholder — keeps the array dense + state.nodes[id] returning
      // an object so neighbour iterations don't crash. Worker code only
      // reads `.owner` on neutral neighbours.
      out[i] = { id: n.id, owner: 'neutral' };
    } else {
      out[i] = fullSlimNode(n);
    }
  }
  return out;
}

/** Per-turret slice. Union of the fields AI tick + render read. AI tick
 *  needs owner/type/x/y/hp/hpMax/active/pendingEngineer/dronesReady/
 *  prodCooldown; render also reads progress/total (build-arc) and
 *  artyCooldown (artillery recoil flash). */
export function sliceTurrets(turrets) {
  const out = new Array(turrets.length);
  for (let i = 0; i < turrets.length; i++) {
    const t = turrets[i];
    out[i] = {
      id: t.id, owner: t.owner, type: t.type,
      x: t.x, y: t.y, hp: t.hp, hpMax: t.hpMax,
      active: t.active, pendingEngineer: t.pendingEngineer,
      dronesReady: t.dronesReady, prodCooldown: t.prodCooldown,
      progress: t.progress, total: t.total,
      artyCooldown: t.artyCooldown,
    };
  }
  return out;
}

/** Per-fleet slice. Union of fields read by AI tick (target bucketing,
 *  inbound-drone counts) and render (drone/troop/engineer/assault draw,
 *  trail rendering). spawnT carries through for drone-lifetime gates that
 *  may run in worker mirrors; the sim's mutable segTraveled is dropped —
 *  no consumer reads it off-thread. */
export function sliceFleets(fleets) {
  const out = new Array(fleets.length);
  for (let i = 0; i < fleets.length; i++) {
    const f = fleets[i];
    out[i] = {
      _id: f._id, owner: f.owner, kind: f.kind,
      x: f.x, y: f.y, units: f.units,
      targetKind: f.targetKind, targetId: f.targetId,
      targetNodeId: f.targetNodeId,
      path: f.path, segIdx: f.segIdx,
      hp: f.hp, hpMax: f.hpMax, spawnT: f.spawnT,   // hpMax: mobile tanks store HP in units; the bar needs the max
      // Drone / engineer / assault motion targets. Render uses these to
      // draw the off-road final leg + animate drones toward their target.
      tx: f.tx, ty: f.ty,
      // Drone banking heading — render points the delta-wing sprite along
      // the actual turn-radius flight direction, not straight at the target
      // (without this the worker path falls back to target-facing → crabbing).
      heading: f.heading,
      finalX: f.finalX, finalY: f.finalY,
      offroad: f.offroad,
    };
  }
  return out;
}

/** Serialize state.adj (Map<id, Set<id>>) as [id, neighborIds[]][].
 *  Faster + more portable across browsers than structuredClone of the Map. */
export function sliceAdj(adj) {
  return Array.from(adj.entries(), ([id, set]) => [id, Array.from(set)]);
}

/** Serialize state.edgeData as [key, value][]. The `mode` distinguishes
 *  what each bridge needs:
 *   - 'ai':    just net info (netLevel/netCharges/netOwner). AI tick
 *              reads only `netLevel`; the extras are cheap and let the
 *              worker mirror keep correct net ownership for actions.
 *   - 'render': raw entry objects (includes wrecks for blockage draw).
 *              Render needs the wreck markers per road. */
export function sliceEdgeData(edgeData, mode = 'render') {
  if (mode === 'ai') {
    return Array.from(edgeData.entries(), ([k, v]) => [k, {
      netLevel: v.netLevel, netCharges: v.netCharges, netOwner: v.netOwner,
      // AI road-clearing (clearBlockedRoads) needs to know how clogged each
      // edge is. Ship only the COUNT, not the wreck objects — the slim 'ai'
      // snapshot stays cheap and the actual clear replays main-thread where
      // the full wrecks array lives.
      wreckCount: v.wrecks ? v.wrecks.length : 0,
    }]);
  }
  return Array.from(edgeData.entries());
}

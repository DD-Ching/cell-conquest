// =====================================================
// Faction alliance registry.
//
// "Are we on the same side?" check used by:
//   ai.js          — target filtering, reinforce eligibility
//   combat.js      — AA/Tank/Artillery skip allies
//   drones.js      — target picker / retarget / hunt skip allies
//   fleets.js      — arriveAt: ally → reinforce, enemy → combat
//   main.js        — gate player attack input vs ally nodes
//
// isAlly() is hot — called inside every per-tick combat / target loop.
// Cheap path is the same-owner shortcut (most checks); the Set lookup
// only happens for cross-faction pairs.
// =====================================================

// owner string -> Set<owner string> of allies
const _allies = new Map();

/** Wipe every registered alliance. Called from rollFactions() when a new
 *  game starts so stale ally pairings don't carry over. */
export function resetAlliances() {
  _allies.clear();
}

/** Register a SYMMETRIC alliance between two owners. */
export function setAlly(a, b) {
  if (a === b) return;
  if (!_allies.has(a)) _allies.set(a, new Set());
  if (!_allies.has(b)) _allies.set(b, new Set());
  _allies.get(a).add(b);
  _allies.get(b).add(a);
}

/** Same-side check. True when owners are identical OR registered allies. */
export function isAlly(a, b) {
  if (a === b) return true;
  const s = _allies.get(a);
  return s !== undefined && s.has(b);
}

/** Snapshot the alliance registry as a flat list of unordered pairs.
 *  Used by the AI worker bridge to ship alliance state with each snapshot
 *  so isAlly() in the worker context returns the same answers as the main
 *  thread (the G-key toggle can change membership mid-game). */
export function listAlliances() {
  const seen = new Set();
  const out = [];
  for (const [a, set] of _allies) {
    for (const b of set) {
      const k = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([a, b]);
    }
  }
  return out;
}

// =====================================================
// AI logistics — continuous supply flow from the saturated interior to the
// front. This is NOT a one-action-per-tick decision: it runs on every aiTick
// and may dispatch several transfers, because a city sitting at capacity is
// wasted production every second — regen caps at 1.0× capacity (see
// world.catchUpRegen), so a full node throws away its ENTIRE regen rate until
// something drains it. The rule the player asked for: almost ZERO tolerance
// for an idle-full city. Drain it toward where the units can actually be SPENT
// (attack / expand / build happen at the perimeter, not the core).
//
// Model — BFS distance-to-front over the owner's OWN territory:
//   front  = an own node touching an enemy/neutral node  → distance 0
//   inward = distance grows one hop at a time through own nodes
// Every near-full node ships its surplus one hop to the adjacent own node that
// is NEARER the front (strictly smaller distance) and still has headroom.
// Surplus therefore migrates interior → perimeter step by step, and the
// perimeter spends it. Front nodes themselves (distance 0) are left alone —
// they EXPAND outward, they don't ship backward. This is exactly the
// "middle resupplies the cities that are pushing the line" flow the player
// described.
//
// Uses ctx.sendFleet (the effects bundle) so the transfers replay correctly in
// Worker mode. See ai-effects.js / ai.js.
// =====================================================
import { state } from './state.js';
import { isAlly } from './alliance.js';

/** Drain idle-full interior nodes one hop toward the front. Always runs;
 *  returns nothing (not part of the one-action-per-tick phase budget). */
export function flowSupplyToFront(ctx) {
  const { owner, myNodes, sendFleet } = ctx;
  if (myNodes.length < 2) return;

  // --- BFS distance-to-front over OWN territory ---
  const distToFront = new Map();
  const queue = [];
  for (const n of myNodes) {
    let atFront = false;
    for (const nbId of state.adj.get(n.id)) {
      // A non-allied neighbour (enemy OR neutral) means this node sits on the
      // line — it can expand here, so it's a sink, distance 0.
      if (!isAlly(state.nodes[nbId].owner, owner)) { atFront = true; break; }
    }
    if (atFront) { distToFront.set(n.id, 0); queue.push(n.id); }
  }
  if (queue.length === 0) return;          // no front reachable — nothing to feed
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    const d = distToFront.get(id);
    for (const nbId of state.adj.get(id)) {
      if (state.nodes[nbId].owner !== owner) continue;   // traverse own nodes only
      if (distToFront.has(nbId)) continue;
      distToFront.set(nbId, d + 1);
      queue.push(nbId);
    }
  }

  // --- Drain near-full interior nodes toward the front ---
  for (const my of myNodes) {
    if (my.units < my.capacity * 0.9) continue;          // not full yet — let it regen
    const myD = distToFront.get(my.id);
    if (!myD) continue;        // undefined (no front in its component) or 0 (it IS the front → expands, doesn't ship back)
    // Pick the adjacent own node nearer the front that still has headroom.
    let best = null, bestD = myD;
    for (const nbId of state.adj.get(my.id)) {
      const nb = state.nodes[nbId];
      if (nb.owner !== owner) continue;
      if (nb.units >= nb.capacity * 1.45) continue;       // recipient near its 1.5× ceiling — no room
      const d = distToFront.get(nbId);
      if (d !== undefined && d < bestD) { bestD = d; best = nb; }
    }
    if (!best) continue;
    // Drain down to ~60% so the node keeps regen headroom (it'll refill and
    // ship again) instead of bouncing right back to a wasteful cap.
    const send = Math.floor(my.units - my.capacity * 0.6);
    if (send >= 5) sendFleet(my, best, send);
  }
}

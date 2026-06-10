// =====================================================
// Node fill ceiling — single source of truth.
//
// A node's "natural" garrison ceiling is its capacity (passive regen stops
// there, see world.catchUpRegen). Friendly fleets may pack a node above that,
// up to OVERFILL× capacity, before it's considered "stuffed". Beyond OVERFILL×
// the surplus is *not* discarded — arriveAt keeps it and the saturation-relief
// pass (ai-logistics.relieveSaturation) bleeds it back out into expansion /
// reinforcement. OVERFILL is therefore the level relief pulls a node DOWN to,
// not a wall that throws units away.
//
// roomLeft() is the canonical "how many units can I still send here before I'm
// just over-packing it" check. Every AI reinforcement amount-calc routes
// through it so the enemy AI and the player's Lieutenant (ally1) never blindly
// over-send into a node that's already full — they spend the surplus somewhere
// useful instead. Pass allied in-flight units so two donors racing into the
// same gap don't both count the same room.
// =====================================================

export const OVERFILL = 1.5;

/** The overfill ceiling for a node (capacity × OVERFILL). */
export const nodeCeiling = (n) => n.capacity * OVERFILL;

/** Units `n` can absorb before it's over the overfill ceiling. Never negative.
 *  `inboundAllied` = allied units already in flight toward `n` (subtract them so
 *  concurrent reinforcements don't collectively over-pack it). */
export function roomLeft(n, inboundAllied = 0) {
  return Math.max(0, n.capacity * OVERFILL - n.units - inboundAllied);
}

// =====================================================
// All gameplay & system constants — tune here.
// Nothing in this file depends on DOM, state, or other modules.
// =====================================================

// ---- World ----
// Massive Mars theatre — 5× linear (25× area) of the original 2400×1800
// arena. ~150-200 nodes, 90-minute games. Unit speeds intentionally kept
// the same so the bigger map FEELS bigger (cross-map troop travel ~2 min).
// Camera ZOOM_MIN dropped so the player can fit the whole world in view
// for strategic overview, and PAN_SPEED bumped so WASD traversal isn't
// glacial across the bigger canvas.
export const WORLD_W = 12000;
export const WORLD_H = 9000;
export const N_NODES_MIN = 1400;
export const N_NODES_MAX = 1800;

// ---- Movement ----
export const FLEET_SPEED = 95;          // troop fleets, world px/sec
export const PAN_SPEED = 1800;          // camera key-pan speed (bumped for big map)
export const EDGE_PAN_SPEED = 1400;     // edge-of-screen pan speed
export const EDGE_PAN_MARGIN = 28;
export const ZOOM_MIN = 0.1;            // allows whole-world overview (1920×1000 canvas / 12000×9000 world ≈ 0.11 fit)
export const ZOOM_MAX = 2.2;

// ---- Time / speed presets ----
export const SPEEDS = [1, 2, 5, 10, 20];

// ---- Battle Engineering ----
// Engineer (physical unit on map)
export const ENG_HP = 60;
export const ENG_SPEED = 70;            // world px/sec; slower than FLEET_SPEED
export const ENG_CLEAR_RATE = 0.6;      // wreck-pile-HP/sec/engineer (idle eng at node
                                        // chips away at piles on connected edges)
export const ENG_COST = 12;             // units consumed at source node to dispatch

// Buildings: build time (sec), HP
export const AA_BUILD_TIME = 10;
export const AA_HP = 100;
export const AA_RADIUS = 200;
export const AA_DPS = 15;

export const DF_BUILD_TIME = 15;
export const DF_HP = 150;
export const DF_PRODUCTION_T = 12;      // sec between drone spawns
export const FACTORY_MAX_STOCKPILE = 6; // max held drones per factory while Hold-Fire is on

// Drone Net (per-road segment). Engineer trips raise the level; each level grants
// a finite "intercept" pool. Drones trying to attack troops on a netted road are
// shot down by the net instead, consuming one charge per drone.
export const NET_LEVEL_MAX       = 3;
export const NET_CHARGES_LEVEL   = [0, 20, 40, 60]; // capacity at level 0/1/2/3
export const NET_PICK_R          = 36;              // world-px tolerance when clicking near a road
// Net-engineer trip removes this many wreck piles from the targeted edge.
// (Idle engineers stationed at a node clear piles continuously at ENG_CLEAR_RATE.)
export const NET_ENG_WRECK_CLEAR = 2;

// Tank / cannon — anti-ground (and anti-drone, anti-turret) generalist tower.
// Longer range than AA but lower DPS per target.
export const TANK_BUILD_TIME = 12;
export const TANK_HP = 130;
export const TANK_RADIUS = 240;
export const TANK_DPS = 8;

// Artillery — long-range area cannon. Built by an engineer (like AA), but
// fires AOE shells that are INACCURATE — random within a wobble circle. So
// stacking many turrets at one spot becomes a vulnerability: one lucky
// shell wipes the whole cluster. Counters dense defenses.
export const ARTILLERY_BUILD_TIME    = 20;
export const ARTILLERY_HP            = 120;
export const ARTILLERY_RANGE         = 420;   // longest range in the game
export const ARTILLERY_AOE           = 42;    // tighter blast — only really hits a *tight* cluster
export const ARTILLERY_INTERVAL      = 5.0;   // slower fire — bombardment, not autocannon
export const ARTILLERY_INACCURACY    = 240;   // very wide wobble — shells can land anywhere in this radius around the aim
export const ARTILLERY_DAMAGE_TURRET = 35;    // damage per shell to each turret in AOE
export const ARTILLERY_DAMAGE_FLEET  = 28;    // damage per shell to each ground fleet
export const ARTILLERY_SHELL_FLIGHT  = 0.7;   // sec of flight before detonation

// Drone
export const DRONE_HP_AIR = 30;
export const DRONE_SPEED = 130;
export const DRONE_DAMAGE = 50;
// Drones now hunt enemy ground fleets they detect in flight.
export const DRONE_DETECT_R = 110;      // scan radius for nearby ground fleets
export const DRONE_HUNT_DMG = 18;       // damage to fleet on impact (less than fixed-target)
export const DRONE_HUNT_SWITCH_RATIO = 0.7;  // switch from primary→hunt only if hunt is this much closer

// ---- Road wreckage (replaces the old abstract "blockage" speed-mult system) ----
// When a vehicle dies on a road segment it leaves a physical pile at its death
// position. Fleets behind it must steer AROUND the pile (lateral offset off
// the road centerline); the natural off-road tax slows them down, producing
// congestion organically. Engineers physically clear the piles to restore flow.
export const WRECK_PILE_HP_INIT  = 4;   // engineer HP needed to remove one pile
export const WRECK_RENDER_R      = 8;   // visual radius of one pile
export const WRECK_MAX_PER_EDGE  = 18;  // perf cap — beyond this, new wrecks
                                        // coalesce into the nearest existing
                                        // pile (visually + HP-wise) so the
                                        // per-tick detour scan stays bounded
export const DETOUR_LOOKAHEAD    = 55;  // sec-ahead a vehicle "sees" a pile to dodge it
export const DETOUR_OFFSET       = 22;  // peak lateral offset (px) when squeezing past
export const DETOUR_SPEED_MIN    = 0.014; // slowdown factor at peak detour (wasteland crawl)

// ---- NN integration ----
export const NN_OWNERS = new Set(['red']);
export const NN_MODEL_URL = 'cell_policy.onnx';
export const NN_N = 40;
export const NN_F = 21;
export const NN_HIDDEN = 96;

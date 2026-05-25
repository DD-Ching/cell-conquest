// =====================================================
// All gameplay & system constants — tune here.
// Nothing in this file depends on DOM, state, or other modules.
// =====================================================

// ---- World ----
// Larger Mars arena so 2-5 factions have room to maneuver.
export const WORLD_W = 2400;
export const WORLD_H = 1800;
export const N_NODES_MIN = 18;
export const N_NODES_MAX = 28;

// ---- Movement ----
export const FLEET_SPEED = 95;          // troop fleets, world px/sec
export const PAN_SPEED = 800;           // camera key-pan speed
export const EDGE_PAN_SPEED = 650;      // edge-of-screen pan speed
export const EDGE_PAN_MARGIN = 28;
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.2;

// ---- Time / speed presets ----
export const SPEEDS = [1, 2, 5, 10, 20];

// ---- Battle Engineering ----
// Engineer (physical unit on map)
export const ENG_HP = 60;
export const ENG_SPEED = 70;            // world px/sec; slower than FLEET_SPEED
export const ENG_BUILD_RATE = 1.0;      // fraction/sec/engineer toward site.total
export const ENG_CLEAR_RATE = 0.15;     // blockage/sec/engineer (decreases edge.blockage)
export const ENG_COST = 12;             // units consumed at source node to dispatch

// Buildings: build time (sec), HP
export const AA_BUILD_TIME = 10;
export const AA_HP = 100;
export const AA_RADIUS = 200;
export const AA_DPS = 15;

export const DF_BUILD_TIME = 15;
export const DF_HP = 150;
export const DF_PRODUCTION_T = 12;      // sec between drone spawns

// Drone Net (per-road segment). Engineer trips raise the level; each level grants
// a finite "intercept" pool. Drones trying to attack troops on a netted road are
// shot down by the net instead, consuming one charge per drone.
export const NET_LEVEL_MAX       = 3;
export const NET_CHARGES_LEVEL   = [0, 20, 40, 60]; // capacity at level 0/1/2/3
export const NET_PICK_R          = 36;              // world-px tolerance when clicking near a road
export const WRECK_CLEAR_PER_ENG = 0.4;             // blockage reduced per engineer trip

// Tank / cannon — anti-ground (and anti-drone, anti-turret) generalist tower.
// Longer range than AA but lower DPS per target.
export const TANK_BUILD_TIME = 12;
export const TANK_HP = 130;
export const TANK_RADIUS = 240;
export const TANK_DPS = 8;

// Drone
export const DRONE_HP_AIR = 30;
export const DRONE_SPEED = 130;
export const DRONE_DAMAGE = 50;
// Drones now hunt enemy ground fleets they detect in flight.
export const DRONE_DETECT_R = 110;      // scan radius for nearby ground fleets
export const DRONE_HUNT_DMG = 18;       // damage to fleet on impact (less than fixed-target)
export const DRONE_HUNT_SWITCH_RATIO = 0.7;  // switch from primary→hunt only if hunt is this much closer

// Road blockage
export const BLOCKAGE_DECAY = 0.01;     // per second
export const BLOCKAGE_HEAVY = 0.8;      // threshold for dashed-red visualization
export const BLOCKAGE_PER_WRECK = 0.35; // amount added when a drone hits

// ---- NN integration ----
export const NN_OWNERS = new Set(['red']);
export const NN_MODEL_URL = 'cell_policy.onnx';
export const NN_N = 40;
export const NN_F = 21;
export const NN_HIDDEN = 96;

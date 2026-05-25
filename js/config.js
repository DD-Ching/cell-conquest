// =====================================================
// All gameplay & system constants — tune here.
// Nothing in this file depends on DOM, state, or other modules.
// =====================================================

// ---- World ----
// Smaller arena → fewer nodes, faster decisive fights.
export const WORLD_W = 1600;
export const WORLD_H = 1200;
export const N_NODES_MIN = 10;
export const N_NODES_MAX = 16;

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

export const NET_BUILD_TIME = 8;
export const NET_HP = 80;
export const NET_DAMAGE_MULT = 0.2;     // drone damage multiplier on protected node

// Drone
export const DRONE_HP_AIR = 30;
export const DRONE_SPEED = 130;
export const DRONE_DAMAGE = 50;

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

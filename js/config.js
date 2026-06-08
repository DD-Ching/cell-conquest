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
//
// These four are `let` exports so `js/game-presets.js` can re-bind them at
// boot via the setters below. ESM live bindings mean every importing module
// (world.js, camera.js, render-*, main.js, …) sees the updated value
// automatically — no need to plumb arguments through. See game-presets.js
// header for the full story and known limitations (render-worker.js runs
// in a separate module graph and won't see the mutation, so presets that
// change WORLD dims are incompatible with ?renderWorker=1).
export let WORLD_W = 12000;
export let WORLD_H = 9000;
export let N_NODES_MIN = 700;
export let N_NODES_MAX = 900;

/** Override world size. Call BEFORE newGame() — already-generated state
 *  (cameras, baked terrain, scorch buffers) won't redo themselves. */
export function setWorldDims(w, h) {
  WORLD_W = w;
  WORLD_H = h;
}
/** Override node-count target. Call BEFORE newGame(); world.js samples
 *  these at placeNodes() time. */
export function setNodeRange(min, max) {
  N_NODES_MIN = min;
  N_NODES_MAX = max;
}

// ---- Procedural map generation (?procgen=1) ----
// Geography-first generator (worldgen.js): the map is built in region → node →
// road layers instead of a uniform scatter. Opt-in via URL flag, default OFF so
// the legacy world.js path stays the baseline. Region count scales the theatre's
// macro structure (more regions = more distinct clusters / chokepoints).
export const PROCGEN_REGIONS_MIN = 8;
export const PROCGEN_REGIONS_MAX = 15;

// ---- Cartographic view modes (V key cycles) ----
// The map can be drawn at four "view philosophy" levels. All but 'debug' are
// cartographic (curved roads + geography-first + minor nodes demoted by
// importance); 'debug' restores the raw graph (straight edges, every node +
// number drawn equally) for diagnostics.
export const MAP_MODES = ['cinematic', 'strategic', 'detailed', 'debug'];

// ---- Movement ----
export const FLEET_SPEED = 95;          // troop fleets, world px/sec
export const PAN_SPEED = 1800;          // camera key-pan speed (bumped for big map)
export const EDGE_PAN_SPEED = 1400;     // edge-of-screen pan speed
export const EDGE_PAN_MARGIN = 28;
export const ZOOM_MIN = 0.1;            // allows whole-world overview (1920×1000 canvas / 12000×9000 world ≈ 0.11 fit)
export const ZOOM_MAX = 2.2;

// ---- Territory floor tint (late-game turf shading) ----
// A faction-coloured wash painted on the GROUND beneath connected friendly
// nodes so an established empire reads as owned turf ("領土" feel). Baked once
// into a small fixed-size offscreen buffer and re-baked only when ownership
// changes — see render-territory.js. Memory is independent of WORLD size:
// TERRITORY_TEX_MAX² · 4 bytes ≈ 4 MB worst case, same on a 12000×9000 theatre
// as on a tiny arena.
export const TERRITORY_TEX_MAX    = 1024;  // longest-side px of the bake buffer
export const TERRITORY_MAX_ALPHA  = 0.20;  // opacity once fully settled
// Fade driver = fraction of the map that's been claimed (a self-calibrating
// "the game has settled" proxy that holds at any speed / game length). Below
// START the wash is invisible (early/mid game); it ramps to full by FULL.
export const TERRITORY_FADE_START = 0.45;
export const TERRITORY_FADE_FULL  = 0.85;
// Footprint sizing, as multiples of the median same-owner edge length so the
// wash fills the gaps between nodes at any map density.
export const TERRITORY_NODE_R_MUL = 0.55;  // disc radius = medLen·this (+ node.size)
export const TERRITORY_EDGE_W_MUL = 0.60;  // connector width = medLen·this

// ---- Time / speed presets ----
// 30× / 40× are fast-forward gears for late-game grinds. They cost the SAME
// per-frame sim budget as 20× — the sub-step loop in main.js is capped at 10
// steps, so a higher timeScale just advances more game-time per sub-step
// (coarser integration) rather than running more sub-steps. Keys 1-5 hit the
// first five; 6→30×, 7→40×; [ ] step through all of them.
export const SPEEDS = [1, 2, 5, 10, 20, 30, 40];

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
// Anti-air firepower — 30× the original 15. The ×100 (1500) bump shredded drones
// instantly and felt too strong, so the last ×10 was dialled back to ×3 off the
// 150 baseline → 450. Still a solid swarm counter without being an instant-kill
// no-fly zone. AA splits this DPS across all drones in range (saturation), so
// this is total drone-HP/sec per battery: a lone 30-HP drone dies in ~0.07 s; a
// swarm of N each takes 450/N DPS → the whole swarm clears in ~N/15 s. Pure
// constant — read by both the wasm batch path and the JS fallback, so ZERO extra
// per-frame work (faster kills → fewer live drones → if anything LESS sim load).
//
// Dialed DOWN from 450: at 450 AA still felt too strong, so per the player it's
// cut to 2/5 → 180 (12× the original 15). A lone drone (30 HP) still dies in
// ~0.17 s, but a swarm divides the fire down (N drones → 180/N each) so a real
// mass can now push some drones through — a counter, not an instant no-fly zone.
export const AA_DPS = 180;

export const DF_BUILD_TIME = 15;
export const DF_HP = 150;
export const DF_PRODUCTION_T = 5;       // sec between drone spawns (fast — many factories build a real swarm)
export const FACTORY_MAX_STOCKPILE = 20; // max held drones per factory while Hold-Fire is on
                                         // (high so both the player's alpha-strike and the AI's
                                         // stalemate stockpile can amass a real wall of drones)

// Drone Net (per-road segment). Engineer trips raise the level; each level grants
// a finite "intercept" pool. Drones trying to attack troops on a netted road are
// shot down by the net instead, consuming one charge per drone.
export const NET_LEVEL_MAX       = 3;
export const NET_CHARGES_LEVEL   = [0, 20, 40, 60]; // capacity at level 0/1/2/3
export const NET_PICK_R          = 36;              // world-px tolerance when clicking near a road
// Net-engineer trip removes this many wreck piles from the targeted edge.
// (Idle engineers stationed at a node clear piles continuously at ENG_CLEAR_RATE.)
export const NET_ENG_WRECK_CLEAR = 2;

// Tank FACTORY (the 'tank' building). Static depot the player/AI places like any
// other turret, but it does NOT fire — instead it periodically rolls out a mobile
// tank UNIT (see the mobile-tank block below). TANK_BUILD_TIME/TANK_HP are the
// factory's build time + hull HP. TANK_RADIUS is kept because the AI build/threat
// heuristics (ai-build.js, ai-tactical.js) still read it as a generic "tank zone"
// proximity; TANK_DPS is retained for back-compat (the old static-turret combat is
// gone — combat.js no longer has updateTanks; tanks.js owns tank fire now).
export const TANK_BUILD_TIME = 12;
export const TANK_HP = 130;
export const TANK_RADIUS = 240;
export const TANK_DPS = 8;

// ---- Mobile tank (the unit a tank factory produces) ----
// A tank is a GROUND fleet (kind:'tank') that auto-advances along the road graph
// toward the nearest non-allied node — capturing neutral land and smashing into
// enemy hubs — and guns down enemy ground fleets / sieges enemy buildings en
// route. Movement rides fleets.simulateFleets (so tanks inherit wreck-detour +
// curved roads); tanks.js owns production, weapons, and the arrival bombard-siege.
//
// A tank's `units` field IS its HP pool: every existing unit-damage path (drone
// hunt, artillery AOE, enemy-tank fire) chips it, and it never merges into a node
// garrison (arrival triggers a siege instead). A tank killed ON A ROAD leaves a
// 6×-HP "death-road" hulk (TANK_WRECK_HP_MUL) that takes engineers ~6× as long to
// clear — exactly the heavy-roadblock the design calls for.
export const TANK_FACTORY_PRODUCTION_T = 18;  // sec between tank roll-outs per factory
export const TANK_CAP_PER_FACTORY      = 4;   // max LIVE tanks per owned tank factory
export const TANK_UNIT_HP    = 220;  // tank health, stored in fleet.units (tough vs drone swarms)
export const TANK_UNIT_SPEED = 60;   // px/sec — heavy, slower than troops (FLEET_SPEED 95)
export const TANK_UNIT_RANGE = 210;  // engage radius for en-route fire (enemy fleets + turrets)
export const TANK_UNIT_DPS_FLEET  = 22;   // dmg/sec to enemy ground fleets in range (incl. tank-vs-tank: bumped so duels actually read)
export const TANK_UNIT_DPS_TURRET = 11;   // dmg/sec to enemy turrets in range (siege)
// Node suppression is RANGED cannon fire, not a melee drain: a tank HALTS the
// moment its target node enters TANK_NODE_RANGE, then lobs a shell every
// TANK_NODE_FIRE_INTERVAL seconds (a cooldown), each removing a fixed chunk of
// garrison. Effective DPS = SHELL_DAMAGE / FIRE_INTERVAL = 26/2.6 ≈ 10/s —
// matched to the old continuous 10/s so prior balance holds; it just reads as
// bombardment instead of a drain. RANGE (280) > the en-route fire radius (210)
// so nodes are the longest-reach engagement ("遠距離開炮"). All three are the
// damage⇄fire-rate knobs the player flagged — tune here.
export const TANK_NODE_RANGE         = 280;  // halt + open fire when node is within this
export const TANK_NODE_FIRE_INTERVAL = 2.6;  // sec between cannon shots at a node (cooldown)
export const TANK_NODE_SHELL_DAMAGE  = 26;   // garrison removed per shell
export const TANK_NODE_RETALIATE  = 0.10; // node fires (garrison × this)/sec back at the besieging tank
// Tanks SUPPRESS, they don't CAPTURE — combined arms: a tank grinds a node's
// garrison down to this floor, then rolls on to the next frontier instead of
// flipping ownership. Taking the ground is infantry's job (send a troop column
// in behind the tanks). A node bombed to/below this is treated as "suppressed"
// and skipped by the tank target picker, so tanks push toward live resistance
// rather than re-hammering an already-cleared husk.
export const TANK_SUPPRESS_UNITS  = 5;
export const TANK_SIEGE_RECHECK_T = 3.0;  // sec between idle-tank target re-scans
export const TANK_WRECK_HP_MUL    = 6;    // a road-killed tank's wreck pile gets this × normal HP

// Artillery — long-range area cannon. Built by an engineer (like AA), but
// fires AOE shells that are INACCURATE — random within a wobble circle. So
// stacking many turrets at one spot becomes a vulnerability: one lucky
// shell wipes the whole cluster. Counters dense defenses.
export const ARTILLERY_BUILD_TIME    = 20;
export const ARTILLERY_HP            = 120;
export const ARTILLERY_RANGE         = 2520;  // 6× the old 420 — true long-range bombardment that reaches deep
// Minimum range (dead zone): artillery is a HIGH-ARC bombard, so it can't hit
// anything too close — targets inside this radius are safe from it (the player
// asked for "not 0→100, more like 30→100"). ~28% of max range → a real close-in
// blind spot you can exploit by closing the distance. Gated in combat.js.
export const ARTILLERY_MIN_RANGE     = 700;
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
// Turn radius (world px) for drone flight: drones bank toward their target at a
// bounded turn rate (ω = DRONE_SPEED / radius) instead of snapping direction, so
// they fly curved approaches and arc into wide circles when they overshoot —
// the orbit emerges near the target, no separate loiter math needed. The radius
// tightens as a drone closes in (so the terminal dive always connects).
export const DRONE_TURN_RADIUS = 180;
// Drone swarm sizing. The airborne ceiling scales with how many factories you
// build (cap = DRONE_CAP_PER_FACTORY × your factory count), so factory
// investment ALWAYS buys a bigger swarm — there is NO flat per-faction wall.
// (The old DRONE_CAP_PER_FACTION=150 was a flat ceiling: 1 factory or 20, you
// hit 150 and stopped — extra factories were pointless. Removed.) The per-
// factory value is generous so it only acts as a runaway-FPS safety valve at
// extreme scale, never a normal-play handicap. DRONE_MAX_LIFETIME still culls
// drones that wander too long without engaging.
export const DRONE_CAP_PER_FACTORY = 50;      // airborne ceiling PER owned factory
export const DRONE_WAVE_SIZE       = 4;       // factory accumulates this many, then
                                              // launches them together → rolling waves
export const DRONE_MAX_LIFETIME    = 360;     // game-seconds; expires past this
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

// ---- VFX FIFO caps ----
// Hard ceilings on the cosmetic-only ephemeral arrays. Spawn sites are
// intentionally unbounded — explosions, salvos, and burst events shouldn't
// have to second-guess whether their effect will appear. Instead, each
// update loop trims the array down to its cap before iterating, dropping
// the OLDEST entries first (FIFO). Caps protect frame time and the
// per-frame view-cull cost on big mid-late-game battles; under normal
// play the arrays sit well below these numbers.
export const PARTICLE_CAP = 1500;
export const TRACER_CAP   = 500;
export const SHELL_CAP    = 100;

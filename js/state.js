// =====================================================
// Single mutable game-state object. All other modules
// import this and mutate fields directly.
//
// Rationale: ES modules support live bindings, but only
// for `let`-exported identifiers re-assigned in their
// own module. A shared mutable object is the cleanest
// way to share evolving game state across modules.
//
// DOM canvases / contexts are populated by main.js after
// DOMContentLoaded; until then they are null.
// =====================================================

export const state = {
  // DOM (set by main.js)
  canvas: null,
  ctx: null,
  minimap: null,
  mctx: null,
  W: 0,
  H: 0,

  // Game data
  nodes: [],
  fleets: [],
  particles: [],
  dust: [],                  // atmospheric Mars dust (was 'snowflakes')
  terrain: [],               // world-space ground features: rocks, craters, sand patches
  tracers: [],               // AA-fire tracer beams: {x1,y1,x2,y2,age,maxAge,color}
  shells: [],                // artillery shells in flight: {x1,y1,x2,y2,t,maxT,owner}
  scorches: [],              // ACTIVE burn marks (still burning + emitting embers).
                             // {x,y,r,age,maxAge,kind,sparkAcc,rot}. Purely cosmetic —
                             // NEVER queried by AI, pathing, or collision. When an
                             // entry's life expires it is BAKED onto groundScorch
                             // (below) and removed from this array, so the array
                             // length stays small no matter how long the game runs.
  groundScorch: null,        // OFFSCREEN canvas storing every "settled" burn mark
                             // for the rest of the match. Half-res relative to the
                             // world (WORLD_W/2 × WORLD_H/2 ≈ 4 MB) so memory stays
                             // bounded — old burns never accumulate as JS objects.
  groundScorchCtx: null,
  bakedTerrain: null,        // OFFSCREEN canvas baked once after placeTerrain.
                             // Each frame we drawImage this single 17 MB texture
                             // instead of replaying ~6000 ctx ops to redraw the
                             // sand patches / craters / rocks. Static — only
                             // re-baked when newGame regenerates terrain.
  turrets: [],               // world-coord buildings: {id,owner,type,x,y,hp,hpMax,active,progress,total,prodCooldown,engineers}
  placeMode: null,           // {type:'antiair'|'factory'|'tank'|'net', byOwner:'player'}; 'net' targets a road segment (not world point)
  roads: [],
  adj: new Map(),
  edgeData: new Map(),       // ekey(a,b) -> { wrecks, netLevel, netCharges, netOwner }
                             //   wrecks: [{x,y,hp,hpMax,rot}] — physical piles on
                             //   the road segment. Fleets detour around them; engineers
                             //   chip away at hp until pile is removed.
  selectedIds: new Set(),
  _nextFleetId: 1,           // monotonic; lets drones lock onto a specific fleet by id

  // Per-tick id-lookup caches. Rebuilt at the top of simulate() so any hot
  // path that needs "give me X by id" is an O(1) Map.get instead of an O(N)
  // array.find / .some. Stale only between simulate() calls — never used
  // outside the sim window.
  turretById:     new Map(), // id -> turret
  turretsByOwner: new Map(), // owner -> turret[] — used by AI hub-loop so each
                             //   hub iterates only its own turrets instead of
                             //   filtering the whole array 5 times per tick.
  turretsByType:  new Map(), // type ('antiair'|'tank'|'factory'|'artillery') ->
                             //   turret[]. Combat firing loops iterate only the
                             //   right type instead of scanning all turrets per
                             //   sim sub-tick (60×subSteps Hz at high time-scale).
  turretGrid:     new Map(), // (cellX*10000 + cellY) -> turret[] — uniform 250-px
                             //   spatial grid. Lets "every turret near (x,y)
                             //   within R" queries (tank siege, artillery AOE,
                             //   drone retarget) check ~9 cells instead of all
                             //   turrets. Cell size chosen so a TANK_RADIUS=240
                             //   query touches a 3×3 cell window.
  droneGrid:        new Map(), // cellKey -> drone fleet[] — same 250-px grid.
                             //   Rebuilt at sim-tick top because fleets move.
                             //   AA fire scans only the cells near each AA.
  groundFleetGrid:  new Map(), // cellKey -> ground fleet[] — drone hunt + tank
                             //   damage queries use this to skip out-of-range
                             //   ground fleets.
  fleetById:      new Map(), // _id -> fleet (alive fleets only — built before
                             //               drone/fleet death cleanups)
  droneCountByOwner: new Map(), // owner -> # currently airborne drones.
                             //   Read by factory tick to gate drone spawn at
                             //   DRONE_CAP_PER_FACTION. Rebuilt per sim tick
                             //   alongside the other entity buckets.

  // Camera / view
  cameraX: 0,
  cameraY: 0,
  zoom: 1.0,

  // Input
  drag: null,
  middlePan: null,
  mouseScreen: { x: 0, y: 0 },
  mousePos: { x: 0, y: 0 },
  panKeys: { up: false, down: false, left: false, right: false },

  // Player Hold-Fire toggle: when true, player's drone factories stop launching
  // and accumulate `dronesReady` instead. Toggling off launches the whole salvo.
  holdFire: false,
  // Designated salvo target while Hold-Fire is on. Click an enemy turret or
  // node during Hold-Fire to mark it; on release, ALL stockpiled drones go
  // there. null = auto-target via the usual scoring.
  salvoTarget: null,

  // Drag-paint state while in placeMode — sweep the mouse to lay down a row
  // of turrets / nets without clicking N separate times. Cleared on mouseup.
  painting: null,

  // Per-AI salvo state. Mirrors the player's holdFire/salvoTarget pair but
  // keyed by faction owner so each enemy stockpiles its drones independently
  // and releases them as a single saturation strike (the player's H trick).
  // - aiHoldFire[owner]: true while owner's factories accumulate dronesReady
  // - aiSalvoT0[owner]: state.elapsed when this stockpile began (for max-age release)
  // - aiSalvoTarget[owner]: { kind, id, x, y } | null — focus target on release
  aiHoldFire: {},
  aiSalvoT0: {},
  aiSalvoTarget: {},
  // Per-AI strategic focus — the node currently being attacked. Persists
  // across ticks so drone salvos, ground waves, and assaults all converge
  // on the same hub instead of dispersing across re-evaluations. Cleared
  // when target falls into owner's hands, becomes overdefended, or ages out.
  aiFocus: {},

  // Time
  gameOver: false,
  paused: false,             // Space toggles. Render + HUD keep running; sim,
                             // AI, particles, and elapsed clock are frozen.
  // Rolling perf samples shown in the HUD so wasm / optimisation changes
  // are visible without DevTools. Each is a small circular buffer; the
  // HUD reads avg() at 10 Hz. _perfIdx is the write head.
  _perfFrameMs: new Float32Array(60),   // last 60 wall-clock frame durations
  _perfSimMs:   new Float32Array(60),   // last 60 simulate() block durations
  _perfIdx: 0,
  startTime: 0,
  elapsed: 0,
  lastTime: 0,
  timeScale: 1.0,
  aiTimers: {},
};

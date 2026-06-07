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
  dust: [],                  // atmospheric Mars dust (foreground layer)
  dustFar: [],               // parallax background dust — half density, half
                             //   speed, smaller particles. Drawn BEHIND state.dust
                             //   so foreground grit occludes the far layer.

  // Mars weather — slow lerp between calm / haze / sand storm. Visual only;
  // never read by AI, pathing, or combat. Cadence: a new target is picked
  // roughly every 60 game seconds; intensity glides toward it over ~10 s.
  //   intensity: 0..1, current haze strength
  //   target:    0..1, where intensity is heading
  //   lastChangeT: state.elapsed at last target pick
  weather: { intensity: 0, target: 0, lastChangeT: 0 },
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
  regions: [],               // procgen: [{id,x,y,type,radius,value,danger}] — empty in legacy gen
  barriers: [],              // procgen: [{kind:'river'|'mountain'|'canyon',points:[{x,y}]}] — terrain that forces chokepoints
  worldTheme: null,          // procgen v2: {key,name,pal,nameStyle,...densities} — the world's climate/setting
  resourceBelts: [],         // procgen v2: [{kind:'mineral'|'energy'|'rare',x,y,r}] — drive node types
  geoGrid: null,             // procgen v2: {GW,GH,seaLevel,ridgeLevel,elev:[...]} — coarse elevation for render shading
  worldSummary: null,        // procgen v2: validation/summary object (logged at gen time)
  worldSeed: 0,              // procgen deterministic seed (0 = legacy random gen)
  worldThemeKey: null,       // procgen v2: forced world theme from ?world=<key> (null = seeded pick)
  procgen: false,            // geography-first generator (default ON; ?procgen=0 → legacy)
  adj: new Map(),
  edgeData: new Map(),       // ekey(a,b) -> { wrecks, netLevel, netCharges, netOwner }
                             //   wrecks: [{x,y,hp,hpMax,rot}] — physical piles on
                             //   the road segment. Fleets detour around them; engineers
                             //   chip away at hp until pile is removed.
  wrecksByEdge:   new Map(), // ekey(a,b) -> { projs: Float32Array, perps: Float32Array,
                             //   segLen: number, aId: number, bId: number }
                             //   Per-tick spatial cache for the fleet detour scan
                             //   (fleets.js). `projs` is sorted along the canonical
                             //   direction (from low-id node to high-id node, so
                             //   aId < bId); `perps` stores the matching signed
                             //   perpendicular offset in the canonical frame. Built
                             //   only for edges with wrecks. Lets simulateFleets
                             //   binary-search "nearest wreck ahead on my segment"
                             //   in O(log W) instead of O(W) per fleet sub-step.
                             //   Rebuilt inside simulateFleets's prologue.
  selectedIds: new Set(),
  _nextFleetId: 1,           // monotonic; lets drones lock onto a specific fleet by id

  // Per-tick id-lookup caches. Rebuilt at the top of simulate() so any hot
  // path that needs "give me X by id" is an O(1) Map.get instead of an O(N)
  // array.find / .some. Stale only between simulate() calls — never used
  // outside the sim window.
  // Turret-derived caches (turretById/ByOwner/ByType/Grid) only change when the
  // turret SET changes: turrets never move (x/y fixed) and never change owner, so
  // a rebuild every sub-step (20×/frame at 40×) re-derives an identical result.
  // simulate() rebuilds them only when this flag is set; engineering.js raises it
  // on every turret add / remove / reset. Starts true so the first tick builds.
  _turretCacheDirty: true,
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
                             //   DRONE_CAP_PER_FACTORY × (owner's factory count).
                             //   Rebuilt per sim tick alongside the other buckets.
  inboundDronesByTarget: new Map(), // `${kind}:${id}` -> count of drones whose
                             //   current target is this entity. Stops factories
                             //   from piling MORE drones on a target that already
                             //   has overkill in flight ("drone black hole").
  strippedOwners: new Set(), // owners with zero active production turrets AND
                             //   tiny total units. Their bases regen-and-die
                             //   in 1010-oscillation; ground troops will mop
                             //   them up. Suicide drones must judge these as
                             //   NOT-worthwhile targets — otherwise A and B's
                             //   drones funnel into dying C instead of each
                             //   other. Rebuilt per sim tick.

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

  // Lifecycle phase. 'spawnSelect' = the opening beat where the world is
  // generated, NPCs have claimed their home towns, and the player is choosing
  // their OWN starting node (sim frozen, fog off so they can scout). 'playing'
  // = normal game. newGame() enters spawnSelect; commitPlayerSpawn() flips to
  // playing. Default 'playing' so any code path that forgets to set it behaves
  // like the old always-running game.
  phase: 'playing',          // 'spawnSelect' | 'playing'
  spawnCandidates: [],       // node ids the player may pick as their capital
                             //   during spawnSelect (rendered as pulsing rings)
  // Onboarding coachmark: true from commitPlayerSpawn until the player's first
  // send (fleets.sendFleet clears it). Drives render-tutorial.drawFirstMoveHint.
  firstMoveHint: false,

  // Time
  gameOver: false,
  timeLimit: 0,              // seconds; >0 = match resolves on territory when
                             // reached (set per preset at boot). 0 = no limit.
  numOpponents: 1,           // enemy AI count (set at boot; 0 = random 1-4).
  paused: false,             // Space/P toggles. Render + HUD keep running; sim,
                             // AI, particles, and elapsed clock are frozen.
  // Rolling perf samples shown in the HUD so wasm / optimisation changes
  // are visible without DevTools. Each is a small circular buffer; the
  // HUD reads avg() at 10 Hz. _perfIdx is the write head.
  _perfFrameMs: new Float32Array(60),   // last 60 wall-clock frame durations
  _perfSimMs:   new Float32Array(60),   // last 60 simulate() block durations
  _perfRenderMs: new Float32Array(60),  // last 60 main-thread render() durations
                                        //   (~0 when the render worker owns the
                                        //   canvas — that IS the offload signal)
  _perfIdx: 0,
  // Per-phase sim profiling (opt-in via ?perf → toggled by the harness through
  // _perfPhaseOn). Each is a running sum of milliseconds; _pFrames counts frames
  // since the last reset, so avg-per-frame = sum / _pFrames. Zero overhead when
  // _perfPhaseOn is false (the timers are skipped). Reset by the harness.
  _perfPhaseOn: false,
  _pSumCache: 0, _pSumCombat: 0, _pSumDrones: 0, _pSumFleets: 0, _pFrames: 0,
  startTime: 0,
  elapsed: 0,
  lastTime: 0,
  timeScale: 1.0,
  aiTimers: {},

  // True when aiTick is running on a Web Worker (Y-key toggle). Used by
  // ai-worker-bridge for state, and by the HUD perf overlay to label
  // the source of the AI cost. See AI_WORKER_BLUEPRINT.md.
  aiInWorker: false,
  // True when the world canvas has been transferred to the Render Worker
  // (U-key toggle). main render() must skip when true (canvas surface
  // now lives in the worker). HUD + minimap stay main-thread.
  renderInWorker: false,

  // Cartographic view mode (V cycles). 'cinematic' | 'strategic' | 'detailed'
  // | 'debug'. Cartographic modes bend roads + demote the swarm of minor nodes
  // so the geography reads as a map; 'debug' restores the literal straight-edge,
  // all-nodes-equal graph for diagnostics. Shipped in the render snapshot so the
  // render worker honors it too.
  mapMode: 'cinematic',

  // ---- Fog of war (Pillar 2) ----
  // Coarse vision grid over the world. `seen` is sticky (ever-explored);
  // `vis` is recomputed each fog tick (currently visible). Both are flat
  // Uint8Arrays of gw*gh, indexed [cy*gw + cx]. Built lazily by fog.js
  // ensureFog() on first use / world change. Render reads them; sim never
  // does (player fog is render-only + outcome-neutral). cell = world px per
  // cell. fogReveal=false during spawnSelect (whole map visible to scout).
  fog: null,                 // { gw, gh, cell, seen:Uint8Array, vis:Uint8Array } | null
  fogReveal: false,          // true once playing — gates drawFog + recompute
  _fogLastT: 0,              // perf.now() of last recompute (throttle ~8 Hz)

  // ---- Day/night ambiance (Pillar 4, visual only) ----
  // Slow 0..1 phase advanced on REAL time (never game time → never read by
  // sim/AI). 0=dawn, 0.25=noon, 0.5=dusk, 0.75=night. drawBackground tints by
  // it. Pure cosmetic.
  dayPhase: 0.18,

  // AI fog (Pillar 3): when true, NPCs only act on enemies their own nodes /
  // fleets can see (ai-context.js gates elimination + the phase target pickers
  // via ctx.canSeeNode). ?aifog=0 sets this false → omniscient AI (debug / A-B).
  aiFog: true,
};

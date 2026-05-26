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

  // Time
  gameOver: false,
  startTime: 0,
  elapsed: 0,
  lastTime: 0,
  timeScale: 1.0,
  aiTimers: {},
};

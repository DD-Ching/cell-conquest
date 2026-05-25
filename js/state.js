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
  turrets: [],               // world-coord buildings: {id,owner,type,x,y,hp,hpMax,active,progress,total,prodCooldown,engineers}
  placeMode: null,           // {type:'antiair'|'factory'|'tank'|'net', byOwner:'player'}; 'net' targets a road segment (not world point)
  roads: [],
  adj: new Map(),
  edgeData: new Map(),       // ekey(a,b) -> { blockage, netLevel, netCharges, netOwner }
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

  // Time
  gameOver: false,
  startTime: 0,
  elapsed: 0,
  lastTime: 0,
  timeScale: 1.0,
  aiTimers: {},
};

# Gameplay Overhaul — toward a shippable Mars Front

Goal (user, 2026-06): make the game actually *playable* and prep for release.
Four pillars, ordered by dependency. Each ships to `dev` independently and is
verified with real Playwright numbers before moving on.

## Pillar 1 — Spawn-town selection (foundational; changes newGame flow)

**What:** At game start the map generates, NPCs claim spread-out home towns, then
the player picks their own starting node by clicking it. Game begins from there.

**Design:**
- New lifecycle field `state.phase: 'spawnSelect' | 'playing'` (default begins in
  spawnSelect). `state.gameOver` unchanged.
- Split `newGame()` in main.js:
  - `setupWorld()` — roll factions, gen world, NPCs claim capitals (reuse
    `pickRegionStarts` / farthest-point), compute a set of **candidate** player
    spawns (high-value neutral nodes, far from every NPC capital), set
    `state.phase='spawnSelect'`, leave the player capital UNassigned.
  - `commitPlayerSpawn(node)` — apply player capital stats at the chosen node,
    descend the fog, center camera, `state.phase='playing'`, start clock.
- During spawnSelect: sim is frozen (loop already gates on `!gameOver && !paused`;
  add `&& state.phase==='playing'`). Whole map is visible (fog not yet active) so
  the player can scout before committing.
- Input: in spawnSelect, a left click on a candidate node calls
  `commitPlayerSpawn`. Other input (pan/zoom) still works; combat input gated off.
- Render: a spawnSelect overlay — "Choose your starting town" + pulsing rings on
  candidate nodes. New layer in render-overlays.js, gated on `state.phase`.
- Files: `js/main.js`, `js/input.js`, `js/state.js`, `js/render-overlays.js`,
  `js/worldgen.js` (candidate picker), `node-conquest.html` (overlay text).

## Pillar 2 — Fog of war: RENDER (player vision; outcome-neutral for sim)

**What:** Map starts black. Owned nodes + your fleets reveal a radius around them.
Three states: unseen (black), explored-but-not-visible (dimmed/remembered),
currently-visible (clear).

**Design:**
- New `js/fog.js`: a coarse vision grid (cell ~64px over WORLD_W×WORLD_H).
  - `state.fog = { gw, gh, cell, seen: Uint8Array, vis: Uint8Array }`.
    `seen`=ever-explored (sticky), `vis`=currently visible (recomputed).
  - `recomputeFog(owner)` (player): clear `vis`; for each owned node + each fleet
    of an allied owner, stamp a filled disc of its vision radius into `vis` and
    OR into `seen`. Throttled to ~6–10 Hz (not per sub-step) — vision doesn't
    need 60Hz and it's pure render input.
  - Vision radii in config: `VISION_NODE`, `VISION_FLEET`, `VISION_CAPITAL`.
- New `js/render-fog.js`: `drawFog(ctx, zoom)` — paints a full-screen dark veil,
  punching clear holes where `vis`, half-dark where `seen && !vis`. Bilinear-ish
  soft edges via a downscaled offscreen mask scaled up (cheap, classic trick).
- Wire: render.js calls drawFog after entities, before vignette. Snapshot the
  fog mask to the render worker (ship the small Uint8Arrays in buildSnapshot;
  add to snapshot-utils). Worker draws identically.
- Entities under fog: nodes/fleets in unseen cells are NOT drawn (and in
  explored-not-visible, drawn as last-known dim ghost for nodes only — fleets
  vanish). This is a render-time cull; sim still simulates everything.
- Files: new `js/fog.js`, `js/render-fog.js`; edit `js/render.js`,
  `js/render-worker.js`, `js/render-worker-bridge.js`, `js/snapshot-utils.js`,
  `js/config.js`, `js/main.js` (call recomputeFog in loop), `js/state.js`.

## Pillar 3 — Fog of war: AI vision (real mechanic change; the user wants this)

**What:** NPCs also can't see the whole map; they only act on what their own
nodes/fleets reveal.

**Design:**
- Per-AI vision grid (or a cheaper per-AI "visible node id set" recomputed each
  AI tick — AI only needs node/fleet visibility, not pixels).
- `buildContext(owner)` gains `visibleEnemyNodes` / `visibleEnemyFleets`: the AI's
  target scans (elimination, coordinated attack, threat) only consider enemy
  entities within its vision. Fall back to "explored" memory for static nodes
  (it remembers a town it once saw) but not for fleet positions.
- Tunable: give AI a slightly larger base vision so it isn't trivially blind
  (balance pass). Keep the player-vs-AI symmetry honest.
- Risk: this is the one balance-changing piece. Verify the AI still expands and
  fights (doesn't freeze blind). A/B with a `?aifog=0` escape hatch.
- Files: `js/ai-context.js`, `js/ai-*.js` (target scans), `js/fog.js` (shared
  grid), `js/config.js`.

## Pillar 4 — Day/night ambiance (pure background visual; lowest priority)

**What:** Slow color/light cycle as atmosphere. NOT a mechanic (explicitly).
- A slow global phase `state.dayPhase` (0..1) advancing on real time.
- render-atmosphere drawBackground tints sky/ground warm→cool→warm; maybe a
  long shadow direction hint. Zero gameplay effect; never read by sim/AI.
- Files: `js/render-atmosphere.js`, `js/state.js`.

## Pillar 5 — Shippable polish (start menu + flow)

- Start screen: title, "New Game", brief how-to, preset/theme picker hookup.
- Make spawnSelect the natural first beat after "New Game".
- Pause/restart flow, ensure the goal/victory screens read well.
- Files: `node-conquest.html`, `js/main.js`.

## Verification per pillar
- `node --check` every touched .js.
- Playwright: boot `?perf=1&seed=12345`, confirm no NEW console errors (favicon +
  nn.js 404 are pre-existing/benign), drive `state` to exercise the feature,
  screenshot for visual confirmation.
- Fog/AI: assert outcome-neutral where claimed (render fog must not alter sim);
  for AI fog, confirm the AI still captures nodes over 60s of sim.
- Commit each pillar to `dev`; merge to `main` only on explicit user confirm.

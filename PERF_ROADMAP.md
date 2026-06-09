# Mars Front — Performance Roadmap / Blueprint

Small blueprint for the perf work. Order agreed with the user:
**combat → WASM  →  H-salvo spike fix  →  (big project) WebGPU compute.**
Do NOT start implementing yet — this is the plan.

## Measured baseline (real numbers, foreground `?perf` tab)
The **sim** is the bottleneck, not render (render ≈ 2.4 ms).
At ~3,600 fleets / ~1,200 turrets, 40× speed, sim ≈ **105 ms**:

| phase | ms/frame |
|---|---|
| **combat (AA+tank+arty+shells)** | **~52 (dominant)** |
| drones (steer + hunt) | ~14 |
| AI strategy + production | ~26 |
| cache rebuild | ~6.7 |
| fleet movement | ~6.2 |

- **WASM (Rust `cell_sim`) is ON by default** and already does: AA damage, tank damage (application), drone hunt-targeting. WASM-off (Shift+W) ≈ +40 % combat.
- **Read the live combat split yourself:** open with `?perf`, watch the **console** — every ~3 s it logs
  `[perf]/frame combat Xms (AA .. tank .. arty .. shell ..) · drones .. · cache .. · fleetMove .. — F.. T..`.
  (A headless/background tab throttles `requestAnimationFrame`, so the split must be read on a real **foreground** tab. The per-combat-pass counters live in `state._pSumAA/_pSumTank/_pSumArty/_pSumShell`.)

## 1. Combat → WASM (the ~52 ms)
Already in WASM: AA damage, tank damage. Still **JS every combat sub-step** (the remaining cost):
- the **packing** of arrays shipped to WASM (O(turrets+fleets), runs many times per frame);
- **artillery** target clustering — `fireArtilleryShell` is **O(cands²)** (`combat.js`);
- **shells** (advance + AOE detonation scans);
- **tank** target-pick / siege.

Plan:
1. First read the live split (`?perf` console) to rank AA/tank/arty/shell, port the biggest.
2. Move the remaining passes into Rust; ideally **one batched WASM call per combat sub-step over a shared spatial grid** (build the grid once, reuse for AA + tank + arty) to kill the repeated packing.
3. Toolchain is present (`cargo` 1.93 / `wasm-pack` 0.15). Rebuild via `wasm/build.sh`; `wasm/pkg/` artifacts are committed.

## 2. H-salvo spike (press-H-to-launch stutter — NOT combat)
**Confirmed cause** (`drones.releasePlayerStockpile`): on release it sets `_nextDecisionT = 0` on **every** player drone, so the next tick **all ~82 k drones run `retargetDrone` (O(nodes) each) at once** → a one-tick spike, before AA engages.

Fixes:
- **Quick / low-risk:** stagger the release — `_nextDecisionT = elapsed + rand(0..~1.5 s)` so the 82 k retargets spread over a second instead of one frame.
- **Root:** cap/merge the held swarm — don't keep 80 k individual drone objects (the hold-fire overflow currently spawns one airborne loiterer each, unbounded). Cap meaningful drones and render the overflow as an aggregate "cloud" that deals lump damage. Also cuts steady-state cost and sets up WebGPU.

## 3. WebGPU compute (big project — true 100 k+ swarms, the "爽" endgame)
Goal: drone position/steer/hunt on GPU compute shaders so 10⁵+ drones fly at 60 fps.

Blueprint:
- **Data layout:** drones as struct-of-arrays in GPU buffers (x, y, heading, owner, target, hp…), not JS objects. The drone-SoA migration is the bulk of the work (state is plain objects + Maps today; no typed-array/SharedArrayBuffer layout yet).
- **Passes (WGSL compute):** (a) hunt/target via a GPU spatial grid; (b) steer + integrate position/heading; (c) impact vs turrets/nodes — read back only the sparse *kill events*, not all positions.
- **Render:** draw drones straight from the GPU buffer (instanced) — zero per-drone JS.
- **Combat interplay:** AA/tank damage must read the drone buffers, so this pairs with workstream #1 (combat off-CPU). Keep most state on the GPU; sync sparse events only.
- **Order:** after #1 and #2. Chrome has WebGPU.

## Also on the radar
- **Snowball cap** (balance *and* perf root): one faction reaching 677 nodes / 310 k units is the real driver of the worst frames. A turret-per-node cap + unit-stack merging bounds combat cost — cheapest structural win; pairs well with #2.

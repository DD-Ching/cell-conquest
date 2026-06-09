# Mars Front — Performance Roadmap / Blueprint (v2: NO caps → WebGPU)

**Direction (user-confirmed 2026-06-09):** NO unit caps — unlimited drones/units IS the point (過癮). The only way to get "unlimited AND smooth" is to move the high-count simulation onto the **GPU via WebGPU compute**. This **supersedes** the earlier "cap the swarm / cap the snowball" ideas — those are rejected (caps kill the feel).

Status: **blueprint only — NOT building yet** (start after the user's /compact). Locked decisions:
- **GPU scope:** high-count units (drones; tanks/troops if needed) + the combat damage *against* them. Nodes / AI / economy stay on CPU.
- **Rollout:** behind `?gpu=1` with the current CPU sim kept as fallback; default ON where WebGPU is supported.
- **Caps vs merge:** NO caps (unlimited is the point). BUT **merging units into commandable "strike groups" IS wanted** — that's not a limit, it's how you command mass. See the Command-layer section.

## What goes on the GPU vs stays on the CPU
"把一切變成 WebGPU" = move everything that is *numerous* to the GPU; keep the *strategic brain* on the CPU (the GPU is bad at branchy, low-count logic).
- **GPU (massively parallel, unbounded count):** drones — and tanks/troops if needed — their position/steering, target-hunt, and the combat damage *against* them.
- **CPU (low count, branchy):** nodes (~830), roads, AI strategy/economy, turret placement, captures, UI. Stays as-is.
- The **CPU↔GPU boundary** is the key design problem, not the shaders.

## Command layer: strike groups (MERGE, not cap)
This is a *feature*, and it's complementary to the GPU plan (not a limit):
- The CPU tracks a SMALL number of named **strike groups** — each is just a set of GPU-resident units sharing one order (target / move / hold). The GPU still simulates every individual; the group is only a command handle.
- So: **GPU = unlimited individuals; CPU = a handful of group orders.** You command "this strike group → that target" once; the GPU applies it to all members in parallel. No per-drone CPU command, no cap.
- Bonus: it makes the H-salvo trivially cheap (one group order vs 82k individual retargets) and gives the player a real RTS feel — select/merge a swarm, send it as one fist (指揮打擊群).
- The existing hold-fire stockpile + Lieutenant delegation are early seeds of this; the GPU rewrite formalises it.

## Why this kills BOTH the cap need AND the H-salvo spike
- No per-drone JS object ⇒ no O(F) CPU grid rebuild, no per-drone JS steering ⇒ F can be 100k+.
- The 82k hold-fire stockpile becomes just a big GPU buffer; releasing it = the GPU re-targets all of them in ONE parallel pass ⇒ the "press-H" stutter disappears, with no cap.

## Measured baseline (why the CPU path can't scale unbounded)
Sim is the bottleneck, not render (render ≈ 2.4 ms). At ~3,600 fleets / ~1,200 turrets, 40×: sim ≈ 105 ms — combat ≈ 52, drones ≈ 14, AI+production ≈ 26, cache ≈ 6.7, fleet-move ≈ 6.2. Every one of those is O(unit count) on the CPU, so "no cap" on the CPU = unbounded ms. GPU is the answer.
(Read the live combat split on a FOREGROUND `?perf` tab — console logs it every ~3 s.)

## Phased build — behind `?gpu=1`, with the current CPU path kept as fallback
(Matches this codebase's opt-in-experiment discipline: WASM Shift+W, AI worker Y, render worker U — lazy, fail-safe, default off until proven.)

- **P0 — Foundation.** WebGPU device init + feature-detect + clean fallback to the existing CPU sim. Define the drone buffers as **struct-of-arrays** (x, y, heading, owner, targetKind, targetId, hp, flags) in GPU storage buffers. Very-large / growable capacity (no cap).
- **P1 — Movement + render on GPU.** Port the `steerDrone` banking model to a WGSL compute pass; draw drones **instanced straight from the buffer** (bypass per-drone JS render). Targeting still CPU-assigned at first (batched writes into the buffer).
- **P2 — Hunt / targeting on GPU.** Build a GPU spatial grid; per-drone nearest-enemy scan as a compute shader (replaces the WASM hunt + the per-drone JS decision). **← this is what removes the H-salvo spike.**
- **P3 — Combat vs drones on GPU.** AA / tank / artillery damage over the drone buffer as compute; read back only a compact **kill-events** append buffer.
- **P4 — Impact / capture on GPU.** Drone-vs-node/turret hits on GPU; read back sparse events (garrison changes, captures) for the CPU to apply to authoritative node state.

## Sync model (the crux)
- GPU authoritative for drone state; CPU authoritative for nodes/turrets/AI/economy.
- Per frame: **CPU → GPU** writes (new spawns, turret positions, salvo target) → GPU runs the passes → **GPU → CPU** writes a compact EVENTS append-buffer (kills, captures, turret damage) → CPU applies. Minimise readback (events only, never all positions). Double-buffer / async `mapAsync` to avoid pipeline stalls (accept ~1-frame event latency).

## Honest risks / decisions to lock
- **Browser support:** WebGPU is stable in Chrome/Edge (you're on Chrome). Safari/Firefox are partial ⇒ the CPU fallback MUST stay. Ship behind `?gpu=1`, default ON where supported.
- **Determinism:** GPU float math varies across hardware ⇒ breaks lockstep determinism. Fine for single-player; if online multiplayer/replay ever happens (the Supabase idea), the netcode must be server-authoritative / event-synced, not lockstep.
- **Scope of work:** multi-session rewrite. Land P0–P1 first (visible win: drones fly on GPU), then P2 (spike gone), then P3–P4 (combat fully off the CPU).
- **Cheap interim (NOT a cap):** a one-line *stagger* of the H-salvo release (`_nextDecisionT = elapsed + rand`) kills the press-H spike immediately while the GPU path is built. Doesn't limit count.

## Superseded by this plan
- ~~Cap the snowball~~ / ~~cap the unit count~~ — rejected (no caps; unlimited is the point).
- **Merging units into strike groups is KEPT** (it's a wanted feature, not a cap — see the Command-layer section). Only the *capping* half of the old "cap + merge" idea is dropped.
- **Combat → WASM** as a separate workstream is now optional/interim: once GPU combat (P3) lands it isn't needed. The existing WASM AA/tank damage stays as the CPU-fallback path.

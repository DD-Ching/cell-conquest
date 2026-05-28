# Cell Conquest — Project Memory

## Repo

- GitHub: https://github.com/DD-Ching/cell-conquest (private)
- Branches: `main` (stable), `dev` (work-in-progress)
- Multi-machine setup: same user, two checkouts (MacBook + Intel NUC).
  Always pull before starting work — the other machine may have pushed
  while this one was off. See "Running on a new machine" below.

## Git workflow — **always follow**

1. **All new work goes on `dev`**, never directly on `main`.
2. Commit + push `dev` after each meaningful change:
   ```
   git checkout dev
   git add <files>
   git commit -m "..."
   git push origin dev
   ```
3. **Only merge `dev` → `main` after the user explicitly confirms stability** (e.g. game played, training succeeded, smoke test passed). Don't pre-emptively merge.
   ```
   git checkout main
   git merge dev
   git push origin main
   ```
4. New repos: use `gh repo create <name> --private --source=. --remote=origin --push`.

## Project structure

- `node-conquest.html` — the playable browser game (heuristic v3 AI; optional ONNX-loaded NN player slot)
- `cell_env.py` — headless RL training environment (v2: variable-player, player-agnostic 23-feature observation)
- `train_full.ipynb` — full fresh-train notebook (BC + PPO league self-play)
- `train_fine.ipynb` — 3h fine-tune notebook (resumes from uploaded league/, higher P_HEURISTIC)
- `build_notebook.py` / `build_notebook_fine.py` — generators for the above notebooks
- `export_onnx.py` — converts trained `final.pt` to ONNX for browser
- `train_league_fast.py` / `train_fast.py` — older standalone training scripts (kept for reference)

## Tech facts

- v1 model: 4-player fixed, 21-feature obs, achieved ~96.8% leader rate in 4P games (overfit specialist)
- v2 model: variable 2-6 player, 23-feature player-agnostic obs, plateaued ~38-41% (12h on Kaggle T4)
- Honest assessment: hand-tuned heuristic (current v3 in `node-conquest.html`) is competitive with NN models for this game given Kaggle-scale compute. Pure RL self-play degenerates into equilibrium without strong asymmetric signal.

## Game design direction (current)

**Setting:** Mars warfare ("Mars Front"). Warm rust palette, sandy dust haze,
1v1 by default (player vs Crimson). Small-arena tactical: 10–16 nodes.

**Gameplay target:** tower-defense / RTS hybrid where every "building" is a
physical unit that has to travel from a base to its deployment slot before it
works. Bases differ — some only spit infantry, some only drones, etc.

**Done so far:**
- Mars visual restyle, dust particles, AA tracer beams (saturation animation)
- AIS = ['red'] (single opponent)
- Smaller arena (1600×1200), 10–16 nodes
- Roads, road blockage, engineers, construction sites
- Anti-air, drone factory, drone net (still node-anchored)
- Drones (straight-line suicide)

**Not yet (next iterations):**
1. **Deployable physical structures** — turrets / AA carry to a chosen world
   slot before activating. Engineer fleet → deployment site → activates there
   (not on the parent node). Lets player draw a defensive line between nodes.
2. **Asymmetric bases** — big bases can build anything; small bases restricted
   to one or two unit types (e.g. infantry-only outposts, drone-factory bases).
3. **Saturation math, formally** — currently AA damage simply stacks. Want
   probabilistic interception: each AA has per-second kill chance, multiple
   drones in zone divide attention. Tracer beams already give the visual hook.
4. **Free art** — Kenney.nl packs to consider:
     - Top-Down Tanks (kenney.nl/assets/top-down-tanks)
     - Tower Defense — Top-Down (kenney.nl/assets/tower-defense-top-down)
     - Space Kit (kenney.nl/assets/space-kit)
   Drop sprites into `assets/` and have `render.js` swap canvas primitives for
   `Image()` blits where appropriate. Keep code paths so missing assets fall
   back to current primitive shapes.

## Running on a new machine (Intel NUC / second laptop)

First-time setup:

```bash
git clone https://github.com/DD-Ching/cell-conquest.git
cd cell-conquest
git checkout dev          # work always happens on dev
```

Run the game (no build step, plain ES modules):

```bash
python3 -m http.server 8765
# browse http://localhost:8765/node-conquest.html
```

Optional flags / hotkeys (see node-conquest.html help panel for the full
list):

- URL `?renderWorker=1` — boot with the OffscreenCanvas render worker
  already on (transferControlToOffscreen has to happen before any
  getContext('2d'), so the URL flag is the clean way to enable). U key
  toggles by reloading with the flag flipped.
- Y key — move enemy AI to a Web Worker (`ai-worker`). Safe to toggle
  mid-game.
- G key — delegate the hovered (or all selected) base(s) to the
  Lieutenant; press again to revoke.
- H key — Hold-Fire drone stockpile; second press launches the salvo.

Rust / wasm toolchain (only needed when changing wasm code):

```bash
brew install rustup-init && rustup-init -y       # macOS
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh    # Linux NUC
cargo install wasm-pack
cd wasm && ./build.sh        # rebuilds wasm/pkg/cell_sim.wasm
```

The wasm artifacts in `wasm/pkg/` are committed — second machine doesn't
need the Rust toolchain to *play*, only to *build*.

## Collaboration discipline — keep modules small

Adding a feature? Default to a **new file**, not new lines in an existing one.

Hard ceilings (when crossed, split):

| File type | Soft cap | Hard cap |
|---|---|---|
| Single module (`.js`) | 300 lines | 500 lines |
| Single function | 50 lines | 80 lines |
| `main.js` | 600 lines | 800 lines (then move concerns out) |

Established patterns (mimic these when adding new domains):

- **Domain split** — when a single concern grows past ~250 lines, slice
  by sub-concern. Example: `ai.js` (670 lines) → `ai.js` (orchestrator)
  + `ai-build.js` + `ai-tactical.js` + `ai-strategic.js`.
- **Effects facade** — when a module needs to run both main-thread and
  worker-side, route side-effects through a `ctx.sendFleet` / etc.
  bundle so the same phase code works both contexts.
  Reference: `ai-effects.js` + `makeEffects(actions)`.
- **Worker pair** — every off-thread feature is two files: `X-worker.js`
  (the worker entry) and `X-worker-bridge.js` (main-thread proxy).
  Reference: `ai-worker.js` + `ai-worker-bridge.js`,
  `render-worker.js` + `render-worker-bridge.js`.
- **Lazy / opt-in** — perf experiments ship behind a state flag +
  hotkey, default OFF. WASM (Shift+W), AI worker (Y), render worker (U).
  Lets the user A/B compare and lets a broken experiment fail safely
  without breaking the main-thread path.

Avoid in `main.js`:

- New cross-module orchestration (extract a `*-bridge.js` instead)
- New rendering primitives (those belong in `render-*.js`)
- New AI logic (one of `ai-*.js`)
- New combat tuning constants (`config.js`)

When in doubt: read the existing comments at the top of similar modules
— they explain the boundary the file is supposed to defend.

## Kaggle deployment notes

- Datasets auto-found via `glob.glob('/kaggle/input/**/cell_env.py', recursive=True)` — slug name doesn't matter
- Resume ckpts: upload `league/` folder, Cell 1.5 in `train_fine.ipynb` copies into `/kaggle/working/league/`
- Background "Save Version" runs cannot be interacted with; use interactive sessions if you need to download intermediate files
- 12h hard limit on commit runs; outputs auto-saved on timeout

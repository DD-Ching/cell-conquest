# Cell Conquest — Project Memory

## Repo

- GitHub: https://github.com/DD-Ching/cell-conquest (private)
- Branches: `main` (stable), `dev` (work-in-progress)

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

## Kaggle deployment notes

- Datasets auto-found via `glob.glob('/kaggle/input/**/cell_env.py', recursive=True)` — slug name doesn't matter
- Resume ckpts: upload `league/` folder, Cell 1.5 in `train_fine.ipynb` copies into `/kaggle/working/league/`
- Background "Save Version" runs cannot be interacted with; use interactive sessions if you need to download intermediate files
- 12h hard limit on commit runs; outputs auto-saved on timeout

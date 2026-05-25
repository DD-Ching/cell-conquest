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

## Kaggle deployment notes

- Datasets auto-found via `glob.glob('/kaggle/input/**/cell_env.py', recursive=True)` — slug name doesn't matter
- Resume ckpts: upload `league/` folder, Cell 1.5 in `train_fine.ipynb` copies into `/kaggle/working/league/`
- Background "Save Version" runs cannot be interacted with; use interactive sessions if you need to download intermediate files
- 12h hard limit on commit runs; outputs auto-saved on timeout

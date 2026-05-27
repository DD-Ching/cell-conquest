#!/usr/bin/env bash
# Rebuild the cell_sim wasm module. Run after editing anything under src/.
# Strips the auto-generated pkg/.gitignore that wasm-pack would otherwise
# write — we WANT pkg/ tracked so the dev server + cloners don't need to
# rebuild before the game loads.
set -e
cd "$(dirname "$0")"
wasm-pack build --target web --release
rm -f pkg/.gitignore
echo "[wasm] rebuild done. Reload the page to pick up the new module."

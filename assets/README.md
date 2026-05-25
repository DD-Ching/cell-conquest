# Sprite assets — drop PNGs here

The game ships with programmatic top-down sprites that always work.
Dropping a PNG with one of the filenames below will make `js/sprites.js`
use it instead — useful if you want richer art from Kenney.nl etc.

## Expected filenames

All files are optional. Missing files just fall back to the built-in
canvas sprites. Sized so the longest edge is roughly 64-128 px.

| File | What it is | Where in-game |
|---|---|---|
| `tank.png` | top-down tank, top points right | troop fleets with >= 40 units, assault waves |
| `apc.png` | top-down APC / armored vehicle | troop fleets with 12-39 units |
| `truck.png` | top-down light truck or jeep | troop fleets with < 12 units |
| `engineer.png` | top-down bulldozer / construction vehicle | engineer & deploy fleets |
| `drone.png` | top-down quadcopter / UAV | aerial drones |
| `turret_aa.png` | top-down anti-air radar / missile turret | placed AA turret |
| `turret_tank.png` | top-down stationary cannon | placed Tank turret |
| `turret_factory.png` | top-down hangar / production building | placed Drone Factory |

Sprites are tinted by faction at draw time (multiply composite). Start
from a neutral / light-grey base so the tint reads on both blue (player)
and red (Crimson AI). Vehicles should be drawn pointing right (+X).

## Suggested free packs (Kenney.nl, CC0)

- **Top-Down Tanks** — <https://kenney.nl/assets/top-down-tanks>
  Source for `tank.png`, `apc.png`, `truck.png`, `turret_tank.png`.
- **Tower Defense — Top-Down** — <https://kenney.nl/assets/tower-defense-top-down>
  Source for `turret_aa.png`, `turret_factory.png`, `engineer.png`.

Download the ZIP, pick the closest-matching PNG, copy + rename to one of
the filenames above. Restart (or just hard-reload) the page.

## Hot-reloading

The loader runs once at boot. Reload the page to pick up new files.

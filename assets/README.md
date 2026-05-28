# Sprite assets — drop PNGs here

The game ships with programmatic top-down sprites that always work.
Dropping a PNG with one of the filenames below will make `js/sprites.js`
use it instead — useful if you want richer art from Kenney.nl etc.

## Shipped art (current)

Two Kenney CC0 packs, chosen so each sprite READS as its function:
- **Tower Defense (top-down)** — <https://opengameart.org/content/tower-defense-300-tilessprites>
  — the actual WEAPON turrets (missile launcher = AA, cannon = artillery,
  tank). These are unmistakable, unlike a generic building.
- **Sci-Fi RTS** — <https://opengameart.org/content/sci-fi-rts-120-sprites>
  — the ground VEHICLES + the factory building.

`drone` and `engineer` stay PROCEDURAL: no aircraft in either pack (the
delta-wing suicide drone is hand-drawn) and the soldier engineer looks
wrong rotated to travel direction (the built-in bulldozer reads better).
Credit "Kenney.nl" — not mandatory under CC0 but appreciated.

Source → in-game mapping:

| In-game file | Kenney source | Notes |
|---|---|---|
| `tank.png` | Sci-Fi RTS scifiUnit_45 | top-down tank, rotated 90° CW (pack points up; game angle 0 = east) |
| `apc.png` | Sci-Fi RTS scifiUnit_46 | rotated 90° CW |
| `truck.png` | Sci-Fi RTS scifiUnit_47 | rotated 90° CW |
| `turret_aa.png` | TD towerDefense_tile205 | **missile launcher, missiles point up** = anti-air. Upright (no aim-rotate). |
| `turret_tank.png` | TD towerDefense_tile249 | **tank body + turret**. Upright. |
| `turret_artillery.png` | TD towerDefense_tile291 | **cannon, barrel points east** — matches the artillery aim-rotation, so the barrel tracks its target. No pre-rotation. |
| `turret_factory.png` | Sci-Fi RTS scifiStructure_05 | factory w/ orange roof, upright |

## Expected filenames

All files are optional. Missing files just fall back to the built-in
canvas sprites. Sized so the longest edge is roughly 64-128 px.

| File | What it is | Where in-game |
|---|---|---|
| `tank.png` | top-down tank, top points right | troop fleets with >= 40 units, assault waves |
| `apc.png` | top-down APC / armored vehicle | troop fleets with 12-39 units |
| `truck.png` | top-down light truck or jeep | troop fleets with < 12 units |
| `engineer.png` | top-down bulldozer / construction vehicle | engineer & deploy fleets |
| `drone.png` | top-down delta-wing / paper-airplane suicide drone (Shahed-style) | aerial drones |
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

## How the loader decides what to fetch

`js/sprites.js` reads `assets/manifest.json` (this folder) and only fetches
the PNGs listed there. Default ships with `[]` so the game makes ZERO PNG
requests (no 404 spam in the server log).

When you drop in a sprite, add its name to the manifest:

```json
["tank", "drone", "turret_aa"]
```

Then reload. Names must match the `File` column above (without `.png`).

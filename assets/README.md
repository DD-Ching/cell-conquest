# Sprite assets — drop PNGs here

The game ships with programmatic top-down sprites that always work.
Dropping a PNG with one of the filenames below will make `js/sprites.js`
use it instead — useful if you want richer art from Kenney.nl etc.

## Shipped art (current)

Ground units + turret structures use **Kenney "Sci-Fi RTS" (CC0)** sprites
— <https://opengameart.org/content/sci-fi-rts-120-sprites>. The pack's
rust/grey palette suits Mars and tints cleanly to faction colours.
`drone` and `engineer` deliberately stay PROCEDURAL: the pack has no
aircraft (the delta-wing suicide drone is hand-drawn) and its engineer is
a standing soldier that looks wrong rotated to travel direction (the
built-in bulldozer reads better). Credit "Kenney.nl" — not mandatory under
CC0 but appreciated.

Source → in-game mapping:

| In-game file | Kenney source | Notes |
|---|---|---|
| `tank.png` | scifiUnit_45 | rotated 90° CW (Kenney points up; game angle 0 = east) |
| `apc.png` | scifiUnit_46 | rotated 90° CW |
| `truck.png` | scifiUnit_47 | rotated 90° CW |
| `turret_aa.png` | scifiStructure_13 | radar dish, upright (no aim-rotate) |
| `turret_tank.png` | scifiStructure_14 | round turret, upright |
| `turret_factory.png` | scifiStructure_05 | factory w/ orange roof, upright |
| `turret_artillery.png` | scifiStructure_09 | barreled gun, rotated 90° CW — sprite tracks aim |

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

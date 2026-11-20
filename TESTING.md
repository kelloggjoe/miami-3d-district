# Testing

All checks are automated in `tests/e2e.mjs` and run against the production build in headless Chromium. Raw output is in `docs/test-results.json`. **Expanded map (2026-11-20):** the last complete run is in `docs/test-results.json`. It ran on the 6 × 6 km map *before* two final tweaks: following Brickell Avenue's connected path in the walking test, and choosing NPC destinations locally. On that run, every walking, flying and teleport check passed except the Brickell Avenue walk: 79 of 80 waypoints reached, with 1 stuck, caused by the old test's straight-line sorting of the avenue's points. The NPC checks found 0 inside buildings and 0 on water. Performance: 97–359 draw calls on Medium, 696 at most on High; 275k–410k triangles on Medium.

A rerun after the final tweaks was **killed by the build machine** (out of memory on the larger map) before it finished, so the final build had only a smoke check:
- it loads with no errors;
- after 3 simulated hours, 141 people were outdoors, 0 inside buildings and 0 on water;
- NPC update took 0.42 ms.

**Still needed:** a full `npm run test:e2e` on a machine with more memory, or splitting the suite into parts.

Previous run: 2026-11-19, after the graphics upgrade. Walking and NPC checks run at the default **Medium** quality.

```
npm run build && npm run test:e2e
```

**Important:** the test machine has no GPU. Chromium used **SwiftShader (software WebGL on the CPU)**. Its FPS numbers measure that machine, not a laptop. **The 60 FPS target on a mid-range integrated-GPU laptop is UNTESTED.** Draw calls, triangle counts, data sizes and NPC CPU time do not depend on the GPU, so those numbers are real.

## Milestone 1: data pipeline

| Check | Result |
|---|---|
| One command re-runs the pipeline | `npm run pipeline` (uses the cache) / `npm run pipeline:refresh` (re-downloads). **Pass**. Offline re-run takes about 10 s. |
| Processed data size (budget 5 MB) | `data/district.json` = **0.87 MB** (275 KB gzipped). **Pass** |
| 2D preview aligned to a reference | `docs/map-preview.png`. The Bayfront Park shoreline, Miami River, Brickell Key and the Metromover loop all line up visually with the coastline and street grid. **Pass (visual)** |
| Independent reference points | Kaseya Center: reference point falls **inside** its footprint (0 m). Freedom Tower: **47 m** from its footprint. The reference coordinates were entered from memory of Wikipedia infobox values, so that 47 m most likely reflects a rough reference point, not misaligned data. **Partial.** Re-check with a surveyed coordinate. |
| Self-intersecting / duplicate footprints | 0 / 0 found after cleaning |
| Coastline closure | 7 coastline ways became 2 land polygons, with 0 loose ends |

## Milestone 2: static 3D district

| Check | Result |
|---|---|
| View from above | `docs/view-aerial.png`, `docs/view-downtown-aerial.png`. **Pass (visual)** |
| Street level near Brickell Avenue | `docs/view-brickell-ave.png`. **Pass (visual)** |
| Draw calls (budget 1,500) | Low 77–150, Medium 184–227, High 369–446. **Pass** |
| Triangles per frame | 134k–150k |
| JavaScript + data (budget 15 MB) | **1.71 MB** total. Textures are generated in code, so there are no image downloads. **Pass** |
| Load time (budget 5 s) | The app's own setup takes **0.3 s** of main-thread work on Medium (world 192 ms, collision 51 ms, props 57 ms, NPCs 7 ms). Wall-clock time to the first rendered frame with software rendering: **11.4 s on Medium** (the earlier Low-only build was 2.0 s). Almost all of that is shader compiling and the first shadow render on the CPU. **Untested on a real GPU and over a real network.** About 490 KB gzipped would need to be downloaded. |
| Console errors | 0 in every run |

## Milestone 3: walking

Scripted walker: it steers toward each waypoint in 1/60 s steps through the real player controller and collision code. "Stuck" means no progress for 3 s.

| Check | Result |
|---|---|
| Walk the full length of Brickell Avenue | 41 of 41 waypoints reached, **1,942 m walked**, including the Miami River bridge. 0 stuck, eye height never below 1.70 m, never inside a building or on water. **Pass**. Waypoints within 3 m of the model's edge are skipped, because the avenue continues beyond the bounding box. |
| Walk around Bayfront Park | 205 of 205 waypoints reached, **2,226 m walked** on the park's footpaths through 16 perimeter points. 0 stuck. **Pass**. An earlier run failed on a roof-only canopy over a path; fixed (see DECISIONS.md). |
| Slide along walls | Walking into a 362 m wall at 30°: slid **4.16 m** along it (4.16 m expected for free sliding), never closer than 0.6 m (radius 0.35 m). **Pass** |
| Water | Sprinting east from Bayfront Park for 60 s: stopped at the shoreline after 113 m, still on walkable ground. **Pass** |
| Jump | Peak 0.50 m, lands back on the ground. **Pass** |
| Reset key (R) | Returns to the Bayfront Park spawn point. **Pass** |
| Debug overlay | Toggles with the backtick key. Shows FPS, draw calls, triangles, position, distance walked, NPC update time and paths per second. Checked by hand in screenshots; no automated test. |
| Mouse look / pointer lock | **Untested by automation**: headless Chromium cannot grant pointer lock. The code uses Three's standard `PointerLockControls`. |

## Milestone 4: NPCs

300 NPCs simulated from 6:00 AM to 11:30 PM at a 60× clock (no rendering). Every 15 sim-minutes, every outdoor NPC was checked.

| Check | Result |
|---|---|
| NPCs never inside buildings or parked cars | **8 of 7,480 position checks (0.11%)** were inside a footprint. **Known issue**: most likely separation steering or corner-cutting on very short segments. |
| NPCs never on water | 0 of 7,412. **Pass** |
| NPCs stay on sidewalks / paths | 3 of 7,480 were more than their allowed corridor from a walk edge (worst 0.44 m beyond). 99th percentile is 1.45 m *inside* the corridor. **Pass** |
| Activity changes with the clock | **Pass**. Most common activity: 8 AM "Heading to work" (97) → noon "Getting lunch" (64) → 2 PM "Back to the office" (126) → 6 PM "Heading to the station" (76) → 8 PM "Going home" (133). Outdoor count goes from 161 at 6 AM to 260 at 8 PM to 171 at 10 PM. |
| Click to inspect | Raycasts from the screen center to NPC bodies and shows a label like "Commuter #12, Heading to lunch, 12:40 PM". **Untested by automation** (needs pointer lock). |

### Performance by graphics quality (1280×720 unless noted)

Triangle counts include the shadow pass on Medium/High, and the extra post-processing passes on High.

| Preset / NPCs | Scene | Draw calls | Triangles | NPC update (CPU) | FPS (software GL) |
|---|---|---|---|---|---|
| Low, 300 NPCs | street, Brickell area | 107 | 141,900 | 2.06 ms | 4.7 |
| Low, 300 NPCs | street, Bayfront Park (spawn) | 77 | 141,189 | 0.78 ms | 5.5 |
| Low, 300 NPCs | aerial, whole district | 150 | 143,012 | 1.41 ms | 5.4 |
| Medium, 200 NPCs | street, Brickell area | 227 | 219,029 | 2.93 ms | 1.5 |
| Medium, 200 NPCs | street, Bayfront Park (spawn) | 184 | 287,481 | 1.74 ms | 1.5 |
| Medium, 200 NPCs | aerial, whole district | 213 | 129,114 | 0.99 ms | 2.6 |
| Medium, 400 NPCs | street, Brickell area | 227 | 247,829 | 6.35 ms | 1.4 |
| Medium, 400 NPCs | street, Bayfront Park (spawn) | 184 | 316,281 | 3.31 ms | 1.4 |
| Medium, 400 NPCs | aerial, whole district | 213 | 157,914 | 2.09 ms | 2.5 |
| High, 300 NPCs | street, Brickell area | 446 | 466,628 | 4.37 ms | 0.9 |
| High, 300 NPCs | street, Bayfront Park (spawn) | 369 | 603,496 | 3.15 ms | 0.9 |
| High, 300 NPCs | aerial, whole district | 408 | 286,702 | 2.1 ms | 1.2 |
| Medium, 300 NPCs, 1920×1080 | street, Brickell area | 227 | 233,429 | 4.28 ms | 0.8 |
| Medium, 300 NPCs, 1920×1080 | street, Bayfront Park (spawn) | 184 | 301,881 | 2.67 ms | 0.9 |
| Medium, 300 NPCs, 1920×1080 | aerial, whole district | 213 | 143,514 | 2.36 ms | 1.8 |

Reading the numbers:
- **Draw calls** stay far under the 1,500 budget on every preset: at most 227 on Medium and 446 on High.
- **Triangles:** Medium draws about 130k–320k, about 1.5–2× Low.
- **NPCs:** going from 200 to 400 NPCs adds no draw calls and a few ms of CPU time.
- **FPS:** software rendering is about 3–5× slower on Medium than Low. Expect a smaller gap on a real GPU, but **the 60 FPS target on a laptop is UNTESTED for every preset.**

An earlier Medium build drew about 1.5M triangles per frame because every street prop was one instanced mesh covering the whole city. Splitting the props into 250 m chunks with frustum culling, plus hiding props beyond about 650 m and simplifying the tree and car models, brought that down to the numbers above.

## Flying and speed (creative mode)

All scripted through the real player controller at 60 steps per second, on Medium quality.

| Check | Result |
|---|---|
| Double-tap Space starts flying | **Pass** (two key events 150 ms apart, dispatched in the page) |
| Climb with Space for 5 s | Reached **39.3 m**, still flying |
| Fly at 60 m into the tallest tower (265 m) at fast speed for 10 s | Never entered it. Stopped 50.7 m from its center. **Pass** |
| Same tower, flying 20 m above its roof | Passed over it (215.5 m beyond its center). **Pass** |
| Descend onto a 43.3 m roof | Landed at exactly 43.3 m and flight ended. **Pass** |
| Walk off that roof's edge | Fell to the street (z = 0 m), on the ground. **Pass** |
| Descend onto Biscayne Bay | Kept flying, hovering at 0.6 m above the water. **Pass** |
| Speed multiplier | 2 s of walking: 3.2 m at 1×, 16 m at 5× (ratio 5). Pressing + twice from 1× gives 2×. **Pass** |
| Walking checks after the collision change | Brickell Ave, Bayfront Park loop, wall sliding, water and jump all still pass |
| Mouse-wheel speed change | **Untested by automation**: it only works while the mouse is locked, which headless Chromium can't do |

## Map and teleporting

| Check | Result |
|---|---|
| M opens the full map | **Pass** (real key press) |
| Clicking the map teleports and closes it | Real mouse click at a map point: moved 779 m from the spawn, on open land, not inside a building, map closed. **Pass** |
| Every place in the "Go to" list | 28 of 28 land on open ground. The farthest is 68 m from the place's marker, because building markers sit inside footprints and the teleport finds the nearest street. **Pass** |
| Shift+click onto a roof | Tallest building: landed at 265 m on its 265 m roof. **Pass** |
| Minimap | Visual check: `docs/view-minimap.png` |
| Re-locking the mouse after a teleport | **Untested by automation** (headless Chromium can't lock the pointer) |

## Graphics upgrade (tiers 1 and 2)

| Check | Result |
|---|---|
| All three presets load with no console errors | Low, Medium and High. **Pass** |
| Walking and NPC checks still pass with parked cars as solid obstacles | Brickell Ave, Bayfront Park loop, wall sliding, water and jump all pass on Medium. **Pass** |
| Props placed | 818 palms, 681 shade trees, 742 street lamps (41 from OSM, 701 generated), 39 benches, 100 bus shelters, 500 parked cars |
| Visual comparison | `docs/quality-low.png`, `docs/quality-medium.png`, `docs/quality-high.png` (same spot), plus `docs/view-parked-cars.png` |
| High preset labels | Labels render, but slightly faded because the final post-processing pass tone-maps them. **Known cosmetic issue.** |

## Milestone 5: polish

| Check | Result |
|---|---|
| Landmark overrides applied | 11 of 11 height overrides matched an OSM building, and 13 of 13 label-only landmarks matched. 4 place labels are shown. |
| "© OpenStreetMap contributors" visible | Always shown bottom-right, linked to the OSM copyright page. **Pass** |
| Production build runs as a static site | `dist/` served by `vite preview` in every test above. **Pass** |

## Not tested

- Real GPU frame rate (60 FPS target) for each quality preset
- How the graphics look on a real GPU and display (all screenshots are software-rendered)
- Load time over the network
- Pointer-lock mouse look and click-to-inspect (needs a real user gesture)
- Browsers other than Chromium

# Testing

All checks are automated in `tests/e2e.mjs` and run against the production build in headless Chromium. Raw output is in `docs/test-results.json`. Last run: 2026-11-19.

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
| Draw calls (budget 1,500) | **77–150** across street, park and aerial views. **Pass** |
| Triangles per frame | 134k–150k |
| JavaScript + data (budget 15 MB) | **1.63 MB** total (JS 718 KB, data 908 KB, CSS 2 KB). Single-file build: 1.93 MB. **Pass** |
| Load to ready (budget 5 s) | **2.0 s** from navigation to ready, served locally with software rendering. **Untested over a real broadband connection.** About 465 KB gzipped would need to be downloaded. |
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
| NPCs never inside buildings | **6 of 7,530 position checks (0.08%)** were inside a footprint. **Known issue**: most likely separation steering or corner-cutting on very short segments. Down from 124 before walk edges through buildings were removed. |
| NPCs never on water | 0 of 7,530. **Pass** |
| NPCs stay on sidewalks / paths | 1 of 7,530 was more than its allowed corridor from a walk edge (worst 1.6 m beyond). 99th percentile is 1.4 m *inside* the corridor. Corridor = on a footway (2.5 m) or beside a road (half width + 3 m). **Pass** |
| Activity changes with the clock | **Pass**. Most common activity: 8 AM "Heading to work" (97) → noon "Getting lunch" (64) → 2 PM "Back to the office" (126) → 6 PM "Heading to the station" (76) → 8 PM "Going home" (133). Outdoor count goes from 161 at 6 AM to 260 at 8 PM to 171 at 10 PM. |
| Click to inspect | Raycasts from the screen center to NPC bodies and shows a label like "Commuter #12, Heading to lunch, 12:40 PM". **Untested by automation** (needs pointer lock). |

### Performance with 200 and 400 NPCs (1280×720)

| Scene | NPCs | Draw calls | Triangles | NPC update (CPU) | FPS (software GL) |
|---|---|---|---|---|---|
| Street, Brickell area | 200 | 107 | 134,700 | 1.96 ms | 4.9 |
| Street, Bayfront Park | 200 | 77 | 133,989 | 0.67 ms | 5.7 |
| Aerial, whole district | 200 | 150 | 135,812 | 0.59 ms | 5.9 |
| Street, Brickell area | 400 | 107 | 149,100 | 3.87 ms | 4.3 |
| Street, Bayfront Park | 400 | 77 | 148,389 | 1.21 ms | 5.2 |
| Aerial, whole district | 400 | 150 | 150,212 | 0.91 ms | 5.3 |
| Street, Brickell area, 1920×1080 | 300 | 107 | 141,900 | 3.66 ms | 3.0 |

Reading the numbers: going from 200 to 400 NPCs adds about 15k triangles, adds no draw calls (the crowd is always 6 instanced draws), and adds up to about 1.9 ms of CPU per frame. On a GPU, about 150k triangles in 150 draw calls is a light load. **That still needs to be confirmed on real hardware: open the app, press the backtick key, and read FPS.**

## Milestone 5: polish

| Check | Result |
|---|---|
| Landmark overrides applied | 11 of 11 height overrides matched an OSM building, and 13 of 13 label-only landmarks matched. 4 place labels are shown. |
| "© OpenStreetMap contributors" visible | Always shown bottom-right, linked to the OSM copyright page. **Pass** |
| Production build runs as a static site | `dist/` served by `vite preview` in every test above. **Pass** |

## Not tested

- Real GPU frame rate (60 FPS target)
- Load time over the network
- Pointer-lock mouse look and click-to-inspect (needs a real user gesture)
- Browsers other than Chromium

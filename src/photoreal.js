// Photoreal mode: Google Photorealistic 3D Tiles in place of the generated city.
// The scanned city is reoriented so it lines up with the app's local frame
// (x = east, y = up, -z = north, origin = data.meta.origin), then shifted vertically so the
// street at the spawn point sits at y = 0, where the player, people and collision already live.
//
// Billing: GoogleCloudAuthPlugin uses a session token, so one page visit = one root request.
// The key comes from VITE_GOOGLE_TILES_KEY at build time and must be restricted in Google Cloud
// to the site's domain and to the Map Tiles API.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';

// Not included in the claude.ai and single-file builds: those can't reach Google (CSP / no site referrer).
export const PHOTOREAL_KEY = (import.meta.env.MODE === 'artifact' || import.meta.env.MODE === 'single') ? '' : (import.meta.env.VITE_GOOGLE_TILES_KEY || '');
export const photorealAvailable = () => !!PHOTOREAL_KEY;

export function createPhotoreal(scene, camera, renderer, data, { calibrateAt }) {
  const D2R = Math.PI / 180;
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: PHOTOREAL_KEY, autoRefreshToken: true }));
  tiles.registerPlugin(new ReorientationPlugin({ lat: data.meta.origin.lat * D2R, lon: data.meta.origin.lon * D2R, height: 0, recenter: true }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.errorTarget = 12; // a bit coarser than the default to keep phones and laptops smooth

  // The plugin gives X = west, Z = north; the app uses X = east, -Z = north: turn 180 degrees about Y.
  const frame = new THREE.Group();
  frame.rotation.y = Math.PI;
  frame.add(tiles.group);
  scene.add(frame);
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);

  // Vertical alignment: ray down at a known open street-level point and move the scan so it sits at y = 0.
  const ray = new THREE.Raycaster();
  let calibrated = false, calibTimer = 0, offset = 0;
  const state = { loadedTiles: 0, calibrated: false, groundOffsetM: 0, error: null };
  // If nothing has loaded and Google refuses (daily cap reached, key problem, offline), report failure so the
  // app can fall back to the generated city instead of showing empty sky.
  const failListeners = [];
  const fail = (why) => { if (state.failed) return; state.failed = true; state.error = why; failListeners.forEach((f) => f(why)); };
  tiles.addEventListener('load-error', (e) => { const why = String(e.error?.message || e.error || 'load error'); state.error = why; if (state.loadedTiles === 0) fail(why); });
  setTimeout(() => { if (state.loadedTiles === 0) fail(state.error || 'timeout'); }, 20000);
  tiles.addEventListener('load-model', () => { state.loadedTiles++; });

  function calibrate() {
    // Several points around the open spawn area; the lowest hit is the ground (others may be treetops).
    const [cx, cy] = calibrateAt;
    let low = Infinity;
    for (const [dx, dy] of [[0, 0], [25, 0], [-25, 0], [0, 25], [0, -25], [18, 18], [-18, -18], [18, -18], [-18, 18]]) {
      ray.set(new THREE.Vector3(cx + dx, 400, -(cy + dy)), new THREE.Vector3(0, -1, 0));
      ray.far = 900;
      const hit = ray.intersectObject(tiles.group, true)[0];
      if (hit) low = Math.min(low, hit.point.y);
    }
    if (!isFinite(low)) return false;
    offset -= low; // move the scan so the street is at 0
    frame.position.y = offset;
    frame.updateMatrixWorld(true);
    state.groundOffsetM = +offset.toFixed(2);
    return true;
  }

  function update(dt) {
    camera.updateMatrixWorld();
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    // Re-check the ground height a few times while finer tiles stream in, then stop.
    calibTimer -= dt;
    if (calibTimer <= 0 && state.loadedTiles > 0 && (!calibrated || calibTimer > -20)) {
      calibTimer = calibrated ? 3 : 0.5;
      if (calibrate()) { calibrated = true; state.calibrated = true; }
    }
  }

  // Google requires its logo and the data providers' copyright text to be shown.
  function attributionText() {
    const list = tiles.getAttributions ? tiles.getAttributions([]) : [];
    const words = list.filter((a) => a.type === 'string').map((a) => a.value).join('; ');
    return words;
  }

  return { tiles, frame, update, state, attributionText, onFail: (f) => failListeners.push(f) };
}

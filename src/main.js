import * as THREE from 'three';
import { buildWorld } from './world.js';
import { buildCollision } from './collision.js';
import { createPlayer } from './player.js';
import { buildGraph, fmtTime, ARCHETYPES } from './npc.js';
import { createPedestrians } from './pedestrians.js';
import { buildProps } from './props.js';
import { loadCarModels, createVehicles } from './vehicles.js';
import { createMaps } from './minimap.js';
import { getQuality, setQuality, PRESETS, availablePresets } from './quality.js';
import { createPhotoreal } from './photoreal.js';
import { parseArea, generateArea } from './generator.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { STYLES, GradeShader, getStyle, saveStyle, createStyleController } from './styles.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

async function loadData() {
  // A generated area (?area=lat,lon,km from the Explore page): download and build it in the browser.
  const area = parseArea(params);
  if (area) {
    document.body.classList.add('generated');
    $('area-name').textContent = area.name || `${area.lat.toFixed(3)}, ${area.lon.toFixed(3)}`;
    return generateArea(area, (p) => { $('loading').textContent = p.text; });
  }
  // Artifact build: data is published beside the page. Other builds: hashed asset (or inlined data: URL in the single-file build).
  const dataUrl = import.meta.env.MODE === 'artifact' ? './district.json' : (await import('../data/district.json?url')).default;
  const res = await fetch(dataUrl);
  if (!res.ok) throw new Error(`Could not load district data (${res.status})`);
  return res.json();
}

async function main() {
  const t0 = performance.now();
  const data = await loadData();
  const canvas = $('c');
  const Q = getQuality();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  renderer.info.autoReset = false;
  if (Q.pbr) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.5; }
  if (Q.shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.2, 9000);

  const timings = {}; let tm = performance.now();
  const lap = (k) => { const n = performance.now(); timings[k] = Math.round(n - tm); tm = n; };
  lap('fetch+parse');
  const world = buildWorld(scene, data, Q, renderer); lap('world');
  let photo = null;
  if (Q.photoreal) {
    // Keep the generated city for collision, people and labels, but show Google's scan instead of it.
    for (const o of scene.children) if (!o.isLight && o !== world.labels) o.visible = false;
    for (const c of world.chunkList) { c.full.visible = false; if (c.lod) c.lod.visible = false; }
    world.updateLod = () => {}; // the generated buildings stay hidden
    scene.background = new THREE.Color('#a9d4ea'); scene.fog = null;
    photo = createPhotoreal(scene, camera, renderer, data, { calibrateAt: data.meta.spawn });
    photo.onFail(() => { // Google's daily cap or a key problem: reload as the generated city (don't change the saved choice)
      const u = new URL(location.href); u.searchParams.set('quality', 'medium'); u.searchParams.set('photoreal', 'unavailable'); location.replace(u.toString());
    });
  }
  const collision = buildCollision(data); lap('collision');
  // Car models load in the background; parked and moving cars appear a moment after the first frame.
  const carKitPromise = params.get('traffic') === 'off' ? Promise.resolve(null) : loadCarModels().catch((e) => { console.warn('Car models failed to load.', e); return null; });
  const props = Q.props ? buildProps(scene, data, collision, { castShadow: Q.shadows, useCarModels: params.get('traffic') !== 'off' }) : null; lap('props');
  if (props) collision.addPolys(props.carPolys); // parked cars are solid
  const player = createPlayer(camera, canvas, collision, data.meta.spawn, data.meta.start);
  const graph = buildGraph(data.walk, collision);
  // People: an ambient crowd around the player (sized by preset; ?npcs= overrides).
  const crowdSize = +(params.get('npcs') || (Q.id === 'low' ? 600 : Q.id === 'high' ? 2500 : 1500));
  const density = data.meta.autoDensity ? data.meta.density : 1; // generated areas scale crowds and traffic to how built-up they are
  const crowd = createPedestrians(scene, data, collision, { count: crowdSize, density }); lap('npcs');
  if (Q.shadows) for (const m of Object.values(crowd.meshes)) m.castShadow = true;
  let vehicles = null;
  carKitPromise.then((kit) => { if (kit) vehicles = createVehicles(scene, data, Q, kit, props ? props.parkedSpots : [], collision, { density }); window.__miami && (window.__miami.vehicles = vehicles); });

  // High: ambient occlusion + subtle bloom.
  // Post-processing: one composer, passes switched on as needed. Normal style without High quality renders
  // directly (no extra cost); High adds ambient occlusion + light bloom; styles add bloom and a color grade.
  const rt = new THREE.WebGLRenderTarget(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio(), { samples: 4, type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  if (Q.post) {
    const ao = new GTAOPass(scene, camera, innerWidth, innerHeight);
    ao.updateGtaoMaterial({ radius: 2.0, distanceExponent: 1.5, thickness: 2.0, scale: 1.0 });
    // Labels (sprites) and transparent glass must not write into the AO depth/normal pass.
    ao.overrideVisibility = function () {
      const cache = this._visibilityCache;
      this.scene.traverse((o) => { cache.set(o, o.visible); if (o.isPoints || o.isLine || o.isSprite || (o.material && o.material.transparent)) o.visible = false; });
    };
    composer.addPass(ao);
  }
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.18, 0.5, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  const styler = createStyleController({ scene, renderer, world, Q, photoreal: !!photo });
  let style = 'normal', useComposer = Q.post;
  function setStyle(id) {
    style = id; saveStyle(id);
    styler.apply(id);
    const vice = id === 'miamivice';
    bloom.enabled = Q.post || vice;
    bloom.strength = vice ? (photo ? 0.3 : 0.45) : 0.18; bloom.radius = vice ? 0.5 : 0.5; bloom.threshold = vice ? 0.82 : 0.9;
    grade.enabled = id !== 'normal';
    grade.uniforms.uMode.value = id === 'miamivice' ? 1 : id === 'noir' ? 2 : 0;
    useComposer = Q.post || id !== 'normal';
    for (const b of document.querySelectorAll('#style button')) b.classList.toggle('on', b.dataset.id === id);
  }
  const sBox = $('style');
  for (const [id, name] of Object.entries(STYLES)) {
    const b = document.createElement('button'); b.textContent = name; b.dataset.id = id;
    b.onclick = (e) => { e.stopPropagation(); setStyle(id); };
    sBox.appendChild(b);
  }
  setStyle(getStyle());

  // Graphics quality picker (reloads the page).
  const qBox = $('quality');
  for (const id of availablePresets()) {
    const b = document.createElement('button'); b.textContent = PRESETS[id].name; b.className = id === Q.id ? 'on' : '';
    b.onclick = (e) => { e.stopPropagation(); if (id !== Q.id) setQuality(id); };
    qBox.appendChild(b);
  }

  // ---- simulated clock ----
  const SPEEDS = [0, 1, 10, 30, 60, 120, 300, 600];
  const clock = { hour: +(params.get('hour') || 8), speedIdx: 4, paused: false };
  const rate = () => (clock.paused ? 0 : SPEEDS[clock.speedIdx]);
  const setSpeed = (d) => { clock.speedIdx = Math.max(1, Math.min(SPEEDS.length - 1, clock.speedIdx + d)); clock.paused = false; };
  $('slower').onclick = () => setSpeed(-1); $('faster').onclick = () => setSpeed(1);
  $('pause').onclick = () => { clock.paused = !clock.paused; };

  // ---- UI wiring ----
  const loadMs = performance.now() - t0;
  $('loading').textContent = data.meta.autoDensity
    ? `${data.buildings.length.toLocaleString()} buildings · busyness ${Math.round(data.meta.density * 100)}% · ready`
    : `Loaded ${data.buildings.length.toLocaleString()} building shapes in ${(loadMs / 1000).toFixed(1)} s.`;
  const copy = $('copy-link');
  if (copy) copy.onclick = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(location.href); copy.textContent = 'Link copied'; } catch { copy.textContent = 'Copy the address bar to share'; }
    setTimeout(() => { copy.textContent = 'Copy link'; }, 2500);
  };
  $('go').disabled = false;
  if (params.get('photoreal') === 'unavailable') {
    const n = document.createElement('p'); n.className = 'notice';
    n.textContent = "Photoreal isn't available right now (its daily limit may be used up), so you're seeing the generated city. Try Photoreal again later.";
    $('loading').after(n);
  }
  $('go').onclick = () => player.controls.lock();
  canvas.addEventListener('click', () => { if (!player.controls.isLocked) player.controls.lock(); else inspect(); });
  player.controls.addEventListener('lock', () => $('start').classList.add('hidden'));
  player.controls.addEventListener('unlock', () => { if (!maps.open) $('start').classList.remove('hidden'); });
  const maps = createMaps({ data, player, camera, crowd, collision, world,
    onOpenChange: (o) => { if (o) $('start').classList.add('hidden'); else if (!player.controls.isLocked) $('start').classList.remove('hidden'); } });
  addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') $('debug').classList.toggle('hidden');
    if (e.code === 'KeyL') world.labels.visible = !world.labels.visible;
    if (e.code === 'KeyV') { const ids = Object.keys(STYLES); setStyle(ids[(ids.indexOf(style) + 1) % ids.length]); }
    if (e.code === 'KeyG') { const ids = Object.keys(PRESETS); setQuality(ids[(ids.indexOf(Q.id) + 1) % ids.length]); }
    if (e.code === 'KeyP') clock.paused = !clock.paused;
    if (e.code === 'BracketLeft') setSpeed(-1);
    if (e.code === 'BracketRight') setSpeed(1);
  });
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); });

  // ---- NPC inspection (center of screen) ----
  const ray = new THREE.Raycaster(); ray.far = 60;
  let inspectTimer = 0, inspected = null;
  function inspect() {
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hit = ray.intersectObjects(crowd.pickables, false)[0];
    if (!hit) { $('inspect').classList.add('hidden'); inspected = null; return; }
    inspected = crowd.npcs[hit.instanceId]; inspectTimer = 6;
  }

  // ---- loop ----
  const fps = { frames: 0, t: performance.now(), value: 0 };
  let last = performance.now(), lodTimer = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const simDtH = (dt * rate()) / 3600;
    clock.hour = (clock.hour + simDtH) % 24;
    if (!maps.open) player.update(dt); // no walking while the map is open
    lodTimer -= dt; if (lodTimer <= 0) { world.updateLod(player.state.x, player.state.y); lodTimer = 0.25; }
    world.updateShadow(camera); world.updateWater(now / 1000);
    if (photo) photo.update(dt);
    if (props) props.update(camera);
    if (vehicles) vehicles.update(dt, camera);
    maps.update(dt);
    crowd.update(dt, clock.hour, simDtH, player.state, camera);
    renderer.info.reset();
    grade.uniforms.uTime.value = (now / 1000) % 100; grade.uniforms.uRes.value.set(innerWidth, innerHeight);
    if (useComposer) composer.render(); else renderer.render(scene, camera);
    // HUD
    fps.frames++;
    if (now - fps.t > 500) { fps.value = (fps.frames * 1000) / (now - fps.t); fps.frames = 0; fps.t = now; }
    $('time').textContent = fmtTime(clock.hour);
    $('speed').textContent = clock.paused ? 'paused' : `${SPEEDS[clock.speedIdx]}×`;
    {
      const st = player.state, m = $('mode');
      const show = st.flying || st.z > 0.6 || st.speedMul !== 1;
      m.classList.toggle('hidden', !show);
      const spd = st.speedMul !== 1 ? ` · speed ${st.speedMul}×` : '';
      if (show) m.textContent = (st.flying ? `FLYING${st.fast ? ' · FAST' : ''} · ${st.z.toFixed(0)} m${st.overWater && st.z < 1 ? ' · over water' : ''}` : st.z > 0.6 ? `On a roof · ${st.z.toFixed(0)} m` : 'Walking') + spd;
    }
    $('crowd').textContent = `${crowd.metrics.visible} of ${crowd.count} people outdoors · ${crowd.metrics.walking} walking`;
    if (!$('debug').classList.contains('hidden')) {
      const i = renderer.info;
      $('debug').textContent = [
        `FPS        ${fps.value.toFixed(0)}`, `draw calls ${i.render.calls}`, `triangles  ${i.render.triangles.toLocaleString()}`,
        `position   x ${player.state.x.toFixed(1)}  y ${player.state.y.toFixed(1)}  z ${player.state.z.toFixed(1)} m${player.state.flying ? ' (flying)' : ''}`, `walked     ${player.state.distance.toFixed(0)} m`,
        `quality    ${Q.name}`, `NPC update ${crowd.metrics.updateMs.toFixed(2)} ms · full-rate ${crowd.metrics.near}`, `paths/s    ${crowd.metrics.pathsPerSec.toFixed(1)}`,
      ].join('\n');
    }
    if (inspected) {
      inspectTimer -= dt;
      const n = inspected;
      $('inspect').innerHTML = `<b>${ARCHETYPES[n.arch].label} #${n.id + 1}</b><br>${n.state === 'inside' ? 'Went indoors' : n.activity}, ${fmtTime(clock.hour)}`;
      $('inspect').classList.toggle('hidden', inspectTimer <= 0);
      if (inspectTimer <= 0) inspected = null;
    }
    if (!window.__firstFrameMs) { window.__firstFrameMs = performance.now(); document.body.dataset.firstFrame = '1'; }
    requestAnimationFrame(frame);
  }
  if (photo) { // Google requires its name and the imagery providers' credits on screen.
    const base = $('attrib').innerHTML;
    setInterval(() => { const t = photo.attributionText(); $('attrib').innerHTML = `${base} · <b>Google</b>${t ? ' · ' + t.replace(/[<>&]/g, '') : ''}`; }, 2000);
  }
  requestAnimationFrame(frame);

  // Test/automation hook (used by tests/e2e.mjs). Read-only use in normal play.
  window.__miami = { THREE, data, scene, camera, renderer, world, collision, player, graph, crowd, clock, loadMs, fps, quality: Q, props, timings, maps, photo, vehicles, setStyle, get style() { return style; } };
  document.body.dataset.ready = '1';
}

main().catch((e) => { console.error(e); $('loading').textContent = e.message; $('loading').classList.add('error'); });

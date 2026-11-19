import * as THREE from 'three';
import { buildWorld } from './world.js';
import { buildCollision } from './collision.js';
import { createPlayer } from './player.js';
import { buildGraph, createCrowd, fmtTime, ARCHETYPES } from './npc.js';
import dataUrl from '../data/district.json?url'; // hashed asset (or inlined data: URL in the single-file build)

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

async function loadData() {
  const res = await fetch(dataUrl);
  if (!res.ok) throw new Error(`Could not load district data (${res.status})`);
  return res.json();
}

async function main() {
  const t0 = performance.now();
  const data = await loadData();
  const canvas = $('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.2, 5000);

  const world = buildWorld(scene, data);
  const collision = buildCollision(data);
  const player = createPlayer(camera, canvas, collision, data.meta.spawn);
  const graph = buildGraph(data.walk, collision);
  const crowd = createCrowd(scene, data, graph, collision, { count: +(params.get('npcs') || 300) });

  // ---- simulated clock ----
  const SPEEDS = [0, 1, 10, 30, 60, 120, 300, 600];
  const clock = { hour: +(params.get('hour') || 8), speedIdx: 4, paused: false };
  const rate = () => (clock.paused ? 0 : SPEEDS[clock.speedIdx]);
  const setSpeed = (d) => { clock.speedIdx = Math.max(1, Math.min(SPEEDS.length - 1, clock.speedIdx + d)); clock.paused = false; };
  $('slower').onclick = () => setSpeed(-1); $('faster').onclick = () => setSpeed(1);
  $('pause').onclick = () => { clock.paused = !clock.paused; };

  // ---- UI wiring ----
  const loadMs = performance.now() - t0;
  $('loading').textContent = `Loaded ${data.buildings.length.toLocaleString()} building shapes in ${(loadMs / 1000).toFixed(1)} s.`;
  $('go').disabled = false;
  $('go').onclick = () => player.controls.lock();
  canvas.addEventListener('click', () => { if (!player.controls.isLocked) player.controls.lock(); else inspect(); });
  player.controls.addEventListener('lock', () => $('start').classList.add('hidden'));
  player.controls.addEventListener('unlock', () => $('start').classList.remove('hidden'));
  addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') $('debug').classList.toggle('hidden');
    if (e.code === 'KeyL') world.labels.visible = !world.labels.visible;
    if (e.code === 'KeyP') clock.paused = !clock.paused;
    if (e.code === 'BracketLeft') setSpeed(-1);
    if (e.code === 'BracketRight') setSpeed(1);
  });
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

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
    player.update(dt);
    lodTimer -= dt; if (lodTimer <= 0) { world.updateLod(player.state.x, player.state.y); lodTimer = 0.25; }
    crowd.update(dt, clock.hour, simDtH, player.state);
    renderer.info.reset();
    renderer.render(scene, camera);
    // HUD
    fps.frames++;
    if (now - fps.t > 500) { fps.value = (fps.frames * 1000) / (now - fps.t); fps.frames = 0; fps.t = now; }
    $('time').textContent = fmtTime(clock.hour);
    $('speed').textContent = clock.paused ? 'paused' : `${SPEEDS[clock.speedIdx]}×`;
    $('crowd').textContent = `${crowd.metrics.visible} of ${crowd.count} people outdoors · ${crowd.metrics.walking} walking`;
    if (!$('debug').classList.contains('hidden')) {
      const i = renderer.info;
      $('debug').textContent = [
        `FPS        ${fps.value.toFixed(0)}`, `draw calls ${i.render.calls}`, `triangles  ${i.render.triangles.toLocaleString()}`,
        `position   x ${player.state.x.toFixed(1)}  y ${player.state.y.toFixed(1)} m`, `walked     ${player.state.distance.toFixed(0)} m`,
        `NPC update ${crowd.metrics.updateMs.toFixed(2)} ms · full-rate ${crowd.metrics.near}`, `paths/s    ${crowd.metrics.pathsPerSec.toFixed(1)}`,
      ].join('\n');
    }
    if (inspected) {
      inspectTimer -= dt;
      const n = inspected;
      $('inspect').innerHTML = `<b>${ARCHETYPES[n.arch].label} #${n.id + 1}</b><br>${n.state === 'inside' ? 'Went indoors' : n.activity}, ${fmtTime(clock.hour)}`;
      $('inspect').classList.toggle('hidden', inspectTimer <= 0);
      if (inspectTimer <= 0) inspected = null;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Test/automation hook (used by tests/e2e.mjs). Read-only use in normal play.
  window.__miami = { THREE, data, scene, camera, renderer, world, collision, player, graph, crowd, clock, loadMs, fps };
  document.body.dataset.ready = '1';
}

main().catch((e) => { console.error(e); $('loading').textContent = `Error: ${e.message}`; });

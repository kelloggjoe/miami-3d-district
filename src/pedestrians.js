// Ambient crowd: lots of people, but only around the player.
//
// People exist inside a bubble around the camera and walk the sidewalk / footpath graph, picking a new
// direction at each corner (no route planning, so spawning thousands costs nothing at load). Anyone who
// drifts out of the bubble is moved to a sidewalk near the player, out of sight. How many are outdoors
// follows the simulated clock: busy at lunch and early evening, thin at 3 AM.
//
// Same interface the rest of the app uses for the old routine-based crowd: npcs[], count, metrics,
// pickables, update(dt, hour, simDtHours, player).
import * as THREE from 'three';
import { ARCHETYPES } from './npc.js';

const BODY_TYPES = [[1, 1], [0.95, 1.08], [1.18, 1.0], [1, 0.9], [0.86, 1.03]];
const SHIRTS = ['#e0457b', '#1f8a8a', '#f2b134', '#ffffff', '#3d5a80', '#ee6c4d', '#7a5195', '#98c1d9', '#2a9d8f', '#f4a261', '#264653', '#e9c46a', '#ffb4a2', '#6d6875'];
const PANTS = ['#2b2d42', '#3d405b', '#6c757d', '#c2b280', '#1d3557', '#5c4033', '#a8a29e'];
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a1665e'];
const ARCH = Object.keys(ARCHETYPES);

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
// share of the crowd outdoors by hour (0..1)
const BUSY = [0.12, 0.08, 0.06, 0.05, 0.05, 0.08, 0.2, 0.45, 0.7, 0.65, 0.7, 0.85, 1, 0.95, 0.8, 0.8, 0.85, 0.95, 1, 0.9, 0.75, 0.55, 0.35, 0.2];
const busyAt = (h) => { const a = Math.floor(h) % 24, f = h - Math.floor(h); return BUSY[a] * (1 - f) + BUSY[(a + 1) % 24] * f; };

export function createPedestrians(scene, data, collision, { count = 1500, radius = 350, seed = 7, density = 1 } = {}) {
  const rand = rng(seed);
  const MAX = Math.max(1, Math.round(count * density));
  // ---- walk graph (from the precomputed data) ----
  const W = data.walk, N = W.nodes.length / 2;
  const nx = new Float32Array(N), ny = new Float32Array(N);
  for (let i = 0; i < N; i++) { nx[i] = W.nodes[2 * i]; ny[i] = W.nodes[2 * i + 1]; }
  const adj = Array.from({ length: N }, () => []);
  for (let e = 0; e < W.edges.length / 3; e++) { const a = W.edges[3 * e], b = W.edges[3 * e + 1], w = W.edges[3 * e + 2]; adj[a].push([b, w]); adj[b].push([a, w]); }
  const CELL = 60, grid = new Map();
  for (let i = 0; i < N; i++) if (adj[i].length) { const k = Math.floor(nx[i] / CELL) * 100000 + Math.floor(ny[i] / CELL); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  const nodeNear = (x, y, minD, maxD) => {
    for (let t = 0; t < 25; t++) {
      const a = rand() * Math.PI * 2, d = minD + Math.sqrt(rand()) * (maxD - minD);
      const list = grid.get(Math.floor((x + Math.cos(a) * d) / CELL) * 100000 + Math.floor((y + Math.sin(a) * d) / CELL));
      if (list && list.length) return list[Math.floor(rand() * list.length)];
    }
    return -1;
  };
  // Sidewalk offset beside road edges; checked once per (edge, direction) against buildings and water.
  const offOk = new Map();
  const sideOffset = (a, b, w) => {
    if (!w) return 0;
    const key = a * 1048576 + b;
    let ok = offOk.get(key);
    if (ok === undefined) {
      const dx = nx[b] - nx[a], dy = ny[b] - ny[a], L = Math.hypot(dx, dy) || 1, o = w / 2 + 1.6;
      const px = dy / L * o, py = -dx / L * o;
      ok = !collision.blocked(nx[a] + px, ny[a] + py, 0.4) && !collision.blocked(nx[b] + px, ny[b] + py, 0.4) && !collision.blocked((nx[a] + nx[b]) / 2 + px, (ny[a] + ny[b]) / 2 + py, 0.4);
      offOk.set(key, ok);
    }
    return ok ? w / 2 + 1.6 : 0;
  };

  // ---- instanced bodies ----
  const parts = {
    torso: new THREE.BoxGeometry(0.42, 0.6, 0.24).translate(0, 1.18, 0), head: new THREE.BoxGeometry(0.22, 0.24, 0.22).translate(0, 1.62, 0),
    leg: new THREE.BoxGeometry(0.16, 0.86, 0.16).translate(0, -0.43, 0), arm: new THREE.BoxGeometry(0.11, 0.58, 0.11).translate(0, -0.29, 0),
  };
  const mat = () => new THREE.MeshLambertMaterial({ color: '#fff' });
  const meshes = {
    torso: new THREE.InstancedMesh(parts.torso, mat(), MAX), head: new THREE.InstancedMesh(parts.head, mat(), MAX),
    legL: new THREE.InstancedMesh(parts.leg, mat(), MAX), legR: new THREE.InstancedMesh(parts.leg, mat(), MAX),
    armL: new THREE.InstancedMesh(parts.arm, mat(), MAX), armR: new THREE.InstancedMesh(parts.arm, mat(), MAX),
  };
  for (const m of Object.values(meshes)) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0; scene.add(m); }

  const npcs = [];
  const c = new THREE.Color();
  for (let i = 0; i < MAX; i++) {
    const arch = ARCH[Math.floor(rand() * ARCH.length)];
    npcs.push({ id: i, arch, x: 0, y: 0, a: -1, b: -1, w: 0, t: 0, lat: (rand() - 0.5) * 1.2, speed: 1.1 + rand() * 0.5, heading: 0, phase: rand() * 6.28,
      body: BODY_TYPES[Math.floor(rand() * BODY_TYPES.length)], state: 'walking', activity: '', idle: 0, acc: 0, rank: rand() });
    meshes.torso.setColorAt(i, c.set(SHIRTS[Math.floor(rand() * SHIRTS.length)])); meshes.armL.setColorAt(i, c); meshes.armR.setColorAt(i, c);
    c.set(PANTS[Math.floor(rand() * PANTS.length)]); meshes.legL.setColorAt(i, c); meshes.legR.setColorAt(i, c);
    meshes.head.setColorAt(i, c.set(SKIN[Math.floor(rand() * SKIN.length)]));
  }
  for (const m of Object.values(meshes)) if (m.instanceColor) m.instanceColor.needsUpdate = true;

  function place(n, x, y, minD, maxD) {
    const s = nodeNear(x, y, minD, maxD); if (s < 0 || !adj[s].length) return false;
    const [b, w] = adj[s][Math.floor(rand() * adj[s].length)];
    n.a = s; n.b = b; n.w = w; n.t = rand(); n.idle = 0; return true;
  }
  function activityFor(n, hour) {
    const plan = ARCHETYPES[n.arch].plan; let step = plan[0];
    for (const p of plan) if (hour >= p[0]) step = p;
    return step[3] === 'inside' ? 'Out for a walk' : step[1];
  }

  const tmp = { m: new THREE.Matrix4(), b: new THREE.Matrix4(), r: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
  const metrics = { updateMs: 0, visible: 0, walking: 0, near: 0, pathsPerSec: 0 };
  let frame = 0, placedAll = false, active = MAX;

  function update(dt, hour, simDtH, player, camera) {
    const t0 = performance.now(); frame++;
    const cx = camera ? camera.position.x : player.x, cy = camera ? -camera.position.z : player.y;
    const alt = camera ? Math.max(0, camera.position.y - 2) : 0;
    const R = radius + Math.min(600, alt * 1.5);
    const want = Math.round(MAX * busyAt(hour));
    // spread the initial placement over a few frames so the first frame stays fast
    if (!placedAll) { let k = 0; for (const n of npcs) if (n.a < 0 && k++ < 400) { if (!place(n, cx, cy, 0, R)) n.a = -2; } placedAll = npcs.every((n) => n.a !== -1); }
    let shown = 0, walking = 0, near = 0;
    for (let i = 0; i < MAX; i++) {
      const n = npcs[i];
      const on = n.rank * MAX < want && n.a >= 0;
      if (!on) { n.state = 'inside'; continue; }
      n.state = 'walking';
      const d = Math.hypot(n.x - cx, n.y - cy);
      if (d > R + 120) { if (!place(n, cx, cy, Math.min(R * 0.6, 150 + alt), R)) { n.state = 'inside'; continue; } }
      // update rate by distance: close people every frame, the rest in turns
      const every = d < 60 ? 1 : d < 180 ? 2 : 4;
      n.acc += dt;
      if ((frame + i) % every !== 0) { shown++; continue; }
      const step = n.acc; n.acc = 0;
      if (n.idle > 0) n.idle -= step;
      else {
        let ax = nx[n.a], ay = ny[n.a], bx = nx[n.b], by = ny[n.b];
        let L = Math.hypot(bx - ax, by - ay) || 0.5;
        n.t += (n.speed * step) / L;
        if (n.t >= 1) {
          const opts = adj[n.b].filter((e) => e[0] !== n.a);
          const nxt = opts.length ? opts[Math.floor(rand() * opts.length)] : adj[n.b][0];
          n.a = n.b; n.b = nxt[0]; n.w = nxt[1]; n.t = 0;
          if (rand() < 0.04) n.idle = 2 + rand() * 6; // stop to look around now and then
          ax = nx[n.a]; ay = ny[n.a]; bx = nx[n.b]; by = ny[n.b]; L = Math.hypot(bx - ax, by - ay) || 0.5;
        }
        const ux = (bx - ax) / L, uy = (by - ay) / L, off = sideOffset(n.a, n.b, n.w) + n.lat;
        n.x = ax + (bx - ax) * n.t + uy * off; n.y = ay + (by - ay) * n.t - ux * off;
        n.heading = Math.atan2(ux, -uy);
        if (d < 60) { n.phase += step * n.speed * 5.2; near++; }
        walking++;
      }
      shown++;
      const moving = n.idle <= 0, swing = moving && d < 120 ? Math.sin(n.phase) * 0.55 : 0, bob = moving && d < 60 ? Math.abs(Math.cos(n.phase)) * 0.04 : 0;
      tmp.q.setFromAxisAngle(tmp.up, n.heading);
      tmp.b.compose(tmp.p.set(n.x, bob, -n.y), tmp.q, tmp.s.set(n.body[0], n.body[1], n.body[0]));
      meshes.torso.setMatrixAt(i, tmp.b); meshes.head.setMatrixAt(i, tmp.b);
      const limb = (mesh, ox, oy, ang) => { tmp.r.makeRotationX(ang).setPosition(ox, oy, 0); tmp.m.multiplyMatrices(tmp.b, tmp.r); mesh.setMatrixAt(i, tmp.m); };
      limb(meshes.legL, -0.11, 0.88, swing); limb(meshes.legR, 0.11, 0.88, -swing);
      limb(meshes.armL, -0.27, 1.45, -swing * 0.8); limb(meshes.armR, 0.27, 1.45, swing * 0.8);
    }
    // hidden people: zero-scale matrices (only when the set shrinks; cheap)
    const hide = tmp.m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) if (npcs[i].state === 'inside') for (const m of Object.values(meshes)) m.setMatrixAt(i, hide);
    for (const m of Object.values(meshes)) { m.instanceMatrix.needsUpdate = true; m.count = MAX; }
    if (frame % 30 === 1) for (const n of npcs) if (n.state !== 'inside') n.activity = activityFor(n, hour);
    active = MAX;
    metrics.visible = shown; metrics.walking = walking; metrics.near = near;
    metrics.updateMs = metrics.updateMs * 0.9 + (performance.now() - t0) * 0.1;
  }
  return { update, npcs, meshes, metrics, get count() { return active; }, pickables: [meshes.torso, meshes.head], setCount() {} };
}

// Cars: parked along curbs and moving traffic on the road network.
//
// Models: Kenney "Car Kit" (CC0, www.kenney.nl), assets/cars/*.glb. Every model uses the same texture atlas,
// so all cars of one kind (parked / moving) draw as a single THREE.BatchedMesh: one draw call, per-car
// frustum culling, and far cars hidden.
//
// Traffic is a "bubble" around the camera: a fixed number of cars drive the real road graph (right-hand side,
// keeping a gap to the car ahead, sometimes pausing at junctions); cars that fall too far behind are moved
// to roads near the camera, out of sight, so traffic looks dense wherever you are.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const URLS = import.meta.glob('../assets/cars/*.glb', { query: '?url', import: 'default', eager: true });
// Real-world length (m) per model; Kenney models are scaled to these. weight = how common it is in traffic.
const MODELS = {
  sedan: { len: 4.7, weight: 6, parked: 'car' }, 'sedan-sports': { len: 4.6, weight: 2, parked: 'car' },
  'hatchback-sports': { len: 4.3, weight: 2, parked: 'car' }, taxi: { len: 4.8, weight: 2, parked: 'car' },
  suv: { len: 4.8, weight: 4, parked: 'suv' }, 'suv-luxury': { len: 5.0, weight: 3, parked: 'suv' },
  van: { len: 5.2, weight: 2, parked: 'suv' }, truck: { len: 5.6, weight: 2, parked: 'suv' },
  police: { len: 5.0, weight: 1 }, delivery: { len: 6.8, weight: 1 }, ambulance: { len: 6.8, weight: 0.3 },
  'garbage-truck': { len: 8.0, weight: 0.3 },
};

export async function loadCarModels() {
  const loader = new GLTFLoader();
  const out = {}; let material = null;
  await Promise.all(Object.entries(URLS).map(async ([path, url]) => {
    const name = path.split('/').pop().replace('.glb', '');
    if (!MODELS[name]) return;
    const gltf = await loader.loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (!material) material = o.material;
      const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      parts.push(g.index ? g : g.toNonIndexed());
    });
    let geom = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    geom.computeBoundingBox();
    const bb = geom.boundingBox, size = bb.getSize(new THREE.Vector3());
    const s = MODELS[name].len / size.z; // models are built along Z
    geom.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    geom.scale(s, s, s);
    geom.computeBoundingBox(); geom.computeBoundingSphere();
    out[name] = { geom, ...MODELS[name] };
  }));
  if (material) { material = material.clone(); material.roughness = 0.45; material.metalness = 0.15; }
  return { models: out, material };
}

function weightedPicker(models, filter, rand) {
  const list = Object.entries(models).filter(([, m]) => filter(m));
  const total = list.reduce((a, [, m]) => a + m.weight, 0);
  return () => { let r = rand() * total; for (const [n, m] of list) { r -= m.weight; if (r <= 0) return n; } return list[0][0]; };
}
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

function makeBatch(models, material, maxInstances) {
  let verts = 0;
  for (const m of Object.values(models)) verts += m.geom.attributes.position.count;
  const bm = new THREE.BatchedMesh(maxInstances, verts, 0, material);
  const ids = {};
  for (const [n, m] of Object.entries(models)) ids[n] = bm.addGeometry(m.geom);
  bm.perObjectFrustumCulled = true;
  bm.sortObjects = false;
  return { bm, ids };
}

const DRIVE = { motorway: 24, trunk: 20, primary: 14, secondary: 13, tertiary: 11, unclassified: 9, residential: 8, living_street: 5, service: 5,
  motorway_link: 14, trunk_link: 12, primary_link: 10, secondary_link: 10, tertiary_link: 9 };

// ------------------------------------------------------------------ road graph for driving
function buildRoadGraph(roads) {
  const key = (x, y) => `${Math.round(x * 2)},${Math.round(y * 2)}`; // 0.5 m snapping joins ways at shared nodes
  const idx = new Map(), nx = [], ny = [], adj = [];
  const node = (x, y) => { const k = key(x, y); let i = idx.get(k); if (i === undefined) { i = nx.length; idx.set(k, i); nx.push(x); ny.push(y); adj.push([]); } return i; };
  for (const r of roads) {
    const v = DRIVE[r.t]; if (!v || r.c.length < 4) continue;
    let prev = node(r.c[0], r.c[1]);
    for (let i = 2; i < r.c.length; i += 2) {
      const cur = node(r.c[i], r.c[i + 1]);
      if (cur !== prev) { adj[prev].push({ to: cur, w: r.w, v }); adj[cur].push({ to: prev, w: r.w, v }); }
      prev = cur;
    }
  }
  return { nx, ny, adj, n: nx.length };
}

export function createVehicles(scene, data, Q, carKit, parkedSpots, collision, opts = {}) {
  const { models, material } = carKit;
  const rand = rng(99);
  const stats = { models: Object.keys(models).length };
  const castShadow = !!Q.shadows;

  // ---------------- parked cars (static) ----------------
  const pickCar = weightedPicker(models, (m) => m.parked === 'car', rand);
  const pickSuv = weightedPicker(models, (m) => m.parked === 'suv', rand);
  const parked = makeBatch(models, material, Math.max(1, parkedSpots.length));
  const pm = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const parkedPos = [];
  for (const s of parkedSpots) {
    const name = s.suv ? pickSuv() : pickCar();
    const id = parked.bm.addInstance(parked.ids[name]);
    q.setFromAxisAngle(up, s.rot);
    parked.bm.setMatrixAt(id, pm.compose(p.set(s.x, 0.02, -s.y), q, one));
    parkedPos.push([id, s.x, s.y]);
  }
  parked.bm.castShadow = castShadow; parked.bm.receiveShadow = true;
  scene.add(parked.bm);
  stats.parked = parkedSpots.length;

  // ---------------- moving traffic ----------------
  const G = buildRoadGraph(data.roads);
  const COUNT = Math.round((Q.id === 'low' ? 300 : Q.id === 'high' ? 900 : 600) * (opts.density || 1));
  const R = 650, VIS = 420;
  const pickAny = weightedPicker(models, () => true, rand);
  const traffic = makeBatch(models, material, COUNT);
  traffic.bm.castShadow = castShadow; traffic.bm.receiveShadow = true;
  scene.add(traffic.bm);
  const cars = [];
  const center = { x: data.meta.start ? data.meta.start.x : data.meta.spawn[0], y: data.meta.start ? data.meta.start.y : data.meta.spawn[1] };

  // grid of graph nodes for spawning near a point
  const CELL = 100, ngrid = new Map();
  for (let i = 0; i < G.n; i++) if (G.adj[i].length) { const k = Math.floor(G.nx[i] / CELL) * 100000 + Math.floor(G.ny[i] / CELL); (ngrid.get(k) || ngrid.set(k, []).get(k)).push(i); }
  function randomNodeNear(x, y, minD, maxD) {
    for (let t = 0; t < 30; t++) {
      const a = rand() * Math.PI * 2, d = minD + rand() * (maxD - minD);
      const k = Math.floor((x + Math.cos(a) * d) / CELL) * 100000 + Math.floor((y + Math.sin(a) * d) / CELL);
      const list = ngrid.get(k); if (list && list.length) return list[Math.floor(rand() * list.length)];
    }
    return -1;
  }
  function place(c, x, y, minD, maxD) {
    const n = randomNodeNear(x, y, minD, maxD); if (n < 0) return false;
    const e = G.adj[n][Math.floor(rand() * G.adj[n].length)];
    c.a = n; c.b = e.to; c.e = e; c.t = rand(); c.speed = e.v * (0.6 + rand() * 0.3); c.wait = 0;
    return true;
  }
  for (let i = 0; i < COUNT; i++) {
    const name = pickAny();
    const id = traffic.bm.addInstance(traffic.ids[name]);
    const c = { id, len: models[name].len, vmul: 0.85 + rand() * 0.3, a: 0, b: 0, e: null, t: 0, speed: 0, wait: 0, x: 0, y: 0, yaw: 0, vis: true };
    if (!place(c, center.x, center.y, 0, R)) { traffic.bm.setVisibleAt(id, false); c.dead = true; }
    cars.push(c);
  }
  stats.traffic = COUNT; stats.roadNodes = G.n;

  function nextEdge(c) {
    // choose the outgoing edge at node b that turns least (60%) or a random one; avoid U-turns unless dead end
    const from = c.a, at = c.b, opts = G.adj[at].filter((e) => e.to !== from);
    if (!opts.length) return G.adj[at][0];
    const dx = G.nx[at] - G.nx[from], dy = G.ny[at] - G.ny[from], L = Math.hypot(dx, dy) || 1;
    if (opts.length > 1 && rand() < 0.6) {
      let best = opts[0], bd = -2;
      for (const e of opts) { const ex = G.nx[e.to] - G.nx[at], ey = G.ny[e.to] - G.ny[at], el = Math.hypot(ex, ey) || 1; const d = (dx * ex + dy * ey) / (L * el); if (d > bd) { bd = d; best = e; } }
      return best;
    }
    return opts[Math.floor(rand() * opts.length)];
  }

  const hash = new Map();
  const m4 = new THREE.Matrix4(), quat = new THREE.Quaternion(), pos = new THREE.Vector3();
  let cullTimer = 0;
  function update(dt, camera) {
    dt = Math.min(dt, 0.1);
    const cx = camera.position.x, cy = -camera.position.z;
    // spatial hash of current car positions (for following distance)
    hash.clear();
    for (const c of cars) { if (c.dead) continue; const k = Math.floor(c.x / 12) * 100000 + Math.floor(c.y / 12); (hash.get(k) || hash.set(k, []).get(k)).push(c); }
    for (const c of cars) {
      if (c.dead) { if (place(c, cx, cy, 250, R)) { c.dead = false; } else continue; }
      const ax = G.nx[c.a], ay = G.ny[c.a], bx = G.nx[c.b], by = G.ny[c.b];
      const segL = Math.hypot(bx - ax, by - ay) || 0.01, ux = (bx - ax) / segL, uy = (by - ay) / segL;
      // gap to the car ahead in the same direction
      let target = c.e.v * c.vmul;
      const lx = c.x + ux * (c.len + 6), ly = c.y + uy * (c.len + 6);
      for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) for (const o of hash.get((Math.floor(lx / 12) + gx) * 100000 + Math.floor(ly / 12) + gy) || []) {
        if (o === c) continue;
        const ox = o.x - c.x, oy = o.y - c.y, along = ox * ux + oy * uy, side = Math.abs(-ox * uy + oy * ux);
        if (along > 0 && along < c.len + 7 && side < 2.2 && Math.cos(o.yaw - c.yaw) > 0.3) target = Math.min(target, Math.max(0, (along - c.len - 2) * 1.2));
      }
      if (c.wait > 0) { c.wait -= dt; target = 0; }
      c.speed += Math.max(-7 * dt, Math.min(3 * dt, target - c.speed));
      c.t += (c.speed * dt) / segL;
      while (c.t >= 1) {
        const e = nextEdge(c); const rest = (c.t - 1) * segL;
        c.a = c.b; c.b = e.to; c.e = e;
        const nl = Math.hypot(G.nx[c.b] - G.nx[c.a], G.ny[c.b] - G.ny[c.a]) || 0.01;
        c.t = rest / nl;
        if (G.adj[c.a].length > 2 && rand() < 0.25) c.wait = 0.8 + rand() * 2.5; // pause at some junctions
      }
      // right-hand lane offset
      const sx = G.nx[c.a] + (G.nx[c.b] - G.nx[c.a]) * c.t, sy = G.ny[c.a] + (G.ny[c.b] - G.ny[c.a]) * c.t;
      const off = c.e.w >= 5.5 ? Math.max(1.6, Math.min(c.e.w / 4, 4.5)) : 0;
      c.x = sx + uy * off; c.y = sy - ux * off;
      const yaw = Math.atan2(ux, -uy); // local +Z faces the direction of travel
      let dy = yaw - c.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); c.yaw += dy * Math.min(1, dt * 8);
      const d = Math.hypot(c.x - cx, c.y - cy);
      if (d > R + 150) { c.dead = true; traffic.bm.setVisibleAt(c.id, false); c.vis = false; continue; }
      const vis = d < VIS + camera.position.y * 1.5;
      if (vis !== c.vis) { traffic.bm.setVisibleAt(c.id, vis); c.vis = vis; }
      if (vis) { quat.setFromAxisAngle(up, c.yaw); traffic.bm.setMatrixAt(c.id, m4.compose(pos.set(c.x, 0.03, -c.y), quat, one)); }
    }
    // parked cars: hide the far ones a few times a second
    cullTimer -= dt;
    if (cullTimer <= 0) {
      cullTimer = 0.3;
      const lim = 320 + camera.position.y * 1.2;
      for (const [id, x, y] of parkedPos) parked.bm.setVisibleAt(id, Math.abs(x - cx) < lim && Math.abs(y - cy) < lim);
    }
  }
  function setVisible(v) { parked.bm.visible = v; traffic.bm.visible = v; }
  return { update, stats, cars, setVisible, parked: parked.bm, traffic: traffic.bm };
}

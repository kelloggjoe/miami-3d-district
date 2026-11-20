// Street detail for Medium/High quality: palms and shade trees, street lamps, benches,
// bus shelters, and static parked cars. All instanced (one draw call per prop type).
//
// Placement sources (see DECISIONS.md):
//   trees, benches, bus shelters, OSM street lamps -> OpenStreetMap nodes
//   extra street lamps along major roads, parked cars -> generated (decorative, not from data)
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

// Non-indexed geometry with a constant vertex color, without uvs (so pieces merge cleanly).
function part(geom, color, transform) {
  let g = geom.index ? geom.toNonIndexed() : geom;
  g.deleteAttribute('uv'); g.deleteAttribute('normal'); // normals are recomputed after merging
  if (transform) g.applyMatrix4(transform);
  const c = new THREE.Color(color), n = g.attributes.position.count;
  const col = new Float32Array(n * 3); for (let i = 0; i < n; i++) { col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
const M = () => new THREE.Matrix4();
const merge = (parts) => { const g = mergeGeometries(parts, false); g.computeVertexNormals(); return g; };

// ---------------------------------------------------------------- models
function palmGeometry() {
  const trunk = new THREE.CylinderGeometry(0.15, 0.24, 10, 5, 6, true).toNonIndexed();
  trunk.translate(0, 5, 0);
  const p = trunk.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), k = 1 + 0.07 * Math.sin(y * 7);
    p.setX(i, p.getX(i) * k + 0.012 * y * y); p.setZ(i, p.getZ(i) * k);
  }
  const parts = [part(trunk, '#9a7b57')];
  const top = new THREE.Vector3(1.2, 10, 0);
  const fronds = [];
  for (let f = 0; f < 9; f++) {
    const a = (f / 9) * Math.PI * 2 + (f % 2) * 0.2, L = 3.2 + (f % 3) * 0.35, rise = f % 2 ? 0.9 : 0.4;
    const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), s = new THREE.Vector3(-d.z, 0, d.x);
    const pts = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4, w = 0.62 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.04;
      const c = top.clone().addScaledVector(d, L * t).add(new THREE.Vector3(0, rise * t - 2.6 * t * t, 0));
      pts.push([c.clone().addScaledVector(s, w).add(new THREE.Vector3(0, -0.12 * w, 0)), c.clone().add(new THREE.Vector3(0, 0.06, 0)), c.clone().addScaledVector(s, -w).add(new THREE.Vector3(0, -0.12 * w, 0))]);
    }
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
      const a0 = pts[i][j], b0 = pts[i][j + 1], a1 = pts[i + 1][j], b1 = pts[i + 1][j + 1];
      fronds.push(a0, a1, b1, a0, b1, b0);
    }
  }
  const fg = new THREE.BufferGeometry().setFromPoints(fronds);
  parts.push(part(fg, '#5e9b45'));
  parts.push(part(new THREE.IcosahedronGeometry(0.32, 0), '#6b5233', M().makeTranslation(1.2, 9.8, 0)));
  return merge(parts);
}

function shadeTreeGeometry() {
  const parts = [part(new THREE.CylinderGeometry(0.16, 0.26, 3.2, 5, 1, true), '#7a5c40', M().makeTranslation(0, 1.6, 0))];
  const blobs = [[0, 4.4, 0, 1.9, '#4f8f3f'], [1.1, 3.9, 0.4, 1.4, '#5a9a45'], [-0.9, 4.0, -0.5, 1.5, '#46833a'], [0.2, 5.3, -0.3, 1.3, '#5fa24a']];
  for (const [x, y, z, r, c] of blobs) parts.push(part(new THREE.IcosahedronGeometry(r, 0), c, M().makeTranslation(x, y, z)));
  return merge(parts);
}

function lampGeometry() { // arm points toward +x (the road)
  return merge([
    part(new THREE.CylinderGeometry(0.07, 0.12, 8, 5, 1, true), '#3d444b', M().makeTranslation(0, 4, 0)),
    part(new THREE.BoxGeometry(1.8, 0.08, 0.08), '#3d444b', M().makeTranslation(0.9, 7.9, 0)),
    part(new THREE.BoxGeometry(0.6, 0.14, 0.3), '#e8e4d6', M().makeTranslation(1.75, 7.82, 0)),
  ]);
}

function benchGeometry() { // faces +z
  return merge([
    part(new THREE.BoxGeometry(1.7, 0.07, 0.45), '#9c6b43', M().makeTranslation(0, 0.45, 0)),
    part(new THREE.BoxGeometry(1.7, 0.4, 0.06), '#9c6b43', M().makeTranslation(0, 0.75, -0.22)),
    part(new THREE.BoxGeometry(0.06, 0.45, 0.45), '#33383d', M().makeTranslation(-0.75, 0.22, 0)),
    part(new THREE.BoxGeometry(0.06, 0.45, 0.45), '#33383d', M().makeTranslation(0.75, 0.22, 0)),
  ]);
}

function shelterGeometry() { // open side faces +z (the road)
  return merge([
    part(new THREE.BoxGeometry(3.8, 0.12, 1.7), '#e6e8ea', M().makeTranslation(0, 2.6, 0)),
    ...[-1.8, 1.8].map((x) => part(new THREE.BoxGeometry(0.1, 2.6, 0.1), '#5a6168', M().makeTranslation(x, 1.3, -0.7))),
    part(new THREE.BoxGeometry(3.4, 0.06, 0.4), '#5a6168', M().makeTranslation(0, 0.5, -0.5)),
  ]);
}
function shelterGlass() { return new THREE.BoxGeometry(3.6, 2.1, 0.04).translate(0, 1.4, -0.72); }

function carGeometry(suv) { // length along +z; body color is white so instance color tints it
  const L = suv ? 4.8 : 4.6, W = suv ? 1.9 : 1.8, bodyH = suv ? 0.85 : 0.68, cabH = suv ? 0.75 : 0.58, cabL = suv ? 3.0 : 2.4;
  const cabin = new THREE.BoxGeometry(W * 0.9, cabH, cabL).toNonIndexed();
  const p = cabin.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) { p.setZ(i, p.getZ(i) * (suv ? 0.9 : 0.72)); p.setX(i, p.getX(i) * 0.94); }
  const parts = [
    part(new THREE.BoxGeometry(W, bodyH, L), '#ffffff', M().makeTranslation(0, 0.3 + bodyH / 2, 0)),
    part(cabin, '#2a3036', M().makeTranslation(0, 0.3 + bodyH + cabH / 2, suv ? -0.2 : -0.15)),
  ];
  for (const [x, z] of [[-W / 2 + 0.05, L * 0.32], [W / 2 - 0.05, L * 0.32], [-W / 2 + 0.05, -L * 0.32], [W / 2 - 0.05, -L * 0.32]])
    parts.push(part(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 6), '#141414', M().makeRotationZ(Math.PI / 2).setPosition(x, 0.34, z)));
  return merge(parts);
}

// ---------------------------------------------------------------- placement helpers
const FOOT = new Set(['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'track']);
function roadIndex(roads) {
  const CELL = 30, grid = new Map(), segs = [];
  roads.forEach((r, ri) => {
    if (FOOT.has(r.t) && r.ft !== 'crossing') return;
    for (let i = 0; i < r.c.length - 2; i += 2) {
      const s = { ri, ax: r.c[i], ay: r.c[i + 1], bx: r.c[i + 2], by: r.c[i + 3], w: r.w, crossing: r.ft === 'crossing' };
      segs.push(s);
      const x0 = Math.min(s.ax, s.bx), x1 = Math.max(s.ax, s.bx), y0 = Math.min(s.ay, s.by), y1 = Math.max(s.ay, s.by);
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        const k = gx * 100000 + gy; (grid.get(k) || grid.set(k, []).get(k)).push(s);
      }
    }
  });
  const dist = (s, x, y) => { const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / l2)); return { d: Math.hypot(x - s.ax - t * dx, y - s.ay - t * dy), t, dx, dy }; };
  function nearby(x, y, r, fn) {
    for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++) for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++)
      for (const s of grid.get(gx * 100000 + gy) || []) fn(s);
  }
  function nearest(x, y, r = 40, pred = (s) => !s.crossing) {
    let best = null; nearby(x, y, r, (s) => { if (!pred(s)) return; const q = dist(s, x, y); if (!best || q.d < best.d) best = { ...q, s }; }); return best;
  }
  return { nearby, nearest, dist };
}

// ---------------------------------------------------------------- build
export function buildProps(scene, data, collision, { castShadow = true, useCarModels = false } = {}) {
  const rand = rng(42);
  const roadsIdx = roadIndex(data.roads);
  const stats = {};
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  // One InstancedMesh per prop type per 250 m chunk, so frustum culling (camera and shadow) and
  // distance hiding skip most props. Chunks farther than PROP_RANGE from the camera are hidden.
  const CH = 250, chunkMeshes = [];
  const instanced = (geom, mat, list, shadow = castShadow) => {
    const groups = new Map();
    for (const it of list) { const k = `${Math.floor(it.x / CH)},${Math.floor(it.y / CH)}`; (groups.get(k) || groups.set(k, []).get(k)).push(it); }
    for (const [k, items] of groups) {
      const mesh = instancedOne(geom, mat, items, shadow);
      const [gx, gy] = k.split(',').map(Number); chunkMeshes.push({ mesh, cx: (gx + 0.5) * CH, cy: (gy + 0.5) * CH });
    }
  };
  const instancedOne = (geom, mat, list, shadow) => {
    const mesh = new THREE.InstancedMesh(geom, mat, Math.max(1, list.length));
    list.forEach((it, i) => {
      q.setFromAxisAngle(up, it.rot || 0);
      if (it.tilt) q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(it.tilt[0], 0, it.tilt[1])));
      mesh.setMatrixAt(i, m4.compose(p.set(it.x, 0, -it.y), q, s.set(it.sx || it.s || 1, it.s || 1, it.sz || it.s || 1)));
      if (it.color) mesh.setColorAt(i, col.set(it.color));
    });
    mesh.count = list.length; mesh.castShadow = shadow; mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    scene.add(mesh); return mesh;
  };
  const vc = (opts = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true, ...opts });
  // rotation so that local +z points along data-frame direction (dx, dy)
  const facing = (dx, dy) => Math.atan2(dx, -dy);

  // Trees (OSM natural=tree)
  const palms = [], shade = [];
  for (let i = 0; i < data.poi.tree.length / 2; i++) {
    const x = data.poi.tree[2 * i], y = data.poi.tree[2 * i + 1], r = rand();
    const tint = new THREE.Color().setHSL(0, 0, 0.85 + rand() * 0.25);
    if (r < 0.55) palms.push({ x, y, rot: rand() * 6.28, s: 0.7 + rand() * 0.6, tilt: [(rand() - 0.5) * 0.12, (rand() - 0.5) * 0.12], color: tint });
    else shade.push({ x, y, rot: rand() * 6.28, s: 0.8 + rand() * 0.5, color: tint });
  }
  instanced(palmGeometry(), vc({ side: THREE.DoubleSide }), palms);
  instanced(shadeTreeGeometry(), vc(), shade);
  stats.palms = palms.length; stats.shadeTrees = shade.length;

  // Street lamps: OSM nodes + generated every 38 m along both sides of major roads.
  const lamps = [];
  const addLamp = (x, y) => {
    const nr = roadsIdx.nearest(x, y, 30);
    let rot = rand() * 6.28;
    if (nr) { const t = nr.t, cx = nr.s.ax + nr.dx * t, cy = nr.s.ay + nr.dy * t; rot = Math.atan2(cy - y, cx - x); } // arm (+x) toward the road
    lamps.push({ x, y, rot });
  };
  for (let i = 0; i < data.poi.lamp.length / 2; i++) addLamp(data.poi.lamp[2 * i], data.poi.lamp[2 * i + 1]);
  const osmLamps = lamps.length;
  for (const r of data.roads) {
    if (!['primary', 'secondary', 'tertiary'].includes(r.t) || r.w < 8 || r.b) continue;
    let acc = 19;
    for (let i = 0; i < r.c.length - 2 && lamps.length < 3000; i += 2) {
      const ax = r.c[i], ay = r.c[i + 1], dx = r.c[i + 2] - ax, dy = r.c[i + 3] - ay, L = Math.hypot(dx, dy);
      for (; acc < L; acc += 38) for (const side of [1, -1]) {
        const ux = dx / L, uy = dy / L, off = r.w / 2 + 0.9;
        const x = ax + ux * acc + uy * off * side, y = ay + uy * acc - ux * off * side;
        if (!collision.blocked(x, y, 0.6)) lamps.push({ x, y, rot: 0 });
      }
      acc -= L;
    }
  }
  // arm rotation for generated lamps: point toward the road center (perpendicular to the road)
  for (let i = osmLamps; i < lamps.length; i++) {
    const l = lamps[i]; const nr = roadsIdx.nearest(l.x, l.y, 20);
    if (nr) { const cx = nr.s.ax + nr.dx * nr.t, cy = nr.s.ay + nr.dy * nr.t; l.rot = Math.atan2(cy - l.y, cx - l.x); }
  }
  instanced(lampGeometry(), vc({ roughness: 0.6, metalness: 0.4 }), lamps);
  stats.lampsOsm = osmLamps; stats.lampsGenerated = lamps.length - osmLamps;

  // Benches (OSM amenity=bench), facing the nearest path or road.
  const benches = [];
  for (let i = 0; i < data.poi.bench.length / 2; i++) {
    const x = data.poi.bench[2 * i], y = data.poi.bench[2 * i + 1];
    let best = null;
    for (const r of data.roads) { if (!FOOT.has(r.t)) continue; for (let k = 0; k < r.c.length - 2; k += 2) { const q2 = roadsIdx.dist({ ax: r.c[k], ay: r.c[k + 1], bx: r.c[k + 2], by: r.c[k + 3] }, x, y); if (q2.d < 25 && (!best || q2.d < best.d)) best = { ...q2, ax: r.c[k], ay: r.c[k + 1] }; } }
    const rot = best ? facing(best.ax + best.dx * best.t - x, best.ay + best.dy * best.t - y) : rand() * 6.28;
    benches.push({ x, y, rot });
  }
  instanced(benchGeometry(), vc({ roughness: 0.7 }), benches);
  stats.benches = benches.length;

  // Bus shelters (OSM bus stops), set back from the nearest road edge, open side facing it.
  const shelters = [];
  for (let i = 0; i < data.poi.bus.length / 2; i++) {
    const x0 = data.poi.bus[2 * i], y0 = data.poi.bus[2 * i + 1];
    const nr = roadsIdx.nearest(x0, y0, 25); if (!nr) continue;
    const L = Math.hypot(nr.dx, nr.dy) || 1, ux = nr.dx / L, uy = nr.dy / L;
    const cx = nr.s.ax + nr.dx * nr.t, cy = nr.s.ay + nr.dy * nr.t;
    let side = Math.sign((x0 - cx) * uy - (y0 - cy) * ux) || 1; // which side of the road the stop is on
    const off = nr.s.w / 2 + 2.6, x = cx + uy * off * side, y = cy - ux * off * side;
    if (collision.blocked(x, y, 1.0)) continue;
    shelters.push({ x, y, rot: facing(-uy * side, ux * side) });
  }
  instanced(shelterGeometry(), vc({ roughness: 0.5, metalness: 0.3 }), shelters);
  instanced(shelterGlass(), new THREE.MeshStandardMaterial({ color: '#bfe3f0', transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.1 }), shelters, false);
  stats.busShelters = shelters.length;

  // Parked cars: curb lanes of local streets, away from intersections, crossings and bus stops.
  const PARK = new Set(['residential', 'tertiary', 'unclassified', 'secondary', 'living_street']);
  const PAINT = ['#f4f4f2', '#c9ccd1', '#1d1f22', '#9b1c1c', '#1f3f73', '#6b7178', '#2f4f3a', '#e8e1d0', '#3a3d42'];
  const cars = [[], []], carPolys = [];
  const busXY = []; for (let i = 0; i < data.poi.bus.length; i += 2) busXY.push([data.poi.bus[i], data.poi.bus[i + 1]]);
  outer: for (let ri = 0; ri < data.roads.length; ri++) {
    const r = data.roads[ri];
    if (!PARK.has(r.t) || r.w < 7 || r.b) continue;
    let acc = 10;
    for (let i = 0; i < r.c.length - 2; i += 2) {
      const ax = r.c[i], ay = r.c[i + 1], dx = r.c[i + 2] - ax, dy = r.c[i + 3] - ay, L = Math.hypot(dx, dy);
      if (L < 1) continue;
      const ux = dx / L, uy = dy / L;
      for (; acc < L - 3; acc += 6.4) for (const side of [1, -1]) {
        if (rand() > 0.42) continue;
        const off = r.w / 2 - 1.15, x = ax + ux * acc + uy * off * side, y = ay + uy * acc - ux * off * side;
        let ok = true;
        roadsIdx.nearby(x, y, 20, (sg) => { if (!ok || sg.ri === ri) return; const q2 = roadsIdx.dist(sg, x, y); if (q2.d < (sg.crossing ? 5 : sg.w / 2 + 6)) ok = false; });
        if (!ok || busXY.some(([bx, by]) => Math.hypot(bx - x, by - y) < 18)) continue;
        if (collision.blocked(x, y, 1.6) || collision.blocked(x + ux * 2.3, y + uy * 2.3, 0.9) || collision.blocked(x - ux * 2.3, y - uy * 2.3, 0.9)) continue;
        const suv = rand() < 0.35, list = cars[suv ? 1 : 0];
        list.push({ x, y, rot: facing(ux * side, uy * side), color: PAINT[Math.floor(rand() * PAINT.length)] });
        const hl = (suv ? 4.8 : 4.6) / 2, hw = (suv ? 1.9 : 1.8) / 2;
        carPolys.push([[x - ux * hl - uy * hw, y - uy * hl + ux * hw], [x + ux * hl - uy * hw, y + uy * hl + ux * hw], [x + ux * hl + uy * hw, y + uy * hl - ux * hw], [x - ux * hl + uy * hw, y - uy * hl - ux * hw]]);
        if (carPolys.length >= 1500) break outer;
      }
      acc -= L;
    }
  }
  // Parked cars are drawn by vehicles.js with real car models; fall back to simple boxes if those didn't load.
  if (!useCarModels) {
    const paint = { vertexColors: true, roughness: 0.35, metalness: 0.5, flatShading: true };
    instanced(carGeometry(false), new THREE.MeshStandardMaterial(paint), cars[0]);
    instanced(carGeometry(true), new THREE.MeshStandardMaterial(paint), cars[1]);
  }
  const parkedSpots = [...cars[0].map((c) => ({ ...c, suv: false })), ...cars[1].map((c) => ({ ...c, suv: true }))];
  stats.parkedCars = carPolys.length;
  const PROP_RANGE = 650;
  function update(camera) {
    const x = camera.position.x, y = -camera.position.z, far = PROP_RANGE + camera.position.y * 1.5;
    for (const c of chunkMeshes) c.mesh.visible = Math.hypot(c.cx - x, c.cy - y) < far;
  }
  stats.chunkMeshes = chunkMeshes.length;
  return { update, stats, carPolys, parkedSpots, carSample: cars[0].slice(0, 20).map((c) => [c.x, c.y, c.rot]) };
}

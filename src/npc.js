// NPC crowd: walk graph + A*, daily routines on a simulated clock, separation steering,
// distance-based update rates, and instanced procedural bodies.
import * as THREE from 'three';

// ---------------------------------------------------------------- walk graph + A*
export function buildGraph(walk, collision) {
  const N = walk.nodes.length / 2;
  const nx = new Float32Array(N), ny = new Float32Array(N);
  for (let i = 0; i < N; i++) { nx[i] = walk.nodes[2 * i]; ny[i] = walk.nodes[2 * i + 1]; }
  const deg = new Uint32Array(N + 1);
  const E = walk.edges.length / 3;
  for (let e = 0; e < E; e++) { deg[walk.edges[3 * e]]++; deg[walk.edges[3 * e + 1]]++; }
  const start = new Uint32Array(N + 1);
  for (let i = 0; i < N; i++) start[i + 1] = start[i] + deg[i];
  const nbr = new Uint32Array(start[N]), cost = new Float32Array(start[N]), width = new Float32Array(start[N]);
  const fill = start.slice(0, N);
  for (let e = 0; e < E; e++) {
    const a = walk.edges[3 * e], b = walk.edges[3 * e + 1], w = walk.edges[3 * e + 2];
    const L = Math.hypot(nx[a] - nx[b], ny[a] - ny[b]) * (w > 0 ? 1.35 : 1); // prefer footways/sidewalks
    nbr[fill[a]] = b; cost[fill[a]] = L; width[fill[a]++] = w;
    nbr[fill[b]] = a; cost[fill[b]] = L; width[fill[b]++] = w;
  }
  // A* with reusable buffers
  const g = new Float32Array(N), from = new Int32Array(N), stamp = new Uint32Array(N), closed = new Uint32Array(N);
  let gen = 0;
  const heap = [], hf = [];
  const push = (n, f) => { heap.push(n); hf.push(f); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= hf[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; [hf[p], hf[i]] = [hf[i], hf[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const ln = heap.pop(), lf = hf.pop(); if (heap.length) { heap[0] = ln; hf[0] = lf; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && hf[l] < hf[m]) m = l; if (r < heap.length && hf[r] < hf[m]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; [hf[m], hf[i]] = [hf[i], hf[m]]; i = m; } } return top; };
  function astar(s, t) {
    if (s === t) return [s];
    gen++; heap.length = 0; hf.length = 0;
    g[s] = 0; stamp[s] = gen; from[s] = -1; push(s, 0);
    let expanded = 0;
    while (heap.length) {
      const u = pop();
      if (closed[u] === gen) continue; closed[u] = gen;
      if (u === t) break;
      if (++expanded > 250000) return null;
      for (let k = start[u]; k < start[u + 1]; k++) {
        const v = nbr[k], ng = g[u] + cost[k];
        if (stamp[v] !== gen || ng < g[v]) { stamp[v] = gen; g[v] = ng; from[v] = u; push(v, ng + Math.hypot(nx[v] - nx[t], ny[v] - ny[t])); }
      }
    }
    if (stamp[t] !== gen) return null;
    const path = []; for (let u = t; u !== -1; u = from[u]) path.push(u);
    return path.reverse();
  }
  const edgeWidth = (a, b) => { for (let k = start[a]; k < start[a + 1]; k++) if (nbr[k] === b) return width[k]; return 0; };
  // Turn a node path into waypoints. Road-centerline edges are offset to the walker's right
  // (onto the sidewalk side); offsets that would land in a building or water are dropped.
  function waypoints(path) {
    const out = [];
    for (let i = 0; i < path.length; i++) {
      const u = path[i];
      const wIn = i > 0 ? edgeWidth(path[i - 1], u) : 0, wOut = i < path.length - 1 ? edgeWidth(u, path[i + 1]) : 0;
      const w = Math.max(wIn, wOut);
      let x = nx[u], y = ny[u];
      if (w > 0) {
        const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
        let dx = nx[b] - nx[a], dy = ny[b] - ny[a]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        const off = w / 2 + 1.6;
        const ox = x + dy * off, oy = y - dx * off;
        // keep the offset only if the point and the legs to its neighbours stay clear of buildings/water
        const px = out.length ? out[out.length - 2] : nx[u], py = out.length ? out[out.length - 1] : ny[u];
        const qx = nx[b], qy = ny[b];
        const clear = (x0, y0, x1, y1) => { for (let f = 0.25; f < 1; f += 0.25) if (collision.blocked(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, 0.3)) return false; return true; };
        if (!collision.blocked(ox, oy, 0.4) && clear(px, py, ox, oy) && clear(ox, oy, qx, qy)) { x = ox; y = oy; }
      }
      out.push(x, y);
    }
    return out;
  }
  return { N, nx, ny, astar, waypoints };
}

// ---------------------------------------------------------------- routines
// Each entry: [startHour, activity label, destination category, what happens on arrival]
// 'inside' = goes indoors (hidden), 'linger' = stays visible and idles/wanders nearby.
export const ARCHETYPES = {
  commuter: { label: 'Commuter', share: 0.32, plan: [
    [0, 'At home', 'home', 'inside'], [7.2, 'Heading to work', 'office', 'inside'], [12.0, 'Heading to lunch', 'food', 'linger'],
    [13.0, 'Back to the office', 'office', 'inside'], [17.4, 'Heading to the station', 'transit', 'linger'], [18.3, 'Going home', 'home', 'inside'] ] },
  lunch: { label: 'Office worker', share: 0.2, plan: [
    [0, 'At home', 'home', 'inside'], [8.4, 'Heading to work', 'office', 'inside'], [11.6, 'Coffee run', 'food', 'linger'],
    [12.2, 'Lunch in the park', 'park', 'linger'], [13.3, 'Back to the office', 'office', 'inside'], [18.5, 'Drinks after work', 'food', 'linger'], [20.5, 'Going home', 'home', 'inside'] ] },
  park: { label: 'Park visitor', share: 0.22, plan: [
    [0, 'At home', 'home', 'inside'], [7.5, 'Morning walk', 'park', 'linger'], [9.5, 'Resting on a bench', 'bench', 'linger'],
    [11.5, 'Getting lunch', 'food', 'linger'], [13.5, 'Afternoon in the park', 'park', 'linger'], [17.0, 'Sunset by the bay', 'park', 'linger'], [19.5, 'Going home', 'home', 'inside'] ] },
  night: { label: 'Late-night worker', share: 0.12, plan: [
    [0, 'Working the night shift', 'office', 'inside'], [5.5, 'Catching the first train', 'transit', 'linger'], [6.5, 'Sleeping', 'home', 'inside'],
    [16.0, 'Errands', 'food', 'linger'], [18.5, 'Heading to the night shift', 'office', 'inside'], [22.5, 'Late snack', 'food', 'linger'], [23.3, 'Back to work', 'office', 'inside'] ] },
  tourist: { label: 'Tourist', share: 0.14, plan: [
    [0, 'At the hotel', 'office', 'inside'], [9.0, 'Sightseeing', 'park', 'linger'], [11.0, 'Exploring Brickell', 'transit', 'linger'],
    [12.5, 'Lunch', 'food', 'linger'], [14.0, 'Walking the bayfront', 'park', 'linger'], [18.0, 'Dinner', 'food', 'linger'], [21.5, 'Back to the hotel', 'office', 'inside'] ] },
};

function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const fmtTime = (h) => { h = ((h % 24) + 24) % 24; const H = Math.floor(h), M = Math.floor((h - H) * 60); const ap = H < 12 ? 'AM' : 'PM'; return `${((H + 11) % 12) + 1}:${String(M).padStart(2, '0')} ${ap}`; };

// ---------------------------------------------------------------- crowd
const BODY_TYPES = [[1, 1], [0.95, 1.08], [1.18, 1.0], [1, 0.9], [0.86, 1.03]]; // [width, height] scales
const SHIRTS = ['#e0457b', '#1f8a8a', '#f2b134', '#ffffff', '#3d5a80', '#ee6c4d', '#7a5195', '#98c1d9', '#2a9d8f', '#f4a261'];
const PANTS = ['#2b2d42', '#3d405b', '#6c757d', '#c2b280', '#1d3557', '#5c4033'];
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a1665e'];

export function createCrowd(scene, data, graph, collision, { count = 600, seed = 7 } = {}) {
  const rnd = mulberry(seed);
  const dest = data.walk.dest;
  // Destinations are chosen near the person (their "neighborhood"): sample a few candidates and take the
  // first within TRIP_RANGE of `from`, else the nearest sampled. Keeps trips walkable and A* cheap on a big map.
  const TRIP_RANGE = 1500;
  const pick = (cat, from = -1) => {
    const a = dest[cat] && dest[cat].length ? dest[cat] : dest.park;
    if (from < 0) return a[Math.floor(rnd() * a.length)];
    let best = -1, bd = Infinity;
    for (let k = 0; k < 12; k++) {
      const c = a[Math.floor(rnd() * a.length)], d = Math.hypot(graph.nx[c] - graph.nx[from], graph.ny[c] - graph.ny[from]);
      if (d < TRIP_RANGE) return c;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };
  // Homes: 75% within 1.8 km of the map center (Axis on Brickell) so Brickell and Downtown stay lively;
  // the rest anywhere, so the outer neighborhoods have people too.
  const pickHome = () => {
    const a = dest.home.length ? dest.home : dest.park, central = rnd() < 0.75;
    for (let k = 0; k < 40; k++) { const c = a[Math.floor(rnd() * a.length)]; if (!central || Math.hypot(graph.nx[c], graph.ny[c]) < 1800) return c; }
    return a[Math.floor(rnd() * a.length)];
  };
  const archNames = Object.keys(ARCHETYPES);
  const cum = []; let acc = 0; for (const n of archNames) { acc += ARCHETYPES[n].share; cum.push(acc); }

  // ---- instanced bodies ----
  const MAX = 800;
  const parts = {
    torso: new THREE.BoxGeometry(0.42, 0.6, 0.24).translate(0, 1.18, 0),
    head: new THREE.BoxGeometry(0.22, 0.24, 0.22).translate(0, 1.62, 0),
    leg: new THREE.BoxGeometry(0.16, 0.86, 0.16).translate(0, -0.43, 0),
    arm: new THREE.BoxGeometry(0.11, 0.58, 0.11).translate(0, -0.29, 0),
  };
  const mat = () => new THREE.MeshLambertMaterial({ color: '#fff', flatShading: true });
  const meshes = {
    torso: new THREE.InstancedMesh(parts.torso, mat(), MAX), head: new THREE.InstancedMesh(parts.head, mat(), MAX),
    legL: new THREE.InstancedMesh(parts.leg, mat(), MAX), legR: new THREE.InstancedMesh(parts.leg, mat(), MAX),
    armL: new THREE.InstancedMesh(parts.arm, mat(), MAX), armR: new THREE.InstancedMesh(parts.arm, mat(), MAX),
  };
  for (const m of Object.values(meshes)) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; scene.add(m); }

  const npcs = [];
  function spawnNpc(i) {
    const r = rnd(); const arch = archNames[cum.findIndex((c) => r <= c)] || 'commuter';
    const jitter = (rnd() - 0.5) * 1.2; // +/- 36 min so the crowd does not move in lockstep
    const n = {
      id: i, arch, jitter, plan: ARCHETYPES[arch].plan, step: -1,
      x: 0, y: 0, heading: rnd() * 6.28, speed: 1.15 + rnd() * 0.45,
      wp: null, wi: 0, node: pickHome(), goalNode: -1, state: 'inside', activity: '', idleT: 0,
      body: BODY_TYPES[Math.floor(rnd() * BODY_TYPES.length)], phase: rnd() * 6.28, pending: false, acc: 0, near: false,
    };
    const c = new THREE.Color();
    meshes.torso.setColorAt(i, c.set(SHIRTS[Math.floor(rnd() * SHIRTS.length)])); meshes.armL.setColorAt(i, c); meshes.armR.setColorAt(i, c);
    c.set(PANTS[Math.floor(rnd() * PANTS.length)]); meshes.legL.setColorAt(i, c); meshes.legR.setColorAt(i, c);
    meshes.head.setColorAt(i, c.set(SKIN[Math.floor(rnd() * SKIN.length)]));
    return n;
  }
  for (let i = 0; i < MAX; i++) npcs.push(spawnNpc(i));
  for (const m of Object.values(meshes)) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  let active = Math.min(count, MAX);

  const stepFor = (n, hour) => { const h = ((hour - n.jitter) % 24 + 24) % 24; let s = 0; for (let k = 0; k < n.plan.length; k++) if (h >= n.plan[k][0]) s = k; return s; };
  const queue = [];
  function assign(n, step, initial) {
    n.step = step; const [, label, cat, arrive] = n.plan[step];
    n.activity = label; n.arrive = arrive; n.goalNode = pick(cat, n.node);
    if (!queue.includes(n)) queue.push(n);
    n.pending = true; n.initial = initial;
  }
  function plan(n) {
    n.pending = false;
    const path = graph.astar(n.node, n.goalNode);
    if (!path || path.length < 2) { arriveAt(n); return; }
    n.wp = graph.waypoints(path); n.path = path; n.wi = 0;
    if (n.initial) { // start-of-sim: place partway along the trip so the street is not empty
      n.wi = Math.floor(rnd() * (path.length - 1));
      if (rnd() < 0.5 && n.arrive === 'inside') { n.node = n.goalNode; n.wp = null; arriveAt(n); return; }
    }
    n.node = path[n.wi]; n.x = n.wp[2 * n.wi]; n.y = n.wp[2 * n.wi + 1]; n.state = 'walking';
  }
  function arriveAt(n) {
    n.node = n.goalNode; n.wp = null;
    if (n.arrive === 'inside') n.state = 'inside';
    else { n.state = 'idle'; n.idleT = 5 + rnd() * 20; n.x = graph.nx[n.node]; n.y = graph.ny[n.node]; }
  }

  // ---- per-frame update ----
  const tmp = { m: new THREE.Matrix4(), b: new THREE.Matrix4(), r: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);
  let frame = 0, lastSort = -1e9;
  const metrics = { updateMs: 0, visible: 0, walking: 0, near: 0, pathsPerSec: 0 };
  let pathCount = 0, pathWindow = 0;
  const FULL = 50;
  const hash = new Map();

  function moveAlong(n, dt) {
    let dist = n.speed * dt;
    while (dist > 0 && n.wp) {
      const tx = n.wp[2 * n.wi], ty = n.wp[2 * n.wi + 1];
      const dx = tx - n.x, dy = ty - n.y, L = Math.hypot(dx, dy);
      if (L <= dist) {
        n.x = tx; n.y = ty; dist -= L; n.node = n.path[n.wi]; n.wi++;
        if (n.wi >= n.wp.length / 2) { arriveAt(n); return; }
      } else { n.x += (dx / L) * dist; n.y += (dy / L) * dist; n.heading = Math.atan2(dx, -dy); dist = 0; }
    }
  }

  function update(dt, simHour, simDtHours, player) {
    const t0 = performance.now(); frame++;
    // routine changes (cheap check, every frame)
    for (let i = 0; i < active; i++) { const n = npcs[i]; const s = stepFor(n, simHour); if (s !== n.step) assign(n, s, n.step === -1); }
    // limited pathfinding per frame
    const budget = Math.max(8, Math.min(60, queue.length));
    for (let k = 0; k < budget && queue.length; k++) { const n = queue.shift(); if (n.id < active && n.pending) { plan(n); pathCount++; } }
    pathWindow += dt; if (pathWindow > 1) { metrics.pathsPerSec = pathCount / pathWindow; pathCount = 0; pathWindow = 0; }

    // nearest-50 set refreshed twice a second
    if (performance.now() - lastSort > 500) {
      lastSort = performance.now();
      const vis = npcs.slice(0, active).filter((n) => n.state !== 'inside');
      vis.sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y));
      for (const n of npcs) n.near = false;
      for (let i = 0; i < Math.min(FULL, vis.length); i++) vis[i].near = true;
    }
    // Sim time moves walkers faster when the clock is sped up, capped so they stay readable.
    // Near walkers keep a natural pace; distant ones are moved in bulk so trips fit the sped-up day.
    const timeScale = Math.min(10, Math.max(1, simDtHours * 3600 / Math.max(dt, 1e-6) / 7.5));
    const nearScale = Math.min(1.5, timeScale);
    hash.clear();
    let visible = 0, walking = 0, near = 0;
    for (let i = 0; i < active; i++) {
      const n = npcs[i];
      if (n.state === 'inside' || n.pending) continue;
      if (n.near) { near++; moveOrIdle(n, dt * nearScale); }
      else { n.acc += dt * timeScale; if ((frame + i) % 4 === 0) { moveOrIdle(n, n.acc); n.acc = 0; } }
      if (n.state === 'walking') walking++;
      const k = Math.floor(n.x) * 100000 + Math.floor(n.y); (hash.get(k) || hash.set(k, []).get(k)).push(n);
    }
    // separation steering for the near set
    for (let i = 0; i < active; i++) {
      const n = npcs[i]; if (!n.near || n.state === 'inside' || n.pending) continue;
      let sx = 0, sy = 0;
      for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) for (const o of hash.get((Math.floor(n.x) + gx) * 100000 + Math.floor(n.y) + gy) || []) {
        if (o === n) continue; const dx = n.x - o.x, dy = n.y - o.y, d = Math.hypot(dx, dy);
        if (d > 0.001 && d < 0.75) { sx += (dx / d) * (0.75 - d); sy += (dy / d) * (0.75 - d); }
      }
      if (sx || sy) { const ox = n.x + sx * 0.5, oy = n.y + sy * 0.5; if (!collision.blocked(ox, oy, 0.25)) { n.x = ox; n.y = oy; } }
    }
    // write instance matrices
    for (let i = 0; i < MAX; i++) {
      const n = npcs[i];
      if (i >= active || n.state === 'inside' || n.pending) { for (const m of Object.values(meshes)) m.setMatrixAt(i, hide); continue; }
      visible++;
      const moving = n.state === 'walking';
      if (moving && n.near) n.phase += dt * nearScale * n.speed * 5.2;
      const swing = moving ? Math.sin(n.phase) * 0.55 : 0;
      const bob = moving ? Math.abs(Math.cos(n.phase)) * 0.04 : 0;
      tmp.q.setFromAxisAngle(tmp.up, n.heading);
      tmp.b.compose(tmp.p.set(n.x, bob, -n.y), tmp.q, tmp.s.set(n.body[0], n.body[1], n.body[0]));
      meshes.torso.setMatrixAt(i, tmp.b); meshes.head.setMatrixAt(i, tmp.b);
      const limb = (mesh, ox, oy, ang) => { tmp.r.makeRotationX(ang).setPosition(ox, oy, 0); tmp.m.multiplyMatrices(tmp.b, tmp.r); mesh.setMatrixAt(i, tmp.m); };
      limb(meshes.legL, -0.11, 0.88, swing); limb(meshes.legR, 0.11, 0.88, -swing);
      limb(meshes.armL, -0.27, 1.45, -swing * 0.8); limb(meshes.armR, 0.27, 1.45, swing * 0.8);
    }
    for (const m of Object.values(meshes)) { m.instanceMatrix.needsUpdate = true; m.count = active; }
    metrics.visible = visible; metrics.walking = walking; metrics.near = near;
    metrics.updateMs = metrics.updateMs * 0.9 + (performance.now() - t0) * 0.1;
  }
  function moveOrIdle(n, dt) {
    if (n.state === 'walking') moveAlong(n, dt);
    else if (n.state === 'idle') {
      n.idleT -= dt;
      if (n.idleT <= 0) { // wander to a neighbouring destination of the same kind
        const cat = n.plan[n.step][2];
        n.goalNode = pick(cat === 'park' || cat === 'bench' ? cat : 'park', n.node);
        if (Math.hypot(graph.nx[n.goalNode] - n.x, graph.ny[n.goalNode] - n.y) > 250) { n.idleT = 10 + rnd() * 20; return; }
        n.pending = true; n.initial = false; queue.push(n);
      }
    }
  }
  function setCount(c) {
    const prev = active; active = Math.max(0, Math.min(MAX, c));
    for (let i = prev; i < active; i++) { npcs[i].step = -1; npcs[i].state = 'inside'; }
  }
  const pickables = [meshes.torso, meshes.head];
  return { update, npcs, meshes, metrics, setCount, get count() { return active; }, pickables };
}

// Acceptance checks run in headless Chromium against the production build.
//   npm run build && npm run test:e2e
// Writes docs/test-results.json and screenshots in docs/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
// Camera spots below were chosen in the v1 coordinate frame (origin 25.7705, -80.1895). V() shifts them into the
// current data frame so they stay on the same streets whatever the bounding box is.
const META = JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta;
const KX = Math.cos(META.origin.lat * Math.PI / 180) * 6371008.8 * Math.PI / 180, KY = 6371008.8 * Math.PI / 180;
const OFF = [(-80.1895 - META.origin.lon) * KX, (25.7705 - META.origin.lat) * KY];
const V = (x, y, ...rest) => [x + OFF[0], y + OFF[1], ...rest];
const PORT = 4179;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));

const results = { date: new Date().toISOString(), environment: 'Headless Chromium, SwiftShader (software WebGL), 1280x720 unless noted. FPS here is NOT representative of a GPU laptop.' };
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function open(query = '', viewport = { width: 1280, height: 720 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  // Pin Medium unless a test asks otherwise, so test runs never spend Google Photoreal sessions.
  if (!/quality=/.test(query)) query += (query.includes('?') ? '&' : '?') + 'quality=medium';
  await page.goto(`http://localhost:${PORT}/${query}`);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 90_000 });
  const readyMs = Date.now() - t0;
  await page.waitForSelector('body[data-first-frame="1"]', { timeout: 90_000 });
  const firstFrameMs = Date.now() - t0;
  await page.evaluate(() => document.getElementById('start').classList.add('hidden'));
  return { page, errors, readyMs, firstFrameMs };
}

// ---------------------------------------------------------------- walking
{
  const { page, errors, readyMs, firstFrameMs } = await open('?npcs=0');
  results.loadToReadyMs = readyMs; results.loadToFirstFrameMs = firstFrameMs;
  results.loadTimings = await page.evaluate(() => window.__miami.timings);
  results.walking = await page.evaluate(() => {
    const m = window.__miami, P = m.player, S = P.state, C = m.collision;
    const EYE = 1.7, dt = 1 / 60;
    function walkTo(tx, ty, { sprint = true, maxT = 400 } = {}) {
      let t = 0, best = Math.hypot(tx - S.x, ty - S.y), lastImprove = 0, minEye = Infinity;
      while (t < maxT) {
        const dx = tx - S.x, dy = ty - S.y, d = Math.hypot(dx, dy);
        if (d < 1.0) return { ok: true, t, minEye };
        m.camera.rotation.set(0, Math.atan2(-dx, dy), 0, 'YXZ');
        P.update(dt, { forward: 1, right: 0, sprint, jump: false });
        minEye = Math.min(minEye, m.camera.position.y);
        t += dt;
        if (d < best - 0.3) { best = d; lastImprove = t; }
        if (t - lastImprove > 3) return { ok: false, t, stuckAt: [+S.x.toFixed(1), +S.y.toFixed(1)], remaining: +d.toFixed(1), minEye };
      }
      return { ok: false, t, timeout: true, minEye };
    }
    function route(points, label) {
      S.x = points[0][0]; S.y = points[0][1]; S.distance = 0;
      const out = { label, targets: points.length - 1, reached: 0, stuck: [], minEyeHeight: Infinity, insideBuildingSamples: 0, onWaterSamples: 0 };
      for (let i = 1; i < points.length; i++) {
        const r = walkTo(points[i][0], points[i][1]);
        out.minEyeHeight = Math.min(out.minEyeHeight, r.minEye);
        if (r.ok) out.reached++; else { out.stuck.push({ target: points[i].map((v) => +v.toFixed(1)), ...r }); S.x = points[i][0]; S.y = points[i][1]; }
        if (C.insideBuilding(S.x, S.y)) out.insideBuildingSamples++;
        if (!C.walkableGround(S.x, S.y)) out.onWaterSamples++;
      }
      out.distanceWalkedM = +S.distance.toFixed(0);
      out.minEyeHeight = +out.minEyeHeight.toFixed(3);
      out.pass = out.stuck.length === 0 && out.minEyeHeight >= EYE - 1e-6 && !out.insideBuildingSamples && !out.onWaterSamples;
      return out;
    }
    // Brickell Avenue: follow the connected centerline of the ways named "Brickell Avenue" from its
    // southernmost point to its northernmost point (shortest path along the avenue's own geometry).
    const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;
    const nodes = new Map(), adj = new Map();
    for (const r of m.data.roads) if (r.n === 'Brickell Avenue') for (let i = 0; i < r.c.length - 2; i += 2) {
      const a = key(r.c[i], r.c[i + 1]), b = key(r.c[i + 2], r.c[i + 3]);
      nodes.set(a, [r.c[i], r.c[i + 1]]); nodes.set(b, [r.c[i + 2], r.c[i + 3]]);
      (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a);
    }
    const ks = [...nodes.keys()].sort((a, b) => nodes.get(a)[1] - nodes.get(b)[1]);
    const src = ks[0], dst = ks.at(-1), dist = new Map([[src, 0]]), prev = new Map(), todo = new Set([src]);
    while (todo.size) {
      let u = null; for (const k of todo) if (u === null || dist.get(k) < dist.get(u)) u = k;
      todo.delete(u); if (u === dst) break;
      for (const v of adj.get(u) || []) { const d = dist.get(u) + Math.hypot(nodes.get(u)[0] - nodes.get(v)[0], nodes.get(u)[1] - nodes.get(v)[1]); if (!dist.has(v) || d < dist.get(v)) { dist.set(v, d); prev.set(v, u); todo.add(v); } }
    }
    const pts = []; for (let k = dst; k; k = prev.get(k)) pts.unshift(nodes.get(k));
    // Skip points within 3 m of the modeled edge (the avenue continues beyond the bounding box).
    const ext = m.data.meta.extent, inner = (p) => p[0] > ext.minX + 3 && p[0] < ext.maxX - 3 && p[1] > ext.minY + 3 && p[1] < ext.maxY - 3;
    const ptsIn = pts.filter(inner);
    const brickellPts = ptsIn.filter((p, i) => i === 0 || Math.hypot(p[0] - ptsIn[i - 1][0], p[1] - ptsIn[i - 1][1]) > 5);
    const brickell = route(brickellPts, 'Brickell Avenue, south end to north end (centerline, incl. Miami River bridge)');
    brickell.lengthAlongAxisM = +Math.hypot(brickellPts[0][0] - brickellPts.at(-1)[0], brickellPts[0][1] - brickellPts.at(-1)[1]).toFixed(0);

    // Around Bayfront Park: ring of the park polygon pulled 15 m inward, connected by walk-graph routes.
    const park = m.data.parks.filter((p) => p.n === 'Bayfront Park').sort((a, b) => b.c.length - a.c.length)[0];
    const ring = []; for (let i = 0; i < park.c.length; i += 2) ring.push([park.c[i], park.c[i + 1]]);
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const G = m.graph;
    const nearestNode = (x, y) => { let b = -1, bd = Infinity; for (let i = 0; i < G.N; i++) { const d = Math.hypot(G.nx[i] - x, G.ny[i] - y); if (d < bd) { bd = d; b = i; } } return b; };
    const step = Math.max(1, Math.floor(ring.length / 16));
    const keys = []; for (let i = 0; i < ring.length; i += step) { const [x, y] = ring[i]; const L = Math.hypot(cx - x, cy - y) || 1; keys.push(nearestNode(x + (cx - x) / L * 15, y + (cy - y) / L * 15)); }
    keys.push(keys[0]);
    const loop = [];
    for (let i = 0; i < keys.length - 1; i++) { const p = G.astar(keys[i], keys[i + 1]) || []; for (const n of p) loop.push([G.nx[n], G.ny[n]]); }
    const bayfront = route(loop, 'Loop around Bayfront Park on its footpaths (walk-graph route through 16 perimeter points)');

    // Wall sliding: approach a long wall of the largest building at 30 degrees.
    const big = C.polys.slice().sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[3];
    const r = big.r; let e = 0, el = 0;
    for (let i = 0; i < r.length; i += 2) { const j = (i + 2) % r.length; const L = Math.hypot(r[j] - r[i], r[j + 1] - r[i + 1]); if (L > el) { el = L; e = i; } }
    const ax = r[e], ay = r[e + 1], bx = r[(e + 2) % r.length], by = r[(e + 3) % r.length];
    const tx = (bx - ax) / el, ty = (by - ay) / el, nxo = ty, nyo = -tx; // outward normal for CCW ring
    S.x = (ax + bx) / 2 - tx * el * 0.25 + nxo * 3; S.y = (ay + by) / 2 - ty * el * 0.25 + nyo * 3;
    const start = [S.x, S.y];
    const dirx = tx * Math.cos(Math.PI / 6) - nxo * Math.sin(Math.PI / 6), diry = ty * Math.cos(Math.PI / 6) - nyo * Math.sin(Math.PI / 6);
    m.camera.rotation.set(0, Math.atan2(-dirx, diry), 0, 'YXZ');
    let minWallDist = Infinity;
    for (let k = 0; k < 180; k++) {
      P.update(1 / 60, { forward: 1, right: 0, sprint: false, jump: false });
      const t = Math.max(0, Math.min(1, ((S.x - ax) * tx + (S.y - ay) * ty) / el));
      minWallDist = Math.min(minWallDist, Math.hypot(S.x - (ax + tx * el * t), S.y - (ay + ty * el * t)));
    }
    const along = (S.x - start[0]) * tx + (S.y - start[1]) * ty;
    const wall = { wallLengthM: +el.toFixed(1), slidAlongWallM: +along.toFixed(2), expectedIfFreeM: +(1.6 * 3 * Math.cos(Math.PI / 6)).toFixed(2), minDistanceToWallM: +minWallDist.toFixed(3), playerRadiusM: 0.35, insideAfter: C.insideBuilding(S.x, S.y) };
    wall.pass = wall.slidAlongWallM > 2 && wall.minDistanceToWallM >= 0.34 && !wall.insideAfter;

    // Water: from the spawn walk due east toward Biscayne Bay for 60 s.
    S.x = m.data.meta.spawn[0]; S.y = m.data.meta.spawn[1]; S.z = 0; S.vz = 0; P.setFlying(false); m.camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ'); // Bayfront Park
    for (let k = 0; k < 3600; k++) P.update(1 / 60, { forward: 1, right: 0, sprint: true, jump: false });
    const water = { stoppedAt: [+S.x.toFixed(1), +S.y.toFixed(1)], onWalkableGround: C.walkableGround(S.x, S.y), eastwardM: +(S.x - m.data.meta.spawn[0]).toFixed(1) };
    water.pass = water.onWalkableGround;

    // Jump: returns to the ground.
    let maxZ = 0; P.update(1 / 60, { forward: 0, right: 0, sprint: false, jump: true });
    for (let k = 0; k < 120; k++) { P.update(1 / 60, { forward: 0, right: 0, sprint: false, jump: false }); maxZ = Math.max(maxZ, S.z); }
    const jump = { peakM: +maxZ.toFixed(2), landed: S.z === 0, pass: maxZ > 0.3 && maxZ < 0.8 && S.z === 0 };
    P.reset();
    return { brickell, bayfront, wall, water, jump, resetGoesToStartRoof: (() => { const st = m.data.meta.start; return S.x === st.x && S.y === st.y && S.z > 200 && Math.abs(m.camera.rotation.y - Math.PI) < 1e-6; })() };
  });
  results.walking.pageErrors = errors;

  // ---------------------------------------------------------------- flying (creative mode) + speed
  // Real keyboard events for the double-tap toggle; scripted input for the rest.
  await page.evaluate(() => window.__miami.player.reset());
  // Two Space taps 150 ms apart, dispatched in-page (Playwright's own key presses arrive ~450 ms apart on this
  // software-rendered page, longer than the 350 ms double-tap window).
  await page.evaluate(async () => {
    const tap = () => { dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' })); };
    tap(); const t = performance.now(); while (performance.now() - t < 150) { /* wait */ } tap();
  });
  const toggledOn = await page.evaluate(() => window.__miami.player.state.flying);
  results.flying = await page.evaluate((toggledOn) => {
    const m = window.__miami, P = m.player, S = P.state, C = m.collision, dt = 1 / 60;
    const step = (n, inp) => { for (let i = 0; i < n; i++) P.update(dt, { forward: 0, right: 0, sprint: false, jump: false, up: false, down: false, ...inp }); };
    const face = (tx, ty) => m.camera.rotation.set(0, Math.atan2(-(tx - S.x), ty - S.y), 0, 'YXZ');
    const out = { doubleTapSpaceStartsFlying: toggledOn };
    // Climb for 5 s.
    P.reset(); P.setFlying(true); step(300, { up: true });
    out.climb5s = { altitudeM: +S.z.toFixed(1), stillFlying: S.flying };
    // Tallest footprint: fly into it at 60 m altitude and check we never enter it.
    const tall = C.polys.filter((p) => !p.extra && !p.noStand).sort((a, b) => b.h - a.h)[0];
    let cx = 0, cy = 0; for (let i = 0; i < tall.r.length; i += 2) { cx += tall.r[i]; cy += tall.r[i + 1]; } cx /= tall.r.length / 2; cy /= tall.r.length / 2;
    S.x = cx - 80; S.y = cy; S.z = 60; P.setFlying(true); S.vx = S.vy = S.vz = 0; face(cx, cy);
    let entered = false; for (let i = 0; i < 600; i++) { P.update(dt, { forward: 1, right: 0, sprint: true, jump: false, up: false, down: false }); if (C.insideBuilding(S.x, S.y, S.z)) entered = true; }
    out.towerAtAltitude = { towerHeightM: tall.h, altitudeM: +S.z.toFixed(1), enteredTower: entered, stoppedDistanceFromCenterM: +Math.hypot(S.x - cx, S.y - cy).toFixed(1), pass: !entered };
    // Same tower from above its roof: should pass over it.
    S.x = cx - 80; S.y = cy; S.z = tall.h + 20; S.vx = S.vy = S.vz = 0; face(cx + 1000, cy);
    step(0); for (let i = 0; i < 600; i++) P.update(dt, { forward: 1, right: 0, sprint: true, jump: false, up: false, down: false });
    out.overTower = { endXOffsetM: +(S.x - cx).toFixed(1), pass: S.x - cx > 60 };
    // Land on a mid-rise roof, then walk off its edge.
    const roofs = C.polys.filter((p) => !p.extra && !p.noStand && p.h > 15 && p.h < 60 && (p.x1 - p.x0) > 25 && (p.y1 - p.y0) > 25);
    let roof = null, rx = 0, ry = 0;
    for (const p of roofs) {
      let ax = 0, ay = 0; for (let i = 0; i < p.r.length; i += 2) { ax += p.r[i]; ay += p.r[i + 1]; } ax /= p.r.length / 2; ay /= p.r.length / 2;
      if (Math.abs(C.groundAt(ax, ay, 1000) - p.h) < 1e-6 && C.groundAt(ax, ay, p.h) === p.h) { roof = p; rx = ax; ry = ay; break; }
    }
    S.x = rx; S.y = ry; S.z = roof.h + 30; S.vx = S.vy = S.vz = 0; P.setFlying(true);
    step(600, { down: true });
    out.roofLanding = { roofHeightM: +roof.h.toFixed(1), landedAtM: +S.z.toFixed(2), flyingAfter: S.flying, pass: Math.abs(S.z - roof.h) < 0.01 && !S.flying };
    face(rx + 500, ry); let maxDrop = 0;
    for (let i = 0; i < 1200 && S.z > 0; i++) { P.update(dt, { forward: 1, right: 0, sprint: true, jump: false }); }
    step(240);
    out.walkOffRoof = { endAltitudeM: +S.z.toFixed(2), onGround: S.onGround, pass: S.z < 0.6 && S.onGround && !S.flying };
    // Descend onto open water (east of Bayfront Park): flight must not end in the bay.
    S.x = m.data.meta.spawn[0] + 260; S.y = m.data.meta.spawn[1]; S.z = 40; S.vz = 0; P.setFlying(true);
    step(600, { down: true });
    out.waterDescent = { overWater: S.overWater, altitudeM: +S.z.toFixed(2), stillFlying: S.flying, pass: S.overWater && S.flying && S.z >= 0.59 };
    // Speed multiplier: walk 2 s in the park at 1x and at 5x.
    const walkFor = (mul) => { P.reset(); S.x = m.data.meta.spawn[0]; S.y = m.data.meta.spawn[1]; S.z = 0; S.speedMul = mul; m.camera.rotation.set(0, 0, 0, 'YXZ'); const x0 = S.x, y0 = S.y; for (let i = 0; i < 120; i++) P.update(dt, { forward: 1, right: 0, sprint: false, jump: false }); return Math.hypot(S.x - x0, S.y - y0); };
    const d1 = walkFor(1), d5 = walkFor(5);
    out.speedMultiplier = { walked2sAt1xM: +d1.toFixed(2), walked2sAt5xM: +d5.toFixed(2), ratio: +(d5 / d1).toFixed(2), pass: Math.abs(d5 / d1 - 5) < 0.3 };
    S.speedMul = 1; P.reset();
    out.pass = toggledOn && out.climb5s.altitudeM > 30 && out.towerAtAltitude.pass && out.overTower.pass && out.roofLanding.pass && out.walkOffRoof.pass && out.waterDescent.pass && out.speedMultiplier.pass;
    return out;
  }, toggledOn);
  // +/- keys change the multiplier
  await page.keyboard.press('Equal'); await page.keyboard.press('Equal');
  results.flying.plusKeyTwiceFrom1x = await page.evaluate(() => window.__miami.player.state.speedMul);
  await page.keyboard.press('Minus'); await page.keyboard.press('Minus');

  // ---------------------------------------------------------------- map + teleport
  await page.evaluate(() => { const m = window.__miami; m.player.reset(); });
  await page.keyboard.press('KeyM'); await page.waitForTimeout(600);
  const mapOpened = await page.evaluate(() => window.__miami.maps.open && !document.getElementById('bigmap').classList.contains('hidden'));
  const box = await page.locator('#bigmap-canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55); await page.waitForTimeout(600);
  results.teleport = await page.evaluate((mapOpened) => {
    const m = window.__miami, S = m.player.state, C = m.collision;
    const out = { mKeyOpensMap: mapOpened, mapClosedAfterClick: !m.maps.open,
      clickTeleport: { x: +S.x.toFixed(1), y: +S.y.toFixed(1), z: S.z, onLand: C.walkableGround(S.x, S.y), inBuilding: C.insideBuilding(S.x, S.y), movedFromSpawnM: +Math.hypot(S.x - m.data.meta.spawn[0], S.y - m.data.meta.spawn[1]).toFixed(0) } };
    // every landmark / place button target
    let ok = 0, worst = 0; const fails = [];
    for (const l of m.data.labels) {
      if (!m.maps.teleport(l.x, l.y)) { fails.push(l.n); continue; }
      const d = Math.hypot(S.x - l.x, S.y - l.y); worst = Math.max(worst, d);
      if (C.walkableGround(S.x, S.y) && !C.insideBuilding(S.x, S.y)) ok++; else fails.push(l.n);
    }
    out.placeTeleports = { places: m.data.labels.length, landedOnOpenGround: ok, worstDistanceFromPlaceM: +worst.toFixed(0), fails };
    // Shift+click equivalent: roof of the tallest standable building
    const tall = C.polys.filter((p) => !p.extra && !p.noStand).sort((a, b) => b.h - a.h)[0];
    let cx = 0, cy = 0; for (let i = 0; i < tall.r.length; i += 2) { cx += tall.r[i]; cy += tall.r[i + 1]; } cx /= tall.r.length / 2; cy /= tall.r.length / 2;
    m.maps.teleport(cx, cy, { roof: true });
    out.roofTeleport = { roofHeightM: tall.h, landedAtM: +S.z.toFixed(1), pass: Math.abs(S.z - C.groundAt(cx, cy, 1e4)) < 0.01 && S.z > 100 };
    out.pass = out.mKeyOpensMap && out.mapClosedAfterClick && out.clickTeleport.onLand && !out.clickTeleport.inBuilding && out.clickTeleport.movedFromSpawnM > 50 && fails.length === 0 && out.roofTeleport.pass;
    m.player.reset();
    return out;
  }, mapOpened);
  await page.close();
}

// ---------------------------------------------------------------- NPC behaviour (headless stepping, no rendering)
{
  const { page, errors } = await open('?npcs=300&hour=6');
  results.npc = await page.evaluate(() => {
    const m = window.__miami, C = m.collision, crowd = m.crowd, G = m.graph;
    m.clock.paused = true; // drive the clock manually
    // distance from a point to the nearest walk-graph edge (sidewalk/footway centerline or road centerline)
    const E = m.data.walk.edges, NX = G.nx, NY = G.ny, CELL = 25, grid = new Map();
    for (let e = 0; e < E.length / 3; e++) { const a = E[3 * e], b = E[3 * e + 1]; const k = (Math.floor((NX[a] + NX[b]) / 2 / CELL)) * 100000 + Math.floor((NY[a] + NY[b]) / 2 / CELL); (grid.get(k) || grid.set(k, []).get(k)).push(e); }
    const edgeDist = (x, y) => { let best = Infinity, bw = 0; const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
      for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) for (const e of grid.get((gx + i) * 100000 + gy + j) || []) {
        const a = E[3 * e], b = E[3 * e + 1], ax = NX[a], ay = NY[a], dx = NX[b] - ax, dy = NY[b] - ay, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)); const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        const allowed = E[3 * e + 2] > 0 ? E[3 * e + 2] / 2 + 3 : 2.5; // road: beside it; footway: on it
        if (d - allowed < best - bw) { best = d; bw = allowed; } }
      return { d: best, allowed: bw }; };
    const player = { x: 0, y: 0 };
    let hour = 6; const samples = [];
    let checked = 0, inBuilding = 0, inWater = 0, offPath = 0; const offDist = [];
    const dt = 1 / 30, simDtH = (dt * 60) / 3600; // 60x clock
    for (let step = 0; hour < 23.5; step++) {
      hour += simDtH; crowd.update(dt, hour, simDtH, player);
      if (step % 900 === 0) { // every 15 sim minutes
        const acts = {};
        for (const n of crowd.npcs.slice(0, crowd.count)) {
          const label = n.state === 'inside' ? `(indoors) ${n.activity}` : n.activity; acts[label] = (acts[label] || 0) + 1;
          if (n.state === 'inside' || n.pending) continue;
          checked++;
          if (C.insideBuilding(n.x, n.y)) inBuilding++;
          if (!C.walkableGround(n.x, n.y)) inWater++;
          const ed = edgeDist(n.x, n.y); offDist.push(ed.d - ed.allowed); if (ed.d > ed.allowed) offPath++;
        }
        samples.push({ time: hour.toFixed(2), outdoors: crowd.metrics.visible, walking: crowd.metrics.walking, top: Object.entries(acts).sort((a, b) => b[1] - a[1]).slice(0, 4) });
      }
    }
    offDist.sort((a, b) => a - b);
    return {
      npcCount: crowd.count, positionChecks: checked, insideBuilding: inBuilding, onWater: inWater, beyondWalkCorridor: offPath,
      worstExcessM: +offDist.at(-1).toFixed(2), p99ExcessM: +offDist[Math.floor(offDist.length * 0.99)].toFixed(2),
      timeline: samples.filter((_, i) => i % 4 === 0),
    };
  });
  results.npc.pageErrors = errors;
  await page.close();
}

// ---------------------------------------------------------------- performance + screenshots
async function perf(npcs, viewport, quality = 'medium') {
  const { page, errors } = await open(`?npcs=${npcs}&hour=12&quality=${quality}`, viewport);
  const views = {
    'street, Brickell area': V(-165, -585, 1.7, 0.45, 0.02),
    'start: Aston Martin Residences roof': null,
    'aerial, whole district': [0, -4300, 1500, 0.0, -0.36],
  };
  const out = {};
  for (const [name, v] of Object.entries(views)) {
    await page.evaluate((v) => {
      const m = window.__miami;
      if (!v) { m.player.reset(); return; }
      m.player.state.x = v[0]; m.player.state.y = v[1];
      m.player.update = function () {};
      m.camera.position.set(v[0], v[2], -v[1]); m.camera.rotation.set(v[4], v[3], 0, 'YXZ');
    }, v);
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => new Promise((res) => {
      const m = window.__miami; let frames = 0, calls = 0, tris = 0, npcMs = 0; const t0 = performance.now();
      const tick = () => { frames++; calls = Math.max(calls, m.renderer.info.render.calls); tris = Math.max(tris, m.renderer.info.render.triangles); npcMs += m.crowd.metrics.updateMs;
        if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else res({ fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1), drawCalls: calls, triangles: tris, npcUpdateMs: +(npcMs / frames).toFixed(2), outdoors: m.crowd.metrics.visible, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null }); };
      requestAnimationFrame(tick);
    }));
    out[name] = r;
  }
  out.pageErrors = errors;
  await page.close();
  return out;
}
results.performance = {
  low_npc300: await perf(300, undefined, 'low'),
  medium_npc200: await perf(200, undefined, 'medium'),
  medium_npc400: await perf(400, undefined, 'medium'),
  high_npc300: await perf(300, undefined, 'high'),
  medium_npc300_1080p: await perf(300, { width: 1920, height: 1080 }, 'medium'),
};

// screenshots for the milestone review
{
  const { page } = await open('?npcs=300&hour=12.5&quality=medium');
  results.props = await page.evaluate(() => window.__miami.props && window.__miami.props.stats);
  // Street-level spot: a Brickell Avenue sidewalk point near y = -700, looking north-east along the avenue.
  const bk = await page.evaluate(() => {
    const m = window.__miami; let best = null;
    for (const r of m.data.roads) if (r.n === 'Brickell Avenue') for (let i = 0; i < r.c.length - 2; i += 2) {
      const d = Math.abs(r.c[i + 1] + 700); if (!best || d < best.d) best = { d, x: r.c[i], y: r.c[i + 1], dx: r.c[i + 2] - r.c[i], dy: r.c[i + 3] - r.c[i + 1], w: r.w };
    }
    const L = Math.hypot(best.dx, best.dy); let ux = best.dx / L; let uy = best.dy / L; if (uy < 0) { ux *= -1; uy *= -1; }
    const off = best.w / 2 + 2; const x = best.x + uy * off, y = best.y - ux * off;
    return [x, y, 1.7, Math.atan2(-ux, uy), 0.05];
  });
  const shots = { 'view-aerial': [0, -4300, 1500, 0.0, -0.36], 'view-axis-aerial': [-350, -700, 320, -0.55, -0.42], 'view-little-havana': [-2050, 250, 30, 1.9, -0.18], 'view-brickell-ave': bk, 'view-downtown-aerial': V(700, 300, 350, 1.25, -0.35), 'quality-medium': V(-186.4, -700, 1.7, -0.45, 0.05), 'view-parked-cars': V(-300, -1230, 1.7, -1.75, -0.02) };
  for (const [name, v] of Object.entries(shots)) {
    await page.evaluate((v) => { const m = window.__miami; m.player.update = function () {}; m.player.state.x = v[0]; m.player.state.y = v[1]; m.world.updateLod(v[0], v[1]); m.camera.position.set(v[0], v[2], -v[1]); m.camera.rotation.set(v[4], v[3], 0, 'YXZ'); }, v);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `docs/${name}.png` });
  }
  // Crowd close-up: densest 40 m cell of outdoor NPCs, viewed from 18 m away at eye level.
  await page.evaluate(() => {
    const m = window.__miami, cells = new Map();
    for (const n of m.crowd.npcs.slice(0, m.crowd.count)) if (n.state !== 'inside' && !n.pending) { const k = `${Math.floor(n.x / 40)},${Math.floor(n.y / 40)}`; cells.set(k, (cells.get(k) || 0) + 1); }
    const [k] = [...cells.entries()].sort((a, b) => b[1] - a[1])[0]; const [gx, gy] = k.split(',').map(Number);
    const cx = gx * 40 + 20, cy = gy * 40 + 20;
    let px = cx, py = cy - 18;
    for (let a = 0; a < 6.28; a += 0.4) { const x = cx + Math.sin(a) * 18, y = cy - Math.cos(a) * 18; if (!m.collision.blocked(x, y, 0.5)) { px = x; py = y; break; } }
    m.player.state.x = px; m.player.state.y = py; m.world.updateLod(px, py);
    m.camera.position.set(px, 1.7, -py); m.camera.rotation.set(-0.05, Math.atan2(-(cx - px), cy - py), 0, 'YXZ');
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/view-crowd.png' });
  await page.evaluate(() => { const m = window.__miami; m.player.update = (dt) => {}; m.player.reset(); });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'docs/view-minimap.png' });
  await page.keyboard.press('KeyM'); await page.waitForTimeout(1200);
  await page.screenshot({ path: 'docs/view-map-teleport.png' });
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/view-spawn.png' });
  await page.close();
}

// Same street view at each quality, for comparison.
for (const q of ['low', 'high']) {
  const { page } = await open(`?npcs=300&hour=12.5&quality=${q}`);
  await page.evaluate((v) => { const m = window.__miami; m.player.update = function () {}; m.player.state.x = v[0]; m.player.state.y = v[1]; m.world.updateLod(v[0], v[1]); m.camera.position.set(v[0], v[2], -v[1]); m.camera.rotation.set(v[4], v[3], 0, 'YXZ'); }, V(-186.4, -700, 1.7, -0.45, 0.05));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `docs/quality-${q}.png` });
  await page.close();
}
const sizes = {};
for (const f of fs.readdirSync('dist/assets')) sizes[f] = fs.statSync(`dist/assets/${f}`).size;
results.buildSizes = { ...sizes, totalBytes: Object.values(sizes).reduce((a, b) => a + b, 0) };
fs.writeFileSync('docs/test-results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
server.kill();

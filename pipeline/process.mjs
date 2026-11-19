// Converts cached raw OSM JSON into the compact district file the app loads.
import { BBOX, SIMPLIFY_TOLERANCE_M, MIN_BUILDING_AREA_M2, LEVEL_HEIGHT_M, DEFAULT_HEIGHT_CORE_M,
  DEFAULT_HEIGHT_EDGE_M, CORE_POINTS, CORE_RADIUS_M, ROAD_WIDTH_DEFAULTS, LANE_WIDTH_M } from './config.mjs';
import { makeProjection, ringArea, centroid, pointInRing, simplifyRing, simplifyLine, dedupeRing,
  selfIntersects, stitch, coastlineToLand, clipPolyline } from './geo.mjs';

const r1 = (v) => Math.round(v * 10) / 10;
const flat = (ring) => ring.flatMap(([x, y]) => [r1(x), r1(y)]);

function parseLength(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(',', '.');
  let m = s.match(/^([\d.]+)\s*(m|meters?|metres?)?$/);
  if (m) return parseFloat(m[1]);
  m = s.match(/^([\d.]+)\s*(ft|feet|')$/);
  if (m) return parseFloat(m[1]) * 0.3048;
  m = s.match(/^(\d+)'\s*(\d+)"?$/);
  if (m) return (parseInt(m[1]) + parseInt(m[2]) / 12) * 0.3048;
  return null;
}

export function processOsm(raw, landmarkFile) {
  const lat0 = (BBOX.south + BBOX.north) / 2, lon0 = (BBOX.west + BBOX.east) / 2;
  const P = makeProjection(lat0, lon0);
  const [minX, minY] = P.project(BBOX.south, BBOX.west);
  const [maxX, maxY] = P.project(BBOX.north, BBOX.east);
  const rect = { minX, minY, maxX, maxY };
  const proj = (g) => g.map((p) => P.project(p.lat, p.lon));
  const report = { dropped: { tooSmall: 0, selfIntersecting: 0, duplicate: 0, degenerate: 0, outside: 0 }, heightSource: { tag: 0, levels: 0, default: 0, landmark: 0 }, defaults: [] };

  const els = raw.elements;
  const ways = els.filter((e) => e.type === 'way');
  const rels = els.filter((e) => e.type === 'relation');
  const nodes = els.filter((e) => e.type === 'node');

  // ---------- polygons (ways + multipolygon relations) ----------
  function polygonsOf(pred) {
    const out = [];
    for (const w of ways) {
      if (!pred(w.tags || {}) || !w.geometry || w.geometry.length < 4) continue;
      const g = proj(w.geometry);
      const closed = w.nodes ? w.nodes[0] === w.nodes[w.nodes.length - 1] : true;
      if (!closed) continue;
      out.push({ id: `w${w.id}`, tags: w.tags, outer: g.slice(0, -1), holes: [] });
    }
    for (const r of rels) {
      if (!pred(r.tags || {}) || !r.members) continue;
      const segs = (role) => r.members.filter((m) => m.type === 'way' && m.geometry && m.geometry.length >= 2 && (m.role || 'outer') === role).map((m) => proj(m.geometry));
      const { rings: outers } = stitch(segs('outer'));
      const { rings: inners } = stitch(segs('inner'));
      for (const o of outers) {
        const holes = inners.filter((h) => pointInRing(h[0][0], h[0][1], o));
        out.push({ id: `r${r.id}`, tags: r.tags, outer: o, holes });
      }
    }
    return out;
  }
  const inBox = (ring) => ring.some(([x, y]) => x >= minX && x <= maxX && y >= minY && y <= maxY);
  function clean(poly, { tol = SIMPLIFY_TOLERANCE_M, minArea = 0 } = {}) {
    let o = dedupeRing(poly.outer);
    if (o.length < 3) { report.dropped.degenerate++; return null; }
    let s = simplifyRing(o, tol);
    if (s.length < 3 || selfIntersects(s)) s = o;           // fall back to unsimplified
    if (selfIntersects(s)) { report.dropped.selfIntersecting++; return null; }
    if (ringArea(s) < 0) s.reverse();                       // outer CCW
    const area = ringArea(s);
    if (area < minArea) return { tooSmall: true, area };
    const holes = poly.holes.map((h) => { let q = simplifyRing(dedupeRing(h), tol); if (ringArea(q) > 0) q.reverse(); return q; }).filter((h) => h.length >= 3);
    return { outer: s, holes, area };
  }

  // ---------- buildings ----------
  const landmarkCfg = landmarkFile;
  const isLandmarkName = (n) => n && landmarkCfg.landmarks.some((l) => new RegExp(l.match, 'i').test(n));
  const corePts = CORE_POINTS.map((c) => P.project(c.lat, c.lon));
  const seen = new Map();
  const buildings = [];
  for (const kind of ['building', 'building:part']) {
    const polys = polygonsOf((t) => kind === 'building' ? (t.building && t.building !== 'no' && !t['building:part']) : (t['building:part'] && t['building:part'] !== 'no'));
    for (const p of polys) {
      if (!inBox(p.outer)) { report.dropped.outside++; continue; }
      const name = p.tags.name;
      const c = clean(p, { minArea: 0 });
      if (!c) continue;
      if (c.tooSmall || c.area < MIN_BUILDING_AREA_M2) { if (!isLandmarkName(name)) { report.dropped.tooSmall++; continue; } }
      const ctr = centroid(c.outer);
      if (ctr[0] < minX || ctr[0] > maxX || ctr[1] < minY || ctr[1] > maxY) { report.dropped.outside++; continue; }
      const sig = `${kind}|${Math.round(ctr[0] * 2)}|${Math.round(ctr[1] * 2)}|${Math.round(c.area / 5)}`;
      if (seen.has(sig)) { report.dropped.duplicate++; continue; }
      seen.set(sig, true);
      const t = p.tags;
      let h = parseLength(t.height), src = 'tag';
      if (h == null && t['building:levels'] != null && !isNaN(parseFloat(t['building:levels']))) { h = parseFloat(t['building:levels']) * LEVEL_HEIGHT_M; src = 'levels'; }
      if (h == null || h <= 0) {
        if (kind === 'building:part') { h = null; src = 'inherit'; }
        else {
          const dCore = Math.min(...corePts.map((q) => Math.hypot(ctr[0] - q[0], ctr[1] - q[1])));
          h = dCore < CORE_RADIUS_M ? DEFAULT_HEIGHT_CORE_M : DEFAULT_HEIGHT_EDGE_M; src = 'default';
        }
      }
      let mh = parseLength(t.min_height);
      if (mh == null && t['building:min_level'] != null) mh = parseFloat(t['building:min_level']) * LEVEL_HEIGHT_M;
      const type = t.building || t['building:part'];
      // Open structures (roofs, canopies, carports) are walk-through: rendered as a raised slab, no collision.
      const open = /^(roof|canopy|carport)$/.test(type) || t['building:part'] === 'roof';
      if (open && !mh) mh = Math.max(2.5, (h || 4) - 1.2);
      buildings.push({ id: p.id, kind, name, type, open, outer: c.outer, holes: c.holes, area: c.area, ctr, h, mh: mh || 0, src });
    }
  }
  // Parent/part relationship: hide parent mesh when its parts cover >= 50% of it.
  const parents = buildings.filter((b) => b.kind === 'building');
  const parts = buildings.filter((b) => b.kind === 'building:part');
  for (const pt of parts) {
    const par = parents.find((b) => pointInRing(pt.ctr[0], pt.ctr[1], b.outer) && b.area >= pt.area * 0.9);
    pt.parent = par || null;
    if (par) par.partArea = (par.partArea || 0) + pt.area;
  }
  for (const b of parents) b.hasParts = (b.partArea || 0) >= 0.5 * b.area;
  for (const pt of parts) {
    if (pt.h == null) {
      if (pt.parent && pt.parent.src !== 'default') { pt.h = pt.parent.h; pt.src = 'parent'; }
      else { pt.h = pt.parent ? pt.parent.h : DEFAULT_HEIGHT_EDGE_M; pt.src = 'default'; }
    }
  }
  // Orphan parts whose parent is not hidden would double-render: drop parts under a non-hidden parent.
  const finalBuildings = buildings.filter((b) => b.kind === 'building' || !b.parent || b.parent.hasParts);

  // Landmark overrides.
  const landmarkReport = [];
  for (const l of landmarkCfg.landmarks) {
    const re = new RegExp(l.match, 'i');
    const matches = finalBuildings.filter((b) => b.name && re.test(b.name));
    if (!matches.length) { landmarkReport.push({ name: l.name, matched: 0 }); continue; }
    const parent = matches.sort((a, b) => b.area - a.area)[0];
    // Target = tallest part inside the matched parent when it has parts, else the parent itself.
    const inside = parent.hasParts ? finalBuildings.filter((b) => b.parent === parent) : [];
    const target = inside.length ? inside.sort((a, b) => b.h - a.h)[0] : parent;
    const before = target.h;
    if (l.height_m != null) {
      const scale = l.height_m / Math.max(1, before);
      target.h = l.height_m; target.src = 'landmark';
      if (parent !== target) { parent.h = Math.max(parent.h, l.height_m); }
      // keep other parts proportional only if they were taller than the new height
      for (const p of inside) if (p !== target && p.h > l.height_m) p.h = l.height_m;
      void scale;
    }
    parent.landmark = l.name;
    landmarkReport.push({ name: l.name, matched: matches.length, osmHeight: before != null ? +before.toFixed(1) : null, override: l.height_m, diff: l.height_m != null && before != null ? +(l.height_m - before).toFixed(1) : null });
  }
  for (const b of finalBuildings) {
    if (b.kind === 'building' && b.hasParts) continue;
    report.heightSource[b.src === 'parent' ? 'tag' : b.src === 'inherit' ? 'default' : b.src] = (report.heightSource[b.src === 'parent' ? 'tag' : b.src] || 0) + 1;
    if (b.src === 'default') report.defaults.push({ id: b.id, name: b.name || null, h: b.h });
  }

  // ---------- roads & paths ----------
  const SKIP_HW = new Set(['construction', 'proposed', 'platform', 'elevator', 'bus_stop', 'raceway', 'abandoned', 'razed']);
  const roads = [];
  for (const w of ways) {
    const t = w.tags || {};
    if (!t.highway || SKIP_HW.has(t.highway) || !w.geometry) continue;
    if (t.area === 'yes') continue;
    if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') continue;
    if (t.indoor === 'yes' || (t.level && !/^0(;|$)/.test(t.level) && t.highway === 'footway' && !t.bridge)) continue;
    let w_ = parseLength(t.width);
    if (w_ == null && t.lanes && !isNaN(parseInt(t.lanes))) w_ = parseInt(t.lanes) * LANE_WIDTH_M;
    if (w_ == null) w_ = ROAD_WIDTH_DEFAULTS[t.highway] ?? 5;
    w_ = Math.min(Math.max(w_, 1.5), 30);
    for (const pts of clipPolyline(simplifyLine(proj(w.geometry), SIMPLIFY_TOLERANCE_M), rect))
      roads.push({ id: w.id, t: t.highway, w: r1(w_), c: flat(pts), ...(t.name ? { n: t.name } : {}), ...(t.bridge && t.bridge !== 'no' ? { b: 1 } : {}), ...(t.footway ? { ft: t.footway } : {}) });
  }

  // ---------- land (coastline) / water / parks ----------
  const coastWays = ways.filter((w) => w.tags?.natural === 'coastline' && w.geometry?.length >= 2);
  const { rings: coastRings, chains: coastChains } = stitch(coastWays.map((w) => proj(w.geometry)));
  const coast = coastlineToLand([...coastChains.map((pts) => ({ pts, closed: false })), ...coastRings.map((pts) => ({ pts, closed: true }))], rect);
  let land = [...coast.land, ...coast.islands].map((r) => simplifyRing(dedupeRing(r), SIMPLIFY_TOLERANCE_M));
  land = land.map((r) => (ringArea(r) < 0 ? r.reverse() : r)).filter((r) => ringArea(r) > 100);
  const landInfo = { coastlineWays: coastWays.length, chains: coastChains.length, closedRings: coastRings.length, landPolygons: land.length, danglingPieces: coast.dangling };
  if (!land.length) { // fallback: whole box is land; water polygons still apply
    land = [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]];
    landInfo.fallback = 'no coastline crossing the box; treated whole box as land';
  }
  const water = polygonsOf((t) => t.natural === 'water' || t.waterway === 'riverbank' || t.water === 'river')
    .filter((p) => inBox(p.outer)).map((p) => clean(p, { tol: 1 })).filter((c) => c && !c.tooSmall && c.area > 50)
    .map((c) => ({ c: flat(c.outer), ...(c.holes.length ? { holes: c.holes.map(flat) } : {}) }));
  const parkPolys = polygonsOf((t) => ['park', 'garden', 'playground', 'pitch', 'dog_park'].includes(t.leisure) || ['grass', 'recreation_ground', 'village_green'].includes(t.landuse) || ['wood', 'scrub'].includes(t.natural))
    .filter((p) => inBox(p.outer)).map((p) => ({ p, c: clean(p, { tol: 0.5 }) })).filter(({ c }) => c && !c.tooSmall && c.area > 30);
  const parks = parkPolys.map(({ p, c }) => ({ c: flat(c.outer), ...(c.holes.length ? { holes: c.holes.map(flat) } : {}), ...(p.tags.name ? { n: p.tags.name } : {}), k: p.tags.leisure || p.tags.landuse || p.tags.natural, _ring: c.outer, _area: c.area }));
  const beaches = polygonsOf((t) => ['beach', 'sand'].includes(t.natural)).filter((p) => inBox(p.outer)).map((p) => clean(p)).filter((c) => c && !c.tooSmall).map((c) => ({ c: flat(c.outer) }));

  // ---------- rail ----------
  const rail = [];
  for (const w of ways) {
    const t = w.tags || {};
    if (!t.railway || !w.geometry || !['rail', 'light_rail', 'monorail', 'subway', 'narrow_gauge'].includes(t.railway)) continue;
    const name = `${t.name || ''} ${t.operator || ''}`;
    const k = /metromover/i.test(name) || t.railway === 'monorail' ? 'metromover' : /metrorail/i.test(name) || t.railway === 'subway' ? 'metrorail' : 'rail';
    const elevated = k !== 'rail' || (t.bridge && t.bridge !== 'no') || parseInt(t.layer || '0') > 0;
    for (const pts of clipPolyline(simplifyLine(proj(w.geometry), 0.5), rect)) rail.push({ k, e: elevated ? 1 : 0, c: flat(pts) });
  }

  // ---------- POIs ----------
  const poi = { tree: [], lamp: [], bus: [], food: [], bench: [], station: [], entrance: [] };
  for (const n of nodes) {
    const t = n.tags || {};
    const [x, y] = P.project(n.lat, n.lon);
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    const xy = [r1(x), r1(y)];
    if (t.natural === 'tree') poi.tree.push(...xy);
    else if (t.highway === 'street_lamp') poi.lamp.push(...xy);
    else if (t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes')) poi.bus.push(...xy);
    else if (['cafe', 'restaurant', 'fast_food', 'bar', 'pub'].includes(t.amenity)) poi.food.push({ x: xy[0], y: xy[1], n: t.name || t.amenity });
    else if (t.amenity === 'bench') poi.bench.push(...xy);
    else if ((t.railway === 'station' || t.public_transport === 'station') && t.name) poi.station.push({ x: xy[0], y: xy[1], n: t.name });
    else if (t.entrance) poi.entrance.push(...xy);
  }

  // ---------- blocking footprints (same rule as the app's collision: grounded, not open) ----------
  const blockers = finalBuildings.filter((b) => !b.open && (b.kind === 'building' || (b.mh || 0) <= 2));
  const BCELL = 25, bgrid = new Map();
  blockers.forEach((b, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of b.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    b.bb = [x0, y0, x1, y1];
    for (let gx = Math.floor(x0 / BCELL); gx <= Math.floor(x1 / BCELL); gx++) for (let gy = Math.floor(y0 / BCELL); gy <= Math.floor(y1 / BCELL); gy++) {
      const k = gx * 100000 + gy; (bgrid.get(k) || bgrid.set(k, []).get(k)).push(i);
    }
  });
  const inBlocker = (x, y) => (bgrid.get(Math.floor(x / BCELL) * 100000 + Math.floor(y / BCELL)) || []).some((i) => {
    const b = blockers[i]; return x >= b.bb[0] && x <= b.bb[2] && y >= b.bb[1] && y <= b.bb[3] && pointInRing(x, y, b.outer);
  });
  let edgesThroughBuildings = 0;

  // ---------- walk graph ----------
  const WALK_HW = new Set(['footway', 'path', 'pedestrian', 'steps', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'secondary', 'primary', 'tertiary_link', 'secondary_link', 'primary_link', 'cycleway', 'track']);
  const FOOT_HW = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track']);
  const nodeIndex = new Map(); const nxy = []; const adj = []; const edges = [];
  const nid = (id, lat, lon) => {
    if (nodeIndex.has(id)) return nodeIndex.get(id);
    const i = nxy.length / 2; const [x, y] = P.project(lat, lon);
    nxy.push(r1(x), r1(y)); adj.push([]); nodeIndex.set(id, i); return i;
  };
  for (const w of ways) {
    const t = w.tags || {};
    if (!t.highway || !WALK_HW.has(t.highway) || !w.nodes || !w.geometry || w.geometry.length !== w.nodes.length) continue;
    if (t.access === 'no' || t.foot === 'no' || t.indoor === 'yes' || t.area === 'yes') continue;
    if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') continue;
    if (t.service === 'parking_aisle' || t.service === 'drive-through') continue;
    if (t.highway === 'footway' && t.level && !/^0(;|$)/.test(t.level)) continue;
    const foot = FOOT_HW.has(t.highway) || t.highway === 'living_street';
    const rw = r1(Math.min(Math.max(parseLength(t.width) ?? (t.lanes ? parseInt(t.lanes) * LANE_WIDTH_M : ROAD_WIDTH_DEFAULTS[t.highway] ?? 6), 2), 30));
    for (let i = 0; i < w.nodes.length - 1; i++) {
      const a = nid(w.nodes[i], w.geometry[i].lat, w.geometry[i].lon);
      const b = nid(w.nodes[i + 1], w.geometry[i + 1].lat, w.geometry[i + 1].lon);
      if (a === b) continue;
      const ax = nxy[2 * a], ay = nxy[2 * a + 1], bx = nxy[2 * b], by = nxy[2 * b + 1];
      const L = Math.hypot(bx - ax, by - ay), ns = Math.max(2, Math.ceil(L / 2));
      let through = false;
      for (let k = 1; k < ns && !through; k++) through = inBlocker(ax + (bx - ax) * k / ns, ay + (by - ay) * k / ns);
      if (through) { edgesThroughBuildings++; continue; }
      const e = edges.length / 3;
      edges.push(a, b, foot ? 0 : rw); // 0 = footpath; otherwise road width (NPCs walk beside it)
      adj[a].push(e); adj[b].push(e);
    }
  }
  // Largest connected component, restricted to nodes inside the box.
  const N = nxy.length / 2;
  const insideNode = (i) => nxy[2 * i] >= minX && nxy[2 * i] <= maxX && nxy[2 * i + 1] >= minY && nxy[2 * i + 1] <= maxY;
  const comp = new Int32Array(N).fill(-1); let best = -1, bestSize = 0;
  for (let s = 0, c = 0; s < N; s++) {
    if (comp[s] !== -1 || !insideNode(s)) continue;
    const stack = [s]; comp[s] = c; let size = 0;
    while (stack.length) {
      const u = stack.pop(); size++;
      for (const e of adj[u]) { const v = edges[3 * e] === u ? edges[3 * e + 1] : edges[3 * e]; if (comp[v] === -1 && insideNode(v)) { comp[v] = c; stack.push(v); } }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  const remap = new Int32Array(N).fill(-1); const gN = [];
  for (let i = 0; i < N; i++) if (comp[i] === best) { remap[i] = gN.length / 2; gN.push(nxy[2 * i], nxy[2 * i + 1]); }
  const gE = [];
  for (let e = 0; e < edges.length / 3; e++) {
    const a = remap[edges[3 * e]], b = remap[edges[3 * e + 1]];
    if (a >= 0 && b >= 0) gE.push(a, b, edges[3 * e + 2]);
  }
  // Snap destinations to the graph (uniform grid of graph nodes).
  const CELL = 50; const grid = new Map();
  for (let i = 0; i < gN.length / 2; i++) { const k = `${Math.floor(gN[2 * i] / CELL)},${Math.floor(gN[2 * i + 1] / CELL)}`; (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  const footNode = new Uint8Array(gN.length / 2);
  for (let e = 0; e < gE.length / 3; e++) if (gE[3 * e + 2] === 0) { footNode[gE[3 * e]] = 1; footNode[gE[3 * e + 1]] = 1; }
  const nearest = (x, y, maxD = 60, preferFoot = true) => {
    let bi = -1, bd = maxD;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (const i of grid.get(`${cx + dx},${cy + dy}`) || []) {
      const d = Math.hypot(gN[2 * i] - x, gN[2 * i + 1] - y) + (preferFoot && !footNode[i] ? 15 : 0);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const uniq = (a) => [...new Set(a.filter((i) => i >= 0))];
  const dest = {
    food: uniq(poi.food.map((p) => nearest(p.x, p.y))),
    bench: uniq([...Array(poi.bench.length / 2).keys()].map((i) => nearest(poi.bench[2 * i], poi.bench[2 * i + 1], 40))),
    transit: uniq([...Array(poi.bus.length / 2).keys()].map((i) => nearest(poi.bus[2 * i], poi.bus[2 * i + 1])).concat(poi.station.map((s) => nearest(s.x, s.y, 120)))),
    park: [], office: [], home: [],
  };
  for (let i = 0; i < gN.length / 2; i++) for (const p of parks) if (p._area > 2000 && pointInRing(gN[2 * i], gN[2 * i + 1], p._ring)) { dest.park.push(i); break; }
  const OFFICE = /^(office|commercial|retail|government|civic|public|hotel)$/; const HOME = /^(apartments|residential|house|dormitory)$/;
  for (const b of finalBuildings) {
    if (b.kind !== 'building') continue;
    const n = nearest(b.ctr[0], b.ctr[1], 120);
    if (n < 0) continue;
    if (OFFICE.test(b.type) || (b.type === 'yes' && b.h >= 60)) dest.office.push(n);
    else if (HOME.test(b.type)) dest.home.push(n);
  }
  dest.office = uniq(dest.office); dest.home = uniq(dest.home); dest.park = uniq(dest.park);
  if (dest.home.length < 20) dest.home = uniq(dest.home.concat(dest.office.filter((_, i) => i % 2))); // documented fallback

  // ---------- labels & spawn ----------
  const labels = [];
  for (const b of finalBuildings) if (b.landmark) {
    const hMax = Math.max(b.h, ...finalBuildings.filter((p) => p.parent === b).map((p) => p.h));
    labels.push({ n: b.landmark, x: r1(b.ctr[0]), y: r1(b.ctr[1]), h: r1(hMax), k: 'landmark' });
  }
  for (const pl of landmarkCfg.places) {
    if (pl.matchPark) {
      const re = new RegExp(pl.matchPark, 'i');
      const p = parks.filter((q) => q.n && re.test(q.n)).sort((a, b) => b._area - a._area)[0];
      if (p) { const c = centroid(p._ring); labels.push({ n: pl.name, x: r1(c[0]), y: r1(c[1]), h: 25, k: 'place' }); }
      else labels.push({ n: pl.name, missing: true });
    } else { const [x, y] = P.project(pl.lat, pl.lon); labels.push({ n: pl.name, x: r1(x), y: r1(y), h: 30, k: 'place', approx: true }); }
  }
  const bayfront = parks.filter((q) => q.n && /^Bayfront Park$/i.test(q.n)).sort((a, b) => b._area - a._area)[0];
  let spawn = [0, 0];
  if (bayfront) {
    const c = centroid(bayfront._ring);
    const blocked = (x, y) => finalBuildings.some((b) => pointInRing(x, y, b.outer)) || !pointInRing(x, y, bayfront._ring);
    outer: for (let r = 0; r < 300; r += 4) for (let a = 0; a < 6.283; a += 0.3) {
      const x = c[0] + r * Math.cos(a), y = c[1] + r * Math.sin(a);
      if (!blocked(x, y)) { spawn = [r1(x), r1(y)]; break outer; }
    }
  }

  // ---------- assemble ----------
  const outBuildings = finalBuildings.map((b) => ({
    c: flat(b.outer), ...(b.holes.length ? { holes: b.holes.map(flat) } : {}),
    h: r1(b.h), ...(b.mh ? { mh: r1(b.mh) } : {}),
    ...(b.kind === 'building:part' ? { p: 1 } : {}), ...(b.hasParts ? { hp: 1 } : {}),
    ...(b.src === 'default' ? { d: 1 } : {}), ...(b.src === 'landmark' ? { lm: 1 } : {}), ...(b.open ? { o: 1 } : {}),
    ...(b.landmark ? { n: b.landmark } : {}),
  }));
  const data = {
    meta: {
      title: 'Downtown and Brickell, Miami',
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/)',
      source: raw._fetched?.endpoint, fetched: raw._fetched?.date, method: raw._fetched?.method || 'overpass',
      bbox: BBOX, origin: { lat: lat0, lon: lon0 }, projection: 'equirectangular, meters, x=east y=north',
      extent: { minX: r1(minX), minY: r1(minY), maxX: r1(maxX), maxY: r1(maxY) },
      spawn, generated: new Date().toISOString(),
    },
    buildings: outBuildings, roads, land: land.map(flat), water, parks: parks.map(({ _ring, _area, ...p }) => p), beaches, rail, poi, labels: labels.filter((l) => !l.missing),
    walk: { nodes: gN, edges: gE, dest },
  };
  report.counts = {
    buildings: outBuildings.filter((b) => !b.p).length, parts: outBuildings.filter((b) => b.p).length, hiddenParents: outBuildings.filter((b) => b.hp).length,
    roads: roads.length, water: water.length, parks: parks.length, rail: rail.length, trees: poi.tree.length / 2, lamps: poi.lamp.length / 2,
    walkNodes: gN.length / 2, walkEdges: gE.length / 3, walkEdgesDroppedThroughBuildings: edgesThroughBuildings, openStructures: finalBuildings.filter((b) => b.open).length, walkNodesDroppedNotLargestComponent: N - gN.length / 2,
    dest: Object.fromEntries(Object.entries(dest).map(([k, v]) => [k, v.length])),
  };
  report.land = landInfo; report.landmarks = landmarkReport; report.missingPlaces = labels.filter((l) => l.missing).map((l) => l.n);
  report.spawn = { spawn, bayfrontFound: !!bayfront };
  return { data, report, P, rect };
}

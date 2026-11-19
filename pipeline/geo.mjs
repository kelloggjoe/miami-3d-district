// Geometry helpers for the pipeline. Units: meters in a local planar frame (x east, y north).
const R = 6371008.8;
const D2R = Math.PI / 180;

export function makeProjection(lat0, lon0) {
  const kx = Math.cos(lat0 * D2R) * R * D2R;
  const ky = R * D2R;
  return {
    lat0, lon0,
    project: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    unproject: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

export function ringArea(r) { // signed, CCW positive; r = [[x,y],...] not closed
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function centroid(r) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f; cy += (y1 + y2) * f; a += f;
  }
  if (Math.abs(a) < 1e-9) { // degenerate: average
    const s = r.reduce((p, q) => [p[0] + q[0], p[1] + q[1]], [0, 0]);
    return [s[0] / r.length, s[1] / r.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function simplifyLine(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let md = 0, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(pts[i], pts[s], pts[e]);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function simplifyRing(ring, tol) { // ring not closed
  if (ring.length <= 4) return ring.slice();
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > fd) { fd = d; far = i; }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tol);
  const b = simplifyLine(ring.slice(far).concat([ring[0]]), tol);
  const out = a.slice(0, -1).concat(b.slice(0, -1));
  return out.length >= 3 ? out : ring.slice();
}

export function dedupeRing(ring, eps = 0.01) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}

function segsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

export function selfIntersects(ring) {
  const n = ring.length;
  if (n > 1500) return false; // too costly; accept
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsIntersect(a, b, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

// Stitch way segments (arrays of [x,y] with stable endpoint keys) into closed rings / open chains.
export function stitch(segments, keyOf = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`) {
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings = [], chains = [];
  while (pool.length) {
    let cur = pool.pop();
    let changed = true;
    while (changed && keyOf(cur[0]) !== keyOf(cur[cur.length - 1])) {
      changed = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        const ce = keyOf(cur[cur.length - 1]), cs = keyOf(cur[0]);
        const ss = keyOf(s[0]), se = keyOf(s[s.length - 1]);
        if (ce === ss) cur = cur.concat(s.slice(1));
        else if (ce === se) cur = cur.concat(s.slice(0, -1).reverse());
        else if (cs === se) cur = s.concat(cur.slice(1));
        else if (cs === ss) cur = s.slice(1).reverse().concat(cur);
        else continue;
        pool.splice(i, 1); changed = true; break;
      }
    }
    if (keyOf(cur[0]) === keyOf(cur[cur.length - 1]) && cur.length >= 4) rings.push(cur.slice(0, -1));
    else chains.push(cur);
  }
  return { rings, chains };
}

// --- Coastline → land polygons, clipped to an axis-aligned rectangle --------------------------
// OSM convention: land is on the LEFT of the coastline direction.
export function coastlineToLand(chainsAndRings, rect) {
  const { minX, minY, maxX, maxY } = rect;
  const W = maxX - minX, H = maxY - minY, P = 2 * (W + H);
  const inside = (p) => p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY;
  // perimeter param, CCW starting at (minX,minY)
  const perim = ([x, y]) => {
    const e = 1e-6;
    if (Math.abs(y - minY) < e) return x - minX;
    if (Math.abs(x - maxX) < e) return W + (y - minY);
    if (Math.abs(y - maxY) < e) return W + H + (maxX - x);
    return 2 * W + H + (maxY - y);
  };
  const clipSeg = (a, b) => { // Liang-Barsky, returns [t0,t1] or null
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy], q = [a[0] - minX, maxX - a[0], a[1] - minY, maxY - a[1]];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [t0, t1];
  };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  const islands = []; // closed rings fully inside
  const pieces = [];  // open pieces that enter and exit the rect: {pts, ein, eout}
  for (const { pts, closed } of chainsAndRings) {
    const line = closed ? pts.concat([pts[0]]) : pts;
    if (closed && line.every(inside)) { islands.push(pts); continue; }
    let cur = null;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const c = clipSeg(a, b);
      if (!c) { continue; }
      const [t0, t1] = c;
      const pa = lerp(a, b, t0), pb = lerp(a, b, t1);
      if (!cur) cur = { pts: [pa], startOnEdge: t0 > 0 || !inside(a) };
      cur.pts.push(pb);
      if (t1 < 1) { cur.endOnEdge = true; pieces.push(cur); cur = null; }
    }
    if (cur) { cur.endOnEdge = false; pieces.push(cur); }
  }
  // Only pieces that both enter and exit through the boundary can be closed against it.
  const usable = pieces.filter((p) => p.startOnEdge && p.endOnEdge && p.pts.length >= 2);
  const dangling = pieces.length - usable.length;
  const land = [];
  const used = new Set();
  for (let s = 0; s < usable.length; s++) {
    if (used.has(s)) continue;
    const ring = [];
    let i = s, guard = 0;
    while (guard++ < 1000) {
      used.add(i);
      const piece = usable[i];
      ring.push(...piece.pts);
      const exitT = perim(piece.pts[piece.pts.length - 1]);
      // walk CCW along the boundary to the nearest entry point
      let best = -1, bestD = Infinity;
      for (let j = 0; j < usable.length; j++) {
        const d = (perim(usable[j].pts[0]) - exitT + P) % P;
        if (d < bestD && !(used.has(j) && j !== s)) { bestD = d; best = j; }
      }
      // add rect corners passed on the way
      const corners = [[minX, minY, 0], [maxX, minY, W], [maxX, maxY, W + H], [minX, maxY, 2 * W + H]];
      const cs = corners.map((c) => ({ p: [c[0], c[1]], d: (c[2] - exitT + P) % P })).filter((c) => c.d > 1e-9 && c.d < bestD).sort((a, b) => a.d - b.d);
      for (const c of cs) ring.push(c.p);
      if (best === s || best < 0) break;
      i = best;
    }
    land.push(ring);
  }
  return { land, islands, dangling };
}

// Clip a polyline to a rectangle; returns zero or more pieces.
export function clipPolyline(pts, { minX, minY, maxX, maxY }) {
  const out = []; let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy], q = [a[0] - minX, maxX - a[0], a[1] - minY, maxY - a[1]];
    let ok = true;
    for (let k = 0; k < 4 && ok; k++) {
      if (p[k] === 0) { if (q[k] < 0) ok = false; continue; }
      const r = q[k] / p[k];
      if (p[k] < 0) { if (r > t1) ok = false; else if (r > t0) t0 = r; } else { if (r < t0) ok = false; else if (r < t1) t1 = r; }
    }
    if (!ok) { if (cur) { out.push(cur); cur = null; } continue; }
    const pa = [a[0] + dx * t0, a[1] + dy * t0], pb = [a[0] + dx * t1, a[1] + dy * t1];
    if (!cur) cur = [pa];
    cur.push(pb);
    if (t1 < 1) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.length >= 2);
}

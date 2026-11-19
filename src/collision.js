// Collision world: building footprints (exact polygons in a uniform grid) + a 1 m land/water raster.
// Footprints carry a height range [mh, h] so the same data works for walking and for flying:
// a footprint blocks the player only where it overlaps the player's body (feet z .. z + BODY),
// and anything at most STEP above the feet can be stepped onto (curbs, car roofs from above, rooftops).
const CELL = 20;
export const STEP = 0.5, BODY = 1.8;

export function buildCollision(data) {
  const { minX, minY, maxX, maxY } = data.meta.extent;
  // ---- buildings: every footprint that touches the ground (parents always, parts only if grounded) ----
  const polys = [];
  for (const b of data.buildings) {
    const r = []; for (let i = 0; i < b.c.length; i += 2) r.push(b.c[i], b.c[i + 1]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
    // A parent whose parts are drawn instead is invisible: it only blocks at street level (its parts do the rest)
    // and is never stood on.
    const h = b.hp ? 2.0 : Math.max((b.mh || 0) + 0.5, b.h), mh = b.mh || 0;
    polys.push({ r: Float64Array.from(r), x0, y0, x1, y1, h, mh, noStand: !!b.hp });
  }
  const grid = new Map();
  const index = (p, i) => {
    for (let gx = Math.floor(p.x0 / CELL); gx <= Math.floor(p.x1 / CELL); gx++)
      for (let gy = Math.floor(p.y0 / CELL); gy <= Math.floor(p.y1 / CELL); gy++) {
        const k = gx * 100000 + gy; (grid.get(k) || grid.set(k, []).get(k)).push(i);
      }
  };
  polys.forEach(index);
  // Extra solid obstacles added after load (e.g. parked cars). rings: [[x,y],...]
  function addPolys(rings) {
    for (const ring of rings) {
      const r = Float64Array.from(ring.flat());
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const p = { r, x0, y0, x1, y1, h: 1.6, mh: 0, extra: true }; polys.push(p); index(p, polys.length - 1);
    }
  }
  const near = (x, y, r) => {
    const out = new Set();
    for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++)
      for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++)
        for (const i of grid.get(gx * 100000 + gy) || []) out.add(i);
    return out;
  };
  const inside = (x, y, r) => {
    let c = false;
    for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const solidAt = (p, z) => p.h > z + STEP && p.mh < z + BODY; // overlaps the body, too tall to step onto
  function insideBuilding(x, y, z = 0) {
    for (const i of near(x, y, 0)) { const p = polys[i]; if (solidAt(p, z) && x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1 && inside(x, y, p.r)) return true; }
    return false;
  }
  // Highest surface under (x, y) that a player whose feet are at z can stand on (0 = street level).
  function groundAt(x, y, z = 0) {
    let g = 0;
    for (const i of near(x, y, 0)) {
      const p = polys[i];
      if (p.noStand || p.h > z + STEP + 1e-6 || p.h <= g) continue;
      if (x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1 && inside(x, y, p.r)) g = p.h;
    }
    return g;
  }
  // Push a circle out of nearby building edges. Returns corrected [x,y].
  function pushOut(x, y, rad, z = 0) {
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (const i of near(x, y, rad + 1)) {
        const p = polys[i];
        if (!solidAt(p, z)) continue;
        if (x < p.x0 - rad || x > p.x1 + rad || y < p.y0 - rad || y > p.y1 + rad) continue;
        const r = p.r, isIn = inside(x, y, r);
        let bd = Infinity, bx = 0, by = 0;
        for (let k = 0, n = r.length, j = n - 2; k < n; j = k, k += 2) {
          const ax = r[j], ay = r[j + 1], dx = r[k] - ax, dy = r[k + 1] - ay;
          const l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
          const cx = ax + t * dx, cy = ay + t * dy, d = Math.hypot(x - cx, y - cy);
          if (d < bd) { bd = d; bx = cx; by = cy; }
        }
        if (isIn) { // inside: move to nearest edge point then out by radius
          const nx = bx - x, ny = by - y, L = Math.hypot(nx, ny) || 1;
          x = bx + (nx / L) * rad; y = by + (ny / L) * rad; moved = true;
        } else if (bd < rad) {
          const nx = x - bx, ny = y - by, L = bd || 1;
          x = bx + (nx / L) * rad; y = by + (ny / L) * rad; moved = true;
        }
      }
      if (!moved) break;
    }
    return [x, y];
  }

  // ---- walkable raster (1 m): land minus water, plus bridges ----
  const RES = 1;
  const w = Math.ceil((maxX - minX) * RES), h = Math.ceil((maxY - minY) * RES);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const toPx = (x, y) => [(x - minX) * RES, (maxY - y) * RES];
  const poly = (f) => { for (let i = 0; i < f.length; i += 2) { const [u, v] = toPx(f[i], f[i + 1]); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); } ctx.closePath(); };
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff'; for (const l of data.land) { ctx.beginPath(); poly(l); ctx.fill('evenodd'); }
  ctx.fillStyle = '#000'; for (const wt of data.water) { ctx.beginPath(); poly(wt.c); for (const hh of wt.holes || []) poly(hh); ctx.fill('evenodd'); }
  ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const r of data.roads) {
    if (!r.b) continue;
    ctx.lineWidth = Math.max(3, r.w) * RES; ctx.beginPath();
    for (let i = 0; i < r.c.length; i += 2) { const [u, v] = toPx(r.c[i], r.c[i + 1]); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); }
    ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = img[i * 4] > 127 ? 1 : 0;
  const walkableGround = (x, y) => {
    const u = Math.floor((x - minX) * RES), v = Math.floor((maxY - y) * RES);
    if (u < 0 || v < 0 || u >= w || v >= h) return false;
    return mask[v * w + u] === 1;
  };
  const groundOk = (x, y, rad) => walkableGround(x, y) && walkableGround(x + rad, y) && walkableGround(x - rad, y) && walkableGround(x, y + rad) && walkableGround(x, y - rad);

  // Full move with sliding: resolve buildings by push-out, water by axis-separated fallback.
  // z = feet height. Water only blocks near street level; in the air (flying, or on a roof) it does not.
  function move(x, y, dx, dy, rad, z = 0) {
    const ok = (px, py) => (z >= 0.6 || groundOk(px, py, rad)) && !insideBuilding(px, py, z);
    let [nx, ny] = pushOut(x + dx, y + dy, rad, z);
    if (ok(nx, ny)) return [nx, ny];
    for (const [sx, sy] of [[dx, 0], [0, dy]]) {
      if (!sx && !sy) continue;
      [nx, ny] = pushOut(x + sx, y + sy, rad, z);
      if (ok(nx, ny)) return [nx, ny];
    }
    return [x, y];
  }
  const blocked = (x, y, rad = 0.3) => !groundOk(x, y, rad) || insideBuilding(x, y) || pushOut(x, y, rad).some((v, i) => Math.abs(v - (i ? y : x)) > 1e-6);
  return { move, blocked, insideBuilding, groundAt, walkableGround, polys, addPolys, maskSize: [w, h], extent: { minX, minY, maxX, maxY } };
}

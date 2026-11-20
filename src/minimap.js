// Minimap (corner, follows the player, north up) and a full-screen map for teleporting.
//   M          open / close the full map
//   click map  teleport to the nearest open street-level spot
//   Shift+click on a building: land on its roof
//   landmark list: teleport next to that place
const SCALE = 0.5; // px per meter in the pre-rendered map image

function ringPath(ctx, flat, toPx) {
  for (let i = 0; i < flat.length; i += 2) { const [u, v] = toPx(flat[i], flat[i + 1]); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); }
  ctx.closePath();
}

// Render the whole district once into an offscreen canvas.
function renderMapImage(data) {
  const { minX, minY, maxX, maxY } = data.meta.extent;
  const W = Math.ceil((maxX - minX) * SCALE), H = Math.ceil((maxY - minY) * SCALE);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const toPx = (x, y) => [(x - minX) * SCALE, (maxY - y) * SCALE];
  g.fillStyle = '#5aa9c9'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#e9e3d4'; for (const l of data.land) { g.beginPath(); ringPath(g, l, toPx); g.fill('evenodd'); }
  g.fillStyle = '#5aa9c9'; for (const w of data.water) { g.beginPath(); ringPath(g, w.c, toPx); for (const h of w.holes || []) ringPath(g, h, toPx); g.fill('evenodd'); }
  g.fillStyle = '#9fcb84'; for (const p of data.parks) { g.beginPath(); ringPath(g, p.c, toPx); for (const h of p.holes || []) ringPath(g, h, toPx); g.fill('evenodd'); }
  g.lineCap = 'round'; g.lineJoin = 'round';
  const FOOT = new Set(['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'track']);
  for (const pass of [0, 1]) for (const r of data.roads) {
    const foot = FOOT.has(r.t);
    if ((pass === 0) !== foot) continue;
    g.strokeStyle = foot ? '#d8cdb8' : '#ffffff'; g.lineWidth = foot ? 1 : Math.max(1.5, r.w * SCALE);
    g.beginPath(); for (let i = 0; i < r.c.length; i += 2) { const [u, v] = toPx(r.c[i], r.c[i + 1]); i ? g.lineTo(u, v) : g.moveTo(u, v); } g.stroke();
  }
  const sorted = data.buildings.filter((b) => !b.hp).sort((a, b) => a.h - b.h);
  for (const b of sorted) {
    const t = Math.min(1, b.h / 220);
    g.fillStyle = `hsl(${205 - t * 10}, ${14 + t * 30}%, ${78 - t * 42}%)`;
    g.beginPath(); ringPath(g, b.c, toPx); for (const h of b.holes || []) ringPath(g, h, toPx); g.fill('evenodd');
  }
  g.strokeStyle = '#d23f8f'; g.lineWidth = 1.6;
  for (const r of data.rail) { if (r.k !== 'metromover') continue; g.beginPath(); for (let i = 0; i < r.c.length; i += 2) { const [u, v] = toPx(r.c[i], r.c[i + 1]); i ? g.lineTo(u, v) : g.moveTo(u, v); } g.stroke(); }
  return { canvas: c, toPx, W, H };
}

function drawArrow(g, x, y, ang, size, fill) {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.beginPath(); g.moveTo(0, -size); g.lineTo(size * 0.65, size * 0.75); g.lineTo(0, size * 0.35); g.lineTo(-size * 0.65, size * 0.75); g.closePath();
  g.fillStyle = fill; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#ffffff'; g.stroke(); g.restore();
}

export function createMaps({ data, player, camera, crowd, collision, world, onOpenChange }) {
  const img = renderMapImage(data);
  const { minX, maxY } = data.meta.extent;
  const st = player.state;
  const heading = () => { const d = camera.getWorldDirection(camera.position.clone().set(0, 0, 0)); return Math.atan2(d.x, -d.z); }; // clockwise from north

  // ---------------------------------------------------------------- minimap
  const mini = document.getElementById('minimap');
  const mctx = mini.getContext('2d');
  const MINI_PX = 180, MINI_RANGE = 220; // meters from center to edge
  const dpr = Math.min(2, devicePixelRatio || 1);
  mini.width = mini.height = MINI_PX * dpr;
  let miniTimer = 0;
  function drawMini(dt) {
    miniTimer -= dt; if (miniTimer > 0) return; miniTimer = 1 / 20; // 20 Hz is plenty
    const g = mctx, S = (MINI_PX * dpr) / (2 * MINI_RANGE); // canvas px per meter
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#5aa9c9'; g.fillRect(0, 0, mini.width, mini.height);
    const [px, py] = img.toPx(st.x, st.y);
    const k = S / SCALE;
    g.imageSmoothingEnabled = true;
    g.drawImage(img.canvas, mini.width / 2 - px * k, mini.height / 2 - py * k, img.W * k, img.H * k);
    // people outdoors
    g.fillStyle = '#e0457b';
    for (const n of crowd.npcs.slice(0, crowd.count)) {
      if (n.state === 'inside' || n.pending) continue;
      const dx = (n.x - st.x) * S, dy = -(n.y - st.y) * S;
      if (Math.abs(dx) > mini.width / 2 || Math.abs(dy) > mini.height / 2) continue;
      g.fillRect(mini.width / 2 + dx - dpr, mini.height / 2 + dy - dpr, 2 * dpr, 2 * dpr);
    }
    drawArrow(g, mini.width / 2, mini.height / 2, heading(), 8 * dpr, st.flying ? '#f2b134' : '#1f8a8a');
    g.fillStyle = '#10202b'; g.font = `bold ${11 * dpr}px system-ui, sans-serif`; g.textAlign = 'center';
    g.fillText('N', mini.width / 2, 13 * dpr);
  }

  // ---------------------------------------------------------------- full map + teleport
  const overlay = document.getElementById('bigmap');
  const big = document.getElementById('bigmap-canvas');
  const bctx = big.getContext('2d');
  const list = document.getElementById('bigmap-places');
  const hint = document.getElementById('bigmap-hint');
  let open = false, view = null, hover = null;

  // Nearest open street-level spot to (x, y), searching outward up to 120 m.
  function openSpotNear(x, y) {
    const free = (px, py) => collision.walkableGround(px, py) && !collision.blocked(px, py, 0.5);
    if (free(x, y)) return [x, y];
    for (let r = 2; r <= 120; r += 2) for (let a = 0; a < Math.PI * 2; a += Math.max(0.08, 1.5 / r)) {
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (free(px, py)) return [px, py];
    }
    return null;
  }
  function teleport(x, y, { roof = false } = {}) {
    let z = 0;
    if (roof) z = collision.groundAt(x, y, 1e4);
    if (!roof || z <= 0) { const s = openSpotNear(x, y); if (!s) return false; [x, y] = s; z = 0; }
    st.x = x; st.y = y; st.z = z; st.vz = st.vx = st.vy = 0; st.onGround = true;
    player.setFlying(false);
    camera.position.set(x, 1.7 + z, -y);
    world.updateLod(x, y);
    return true;
  }

  function layout() {
    const r = big.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    big.width = Math.round(r.width * d); big.height = Math.round(r.height * d);
    const s = Math.min(big.width / img.W, big.height / img.H) * 0.96;
    view = { s, ox: (big.width - img.W * s) / 2, oy: (big.height - img.H * s) / 2, d };
  }
  const worldFromEvent = (e) => {
    const r = big.getBoundingClientRect();
    const cx = (e.clientX - r.left) * view.d, cy = (e.clientY - r.top) * view.d;
    const u = (cx - view.ox) / view.s, v = (cy - view.oy) / view.s;
    return [minX + u / SCALE, maxY - v / SCALE];
  };
  function drawBig() {
    if (!open) return;
    const g = bctx, { s, ox, oy, d } = view;
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#5aa9c9'; g.fillRect(0, 0, big.width, big.height);
    g.drawImage(img.canvas, ox, oy, img.W * s, img.H * s);
    const P = (x, y) => { const [u, v] = img.toPx(x, y); return [ox + u * s, oy + v * s]; };
    g.font = `600 ${11 * d}px system-ui, sans-serif`; g.textAlign = 'left';
    for (const l of data.labels) {
      const [u, v] = P(l.x, l.y);
      g.fillStyle = l.k === 'landmark' ? '#10202b' : '#c2185b';
      g.beginPath(); g.arc(u, v, 3 * d, 0, 7); g.fill();
      g.lineWidth = 3 * d; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.strokeText(l.n, u + 5 * d, v - 4 * d); g.fillText(l.n, u + 5 * d, v - 4 * d);
    }
    if (hover) { const [u, v] = P(hover[0], hover[1]); g.strokeStyle = '#e0457b'; g.lineWidth = 2 * d; g.beginPath(); g.arc(u, v, 9 * d, 0, 7); g.stroke(); }
    const [u, v] = P(st.x, st.y);
    drawArrow(g, u, v, heading(), 10 * d, st.flying ? '#f2b134' : '#1f8a8a');
  }
  function setOpen(o) {
    open = o; overlay.classList.toggle('hidden', !o);
    if (o) { if (player.controls.isLocked) player.controls.unlock(); layout(); drawBig(); }
    onOpenChange && onOpenChange(o);
  }
  big.addEventListener('mousemove', (e) => {
    hover = worldFromEvent(e);
    const onRoof = collision.groundAt(hover[0], hover[1], 1e4) > 0;
    hint.textContent = onRoof ? 'Click: street next to this building · Shift+click: land on its roof' : 'Click to teleport here';
    drawBig();
  });
  big.addEventListener('mouseleave', () => { hover = null; drawBig(); });
  big.addEventListener('click', (e) => {
    const [x, y] = worldFromEvent(e);
    if (teleport(x, y, { roof: e.shiftKey })) { setOpen(false); player.controls.lock(); }
    else hint.textContent = 'No open ground near there. Try a spot on land.';
  });
  // landmark list
  const startEntry = data.meta.start ? { n: `${data.meta.start.name} (start)`, reset: true } : { n: 'Bayfront Park (start)', x: data.meta.spawn[0], y: data.meta.spawn[1] };
  const places = [startEntry, ...(data.meta.start ? [{ n: 'Bayfront Park', x: data.meta.spawn[0], y: data.meta.spawn[1] }] : []), ...data.labels.filter((l) => !l.approx && l.n !== 'Bayfront Park')]
    .concat(data.labels.filter((l) => l.approx));
  for (const p of places) {
    const b = document.createElement('button'); b.textContent = p.n;
    b.onclick = () => { if (p.reset) { player.reset(); world.updateLod(st.x, st.y); setOpen(false); player.controls.lock(); } else if (teleport(p.x, p.y)) { setOpen(false); player.controls.lock(); } };
    list.appendChild(b);
  }
  document.getElementById('bigmap-close').onclick = () => setOpen(false);
  mini.addEventListener('click', (e) => { e.stopPropagation(); setOpen(true); });
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !e.repeat) setOpen(!open);
    else if (e.code === 'Escape' && open) setOpen(false);
  });
  addEventListener('resize', () => { if (open) { layout(); drawBig(); } });

  return {
    update(dt) { drawMini(dt); if (open) drawBig(); },
    get open() { return open; }, setOpen, teleport, openSpotNear,
  };
}

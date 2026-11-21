// Explore page: search a place, frame a square on the map, build it in 3D (index.html?area=lat,lon,km&name=...).
// Map: MapLibre GL with OpenFreeMap's free "positron" style (no key). Search: OpenStreetMap Nominatim.
import * as maplibregl from 'maplibre-gl';
// MapLibre 6 runs its tile parsing in a module worker; let Vite bundle it and hand MapLibre the URL.
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
maplibregl.setWorkerUrl(mapWorkerUrl);
import 'maplibre-gl/dist/maplibre-gl.css';

const $ = (id) => document.getElementById(id);
const FEATURED = [
  { n: 'Brickell, Miami', lat: 25.7632, lon: -80.1944, km: 3 },
  { n: 'The Loop, Chicago', lat: 41.8818, lon: -87.6295, km: 2 },
  { n: 'Midtown Manhattan', lat: 40.7549, lon: -73.9840, km: 2 },
  { n: 'Shibuya, Tokyo', lat: 35.6595, lon: 139.7005, km: 2 },
  { n: 'Le Marais, Paris', lat: 48.8590, lon: 2.3620, km: 2 },
  { n: 'Alfama, Lisbon', lat: 38.7118, lon: -9.1300, km: 1 },
  { n: 'Shaw, Washington DC', lat: 38.9126, lon: -77.0219, km: 2 },
];
const HINTS = { 1: '1 × 1 km. Quick to build, great for a few blocks.', 2: '2 × 2 km. A good balance of size and loading time.', 3: '3 × 3 km. A whole district. Takes a little longer.', 4: '4 × 4 km. The biggest area. Can take a minute in dense cities.' };

let km = 2, placeName = '', placeAt = null;
const mobile = () => innerWidth <= 720;
const padding = () => (mobile() ? { top: 40, bottom: Math.round(innerHeight * 0.55), left: 20, right: 20 } : { top: 60, bottom: 60, left: 460, right: 60 });

const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-80.1944, 25.7632], zoom: 13, attributionControl: { compact: true }, maxPitch: 0, dragRotate: false, pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.setPadding(padding());

function square(lat, lon, size) {
  const dLat = (size * 500) / 111195, dLon = (size * 500) / (111195 * Math.cos((lat * Math.PI) / 180));
  return [[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]];
}
function update() {
  const c = map.getCenter(), sq = square(c.lat, c.lng, km);
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const mask = map.getSource('mask'), frame = map.getSource('frame');
  if (mask) mask.setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [world, sq.slice().reverse()] } });
  if (frame) frame.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: sq } });
  const top = map.project([c.lng, sq[2][1]]);
  const label = $('frame-label'); label.style.left = `${top.x}px`; label.style.top = `${top.y - 8}px`; label.textContent = `${km} × ${km} km`;
  $('where').textContent = `${placeName && placeAt && distKm(placeAt, c) < km ? placeName + ' · ' : ''}${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
}
const distKm = (a, b) => Math.hypot((a.lat - b.lat) * 111.2, (a.lng - b.lng) * 111.2 * Math.cos((a.lat * Math.PI) / 180));
// Center on (lat, lon) and zoom so the square fills most of the visible map (the map's padding keeps it clear of the panel).
function fitSquare(lat, lon, animate = true) {
  const pd = padding(), w = innerWidth - pd.left - pd.right, h = innerHeight - pd.top - pd.bottom;
  const metersPerPx = (km * 1000 * 1.4) / Math.max(120, Math.min(w, h));
  const zoom = Math.log2((40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * metersPerPx));
  if (animate) map.flyTo({ center: [lon, lat], zoom, duration: 900, essential: true });
  else map.jumpTo({ center: [lon, lat], zoom });
}

map.on('load', () => {
  map.addSource('mask', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('frame', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#0a2540', 'fill-opacity': 0.22 } });
  map.addLayer({ id: 'frame-glow', type: 'line', source: 'frame', paint: { 'line-color': '#635bff', 'line-width': 8, 'line-opacity': 0.18 } });
  map.addLayer({ id: 'frame', type: 'line', source: 'frame', paint: { 'line-color': '#533afd', 'line-width': 2.5 } });
  // tilt buildings a touch for depth where the style has them
  fitSquare(25.7632, -80.1944, false); update();
});
map.on('move', update);
addEventListener('resize', () => { map.setPadding(padding()); update(); });

// ---- size ----
for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => {
  km = +b.dataset.km;
  for (const o of document.querySelectorAll('.seg button')) { o.classList.toggle('on', o === b); o.setAttribute('aria-checked', o === b ? 'true' : 'false'); }
  $('size-hint').textContent = HINTS[km];
  const c = map.getCenter(); fitSquare(c.lat, c.lng); update();
});

// ---- featured ----
for (const f of FEATURED) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = f.n;
  b.onclick = () => {
    if (f.n.startsWith('Brickell')) { location.href = './'; return; } // the prebuilt demo
    placeName = f.n; placeAt = { lat: f.lat, lng: f.lon };
    if (f.km !== km) document.querySelector(`.seg button[data-km="${f.km}"]`).click();
    fitSquare(f.lat, f.lon);
  };
  $('chips').appendChild(b);
}

// ---- search (Nominatim; max one request a second per their policy) ----
let timer = null, lastQuery = '', results = [], sel = -1, lastCall = 0;
const list = $('results');
function render() {
  list.innerHTML = '';
  if (!results.length) { list.innerHTML = '<li class="empty">No places found</li>'; list.hidden = false; return; }
  results.forEach((r, i) => {
    const li = document.createElement('li'); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', i === sel ? 'true' : 'false');
    const name = r.name || r.display_name.split(',')[0];
    li.innerHTML = `<b></b><span></span>`; li.querySelector('b').textContent = name; li.querySelector('span').textContent = r.display_name;
    li.onmousedown = (e) => { e.preventDefault(); choose(r); };
    list.appendChild(li);
  });
  list.hidden = false;
}
function choose(r) {
  const lat = +r.lat, lon = +r.lon;
  placeName = r.name || r.display_name.split(',')[0]; placeAt = { lat, lng: lon };
  $('q').value = placeName; list.hidden = true; results = []; sel = -1;
  fitSquare(lat, lon);
}
async function search(q) {
  const wait = Math.max(0, 1000 - (Date.now() - lastCall)); if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': navigator.language || 'en' } });
    const json = await res.json();
    if (q !== lastQuery) return;
    results = json; sel = json.length ? 0 : -1; render();
  } catch { results = []; render(); }
}
$('q').addEventListener('input', (e) => {
  const q = e.target.value.trim(); lastQuery = q; clearTimeout(timer);
  if (q.length < 3) { list.hidden = true; return; }
  timer = setTimeout(() => search(q), 400);
});
$('q').addEventListener('keydown', (e) => {
  if (list.hidden || !results.length) { if (e.key === 'Enter' && $('q').value.trim().length >= 3) { lastQuery = $('q').value.trim(); search(lastQuery); } return; }
  if (e.key === 'ArrowDown') { sel = (sel + 1) % results.length; render(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { sel = (sel - 1 + results.length) % results.length; render(); e.preventDefault(); }
  if (e.key === 'Enter' && sel >= 0) { choose(results[sel]); e.preventDefault(); }
  if (e.key === 'Escape') list.hidden = true;
});
$('q').addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));

// ---- build ----
async function nameFor(c) {
  if (placeName && placeAt && distKm(placeAt, c) < km) return placeName;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${c.lat}&lon=${c.lng}`, { signal: AbortSignal.timeout(4000) });
    const j = await res.json(); const a = j.address || {};
    const local = a.neighbourhood || a.suburb || a.quarter || a.city_district || a.village || a.town;
    const city = a.city || a.town || a.village || a.county;
    return [local, city].filter((v, i, arr) => v && arr.indexOf(v) === i).join(', ') || j.name || '';
  } catch { return ''; }
}
$('build').addEventListener('click', async () => {
  const btn = $('build'); btn.disabled = true; btn.firstChild.textContent = 'Opening… ';
  const c = map.getCenter();
  const name = await nameFor(c);
  const u = new URL('./', location.href);
  u.searchParams.set('area', `${c.lat.toFixed(5)},${c.lng.toFixed(5)},${km}`);
  if (name) u.searchParams.set('name', name);
  location.href = u.toString();
});

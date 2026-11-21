// In-browser city generation for any area: download OpenStreetMap data from Overpass, then run the same
// pipeline used for the Miami build (pipeline/process.mjs) inside a Web Worker. Results are cached in
// IndexedDB so revisiting an area is instant and Overpass isn't asked twice.
//
// URL: ?area=<lat>,<lon>,<sizeKm>[&name=...]
import { QUERY_TEMPLATE } from './overpass-query.js';
import { normalizeOsmApi, wantedRelation } from '../pipeline/osm-normalize.mjs';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter']; // then the OSM API fallback below
const CACHE_VERSION = 'v3';

export function parseArea(params) {
  const a = params.get('area'); if (!a) return null;
  const [lat, lon, size] = a.split(',').map(Number);
  if (![lat, lon, size].every(Number.isFinite) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  const km = Math.min(4, Math.max(0.5, size || 2));
  const dLat = (km * 500) / 111195, dLon = (km * 500) / (111195 * Math.cos((lat * Math.PI) / 180));
  return { lat, lon, km, name: params.get('name') || '', bbox: { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon } };
}

// ---- tiny IndexedDB cache (best effort; any failure just skips caching) ----
function idb() {
  return new Promise((res, rej) => { try { const r = indexedDB.open('city-renderer', 1); r.onupgradeneeded = () => r.result.createObjectStore('areas'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } });
}
async function cacheGet(key) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('areas').objectStore('areas').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch { return null; } }
async function cachePut(key, val) { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('areas', 'readwrite'); t.objectStore('areas').put(val, key); t.oncomplete = res; t.onerror = res; }); } catch { /* ignore */ } }

async function fetchOverpass(bbox, onProgress) {
  const b = `${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)}`;
  const query = QUERY_TEMPLATE.replace('{{BBOX}}', b);
  let lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      onProgress({ step: 'download', text: `Downloading OpenStreetMap data (${new URL(url).host})…` });
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(40000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // stream so we can show the size as it arrives
      const reader = res.body.getReader(); const chunks = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress({ step: 'download', text: `Downloading OpenStreetMap data… ${(got / 1e6).toFixed(1)} MB` }); }
      const all = new Uint8Array(got); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      const text = new TextDecoder().decode(all);
      const json = JSON.parse(text);
      if (!json.elements) throw new Error('No data');
      return { elements: json.elements, _fetched: { method: 'overpass', endpoint: url, date: new Date().toISOString(), bbox } };
    } catch (e) { lastErr = e; }
  }
  // Fallback: the main OpenStreetMap API in small tiles (reliable, allows browser requests). Sequential and gentle.
  try { return await fetchOsmApi(bbox, onProgress); } catch (e) { lastErr = e; }
  throw new Error(`Couldn't reach the map data servers (${lastErr?.message || 'unknown error'}). Try again in a minute, or pick a smaller area.`);
}

async function fetchOsmApi(bbox, onProgress) {
  const API = 'https://api.openstreetmap.org/api/0.6';
  const STEP = 0.006;
  const queue = [];
  for (let lat = bbox.south; lat < bbox.north - 1e-9; lat += STEP) for (let lon = bbox.west; lon < bbox.east - 1e-9; lon += STEP)
    queue.push([lon, lat, Math.min(lon + STEP, bbox.east), Math.min(lat + STEP, bbox.north)]);
  const lists = []; let done = 0, total = queue.length, bytes = 0;
  while (queue.length) {
    const t = queue.shift().map((v) => +v.toFixed(6));
    onProgress({ step: 'download', text: `Downloading OpenStreetMap data… tile ${done + 1} of ${total} (${(bytes / 1e6).toFixed(1)} MB)` });
    const res = await fetch(`${API}/map.json?bbox=${t.join(',')}`, { signal: AbortSignal.timeout(60000) });
    if (res.status === 400) { const [w, s, e, n] = t, mx = (w + e) / 2, my = (s + n) / 2; queue.push([w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]); total += 3; continue; }
    if (!res.ok) throw new Error(`OSM API HTTP ${res.status}`);
    const txt = await res.text(); bytes += txt.length; lists.push(JSON.parse(txt).elements); done++;
  }
  // complete multipolygons that reach outside the tiles (rivers, large parks, big buildings)
  const rels = new Map(); for (const l of lists) for (const e of l) if (e.type === 'relation' && wantedRelation(e)) rels.set(e.id, e);
  let i = 0;
  for (const id of [...rels.keys()].slice(0, 60)) {
    onProgress({ step: 'download', text: `Completing rivers, parks and large buildings… ${++i} of ${Math.min(60, rels.size)}` });
    try { const r = await fetch(`${API}/relation/${id}/full.json`, { signal: AbortSignal.timeout(30000) }); if (r.ok) lists.push((await r.json()).elements); } catch { /* keep going */ }
  }
  return { elements: normalizeOsmApi(lists), _fetched: { method: 'osm-api-tiles', endpoint: API, date: new Date().toISOString(), bbox } };
}

export async function generateArea(area, onProgress) {
  const key = `${CACHE_VERSION}:${area.lat.toFixed(5)},${area.lon.toFixed(5)},${area.km}`;
  const cached = await cacheGet(key);
  if (cached) { onProgress({ step: 'done', text: 'Loaded from this browser' }); return cached; }
  const raw = await fetchOverpass(area.bbox, onProgress);
  if (raw.elements.length < 20) throw new Error('There is almost no map data here. Try an area with streets and buildings.');
  onProgress({ step: 'build', text: `Building the city from ${raw.elements.length.toLocaleString()} map features…` });
  const data = await new Promise((resolve, reject) => {
    const w = new Worker(new URL('./generator.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { if (e.data.error) reject(new Error(e.data.error)); else if (e.data.progress) onProgress(e.data.progress); else { resolve(e.data.data); w.terminate(); } };
    w.onerror = (e) => { reject(new Error(e.message || 'Worker failed')); w.terminate(); };
    w.postMessage({ raw, bbox: area.bbox, title: area.name || 'Generated area' });
  });
  data.meta.autoDensity = true;
  data.meta.area = { lat: area.lat, lon: area.lon, km: area.km, name: area.name };
  cachePut(key, data);
  onProgress({ step: 'done', text: `Built ${data.buildings.length.toLocaleString()} buildings` });
  return data;
}

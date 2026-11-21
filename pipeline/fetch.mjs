// Fetches raw OSM data for the bounding box and caches it as one normalized JSON file.
//
// Source order:
//   1. Overpass API endpoints (preferred; one request each until one succeeds).
//   2. OSM editing API /map in small tiles (fallback when every Overpass endpoint is unreachable).
//      Requests are sequential with a delay and cached per tile, so the servers are hit once.
//      Multipolygon relations we need are completed with /relation/{id}/full.
//
// Re-running reuses pipeline/cache/osm-raw.json unless --refresh is passed (usage policy: do not hammer).
// Output format mimics Overpass `out body geom`.
import fs from 'node:fs';
import path from 'node:path';
import { BBOX, OVERPASS_ENDPOINTS, USER_AGENT } from './config.mjs';

const b = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
export const QUERY = `[out:json][timeout:180][bbox:${b}];
(
  way["building"];
  relation["building"];
  way["building:part"];
  relation["building:part"];
  way["highway"];
  way["leisure"~"^(park|garden|playground|pitch|dog_park)$"];
  relation["leisure"~"^(park|garden)$"];
  way["landuse"~"^(grass|recreation_ground|village_green)$"];
  way["natural"~"^(water|coastline|wood|scrub|beach|sand)$"];
  relation["natural"="water"];
  way["waterway"~"^(river|riverbank|canal)$"];
  way["railway"];
  way["man_made"="bridge"];
  node["natural"="tree"];
  node["highway"~"^(street_lamp|bus_stop|crossing)$"];
  node["amenity"~"^(cafe|restaurant|fast_food|bench|bar|pub)$"];
  node["railway"~"^(station|stop|halt)$"];
  node["public_transport"~"^(station|platform|stop_position)$"];
  node["entrance"];
);
out body geom qt;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init = {}, timeoutMs = 90_000) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 160)}`); e.status = res.status; throw e; }
  return JSON.parse(text);
}

async function viaOverpass() {
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      console.log(`[fetch] Overpass ${url}`);
      const json = await getJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(QUERY),
      }, 240_000);
      return { elements: json.elements, source: { method: 'overpass', endpoint: url, query: QUERY } };
    } catch (e) { console.warn(`[fetch]   failed: ${e.message}`); }
  }
  return null;
}

async function viaOsmApi(tileCacheDir) {
  const API = 'https://api.openstreetmap.org/api/0.6';
  const STEP = 0.005;
  const nodes = new Map(), ways = new Map(), rels = new Map();
  const add = (els) => {
    for (const e of els) {
      if (e.type === 'node') nodes.set(e.id, e);
      else if (e.type === 'way') ways.set(e.id, e);
      else if (e.type === 'relation') rels.set(e.id, e);
    }
  };
  fs.mkdirSync(tileCacheDir, { recursive: true });
  const queue = [];
  for (let lat = BBOX.south; lat < BBOX.north - 1e-9; lat += STEP)
    for (let lon = BBOX.west; lon < BBOX.east - 1e-9; lon += STEP)
      queue.push([lon, lat, Math.min(lon + STEP, BBOX.east), Math.min(lat + STEP, BBOX.north)]);
  let requests = 0;
  while (queue.length) {
    const t = queue.shift().map((v) => +v.toFixed(6));
    const key = t.join('_');
    const cache = path.join(tileCacheDir, `map_${key}.json`);
    let json = null;
    if (fs.existsSync(cache)) json = JSON.parse(fs.readFileSync(cache, 'utf8'));
    else {
      for (let attempt = 0; ; attempt++) {
        try { json = await getJson(`${API}/map.json?bbox=${t.join(',')}`); break; }
        catch (e) {
          if (e.status === 400) { // too many nodes: split the tile
            const [w, s, ee, n] = t, mx = (w + ee) / 2, my = (s + n) / 2;
            queue.push([w, s, mx, my], [mx, s, ee, my], [w, my, mx, n], [mx, my, ee, n]);
            break;
          }
          if (attempt >= 3) throw e;
          console.warn(`[fetch]   retry ${attempt + 1}: ${e.message}`);
          await sleep(3000 * (attempt + 1));
        }
      }
      requests++;
      if (json) fs.writeFileSync(cache, JSON.stringify(json));
      await sleep(1200);
    }
    if (json) { add(json.elements); console.log(`[fetch] tile ${key}: ${json.elements.length} elements`); }
  }
  const wanted = [...rels.values()].filter((r) => r.tags && r.tags.type === 'multipolygon' &&
    (r.tags.building || r.tags['building:part'] || r.tags.leisure || r.tags.natural === 'water' || r.tags.waterway || r.tags.water));
  for (const r of wanted) {
    const cache = path.join(tileCacheDir, `rel_${r.id}.json`);
    let json;
    if (fs.existsSync(cache)) json = JSON.parse(fs.readFileSync(cache, 'utf8'));
    else {
      try { json = await getJson(`${API}/relation/${r.id}/full.json`); requests++; fs.writeFileSync(cache, JSON.stringify(json)); await sleep(1200); }
      catch (e) { console.warn(`[fetch]   relation ${r.id} incomplete: ${e.message}`); continue; }
    }
    add(json.elements);
  }
  console.log(`[fetch] OSM API: ${requests} network requests, ${nodes.size} nodes, ${ways.size} ways, ${rels.size} relations`);
  const geomOf = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean).map((n) => ({ lat: n.lat, lon: n.lon }));
  const elements = [];
  for (const n of nodes.values()) if (n.tags) elements.push({ type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: n.tags });
  for (const w of ways.values()) elements.push({ type: 'way', id: w.id, nodes: w.nodes, tags: w.tags || {}, geometry: geomOf(w) });
  for (const r of rels.values()) elements.push({
    type: 'relation', id: r.id, tags: r.tags || {},
    members: r.members.map((m) => ({ ...m, geometry: m.type === 'way' && ways.get(m.ref) ? geomOf(ways.get(m.ref)) : undefined })),
  });
  return { elements, source: { method: 'osm-api-tiles', endpoint: API, tileDeg: STEP, requests } };
}

export { filterElements } from './osm-normalize.mjs';
import { filterElements } from './osm-normalize.mjs';

export async function fetchOsm(cacheFile, { refresh = false, skipOverpass = false } = {}) {
  if (!refresh && fs.existsSync(cacheFile)) {
    console.log(`[fetch] using cached ${cacheFile}`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  const tileDir = path.join(path.dirname(cacheFile), 'tiles');
  const got = (!skipOverpass && await viaOverpass()) || await viaOsmApi(tileDir);
  const out = { elements: filterElements(got.elements), _fetched: { ...got.source, date: new Date().toISOString(), bbox: BBOX } };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  console.log(`[fetch] ${out.elements.length} elements cached to ${cacheFile}`);
  return out;
}

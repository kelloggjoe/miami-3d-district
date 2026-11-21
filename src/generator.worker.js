// Web Worker: turns raw OSM data for one area into the app's district data (same pipeline as the Miami build).
import { processOsm } from '../pipeline/process.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const len = (v) => { if (v == null) return null; const m = String(v).match(/^([\d.]+)\s*(m|ft)?/); if (!m) return null; return parseFloat(m[1]) * (m[2] === 'ft' ? 0.3048 : 1); };

// Landmarks picked automatically: the tallest named buildings, plus named buildings that have a Wikipedia /
// Wikidata link (a good sign they're notable). Places: the biggest named parks and neighborhood names.
function autoLandmarks(raw, bbox) {
  const named = [];
  for (const e of raw.elements) {
    const t = e.tags || {};
    if (!t.building || !t.name || t['building:part']) continue;
    const h = len(t.height) ?? (t['building:levels'] ? parseFloat(t['building:levels']) * 3.5 : 0);
    named.push({ name: t.name, h: h || 0, notable: !!(t.wikidata || t.wikipedia) });
  }
  const seen = new Set(), pick = [];
  const add = (b) => { if (!seen.has(b.name) && pick.length < 10) { seen.add(b.name); pick.push(b); } };
  named.filter((b) => b.h >= 25).sort((a, b) => b.h - a.h).slice(0, 7).forEach(add);
  named.filter((b) => b.notable).sort((a, b) => b.h - a.h).forEach(add);
  const parks = raw.elements.filter((e) => e.tags && e.tags.name && /^(park|garden)$/.test(e.tags.leisure || '') && e.geometry)
    .map((e) => ({ name: e.tags.name, size: e.geometry.length })).sort((a, b) => b.size - a.size);
  const parkNames = [...new Set(parks.map((p) => p.name))].slice(0, 4);
  const inBox = (lat, lon) => lat > bbox.south && lat < bbox.north && lon > bbox.west && lon < bbox.east;
  const hoods = raw.elements.filter((e) => e.type === 'node' && e.tags && e.tags.place && e.tags.name && inBox(e.lat, e.lon)).slice(0, 4);
  return {
    landmarks: pick.map((b) => ({ name: b.name, match: `^${esc(b.name)}$`, height_m: null })),
    places: [...parkNames.map((n) => ({ name: n, matchPark: `^${esc(n)}$` })), ...hoods.map((n) => ({ name: n.tags.name, lat: n.lat, lon: n.lon }))],
  };
}

self.onmessage = (e) => {
  try {
    const { raw, bbox, title } = e.data;
    const { data } = processOsm(raw, autoLandmarks(raw, bbox), { bbox, corePoints: null, title });
    self.postMessage({ data });
  } catch (err) {
    self.postMessage({ error: `Couldn't build this area: ${err.message}` });
  }
};

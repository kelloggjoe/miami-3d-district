// One command for the whole pipeline: fetch (cached) -> process -> write data -> 2D preview -> report.
//   node pipeline/run.mjs            use cache if present, else fetch
//   node pipeline/run.mjs --refresh  re-download from OSM
//   node pipeline/run.mjs --offline  never touch the network (requires pipeline/cache/osm-raw.json)
import fs from 'node:fs';
import { fetchOsm } from './fetch.mjs';
import { processOsm } from './process.mjs';
import { renderSvg, svgToPng } from './preview.mjs';
import { pointInRing } from './geo.mjs';

const args = new Set(process.argv.slice(2));
const CACHE = 'pipeline/cache/osm-raw.json';
if (args.has('--offline') && !fs.existsSync(CACHE)) { console.error(`--offline needs ${CACHE}`); process.exit(1); }
const raw = await fetchOsm(CACHE, { refresh: args.has('--refresh') });
const landmarks = JSON.parse(fs.readFileSync('data/landmarks.json', 'utf8'));
const { data, report, P } = processOsm(raw, landmarks);


const OUT = 'data/district.json';
fs.writeFileSync(OUT, JSON.stringify(data));
const bytes = fs.statSync(OUT).size;
report.outputBytes = bytes;

// Alignment check against independent reference coordinates (Wikipedia infobox coordinates).
const refsCfg = JSON.parse(fs.readFileSync('pipeline/reference-points.json', 'utf8'));
const refs = refsCfg.points.map((r) => {
  const [x, y] = P.project(r.lat, r.lon);
  const b = data.buildings.filter((q) => q.n === r.expectLandmark && !q.p)[0];
  let dist = null;
  if (b) {
    const ring = []; for (let i = 0; i < b.c.length; i += 2) ring.push([b.c[i], b.c[i + 1]]);
    if (pointInRing(x, y, ring)) dist = 0;
    else { dist = Infinity; for (let i = 0; i < ring.length; i++) { const a = ring[i], c = ring[(i + 1) % ring.length]; const dx = c[0] - a[0], dy = c[1] - a[1]; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1))); dist = Math.min(dist, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)); } }
  }
  return { name: r.name, x, y, expect: r.expectLandmark, distanceToFootprintM: dist == null ? null : +dist.toFixed(1) };
});
report.alignment = refs.map(({ x, y, ...r }) => r);

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/map-preview.svg', renderSvg(data, refs));
const png = await svgToPng('docs/map-preview.svg', 'docs/map-preview.png').catch((e) => { console.warn('[preview]', e.message); return false; });
const { defaults, ...summary } = report;
fs.writeFileSync('docs/pipeline-report.json', JSON.stringify({ ...summary, defaultHeightBuildings: defaults }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`[run] wrote ${OUT} (${(bytes / 1024 / 1024).toFixed(2)} MB), docs/map-preview.svg${png ? ' + .png' : ''}, docs/pipeline-report.json`);

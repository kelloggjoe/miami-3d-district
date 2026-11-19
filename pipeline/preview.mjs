// Renders a top-down 2D SVG (and PNG via headless Chromium if Playwright is available) of the processed data.
import fs from 'node:fs';
import { createRequire } from 'node:module';

export function renderSvg(data, refs = []) {
  const { minX, minY, maxX, maxY } = data.meta.extent;
  const S = 0.5; // px per meter
  const W = Math.ceil((maxX - minX) * S), H = Math.ceil((maxY - minY) * S);
  const pt = (x, y) => `${((x - minX) * S).toFixed(1)},${((maxY - y) * S).toFixed(1)}`;
  const path = (f, holes = []) => [f, ...holes].map((r) => { let s = ''; for (let i = 0; i < r.length; i += 2) s += (i ? 'L' : 'M') + pt(r[i], r[i + 1]); return s + 'Z'; }).join('');
  const line = (f) => { let s = ''; for (let i = 0; i < f.length; i += 2) s += (i ? 'L' : 'M') + pt(f[i], f[i + 1]); return s; };
  const hcol = (h) => { const t = Math.min(1, h / 250); const l = 78 - t * 48; return `hsl(${210 - t * 20},${18 + t * 30}%,${l}%)`; };
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 40}" viewBox="0 0 ${W} ${H + 40}" font-family="Helvetica,Arial,sans-serif">`);
  out.push(`<rect width="${W}" height="${H}" fill="#7fb3d5"/>`);
  for (const r of data.land) out.push(`<path d="${path(r)}" fill="#ece6d6"/>`);
  for (const w of data.water) out.push(`<path d="${path(w.c, w.holes)}" fill="#7fb3d5" fill-rule="evenodd"/>`);
  for (const p of data.parks) out.push(`<path d="${path(p.c, p.holes)}" fill="#a9cf8c" fill-rule="evenodd"/>`);
  const order = ['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'service', 'residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'motorway_link', 'motorway'];
  const roads = [...data.roads].sort((a, b) => order.indexOf(a.t) - order.indexOf(b.t));
  for (const r of roads) {
    const foot = ['footway', 'path', 'steps', 'pedestrian', 'cycleway'].includes(r.t);
    out.push(`<path d="${line(r.c)}" fill="none" stroke="${foot ? '#c9a77c' : r.t.startsWith('motorway') ? '#e8a35a' : '#9a9a9a'}" stroke-width="${(foot ? 1 : r.w * S).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  for (const b of [...data.buildings].sort((a, c) => a.h - c.h)) {
    if (b.hp) continue;
    out.push(`<path d="${path(b.c, b.holes)}" fill="${hcol(b.h)}" stroke="${b.d ? '#d24' : '#456'}" stroke-width="${b.d ? 1.2 : 0.4}" fill-rule="evenodd"/>`);
  }
  for (const r of data.rail) out.push(`<path d="${line(r.c)}" fill="none" stroke="${r.k === 'metromover' ? '#d23f8f' : r.k === 'metrorail' ? '#2f7d32' : '#555'}" stroke-width="2.2" stroke-dasharray="${r.k === 'metromover' ? '' : '6 3'}"/>`);
  for (const l of data.labels) {
    const [x, y] = pt(l.x, l.y).split(',').map(Number);
    out.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="#111"/><text x="${x + 4}" y="${y - 3}" font-size="10" fill="#111" stroke="#fff" stroke-width="2.5" paint-order="stroke">${l.n}</text>`);
  }
  for (const r of refs) {
    const [x, y] = pt(r.x, r.y).split(',').map(Number);
    out.push(`<g stroke="#e00" stroke-width="1.5"><line x1="${x - 9}" y1="${y}" x2="${x + 9}" y2="${y}"/><line x1="${x}" y1="${y - 9}" x2="${x}" y2="${y + 9}"/></g><text x="${x + 6}" y="${y + 13}" font-size="9" fill="#e00">ref: ${r.name}</text>`);
  }
  const [sx, sy] = pt(...data.meta.spawn).split(',').map(Number);
  out.push(`<circle cx="${sx}" cy="${sy}" r="5" fill="none" stroke="#06c" stroke-width="2"/>`);
  out.push(`<rect y="${H}" width="${W}" height="40" fill="#fff"/><text x="8" y="${H + 16}" font-size="11">Downtown &amp; Brickell, Miami — processed OSM data, north up, 1 px = 2 m. Buildings shaded by height; red outline = default height.</text>`);
  out.push(`<text x="8" y="${H + 32}" font-size="11">Pink = Metromover, green dashed = Metrorail. Red crosshairs = independent reference coordinates. Blue ring = spawn. © OpenStreetMap contributors (ODbL)</text>`);
  out.push('</svg>');
  return out.join('\n');
}

export async function svgToPng(svgFile, pngFile) {
  let chromium;
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { console.warn('[preview] playwright not available; SVG only'); return false; }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const svg = fs.readFileSync(svgFile, 'utf8');
  const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/);
  await page.setViewportSize({ width: +w, height: +h });
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: pngFile });
  await browser.close();
  return true;
}

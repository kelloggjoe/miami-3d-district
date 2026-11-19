// Procedural, tileable textures generated at load time (no downloads, no licensing questions).
import * as THREE from 'three';

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

// Tileable fractal value noise in [0,1], size x size.
export function tileNoise(size, { octaves = 5, base = 4, seed = 1, persistence = 0.5 } = {}) {
  const out = new Float32Array(size * size);
  const r = rng(seed);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = base << o;
    const lat = new Float32Array(cells * cells).map(() => r());
    const s = size / cells;
    for (let y = 0; y < size; y++) {
      const fy = y / s, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      const ya = (y0 % cells) * cells, yb = ((y0 + 1) % cells) * cells;
      for (let x = 0; x < size; x++) {
        const fx = x / s, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % cells, xb = (x0 + 1) % cells;
        const v = (lat[ya + xa] * (1 - sx) + lat[ya + xb] * sx) * (1 - sy) + (lat[yb + xa] * (1 - sx) + lat[yb + xb] * sx) * sy;
        out[y * size + x] += v * amp;
      }
    }
    total += amp; amp *= persistence;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function toTexture(size, fn, { srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) { const [r, g, b] = fn(i); img.data[4 * i] = r; img.data[4 * i + 1] = g; img.data[4 * i + 2] = b; img.data[4 * i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export function makeTextures() {
  const S = 256;
  const n1 = tileNoise(S, { octaves: 6, base: 4, seed: 11 });
  const n2 = tileNoise(S, { octaves: 3, base: 32, seed: 23, persistence: 0.6 });
  const n3 = tileNoise(S, { octaves: 4, base: 2, seed: 37 });
  const speck = rng(5);
  // Asphalt: dark gray with aggregate speckle and patchy wear. Covers 4 m per tile.
  const asphalt = toTexture(S, (i) => {
    const v = 0.78 + 0.22 * n1[i] + (speck() < 0.08 ? 0.18 * speck() : 0) - 0.1 * (n3[i] > 0.62 ? 1 : 0) * (n3[i] - 0.62) * 4;
    const g = Math.max(0, Math.min(1, v)) * 255;
    return [g, g, g * 1.02];
  });
  // Concrete: light, slightly mottled (sidewalks). Covers 3 m.
  const concrete = toTexture(S, (i) => { const v = (0.86 + 0.1 * n1[i] + 0.06 * (n2[i] - 0.5)) * 255; return [v, v * 0.99, v * 0.96]; });
  // Detail: neutral gray modulation multiplied onto the ground map (grass, sand, plazas). Covers 6 m.
  const detail = toTexture(S, (i) => { const v = (0.82 + 0.3 * n1[i] + 0.12 * (n2[i] - 0.5)) * 200; return [v, v, v]; }, { srgb: false });
  // Facade grime: subtle large-scale variation. Covers 24 m.
  const grime = toTexture(S, (i) => { const v = (0.9 + 0.1 * n3[i] + 0.05 * (n1[i] - 0.5)) * 255; return [v, v, v]; }, { srgb: false });
  // Water normal map from a tileable height field.
  const h = tileNoise(S, { octaves: 5, base: 4, seed: 71, persistence: 0.55 });
  const water = toTexture(S, (i) => {
    const x = i % S, y = (i / S) | 0;
    const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x - 1 + S) % S)];
    const dy = h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x];
    const nx = -dx * 6, ny = -dy * 6, nz = 1, l = Math.hypot(nx, ny, nz);
    return [(nx / l * 0.5 + 0.5) * 255, (ny / l * 0.5 + 0.5) * 255, (nz / l * 0.5 + 0.5) * 255];
  }, { srgb: false });
  return { asphalt, concrete, detail, grime, water };
}

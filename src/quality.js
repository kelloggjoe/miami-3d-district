// Graphics quality presets. Chosen at load time (URL ?quality=, else saved choice, else medium);
// changing it reloads the page so every material is built once for the chosen preset.
export const PRESETS = {
  low: { name: 'Low', textures: false, shadows: false, shadowSize: 0, sky: false, pbr: false, props: false, post: false, pixelRatio: 1 },
  medium: { name: 'Medium', textures: true, shadows: true, shadowSize: 2048, sky: true, pbr: true, props: true, post: false, pixelRatio: 1.25 },
  high: { name: 'High', textures: true, shadows: true, shadowSize: 4096, sky: true, pbr: true, props: true, post: true, pixelRatio: 1.5 },
};
const KEY = 'miami3d.quality';

export function getQuality() {
  const q = new URLSearchParams(location.search).get('quality');
  if (q && PRESETS[q]) return { id: q, ...PRESETS[q] };
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
  const id = saved && PRESETS[saved] ? saved : 'medium';
  return { id, ...PRESETS[id] };
}

export function setQuality(id) {
  try { localStorage.setItem(KEY, id); } catch { /* storage unavailable */ }
  const u = new URL(location.href); u.searchParams.set('quality', id); location.href = u.toString();
}

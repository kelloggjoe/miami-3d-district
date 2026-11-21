// Visual styles, separate from graphics quality. Switch live (no reload).
//
//   normal      the default look
//   miamivice   sunset sky, pink-and-teal grade, lit windows with bloom, light film grain
//   noir        black-and-white, hard contrast, heavy vignette and grain
//
// Generated city: the style changes the sun, sky, fog and lights, then a final color-grade pass runs on the
// image. Photoreal: Google's scan has its lighting baked in, so only the grade and bloom apply there.
import * as THREE from 'three';
import { SUN_DIR, WINDOW_GLOW } from './world.js';

export const STYLES = { normal: 'Normal', miamivice: 'Miami Vice', noir: 'Noir' };
const KEY = 'miami3d.style';

export function getStyle() {
  const q = new URLSearchParams(location.search).get('style');
  if (q && STYLES[q]) return q;
  try { const s = localStorage.getItem(KEY); if (s && STYLES[s]) return s; } catch { /* storage unavailable */ }
  return 'normal';
}
export function saveStyle(id) { try { localStorage.setItem(KEY, id); } catch { /* storage unavailable */ } }

// Runs after OutputPass, so it works on final display colors.
export const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uMode: { value: 0 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uMode; uniform float uTime; uniform vec2 uRes; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 3.1) * 43758.5453); }
    void main() {
      vec2 uv = vUv; vec2 c = uv - 0.5; float r = length(c);
      vec3 col;
      if (uMode > 0.5 && uMode < 1.5) {          // Miami Vice
        float ca = 0.0025 * r;                   // slight chromatic aberration toward the edges
        col = vec3(texture2D(tDiffuse, uv + c * ca * 2.0).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - c * ca * 2.0).b);
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        vec3 shadowTint = vec3(0.05, 0.55, 0.62), highTint = vec3(1.0, 0.36, 0.72);
        col = mix(col, col * mix(shadowTint, highTint, smoothstep(0.15, 0.85, l)) * 1.6, 0.32);
        col = mix(vec3(l), col, 1.3);                                  // saturation
        col = (col - 0.5) * 1.08 + 0.52;                               // contrast, lifted blacks
        col += vec3(0.10, 0.02, 0.14) * smoothstep(0.35, 0.9, r);      // purple vignette glow
        col *= 0.96 + 0.04 * sin(uv.y * uRes.y * 1.6);                 // faint scanlines
        col += (hash(uv * uRes) - 0.5) * 0.045;                        // grain
      } else if (uMode > 1.5) {                  // Noir
        col = texture2D(tDiffuse, uv).rgb;
        float l = dot(col, vec3(0.3, 0.59, 0.11));
        l = smoothstep(0.08, 0.92, l); l = pow(l, 1.15);
        col = vec3(l) * vec3(0.98, 0.99, 1.03);
        col *= 1.0 - smoothstep(0.3, 0.85, r) * 0.65;
        col += (hash(uv * uRes) - 0.5) * 0.09;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

// Remember the normal look so we can return to it.
export function createStyleController({ scene, renderer, world, Q, photoreal }) {
  const env = world.env;
  const base = {
    sunDir: SUN_DIR.clone(), sunColor: env.sun.color.clone(), sunI: env.sun.intensity,
    hemiSky: env.hemi ? env.hemi.color.clone() : null, hemiGround: env.hemi ? env.hemi.groundColor.clone() : null, hemiI: env.hemi ? env.hemi.intensity : 0,
    fog: scene.fog ? { color: scene.fog.color.clone(), near: scene.fog.near, far: scene.fog.far } : null,
    bg: scene.background && scene.background.isColor ? scene.background.clone() : scene.background,
    sky: env.sky ? { ...Object.fromEntries(['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG'].map((k) => [k, env.sky.material.uniforms[k].value])) } : null,
    exposure: renderer.toneMappingExposure, envI: scene.environmentIntensity,
  };
  let gradient = null;
  const viceBackground = () => {
    if (gradient) return gradient;
    const c = document.createElement('canvas'); c.width = 2; c.height = 256; const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#2b1055'); gr.addColorStop(0.45, '#d4418e'); gr.addColorStop(0.7, '#ff9a5a'); gr.addColorStop(1, '#ffd29d');
    g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
    gradient = new THREE.CanvasTexture(c); gradient.colorSpace = THREE.SRGBColorSpace; return gradient;
  };
  function setSun(dir) {
    SUN_DIR.copy(dir).normalize();
    if (env.sky) env.sky.material.uniforms.sunPosition.value.copy(SUN_DIR);
  }

  function apply(id) {
    // reset to the normal look
    setSun(base.sunDir); env.sun.color.copy(base.sunColor); env.sun.intensity = base.sunI;
    if (env.hemi) { env.hemi.color.copy(base.hemiSky); env.hemi.groundColor.copy(base.hemiGround); env.hemi.intensity = base.hemiI; }
    if (base.fog && scene.fog) { scene.fog.color.copy(base.fog.color); scene.fog.near = base.fog.near; scene.fog.far = base.fog.far; }
    if (!photoreal) scene.background = base.bg && base.bg.isColor ? base.bg.clone() : base.bg;
    if (env.sky && base.sky) { env.sky.visible = true; for (const [k, v] of Object.entries(base.sky)) env.sky.material.uniforms[k].value = v; }
    renderer.toneMappingExposure = base.exposure; scene.environmentIntensity = base.envI;
    WINDOW_GLOW.amount.value = 0;

    if (id === 'miamivice' && !photoreal) {
      setSun(new THREE.Vector3(-0.85, 0.18, 0.5)); // low sun in the west-south-west: sunset
      env.sun.color.set('#ff9a6b'); env.sun.intensity = base.sunI * 0.75;
      if (env.hemi) { env.hemi.color.set('#ff7ad9'); env.hemi.groundColor.set('#2a1b4d'); env.hemi.intensity = base.hemiI * 1.1; }
      if (scene.fog) { scene.fog.color.set('#6a3a78'); scene.fog.near = 900; scene.fog.far = 6500; }
      if (env.sky) { const u = env.sky.material.uniforms; u.turbidity.value = 6; u.rayleigh.value = 3.2; u.mieCoefficient.value = 0.006; u.mieDirectionalG.value = 0.82; }
      else scene.background = viceBackground();
      if (Q.pbr) { renderer.toneMappingExposure = base.exposure * 0.85; scene.environmentIntensity = 0.3; }
      WINDOW_GLOW.color.value.set('#ff4fb3'); WINDOW_GLOW.amount.value = Q.pbr ? 0.7 : 0.35;
    } else if (id === 'noir' && !photoreal) {
      env.sun.intensity = base.sunI * 1.15;
      if (scene.fog) { scene.fog.near = 400; scene.fog.far = 4500; }
    }
    if (env.sky) env.regenEnv();
  }
  return { apply };
}

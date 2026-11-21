// Builds all static geometry from the district data once, at load time.
// Data frame: x east, y north (meters). Three.js frame: (x, height, -y).
// Quality: Low = original flat-shaded look; Medium/High = PBR materials, procedural textures,
// road markings, sky, reflections and sun shadows (see quality.js).
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { makeTextures } from './textures.js';

export const CHUNK = 300;          // m, building chunk size (frustum culling + LOD unit)
export const LOD_DISTANCE = 500;   // m, beyond this a chunk shows simplified boxes
export const SUN_DIR = new THREE.Vector3(-0.6, 1.0, 0.35).normalize(); // mid-afternoon, from the south-west

const ring = (flat) => { const r = []; for (let i = 0; i < flat.length; i += 2) r.push([flat[i], flat[i + 1]]); return r; };
const area = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); return ((n ^ (n >>> 15)) >>> 0) / 4294967296; }

// Stylized Miami palette.
const GLASS = ['#5d8fa6', '#4f7f99', '#6aa3b5', '#7fb0c0', '#3f6f86'];
const LIGHT = ['#f3efe6', '#ece4d4', '#e8eef0', '#f6f2ea', '#dfe6e3'];
const PASTEL = ['#f4c7c3', '#f7dba7', '#bfe3d0', '#f2e3b3', '#cfe0f3', '#f1cfe0', '#fbe7c6'];
// Facade style: 0 low-rise (punched windows + storefront), 1 mid-rise (punched), 2 tower (curtain wall)
const styleOf = (b) => (b.h >= 70 ? 2 : b.h >= 25 ? 1 : 0);
function buildingColor(b, i) {
  const r = hash(i + 7);
  const pal = b.h >= 70 ? GLASS : b.h >= 25 ? LIGHT : PASTEL;
  return new THREE.Color(pal[Math.floor(r * pal.length)]);
}

// Min-area enclosing rectangle (for LOD boxes).
function minRect(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const hull = lo.slice(0, -1).concat(up.slice(0, -1));
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(ang), s = Math.sin(ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of hull) { const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c; x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
    const A = (x1 - x0) * (y1 - y0);
    if (!best || A < best.A) best = { A, c, s, x0, x1, y0, y1 };
  }
  if (!best) return pts.slice(0, 4);
  const { c, s, x0, x1, y0, y1 } = best;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([u, v]) => [u * c - v * s, u * s + v * c]);
}

// Extrude a footprint (outer CCW, holes CW) into non-indexed position/color/style arrays.
function extrude(outer, holes, h0, h1, color, roofColor, style, out, withRoof = true) {
  const push = (x, y, z, c, st) => { out.pos.push(x, y, -z); out.col.push(c.r, c.g, c.b); out.sty.push(st); };
  for (const r of [outer, ...holes]) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      push(p[0], h0, p[1], color, style); push(q[0], h0, q[1], color, style); push(q[0], h1, q[1], color, style);
      push(p[0], h0, p[1], color, style); push(q[0], h1, q[1], color, style); push(p[0], h1, p[1], color, style);
    }
  }
  if (!withRoof) return;
  const contour = outer.map((p) => new THREE.Vector2(p[0], p[1]));
  const hv = holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
  const all = contour.concat(...hv);
  const tris = THREE.ShapeUtils.triangulateShape(contour, hv);
  for (const [a, b, c] of tris) {
    const A = all[a], B = all[b], C = all[c];
    const ccw = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) > 0;
    const [P1, P2] = ccw ? [B, C] : [C, B];
    push(A.x, h1, A.y, roofColor, -1); push(P1.x, h1, P1.y, roofColor, -1); push(P2.x, h1, P2.y, roofColor, -1);
  }
}

function geomFrom({ pos, col, sty }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aStyle', new THREE.Float32BufferAttribute(sty, 1));
  g.computeVertexNormals(); // non-indexed => flat face normals
  g.computeBoundingSphere();
  return g;
}

// Facade material: vertex colors + procedural floors/windows (no textures needed).
// With PBR, window glass is smooth and reflective (picks up the sky environment) and walls get grime.
// Shared uniforms so a visual style can light the windows up (Miami Vice) without rebuilding materials.
export const WINDOW_GLOW = { amount: { value: 0 }, color: { value: new THREE.Color('#ff4fb3') } };
function facadeMaterial({ pbr, grime }) {
  const m = pbr ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 })
    : new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    if (grime) sh.uniforms.uGrime = { value: grime };
    sh.uniforms.uGlow = WINDOW_GLOW.amount; sh.uniforms.uGlowColor = WINDOW_GLOW.color;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aStyle; varying float vStyle; varying vec3 vWPos; varying vec3 vWNorm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvStyle = aStyle; vWPos = (modelMatrix * vec4(transformed,1.0)).xyz; vWNorm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vStyle; varying vec3 vWPos; varying vec3 vWNorm; uniform float uGlow; uniform vec3 uGlowColor;${grime ? '\nuniform sampler2D uGrime;' : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uGlow > 0.0) { // about half the windows lit, in two tints, for night styles
          float cellId = fract(sin(floor(vWPos.y / 3.5) * 12.9898 + floor((abs(vWNorm.x) > abs(vWNorm.z) ? vWPos.z : vWPos.x) / 3.0) * 78.233) * 43758.5453);
          vec3 tint = cellId > 0.8 ? vec3(0.35, 0.9, 1.0) : uGlowColor;
          totalEmissiveRadiance += tint * uGlow * winMask * step(0.45, cellId) * (0.55 + 0.45 * cellId);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float winMask = 0.0;
        float wall = step(abs(vWNorm.y), 0.5) * step(-0.5, vStyle);
        float along = abs(vWNorm.x) > abs(vWNorm.z) ? vWPos.z : vWPos.x;
        float dist = length(vWPos - cameraPosition);
        float fade = 1.0 - smoothstep(${pbr ? '450.0, 1100.0' : '350.0, 900.0'}, dist);
        if (wall > 0.5) {
          float fl = fract(vWPos.y / 3.5);
          float cl = fract(along / 3.0);
          float upper = step(4.2, vWPos.y);
          if (vStyle > 1.5) {          // tower curtain wall: thin mullions and slab edges
            winMask = step(0.10, fl) * step(fl, 0.94) * step(0.05, cl) * step(cl, 0.95) * step(3.0, vWPos.y);
          } else {                      // punched windows
            winMask = step(0.30, fl) * step(fl, 0.86) * step(0.14, cl) * step(cl, 0.86) * upper;
          }
          ${pbr ? `if (vWPos.y > 0.4 && vWPos.y < 3.6 && vStyle < 1.5) winMask = max(winMask, step(0.06, cl) * step(cl, 0.94) * step(0.6, vWPos.y) * step(vWPos.y, 3.2)); // storefront` : ''}
          winMask *= fade;
          ${grime ? 'diffuseColor.rgb *= texture2D(uGrime, vec2(along, vWPos.y) / 24.0).r * (0.88 + 0.12 * smoothstep(0.0, 2.5, vWPos.y));' : ''}
          ${pbr
            ? 'vec3 glass = vStyle > 1.5 ? mix(diffuseColor.rgb, vec3(0.08, 0.17, 0.22), 0.55) : vec3(0.10, 0.14, 0.17);\n          diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask);'
            : 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.66, 0.78), winMask);'}
        }`);
    if (pbr) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, vStyle > 1.5 ? 0.06 : 0.14, winMask);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, vStyle > 1.5 ? 0.75 : 0.4, winMask);');
    }
  };
  return m;
}

// Flat ribbon along a polyline with mitred joins. Optionally emits uv (u across 0..1, v along in m).
function ribbon(flat, width, y, pos, uv) {
  const pts = ring(flat);
  if (pts.length < 2) return;
  const hw = width / 2;
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const off = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const nx = -dy, ny = dx; let scale = 1;
    if (i > 0 && i < pts.length - 1) {
      const d1x = p[0] - a[0], d1y = p[1] - a[1], l1 = Math.hypot(d1x, d1y) || 1;
      const cos = (d1x / l1) * dx + (d1y / l1) * dy;
      scale = Math.min(2.5, 1 / Math.max(0.4, Math.sqrt((1 + cos) / 2)));
    }
    return [p[0] + nx * hw * scale, p[1] + ny * hw * scale, p[0] - nx * hw * scale, p[1] - ny * hw * scale];
  });
  for (let i = 0; i < pts.length - 1; i++) {
    const [lx0, ly0, rx0, ry0] = off[i], [lx1, ly1, rx1, ry1] = off[i + 1];
    pos.push(rx0, y, -ry0, rx1, y, -ry1, lx1, y, -ly1);
    pos.push(rx0, y, -ry0, lx1, y, -ly1, lx0, y, -ly0);
    if (uv) {
      const v0 = along[i], v1 = along[i + 1];
      uv.push(0, v0, 0, v1, 1, v1, 0, v0, 1, v1, 1, v0);
    }
  }
}

function drawPoly(ctx, flat, toPx) {
  for (let i = 0; i < flat.length; i += 2) { const [u, v] = toPx(flat[i], flat[i + 1]); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); }
  ctx.closePath();
}

// Road surface shader: asphalt/concrete texture in world space + painted markings from uv.
// aKind: 0 local road, 1 major road, 2 service/link, 3 footway, 4 crossing. aWidth in meters.
function roadMaterial(tex) {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uAsphalt = { value: tex.asphalt }; sh.uniforms.uConcrete = { value: tex.concrete };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aUv; attribute float aKind; attribute float aWidth; varying vec2 vRUv; varying float vKind; varying float vWidth; varying vec3 vRPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRUv = aUv; vKind = aKind; vWidth = aWidth; vRPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uAsphalt; uniform sampler2D uConcrete; varying vec2 vRUv; varying float vKind; varying float vWidth; varying vec3 vRPos;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float aa = clamp(length(vRPos - cameraPosition) / 400.0, 0.0, 1.0);   // soften markings far away
        vec3 asphalt = texture2D(uAsphalt, vRPos.xz / 4.0).rgb * vec3(0.17, 0.175, 0.185);
        vec3 concrete = texture2D(uConcrete, vRPos.xz / 3.0).rgb * vec3(0.62, 0.60, 0.57);
        float across = vRUv.x * vWidth;             // meters from the right edge
        float fromCenter = abs(vRUv.x - 0.5) * vWidth;
        vec3 c = asphalt;
        if (vKind < 2.5) {
          float paint = 0.0; vec3 pc = vec3(0.92);
          if (vKind > 0.5 && vKind < 1.5 && vWidth >= 7.0) {        // major: double yellow + white edge lines
            float dy = step(abs(fromCenter - 0.13), 0.055);
            if (dy > 0.0) { paint = 1.0; pc = vec3(0.93, 0.74, 0.18); }
            float edge = step(abs(across - 0.45), 0.06) + step(abs(vWidth - across - 0.45), 0.06);
            if (edge > 0.0) { paint = 1.0; pc = vec3(0.92); }
            float lane = step(abs(mod(fromCenter, 3.4) - 0.0), 0.06) * step(1.0, fromCenter) * step(fromCenter, vWidth / 2.0 - 1.0) * step(0.5, fract(vRUv.y / 9.0));
            if (lane > 0.0 && dy == 0.0) { paint = 1.0; pc = vec3(0.92); }
          } else if (vKind < 0.5 && vWidth >= 6.0) {                 // local: dashed white center line
            paint = step(fromCenter, 0.06) * step(0.55, fract(vRUv.y / 8.0));
          }
          c = mix(c, pc, paint * (1.0 - aa * 0.7));
        } else if (vKind < 3.5) {                                    // footway / sidewalk: concrete slabs
          c = concrete;
          float jv = step(fract(vRUv.y / 1.6), 0.025);
          float ju = vWidth > 2.4 ? step(abs(fract(across / 1.6) - 0.5), 0.012) : 0.0;
          c *= 1.0 - 0.25 * max(jv, ju) * (1.0 - aa);
        } else {                                                     // zebra crossing
          float bar = step(fract(vRUv.y / 1.2), 0.55) * step(0.06, vRUv.x) * step(vRUv.x, 0.94);
          c = mix(asphalt, vec3(0.93), bar * (1.0 - aa * 0.6));
        }
        diffuseColor.rgb = c;`);
  };
  return m;
}

export function buildWorld(scene, data, Q, renderer) {
  const { minX, minY, maxX, maxY } = data.meta.extent;
  const W = maxX - minX, H = maxY - minY;
  const stats = {};
  const tex = Q.textures ? makeTextures() : null;
  const shadow = Q.shadows;

  // ---------- sky, light, fog ----------
  const env = { sun: null, sky: null, hemi: null, regenEnv: () => {} };
  const sun = new THREE.DirectionalLight('#fff1dc', Q.pbr ? 5.5 : 2.2);
  sun.position.copy(SUN_DIR).multiplyScalar(1000);
  scene.add(sun, sun.target);
  env.sun = sun;
  if (Q.sky) {
    const sky = new Sky(); sky.scale.setScalar(8000);
    const u = sky.material.uniforms;
    u.turbidity.value = 2.5; u.rayleigh.value = 3.0; u.mieCoefficient.value = 0.003; u.mieDirectionalG.value = 0.75;
    u.sunPosition.value.copy(SUN_DIR);
    scene.add(sky);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene(); const skyEnv = new Sky(); skyEnv.scale.setScalar(1000); skyEnv.material = sky.material; envScene.add(skyEnv);
    scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    scene.environmentIntensity = 0.45;
    scene.fog = new THREE.Fog('#a9c6d6', 1500, 8000);
    env.hemi = new THREE.HemisphereLight('#cfe6f5', '#a8997a', 0.5); scene.add(env.hemi);
    env.sky = sky;
    env.regenEnv = () => { const old = scene.environment; scene.environment = pmrem.fromScene(envScene, 0.02).texture; if (old) old.dispose(); };
  } else {
    scene.background = new THREE.Color('#9fd3ea');
    scene.fog = new THREE.Fog('#bfe2ef', 1200, 7000);
    env.hemi = new THREE.HemisphereLight('#e8f6ff', '#c9b991', 1.6); scene.add(env.hemi);
  }
  if (shadow) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
    const c = sun.shadow.camera; c.left = -320; c.right = 320; c.top = 320; c.bottom = -320; c.near = 1; c.far = 2400;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
  }
  // Keep the shadow box centered on what the camera is looking at; snap to texels to avoid shimmering.
  const texel = shadow ? 640 / Q.shadowSize : 1;
  function updateShadow(camera) {
    if (!shadow) return;
    const f = new THREE.Vector3(); camera.getWorldDirection(f); f.y = 0; if (f.lengthSq() > 0) f.normalize();
    const ahead = Math.min(260, 40 + camera.position.y * 0.8);
    const cx = Math.round((camera.position.x + f.x * ahead) / texel) * texel, cz = Math.round((camera.position.z + f.z * ahead) / texel) * texel;
    sun.target.position.set(cx, 0, cz); sun.position.set(cx, 0, cz).addScaledVector(SUN_DIR, 1200);
  }

  // ---------- water (bay) ----------
  const waterMat = Q.pbr
    ? new THREE.MeshStandardMaterial({ color: '#2b7d99', roughness: 0.1, metalness: 0.15, normalMap: tex.water, normalScale: new THREE.Vector2(0.35, 0.35) })
    : new THREE.MeshPhongMaterial({ color: '#3f9bbf', specular: '#2a4a55', shininess: 18 });
  const WS = W + 12000, HS = H + 12000;
  if (Q.pbr) { tex.water = tex.water.clone(); tex.water.needsUpdate = true; waterMat.normalMap = tex.water; tex.water.repeat.set(WS / 22, HS / 22); }
  const water = new THREE.Mesh(new THREE.PlaneGeometry(WS, HS), waterMat);
  water.rotation.x = -Math.PI / 2; water.position.set((minX + maxX) / 2, -0.6, -(minY + maxY) / 2);
  water.receiveShadow = shadow;
  scene.add(water);
  const updateWater = (t) => { if (Q.pbr) tex.water.offset.set(t * 0.004, t * 0.0025); };

  // ---------- ground texture: land, parks, beaches; river is a transparent hole ----------
  const RES = Math.min(1, 4096 / Math.max(W, H)); // px per m
  const cw = Math.ceil(W * RES), ch = Math.ceil(H * RES);
  const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const toPx = (x, y) => [(x - minX) * RES, (maxY - y) * RES];
  ctx.fillStyle = Q.pbr ? '#b9b2a2' : '#e7e0cf';
  for (const r of data.land) { ctx.beginPath(); drawPoly(ctx, r, toPx); ctx.fill('evenodd'); }
  ctx.fillStyle = '#f0e2bd';
  for (const b of data.beaches) { ctx.beginPath(); drawPoly(ctx, b.c, toPx); ctx.fill(); }
  for (const p of data.parks) {
    ctx.fillStyle = p.k === 'pitch' ? '#7fb86a' : p.k === 'playground' ? '#d9c79a' : Q.pbr ? '#6a9e4c' : '#9ccc7f';
    ctx.beginPath(); drawPoly(ctx, p.c, toPx); for (const h of p.holes || []) drawPoly(ctx, h, toPx); ctx.fill('evenodd');
  }
  ctx.globalCompositeOperation = 'destination-out';
  for (const w of data.water) { ctx.beginPath(); drawPoly(ctx, w.c, toPx); for (const h of w.holes || []) drawPoly(ctx, h, toPx); ctx.fill('evenodd'); }
  ctx.globalCompositeOperation = 'source-over';
  const groundTex = new THREE.CanvasTexture(canvas);
  groundTex.colorSpace = THREE.SRGBColorSpace; groundTex.anisotropy = 8;
  let groundMat;
  if (Q.pbr) {
    groundMat = new THREE.MeshStandardMaterial({ map: groundTex, alphaTest: 0.5, roughness: 0.95 });
    groundMat.onBeforeCompile = (sh) => {
      sh.uniforms.uDetail = { value: tex.detail };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGPos;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uDetail; varying vec3 vGPos;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(1.0, texture2D(uDetail, vGPos.xz / 6.0).r * 1.28, 1.0 - clamp(length(vGPos - cameraPosition) / 600.0, 0.0, 1.0));');
    };
  } else groundMat = new THREE.MeshLambertMaterial({ map: groundTex, alphaTest: 0.5 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, H), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.set((minX + maxX) / 2, 0, -(minY + maxY) / 2);
  ground.receiveShadow = shadow;
  scene.add(ground);

  // Sea walls: short vertical strips along coastline and river banks.
  {
    const pos = [];
    const wall = (flat, flip) => { const r = ring(flat); if (flip) r.reverse(); for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; pos.push(p[0], -0.7, -p[1], q[0], -0.7, -q[1], q[0], 0, -q[1], p[0], -0.7, -p[1], q[0], 0, -q[1], p[0], 0, -p[1]); } };
    for (const l of data.land) wall(l, false);
    for (const w of data.water) wall(w.c, area(ring(w.c)) > 0);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: '#b8b2a3', side: THREE.DoubleSide })));
  }

  // ---------- roads and paths ----------
  const FOOT = new Set(['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'track']);
  const MAJOR = new Set(['primary', 'secondary', 'tertiary', 'motorway', 'trunk']);
  if (Q.textures) {
    const layers = [[], [], []]; // roads, footways, crossings
    for (const r of data.roads) {
      const kind = r.ft === 'crossing' ? 4 : FOOT.has(r.t) ? 3 : MAJOR.has(r.t) ? 1 : (r.t === 'service' || r.t.endsWith('_link')) ? 2 : 0;
      const w = kind === 4 ? Math.max(2.5, r.w) : kind === 3 ? Math.max(1.8, r.w) : r.w;
      const L = layers[kind === 4 ? 2 : kind === 3 ? 1 : 0];
      const pos = [], uv = [];
      ribbon(r.c, w, kind === 4 ? 0.09 : kind === 3 ? 0.07 : 0.04, pos, uv);
      for (let i = 0; i < pos.length / 3; i++) L.push([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], uv[2 * i], uv[2 * i + 1], kind, w]);
    }
    const mat = roadMaterial(tex);
    layers.forEach((L, li) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(L.flatMap((v) => [v[0], v[1], v[2]]), 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(L.flatMap(() => [0, 1, 0]), 3));
      g.setAttribute('aUv', new THREE.Float32BufferAttribute(L.flatMap((v) => [v[3], v[4]]), 2));
      g.setAttribute('aKind', new THREE.Float32BufferAttribute(L.map((v) => v[5]), 1));
      g.setAttribute('aWidth', new THREE.Float32BufferAttribute(L.map((v) => v[6]), 1));
      const mm = mat.clone(); mm.onBeforeCompile = mat.onBeforeCompile; mm.polygonOffsetFactor = mm.polygonOffsetUnits = -1 - li;
      const mesh = new THREE.Mesh(g, mm); mesh.receiveShadow = shadow; scene.add(mesh);
    });
  } else {
    const roadPos = [], footPos = [], crossPos = [];
    for (const r of data.roads) {
      if (r.ft === 'crossing') ribbon(r.c, Math.max(2.5, r.w), 0.09, crossPos);
      else if (FOOT.has(r.t)) ribbon(r.c, Math.max(1.8, r.w), 0.07, footPos);
      else ribbon(r.c, r.w, 0.04, roadPos);
    }
    const flatMesh = (pos, color, offset) => {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset })));
    };
    flatMesh(roadPos, '#5d6166', -1); flatMesh(footPos, '#d3cdc0', -2); flatMesh(crossPos, '#eeeeea', -3);
  }

  // ---------- buildings: per chunk, full + LOD box ----------
  const mat = facadeMaterial({ pbr: Q.pbr, grime: tex && tex.grime });
  const lodMat = Q.pbr ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }) : new THREE.MeshLambertMaterial({ vertexColors: true });
  const chunks = new Map();
  data.buildings.forEach((b, i) => {
    if (b.hp) return; // parent outline replaced by its parts
    const outer = ring(b.c), holes = (b.holes || []).map(ring);
    let cx = 0, cy = 0; for (const p of outer) { cx += p[0]; cy += p[1]; } cx /= outer.length; cy /= outer.length;
    const key = `${Math.floor(cx / CHUNK)},${Math.floor(cy / CHUNK)}`;
    if (!chunks.has(key)) chunks.set(key, { full: { pos: [], col: [], sty: [] }, lod: { pos: [], col: [], sty: [] }, cx: (Math.floor(cx / CHUNK) + 0.5) * CHUNK, cy: (Math.floor(cy / CHUNK) + 0.5) * CHUNK });
    const c = chunks.get(key);
    const color = buildingColor(b, i), roof = color.clone().multiplyScalar(0.82);
    const h0 = b.mh || 0, h1 = Math.max(h0 + 0.5, b.h), style = b.o ? -1 : styleOf(b);
    extrude(outer, holes, h0, h1, color, roof, style, c.full);
    if (h1 >= 8) extrude(minRect(outer), [], h0, h1, color, roof, -1, c.lod); // small buildings vanish in LOD
  });
  const chunkList = [];
  let fullTris = 0, lodTris = 0;
  for (const c of chunks.values()) {
    const full = new THREE.Mesh(geomFrom(c.full), mat);
    const lod = c.lod.pos.length ? new THREE.Mesh(geomFrom(c.lod), lodMat) : null;
    full.castShadow = full.receiveShadow = shadow;
    scene.add(full); if (lod) { lod.visible = false; lod.castShadow = shadow; scene.add(lod); }
    fullTris += c.full.pos.length / 9; lodTris += c.lod.pos.length / 9;
    chunkList.push({ full, lod, cx: c.cx, cy: c.cy, far: false });
  }
  stats.chunks = chunkList.length; stats.buildingTrisFull = fullTris; stats.buildingTrisLod = lodTris;

  // ---------- elevated rail (Metromover / Metrorail) ----------
  {
    const deck = [], pillars = [];
    for (const r of data.rail) {
      if (!r.e) continue;
      const y = r.k === 'metrorail' ? 11 : 8;
      const pts = ring(r.c);
      const top = [], hw = r.k === 'metrorail' ? 2.2 : 1.4;
      ribbon(r.c, hw * 2, y, top); deck.push(...top);
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        const L = Math.hypot(x1 - x0, y1 - y0); if (!L) continue;
        const nx = -(y1 - y0) / L * hw, ny = (x1 - x0) / L * hw;
        for (const s of [1, -1]) {
          const ax = x0 + nx * s, ay = y0 + ny * s, bx = x1 + nx * s, by = y1 + ny * s;
          const q = s > 0 ? [ax, ay, bx, by] : [bx, by, ax, ay];
          deck.push(q[0], y - 1.2, -q[1], q[2], y - 1.2, -q[3], q[2], y, -q[3], q[0], y - 1.2, -q[1], q[2], y, -q[3], q[0], y, -q[1]);
        }
      }
      let acc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        for (let d = (30 - acc) % 30; d < L; d += 30) { const t = d / L; pillars.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, y - 1.2]); }
        acc = (acc + L) % 30;
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(deck, 3)); g.computeVertexNormals();
    const deckMesh = new THREE.Mesh(g, Q.pbr ? new THREE.MeshStandardMaterial({ color: '#d9d6cf', roughness: 0.8, side: THREE.DoubleSide }) : new THREE.MeshLambertMaterial({ color: '#d9d6cf', side: THREE.DoubleSide }));
    deckMesh.castShadow = deckMesh.receiveShadow = shadow; scene.add(deckMesh);
    const pg = new THREE.CylinderGeometry(0.6, 0.7, 1, 8); pg.translate(0, 0.5, 0);
    const pm = new THREE.InstancedMesh(pg, Q.pbr ? new THREE.MeshStandardMaterial({ color: '#c9c4ba', roughness: 0.85 }) : new THREE.MeshLambertMaterial({ color: '#c9c4ba' }), pillars.length);
    const m4 = new THREE.Matrix4();
    pillars.forEach(([x, y, h], i) => pm.setMatrixAt(i, m4.makeScale(1, h, 1).setPosition(x, 0, -y)));
    pm.castShadow = shadow; scene.add(pm); stats.pillars = pillars.length;
  }

  // ---------- trees and lamps (Low quality only; Medium/High use props.js) ----------
  if (!Q.props) {
    const n = data.poi.tree.length / 2;
    const trunkG = new THREE.CylinderGeometry(0.18, 0.28, 1, 6); trunkG.translate(0, 0.5, 0);
    const crownG = new THREE.IcosahedronGeometry(1, 0);
    const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshLambertMaterial({ color: '#8a6b4a' }), n);
    const crowns = new THREE.InstancedMesh(crownG, new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }), n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = data.poi.tree[2 * i], y = data.poi.tree[2 * i + 1], r = hash(i * 3 + 1);
      const palm = r < 0.55, h = palm ? 7 + r * 8 : 4 + r * 3;
      trunks.setMatrixAt(i, m4.makeScale(palm ? 1 : 1.3, h, palm ? 1 : 1.3).setPosition(x, 0, -y));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r * 6.28);
      s.set(palm ? 1.9 : 2.0, palm ? 0.7 : 1.8, palm ? 1.9 : 2.0); p.set(x, h + (palm ? 0.1 : 0.8), -y);
      crowns.setMatrixAt(i, m4.compose(p, q, s));
      crowns.setColorAt(i, col.set(palm ? '#6db35a' : '#4c9a4f').offsetHSL(0, 0, (r - 0.5) * 0.1));
    }
    scene.add(trunks, crowns);
    const ln = data.poi.lamp.length / 2;
    const lg = new THREE.CylinderGeometry(0.08, 0.1, 6, 5); lg.translate(0, 3, 0);
    const lamps = new THREE.InstancedMesh(lg, new THREE.MeshLambertMaterial({ color: '#3b4249' }), Math.max(1, ln));
    for (let i = 0; i < ln; i++) lamps.setMatrixAt(i, m4.makeTranslation(data.poi.lamp[2 * i], 0, -data.poi.lamp[2 * i + 1]));
    lamps.count = ln; scene.add(lamps);
    stats.trees = n; stats.lamps = ln;
  }

  // ---------- labels ----------
  const labels = new THREE.Group();
  for (const l of data.labels) {
    const c = document.createElement('canvas'); const g = c.getContext('2d');
    const font = 'bold 44px system-ui, sans-serif'; g.font = font;
    const w = Math.ceil(g.measureText(l.n).width) + 40; c.width = w; c.height = 72;
    g.font = font; g.fillStyle = l.k === 'landmark' ? 'rgba(16,32,43,0.82)' : 'rgba(224,69,123,0.88)';
    g.beginPath(); g.roundRect(0, 0, w, 72, 18); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(l.n, 20, 38);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, fog: false, toneMapped: false }));
    const scale = l.k === 'landmark' ? 0.32 : 0.3; sp.scale.set(w * scale, 72 * scale, 1);
    sp.position.set(l.x, l.h + 14, -l.y); labels.add(sp);
  }
  scene.add(labels);

  function updateLod(px, py) {
    for (const c of chunkList) {
      const far = Math.hypot(c.cx - px, c.cy - py) > LOD_DISTANCE;
      if (far !== c.far) { c.far = far; c.full.visible = !far || !c.lod; if (c.lod) c.lod.visible = far; }
    }
  }
  return { updateLod, updateShadow, updateWater, labels, stats, chunkList, sun, env };
}

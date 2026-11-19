// First-person player: pointer-lock look, walking with collision and sliding, plus
// Minecraft-style creative flight.
//
//   Walking: WASD move, Shift sprint, Space jump. Stand on and walk across rooftops; fall off edges.
//   Flying:  double-tap Space to start/stop. Space = up, Shift = down, double-tap W = fly fast.
//   Speed:   + / - or mouse wheel scales walking and flying speed (0.5x to 12x).
//            Touching down on a roof or the street ends flight (as in Minecraft creative mode).
import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

export const EYE = 1.7, RADIUS = 0.35, WALK = 1.6, SPRINT = 6.0, JUMP_V = 3.2, GRAVITY = 9.81;
export const FLY = 11, FLY_FAST = 30, FLY_VERTICAL = 8, MAX_ALTITUDE = 800, DOUBLE_TAP_MS = 350; // Minecraft's double-tap window is 7 ticks = 350 ms
export const SPEED_STEPS = [0.5, 1, 1.5, 2, 3, 5, 8, 12];
const WATER_HOVER = 0.6; // flight cannot end over water; the player hovers this high above it

export function createPlayer(camera, dom, collision, spawn) {
  const controls = new PointerLockControls(camera, dom);
  const keys = new Set();
  let savedSpeed = 1;
  try { savedSpeed = SPEED_STEPS.indexOf(+localStorage.getItem('miami3d.speed')) >= 0 ? +localStorage.getItem('miami3d.speed') : 1; } catch { /* storage unavailable */ }
  const state = { x: spawn[0], y: spawn[1], z: 0, vz: 0, vx: 0, vy: 0, onGround: true, flying: false, fast: false, overWater: false, distance: 0, speedMul: savedSpeed };
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f(state));
  const reset = () => {
    Object.assign(state, { x: spawn[0], y: spawn[1], z: 0, vz: 0, vx: 0, vy: 0, flying: false, fast: false, onGround: true });
    camera.position.set(state.x, EYE, -state.y);
    camera.rotation.set(0, Math.PI * 0.5, 0, 'YXZ'); // face west, toward downtown
    emit();
  };
  const setFlying = (on) => {
    if (state.flying === on) return;
    state.flying = on; state.vz = 0;
    if (!on) state.fast = false;
    emit();
  };
  // Speed multiplier for walking and flying: + / - keys or the mouse wheel.
  const changeSpeed = (dir) => {
    const i = SPEED_STEPS.indexOf(state.speedMul);
    state.speedMul = SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, (i < 0 ? 1 : i) + dir))];
    try { localStorage.setItem('miami3d.speed', String(state.speedMul)); } catch { /* storage unavailable */ }
    emit();
  };
  addEventListener('wheel', (e) => { if (controls.isLocked && e.deltaY) changeSpeed(e.deltaY < 0 ? 1 : -1); }, { passive: true });
  reset();

  const lastTap = { Space: 0, KeyW: 0 };
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'KeyR') reset();
    if (e.code === 'Equal' || e.code === 'NumpadAdd') changeSpeed(1);
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') changeSpeed(-1);
    const now = e.timeStamp; // when the key was pressed, not when we got to process it (robust on slow frames)
    if (e.code === 'Space') { if (now - lastTap.Space < DOUBLE_TAP_MS) { setFlying(!state.flying); lastTap.Space = 0; } else lastTap.Space = now; }
    if (e.code === 'KeyW' || e.code === 'ArrowUp') { if (now - lastTap.KeyW < DOUBLE_TAP_MS) { state.fast = true; lastTap.KeyW = 0; } else lastTap.KeyW = now; }
  });
  addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if ((e.code === 'KeyW' || e.code === 'ArrowUp') && state.fast) state.fast = false; // like Minecraft: sprint ends when you stop moving forward
  });
  addEventListener('blur', () => { keys.clear(); state.fast = false; });

  const ext = collision.extent, MARGIN = 1500;
  const fwd = new THREE.Vector3();

  function moveHorizontal(mx, my) {
    const steps = Math.max(1, Math.ceil(Math.hypot(mx, my) / 0.25)); // sub-step so fast moves never skip thin geometry
    for (let s = 0; s < steps; s++) {
      const [nx, ny] = collision.move(state.x, state.y, mx / steps, my / steps, RADIUS, state.z);
      state.distance += Math.hypot(nx - state.x, ny - state.y);
      state.x = Math.min(ext.maxX + MARGIN, Math.max(ext.minX - MARGIN, nx));
      state.y = Math.min(ext.maxY + MARGIN, Math.max(ext.minY - MARGIN, ny));
    }
  }

  // input: optional {forward, right, sprint, jump, up, down} for scripted tests; otherwise keyboard.
  function update(dt, input) {
    const shift = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const k = input || {
      forward: (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0),
      right: (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0),
      sprint: (!state.flying && shift) || state.fast,
      jump: keys.has('Space'), up: keys.has('Space'), down: state.flying && shift,
    };
    camera.getWorldDirection(fwd);
    let fx = fwd.x, fy = -fwd.z; const L = Math.hypot(fx, fy) || 1; fx /= L; fy /= L;
    const rx = fy, ry = -fx; // right of forward in x/y (north-up) frame
    let mx = fx * k.forward + rx * k.right, my = fy * k.forward + ry * k.right;
    const ml = Math.hypot(mx, my);
    if (ml > 0) { mx /= ml; my /= ml; }

    if (state.flying) {
      // Smoothed velocity, Minecraft-like glide.
      const speed = (k.sprint ? FLY_FAST : FLY) * state.speedMul, a = Math.min(1, dt * 6);
      state.vx += (mx * speed - state.vx) * a; state.vy += (my * speed - state.vy) * a;
      const vt = ((k.up ? 1 : 0) - (k.down ? 1 : 0)) * FLY_VERTICAL * (k.sprint ? 1.6 : 1) * Math.max(1, Math.sqrt(state.speedMul));
      state.vz += (vt - state.vz) * Math.min(1, dt * 10);
      moveHorizontal(state.vx * dt, state.vy * dt);
      let nz = Math.min(MAX_ALTITUDE, state.z + state.vz * dt);
      // Ceiling: do not rise into the underside of something overhead.
      if (state.vz > 0 && collision.insideBuilding(state.x, state.y, nz) && !collision.insideBuilding(state.x, state.y, state.z)) { nz = state.z; state.vz = 0; }
      const ground = collision.groundAt(state.x, state.y, Math.max(nz, state.z));
      state.overWater = ground === 0 && !collision.walkableGround(state.x, state.y);
      if (nz <= ground && state.vz >= 0) nz = ground;          // skimming the surface: keep flying
      else if (nz <= ground) {                                   // descending onto it
        if (state.overWater) { nz = Math.max(nz, WATER_HOVER); state.vz = Math.max(0, state.vz); }
        else { nz = ground; setFlying(false); state.onGround = true; }
      }
      if (state.overWater && nz < WATER_HOVER) nz = WATER_HOVER;
      state.z = nz;
    } else {
      state.vx = state.vy = 0;
      if (ml > 0) { const v = (k.sprint ? SPRINT : WALK) * state.speedMul * dt; moveHorizontal(mx * v, my * v); }
      if (k.jump && state.onGround) { state.vz = JUMP_V; state.onGround = false; }
      const ground = collision.groundAt(state.x, state.y, state.z);
      state.overWater = ground === 0 && !collision.walkableGround(state.x, state.y);
      if (state.z <= ground + 1e-4 && state.vz <= 0) { state.z = ground; state.vz = 0; state.onGround = true; } // also steps up onto low surfaces
      else {
        state.vz -= GRAVITY * dt; state.z += state.vz * dt; state.onGround = false;
        if (state.z <= ground) { state.z = ground; state.vz = 0; state.onGround = true; }
      }
      // Walked or dropped onto open water (only possible off a roof edge or from flight): keep hovering.
      if (state.overWater && state.z < WATER_HOVER) { state.z = WATER_HOVER; setFlying(true); }
    }
    camera.position.set(state.x, EYE + state.z, -state.y);
  }
  return { controls, update, reset, state, keys, setFlying, changeSpeed, onChange: (f) => listeners.add(f) };
}

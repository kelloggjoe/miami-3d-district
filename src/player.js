// First-person player: pointer-lock look, WASD movement, sprint, small jump, collision with sliding.
import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

export const EYE = 1.7, RADIUS = 0.35, WALK = 1.6, SPRINT = 6.0, JUMP_V = 3.2, GRAVITY = 9.81;

export function createPlayer(camera, dom, collision, spawn) {
  const controls = new PointerLockControls(camera, dom);
  const keys = new Set();
  const state = { x: spawn[0], y: spawn[1], z: 0, vz: 0, onGround: true, distance: 0 };
  const reset = () => {
    state.x = spawn[0]; state.y = spawn[1]; state.z = 0; state.vz = 0;
    camera.position.set(state.x, EYE, -state.y);
    camera.rotation.set(0, Math.PI * 0.5, 0, 'YXZ'); // face west, toward downtown
  };
  reset();
  addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'KeyR') reset(); if (e.code === 'Space') e.preventDefault(); });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const fwd = new THREE.Vector3();
  // input: optional {forward, right, sprint, jump} for scripted tests; otherwise keyboard.
  function update(dt, input) {
    const k = input || {
      forward: (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0),
      right: (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0),
      sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
      jump: keys.has('Space'),
    };
    camera.getWorldDirection(fwd);
    let fx = fwd.x, fy = -fwd.z; const L = Math.hypot(fx, fy) || 1; fx /= L; fy /= L;
    const rx = fy, ry = -fx; // right of forward in x/y (north-up) frame
    let mx = fx * k.forward + rx * k.right, my = fy * k.forward + ry * k.right;
    const ml = Math.hypot(mx, my);
    if (ml > 0) {
      const speed = k.sprint ? SPRINT : WALK;
      mx = (mx / ml) * speed * dt; my = (my / ml) * speed * dt;
      // sub-step so fast moves never skip thin geometry
      const steps = Math.ceil(Math.hypot(mx, my) / 0.25);
      for (let s = 0; s < steps; s++) {
        const [nx, ny] = collision.move(state.x, state.y, mx / steps, my / steps, RADIUS);
        state.distance += Math.hypot(nx - state.x, ny - state.y);
        state.x = nx; state.y = ny;
      }
    }
    if (k.jump && state.onGround) { state.vz = JUMP_V; state.onGround = false; }
    state.vz -= GRAVITY * dt; state.z += state.vz * dt;
    if (state.z <= 0) { state.z = 0; state.vz = 0; state.onGround = true; } // flat ground at 0 m
    camera.position.set(state.x, EYE + state.z, -state.y);
  }
  return { controls, update, reset, state, keys };
}

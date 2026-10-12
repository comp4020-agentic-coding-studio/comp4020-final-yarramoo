// A pooled particle set: one InstancedMesh, a fixed number of slots, recycled in
// a ring (the oldest slot is overwritten when the pool is full), so nothing is
// allocated after construction and the draw cost is one call per pool. All of it
// is cosmetic and local: nothing here is ever sent anywhere.
import * as THREE from "three";

export function makePool(geometry, material, cap, { gravity = 0, drag = 0, floor = null, fade = false, shrink = true } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // creates instanceColor
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const px = new Float32Array(cap), py = new Float32Array(cap), pz = new Float32Array(cap);
  const vx = new Float32Array(cap), vy = new Float32Array(cap), vz = new Float32Array(cap);
  const age = new Float32Array(cap), life = new Float32Array(cap), s0 = new Float32Array(cap), s1 = new Float32Array(cap);
  const c0 = new Float32Array(cap * 3), c1 = new Float32Array(cap * 3);
  const on = new Uint8Array(cap);
  const M = mesh.instanceMatrix.array, C = mesh.instanceColor.array;
  for (let i = 0; i < cap; i++) { M[i * 16 + 15] = 1; }
  let next = 0, alive = 0;

  function spawn(x, y, z, ax, ay, az, lifeSec, size0, size1, colorA, colorB) {
    const i = next; next = (next + 1) % cap;
    px[i] = x; py[i] = y; pz[i] = z; vx[i] = ax; vy[i] = ay; vz[i] = az;
    age[i] = 0; life[i] = lifeSec; s0[i] = size0; s1[i] = size1;
    c0[i * 3] = colorA.r; c0[i * 3 + 1] = colorA.g; c0[i * 3 + 2] = colorA.b;
    c1[i * 3] = colorB.r; c1[i * 3 + 1] = colorB.g; c1[i * 3 + 2] = colorB.b;
    on[i] = 1;
    return i;
  }

  /** Advance dt seconds; returns the number alive (0 means the pool is idle). */
  function update(dt) {
    alive = 0;
    const damp = drag > 0 ? Math.exp(-drag * dt) : 1;
    for (let i = 0; i < cap; i++) {
      const o = i * 16;
      if (!on[i]) continue;
      age[i] += dt;
      const k = age[i] / life[i];
      if (k >= 1) { on[i] = 0; M[o] = M[o + 5] = M[o + 10] = 0; mesh.instanceMatrix.needsUpdate = true; continue; }
      alive++;
      vy[i] -= gravity * dt;
      if (damp !== 1) { vx[i] *= damp; vy[i] *= damp; vz[i] *= damp; }
      px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
      if (floor !== null && py[i] < floor) { py[i] = floor; vy[i] = 0; vx[i] *= 0.82; vz[i] *= 0.82; }
      let s = s0[i] + (s1[i] - s0[i]) * k;
      if (shrink && k > 0.7) s *= 1 - (k - 0.7) / 0.3;
      M[o] = M[o + 5] = M[o + 10] = s;
      M[o + 12] = px[i]; M[o + 13] = py[i]; M[o + 14] = pz[i];
      const f = fade ? (1 - k) : 1;
      C[i * 3] = (c0[i * 3] + (c1[i * 3] - c0[i * 3]) * k) * f;
      C[i * 3 + 1] = (c0[i * 3 + 1] + (c1[i * 3 + 1] - c0[i * 3 + 1]) * k) * f;
      C[i * 3 + 2] = (c0[i * 3 + 2] + (c1[i * 3 + 2] - c0[i * 3 + 2]) * k) * f;
    }
    if (alive > 0) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; }
    return alive;
  }

  function clear() {
    for (let i = 0; i < cap; i++) { on[i] = 0; M[i * 16] = M[i * 16 + 5] = M[i * 16 + 10] = 0; }
    mesh.instanceMatrix.needsUpdate = true;
    alive = 0;
  }

  return { mesh, spawn, update, clear, get alive() { return alive; }, cap, dispose() { geometry.dispose(); material.dispose(); } };
}

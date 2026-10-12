// The launch moment: pad clock, count atmosphere, ignition and liftoff, the
// climb, and each outcome with its final tableau.
//
// THE RULE: everything here is a function of PUBLIC state only: the phase, the
// mission clock (tMs, extrapolated between messages), the outcome kind and its
// atT, and "now". Nothing reads a console view, a step or a fault.
//   - The rocket follows ONE nominal arc (pathAt) whatever happens. An anomaly
//     is invisible until the outcome arrives; then the rocket ends on that arc
//     at outcome.atT. There is no code path that bends the arc.
//   - A page opened late gets a pure state: where the arc is at tMs, or, when the
//     outcome is old (never seen live), the final tableau without the effects.
//   - Particles are cosmetic and only ever spawned going forward from "now".
import * as THREE from "three";
import { MOUNT_TOP } from "./pad.js";
import { makePool } from "./particles.js";
import { buildClock } from "./clock.js";

// Static sequence data (data/sequences/*.json), not secret: a sequence with an
// ascent climbs this many seconds after T+0; the others get a short cinematic.
const CINEMATIC_SEC = 12;
const BOOM_DELAY = 0.8; // pad explosion: ignition rumble, then the boom
const SCALE = { mvp: 1, kestrel2: 1.3, kestrel3: 1.7 };
const ARC_UP = 600, ARC_ACROSS = 550; // the nominal arc: height and downrange (+x), world units
const ARM_SWING = 1.25;

const col = (h) => new THREE.Color(h);
const C = {
  white: col("#ffffff"), smokeA: col("#f4f1ea"), smokeB: col("#aab4c0"), padSmoke: col("#d8d6d0"),
  ventA: col("#ffffff"), ventB: col("#cfd8e2"),
  trailA: col("#fff4e6"), trailB: col("#9fb0c4"),
  fireA: col("#fff4c0"), fireB: col("#ff4a10"), fireC: col("#ffb060"),
  blastA: col("#2e2b28"), blastB: col("#6b6762"),
  d1: col("#e8ebef"), d2: col("#8a8f98"), d3: col("#2a2d33"), d4: col("#ff7a3d"),
};
const DEBRIS = [C.d1, C.d2, C.d3, C.d4, C.d3, C.d2];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);

// ------------------------------------------------------------ the nominal arc
// p runs 0..1 over the climb. Up accelerates (p^1.9), downrange builds later
// (p^2.4): a vertical rise that pitches over. Scalars only, no allocation.
const arc = { x: 0, y: 0, tilt: 0 };
function pathAt(p) {
  p = clamp(p, 0, 1);
  arc.x = ARC_ACROSS * Math.pow(p, 2.4);
  arc.y = ARC_UP * Math.pow(p, 1.9);
  arc.tilt = Math.atan2(ARC_ACROSS * 2.4 * Math.pow(p, 1.4), ARC_UP * 1.9 * Math.pow(p, 0.9));
  return arc;
}

const label = (kind) => ({
  success: ["NOMINAL", "good"], scrub: ["SCRUB", "bad"], pad_abort: ["PAD ABORT", "bad"],
  explosion: ["VEHICLE LOST", "bad"], terminated: ["TERMINATED", "bad"], range_violation: ["RANGE VIOLATION", "bad"],
})[kind] || ["", ""];

const fmt = (ms) => {
  const t = Math.floor(Math.abs(ms) / 1000), p = (n) => String(n).padStart(2, "0");
  return `T${ms < 0 ? "-" : "+"}${p(Math.floor(t / 60))}:${p(t % 60)}`;
};

export function buildEffects({ scene, container, rocket, pad, stations, lights, sequenceId, ascentSec, invalidate, reduced }) {
  const A = Number(ascentSec) > 0 ? Number(ascentSec) : 0; // from the page (data-ascent-sec), not a table
  const RS = SCALE[sequenceId] || 1;

  // ---------------------------------------------------------------- objects
  const clock = buildClock(rocket.height);
  scene.add(clock.group);

  const puffs = makePool(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true, fog: false }), 200, { gravity: -0.8, drag: 0.5 });
  const fire = makePool(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), 80, { drag: 1.2, fade: true });
  const debris = makePool(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true, fog: false }), 70, { gravity: 24, floor: 0.3, shrink: false });
  scene.add(puffs.mesh, fire.mesh, debris.mesh);
  const pools = [puffs, fire, debris];

  // Engine flame: two additive cones that flicker; the rocket's own cone is the outer one.
  const flameOuter = rocket.flame;
  flameOuter.material.dispose();
  flameOuter.material = new THREE.MeshBasicMaterial({ color: "#ff8a1f", transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const innerGeo = flameOuter.geometry.clone();
  const flameInner = new THREE.Mesh(innerGeo, new THREE.MeshBasicMaterial({ color: "#fff1b8", transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  flameInner.scale.set(0.55, 0.7, 0.55);
  flameInner.frustumCulled = false; flameOuter.frustumCulled = false;
  rocket.group.add(flameInner);
  rocket.body.material.fog = false;
  flameOuter.visible = flameInner.visible = false;

  // Scorch decal on the apron: dark under an explosion, light after a clean liftoff.
  const scorchMat = new THREE.MeshBasicMaterial({ color: "#1c1a18", transparent: true, opacity: 0.8, depthWrite: false });
  const scorchGeo = new THREE.CircleGeometry(1, 20);
  scorchGeo.rotateX(-Math.PI / 2);
  const scorch = new THREE.Mesh(scorchGeo, scorchMat);
  scorch.position.y = 0.47; scorch.visible = false; scorch.renderOrder = 2;
  scene.add(scorch);

  // A far, tiny glow where the rocket is, once it is too small to see.
  const dotMat = new THREE.MeshBasicMaterial({ color: "#fff4cc", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const dot = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), dotMat);
  dot.visible = false; dot.frustumCulled = false;
  scene.add(dot);

  const glow = new THREE.PointLight("#ff9a40", 0, 160, 2);
  glow.position.set(0, MOUNT_TOP + 4, 0);
  scene.add(glow);

  const flashEl = document.createElement("div");
  flashEl.setAttribute("aria-hidden", "true");
  flashEl.style.cssText = "position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:1";
  container.appendChild(flashEl);
  let flashShown = 0;

  // ------------------------------------------------------------ public state
  const S = {
    known: false, phase: "lobby", tMs: 0, at: 0, outcome: null, ocKey: "", outcomeAt: null,
    epoch: 0, flags: { watch: false, boom: false, cheer: false, tab: false },
  };
  let armCur = 0, tiltCur = 0, lightCur = 1, snap = true;
  const acc = { vent: 0, smoke: 0, trail: 0, abort: 0 };
  let pq = 1; // particle quality (1 full, 0.5 halved by adaptive quality in scene.js)
  let lastClock = 0, clockTimer = 0;
  const out = { following: false, focus: new THREE.Vector3(), shake: 0 };
  const dbgState = { tSec: 0, liftSec: -1, p: 0, eOut: Infinity, rocket: false, flame: 0, air: false, alive: 0 };

  function setState(phase, tMs, at, outcome, now, opts = {}) {
    const key = outcome ? `${outcome.kind}:${outcome.atT}` : "";
    const changed = phase !== S.phase || key !== S.ocKey || opts.force;
    if (changed) {
      const was = S.phase;
      S.epoch++;
      S.flags = { watch: false, boom: false, cheer: false, tab: false };
      if (phase === "done") {
        const live = opts.live ?? (S.known && (was === "count" || was === "hold" || was === "ascent"));
        S.outcomeAt = opts.since != null ? now - opts.since * 1000 : live ? now : null;
      } else S.outcomeAt = null;
      if (phase !== "done" || opts.force) for (const p of pools) p.clear();
      if (opts.force || !S.known) snap = true;
    }
    S.known = true; S.phase = phase; S.tMs = tMs; S.at = at; S.outcome = outcome; S.ocKey = key;
    clearInterval(clockTimer); clockTimer = 0;
    // The board needs a redraw each second in a live count or climb; nothing else changes while idle.
    if (phase === "count" || phase === "ascent") clockTimer = setInterval(() => invalidate(), 250);
    invalidate();
  }

  // --------------------------------------------------------------- spawners
  function ventPuff() {
    puffs.spawn(rnd(-0.9, 0.9), MOUNT_TOP + rnd(0.6, 2.2), rnd(-0.9, 0.9), rnd(-1.4, 1.4), rnd(0.5, 1.6), rnd(-1.4, 1.4), 2.4, 0.35 * RS, 1.3 * RS, C.ventA, C.ventB);
  }
  function groundSmoke(x, y, big) {
    const a = rnd(0, Math.PI * 2), sp = rnd(3, 7) * (big ? 1 : 0.6);
    puffs.spawn(x + Math.cos(a) * 2.5, y + 0.6, Math.sin(a) * 2.5, Math.cos(a) * sp, rnd(0.2, 1.4), Math.sin(a) * sp, rnd(3, 4.5), 1.0 * RS, rnd(3, 5) * Math.sqrt(RS), C.smokeA, C.padSmoke);
  }
  function trailPuff(x, y) {
    puffs.spawn(x + rnd(-0.4, 0.4), y, rnd(-0.4, 0.4), rnd(-0.4, 0.4), rnd(-1, 0), rnd(-0.4, 0.4), 5, 0.9 * RS, 3.2 * RS, C.trailA, C.trailB);
  }
  function abortPuff() {
    const a = rnd(0, Math.PI * 2), sp = rnd(1, 3);
    puffs.spawn(Math.cos(a) * 1.5, MOUNT_TOP + rnd(0, 1.5), Math.sin(a) * 1.5, Math.cos(a) * sp, rnd(0.8, 2.2), Math.sin(a) * sp, rnd(4.5, 6), 1.0, rnd(3, 4.5), C.white, C.padSmoke);
  }
  function fireball(x, y, z, n, spread, size) {
    n = Math.max(1, Math.round(n * pq));
    for (let i = 0; i < n; i++) {
      fire.spawn(x + rnd(-1, 1) * 2, y + rnd(0, 3), z + rnd(-1, 1) * 2, rnd(-1, 1) * spread, rnd(0.2, 1) * spread * 0.8, rnd(-1, 1) * spread, rnd(0.9, 1.9), size * 0.3, size * rnd(0.7, 1.2), C.fireA, C.fireB);
    }
    fire.spawn(x, y, z, 0, 0, 0, 0.45, size * 0.5, size * 2.4, C.white, C.fireC); // the flash core
  }
  function blastSmoke(x, y, z, n, size) {
    n = Math.round(n * pq);
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(3, 11);
      puffs.spawn(x, y + rnd(0, 3), z, Math.cos(a) * sp, rnd(2, 9), Math.sin(a) * sp, rnd(5, 8.5), size * 0.25, size * rnd(0.7, 1.2), C.blastA, C.blastB);
    }
  }
  function debrisBurst(x, y, z, n, up, spread, lifeSec) {
    n = Math.round(n * pq);
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(0.3, 1) * spread, s = rnd(0.35, 1.15);
      const c = DEBRIS[(Math.random() * DEBRIS.length) | 0];
      debris.spawn(x, y, z, Math.cos(a) * sp, rnd(0.4, 1) * up, Math.sin(a) * sp, lifeSec, s, s, c, c);
    }
  }
  function landedDebris(n) { // the tableau for anyone who was not there: pieces already on the ground
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), r = rnd(4, 15), s = rnd(0.35, 1.1);
      const c = DEBRIS[(Math.random() * DEBRIS.length) | 0];
      debris.spawn(Math.cos(a) * r, 0.3, Math.sin(a) * r, 0, 0, 0, 1e9, s, s, c, c);
    }
  }

  // ---------------------------------------------------------------- the tick
  const tmpE = new THREE.Euler(), tmpV = new THREE.Vector3();
  function tick(dt, now, camera) {
    const ph = S.phase, oc = S.outcome, kind = oc ? oc.kind : null;
    const eOut = S.outcomeAt != null ? (now - S.outcomeAt) / 1000 : Infinity;
    let tMs = S.tMs + (ph === "count" || ph === "ascent" ? now - S.at : 0);
    if (ph === "done" && oc) tMs = oc.atT;
    let tSec = tMs / 1000;
    if (A && tSec > A) tSec = A;

    // --- what the vehicle is doing: a pure function of (phase, clock, outcome, eOut)
    let flying = false, liftSec = -1, total = A || CINEMATIC_SEC;
    let rocketVis = true, flame = 0, air = false, gone = false;
    const done = ph === "done";
    if (ph === "ascent") { flying = true; liftSec = Math.max(0, tSec); }
    else if (done && kind === "success") {
      if (A) { gone = true; }
      else if (eOut < CINEMATIC_SEC) { flying = true; liftSec = eOut; }
      else gone = true;
    } else if (done && (kind === "explosion" || kind === "terminated" || kind === "range_violation")) {
      air = (A > 0 && oc.atT > 0) || kind !== "explosion";
      rocketVis = !air && eOut < BOOM_DELAY; // gone at the boom; on the pad it waits for it
      if (!air && eOut < BOOM_DELAY) flame = 0.35 + 0.65 * clamp(eOut / BOOM_DELAY, 0, 1);
      if (air || eOut >= BOOM_DELAY) rocketVis = false;
    } else if (done && kind === "pad_abort") {
      if (eOut < 1.2) flame = 0.6; else if (eOut < 2.5) flame = 0.6 * (1 - (eOut - 1.2) / 1.3);
    } else if (ph === "count" && tSec > -1.5) flame = 0.3 * clamp((tSec + 1.5) / 1.5, 0, 1); // faint ignition flicker, time only
    if (flying) flame = 1;
    if (gone) rocketVis = false;

    // --- place the rocket on the one nominal arc
    const p = flying ? clamp(liftSec / total, 0, 1) : 0;
    if (flying) {
      pathAt(p);
      rocket.group.position.set(arc.x, MOUNT_TOP + arc.y, 0);
      rocket.group.rotation.z = -arc.tilt;
      if (p >= 1) rocketVis = false;
    } else {
      rocket.group.position.set(0, MOUNT_TOP, 0);
      rocket.group.rotation.z = 0;
    }
    rocket.group.visible = rocketVis;
    flameOuter.visible = flameInner.visible = rocketVis && flame > 0.01;
    if (flameOuter.visible) {
      const fl = flame * (0.85 + 0.2 * Math.sin(now * 0.031) + 0.12 * Math.sin(now * 0.077));
      const w = 1.3 * RS * (0.9 + 0.1 * Math.sin(now * 0.053));
      flameOuter.scale.set(w, Math.max(0.05, fl) * 1.5 * RS, w);
      flameInner.scale.set(0.55 * w, 0.7 * Math.max(0.05, fl) * 1.5 * RS, 0.55 * w);
    }

    // dot in the sky: the nominal arc's far end, for a few seconds after a successful climb,
    // and a flare on the rocket while it is far away.
    const showDot = (flying && p > 0.55) || (done && kind === "success" && A > 0 && eOut < 8);
    dot.visible = showDot;
    if (showDot) {
      pathAt(flying ? p : 1);
      dot.position.set(arc.x, MOUNT_TOP + arc.y, 0);
      dot.scale.setScalar(Math.max(1.5, camera.position.distanceTo(dot.position) * 0.006));
    }

    // --- pad: arm, tower lean, light level, scorch, tableau debris
    let armT = 0;
    if (ph === "count" || ph === "hold") armT = tSec > -30 ? 1 : 0;
    else if (ph === "ascent") armT = 1;
    else if (done) armT = kind === "scrub" ? 0 : (oc && oc.atT / 1000 > -30 ? 1 : 0);
    const tiltT = done && kind === "explosion" && !air && (eOut >= BOOM_DELAY) ? 1 : 0;
    const lightT = done && kind === "scrub" ? 0.6 : 1;
    if (snap) { armCur = armT; tiltCur = tiltT; lightCur = lightT; snap = false; }
    armCur += clamp(armT - armCur, -0.3 * dt, 0.3 * dt);
    tiltCur += clamp(tiltT - tiltCur, -1.2 * dt, 1.2 * dt);
    lightCur += clamp(lightT - lightCur, -0.35 * dt, 0.35 * dt);
    pad.tower.arm.rotation.y = ARM_SWING * armCur;
    const tw = pad.tower.group;
    tw.rotation.set(0.06 * tiltCur, 0, 0.03 * tiltCur);
    tmpV.copy(pad.tower.base).applyEuler(tw.rotation);
    tw.position.copy(pad.tower.base).sub(tmpV);
    lights.hemi.intensity = lights.hemi0 * lightCur;
    lights.sun.intensity = lights.sun0 * lightCur;

    let scorchR = 0;
    if (done && kind === "explosion" && !air) scorchR = eOut >= BOOM_DELAY ? 11 : 0;
    else if (done && kind === "pad_abort") scorchR = eOut >= 1 ? 6 : 0;
    else if (ph === "ascent" || (done && (kind === "success" || air))) scorchR = liftSec > 1.5 || done ? 8 : 0;
    scorch.visible = scorchR > 0;
    if (scorchR > 0) {
      const r = scorch.scale.x + (scorchR - scorch.scale.x) * Math.min(1, dt * 3) || scorchR;
      scorch.scale.set(r, 1, r);
      scorchMat.color.set(done && kind === "explosion" ? "#1c1a18" : "#47443f");
      scorchMat.opacity = done && kind === "explosion" ? 0.85 : 0.6;
    }
    if (done && kind === "explosion" && !air && !S.flags.tab && eOut >= 10) { S.flags.tab = true; landedDebris(26); }

    // --- one-shot events (only when seen live, not when arriving late)
    let flashT = 0, shakeAmp = 0, glowI = 0;
    if (done && !S.flags.boom && (kind === "explosion" || kind === "terminated" || kind === "range_violation")) {
      const boomAt = air || kind !== "explosion" ? 0 : BOOM_DELAY;
      if (eOut >= boomAt) {
        S.flags.boom = true;
        if (eOut < boomAt + 1.5) {
          if (!air) {
            fireball(0, MOUNT_TOP + 3, 0, 12, 14, 9);
            blastSmoke(0, MOUNT_TOP + 1, 0, 34, 8);
            debrisBurst(0, MOUNT_TOP + 3, 0, 40, 40, 38, 1e9);
          } else {
            const pe = clamp((oc.atT / 1000) / total, 0.04, 1);
            pathAt(pe);
            const bx = arc.x, by = MOUNT_TOP + arc.y;
            if (kind === "range_violation") {
              // Out over the hills: a distant, quiet flash. The rocket was on its arc until now.
              fireball(520, 45, -20, 6, 6, 16);
            } else if (kind === "terminated") {
              fireball(bx, by, 0, 7, 8, 7 * RS);
              debrisBurst(bx, by, 0, 22, 8, 14, 6);
            } else {
              fireball(bx, by, 0, 12, 12, 11 * RS);
              blastSmoke(bx, by, 0, 14, 9);
              debrisBurst(bx, by, 0, 26, 12, 20, 6);
            }
          }
        }
      }
    }
    if (done && S.flags.boom && eOut < 3) {
      const bt = eOut - (air || kind !== "explosion" ? 0 : BOOM_DELAY);
      if (bt >= 0) {
        const far = air ? (kind === "range_violation" ? 0.1 : kind === "terminated" ? 0.4 : 0.3) : 0.6;
        flashT = far * Math.exp(-bt * (kind === "terminated" ? 9 : 5));
        glowI = air ? 0 : 2400 * Math.exp(-bt * 1.4);
        if (!air) shakeAmp = 0.035 * Math.pow(Math.max(0, 1 - bt / 2.5), 2);
      }
    }
    if (kind === "explosion" && done && !air && eOut < BOOM_DELAY) glowI = 150 * flame;

    // liftoff reaction and the climb's shake
    if (flying) {
      if (!S.flags.watch) { S.flags.watch = true; if (liftSec < 3) stations.react("watch"); }
      if (liftSec < 9 && arc.y < 100) {
        const env = liftSec < 1 ? liftSec : Math.max(0, 1 - (liftSec - 1) / 8);
        shakeAmp = Math.max(shakeAmp, 0.011 * env);
      }
      glowI = Math.max(glowI, liftSec < 12 ? 500 * (1 - Math.min(1, liftSec / 12)) * RS : 0);
    }
    if (done && kind === "explosion" && !air && S.flags.boom && eOut < 3 && !S.flags.flinch) { S.flags.flinch = true; stations.react("flinch"); }
    if (done && !S.flags.cheer && kind === "success") {
      const at = A ? 0 : 6; // after a short climb for the cinematic; at once at the end of an ascent
      if (eOut >= at) { S.flags.cheer = true; if (eOut < at + 3) stations.react("cheer"); }
    }

    // --- emitters, forward from now
    let emitting = false;
    if (ph === "count" && tSec > -10 && tSec < 0) { acc.vent += (5 + (tSec + 10) * 1.2) * dt * pq; emitting = true; }
    else acc.vent = 0;
    for (let n = 0; acc.vent >= 1 && n < 6; n++) { acc.vent--; ventPuff(); }

    const lifting = flying && liftSec < 9 && arc.y < 60;
    if (lifting) { acc.smoke += (liftSec < 2 ? 18 : 30 * (1 - liftSec / 9)) * dt * pq; emitting = true; } else acc.smoke = 0;
    for (let n = 0; acc.smoke >= 1 && n < 8; n++) { acc.smoke--; groundSmoke(0, MOUNT_TOP - 1.5 + (arc.y > 0 ? 0 : 0), liftSec < 3); }

    if (flying && liftSec > 0.5 && rocketVis) {
      acc.trail += 16 * dt * pq; emitting = true;
      for (let n = 0; acc.trail >= 1 && n < 6; n++) { acc.trail--; trailPuff(arc.x, MOUNT_TOP + arc.y); }
    } else acc.trail = 0;

    if (done && kind === "pad_abort" && eOut >= 1.2 && eOut < 8) { acc.abort += 16 * dt * pq; emitting = true; } else acc.abort = 0;
    for (let n = 0; acc.abort >= 1 && n < 6; n++) { acc.abort--; abortPuff(); }

    // --- advance the pools; cap is fixed by construction (200 + 80 + 70)
    let alive = 0;
    for (const pl of pools) alive += pl.update(dt);
    glow.intensity = glowI;
    if (glowI > 0 && flying) glow.position.set(arc.x, MOUNT_TOP + arc.y, 0);
    else glow.position.set(0, MOUNT_TOP + 4, 0);

    // --- the pad clock, at most four times a second
    if (now - lastClock >= 250 || S.phase !== dbgState.ph) {
      lastClock = now;
      let sub = "STANDBY", tone = "";
      if (ph === "count") sub = tSec > -10 && tSec < 0 ? "TERMINAL COUNT" : "COUNT";
      else if (ph === "hold") { sub = "HOLD"; tone = "hold"; }
      else if (ph === "ascent") sub = "ASCENT";
      else if (done) [sub, tone] = label(kind);
      clock.draw(fmt(tMs), sub, tone);
    }
    clock.faceTo(camera);

    // --- hand the camera what it needs
    out.following = flying && liftSec < 18 && rocketVis;
    if (out.following) out.focus.set(arc.x, MOUNT_TOP + arc.y + rocket.height * 0.5, 0);
    if (reduced) { shakeAmp = 0; flashT = 0; }
    if (shakeAmp > 0) { tmpV.set(0, MOUNT_TOP, 0); shakeAmp *= Math.min(1.6, 25 / Math.max(8, camera.position.distanceTo(tmpV))); }
    out.shake = shakeAmp;
    if (Math.abs(flashT - flashShown) > 0.01 || (flashT === 0 && flashShown !== 0)) { flashEl.style.opacity = String(flashT.toFixed(2)); flashShown = flashT; }

    dbgState.ph = ph; dbgState.tSec = +tSec.toFixed(2); dbgState.liftSec = +liftSec.toFixed(2); dbgState.p = +p.toFixed(3);
    dbgState.eOut = eOut; dbgState.rocket = rocketVis; dbgState.flame = +flame.toFixed(2); dbgState.air = air; dbgState.alive = alive;

    // keep frames coming while anything is moving; otherwise the loop sleeps
    return alive > 0 || emitting || flying || flame > 0 || shakeAmp > 0 || flashT > 0 || glowI > 0.5 ||
      Math.abs(armT - armCur) > 0.002 || Math.abs(tiltT - tiltCur) > 0.002 || Math.abs(lightT - lightCur) > 0.002 ||
      (done && eOut < 14) || showDot || (ph === "count" && tSec > -12);
  }

  return {
    setState,
    boardBeside: (x) => clock.beside(x),
    setParticleQuality(q) { pq = q; },
    tick,
    out,
    get epoch() { return S.epoch; },
    debug() {
      return { ...dbgState, epoch: S.epoch, flags: { ...S.flags }, arm: +armCur.toFixed(2), tilt: +tiltCur.toFixed(2), particles: pools.map((p) => p.alive), caps: pools.map((p) => p.cap), shake: +out.shake.toFixed(4), flash: flashShown, arc: { x: +arc.x.toFixed(1), y: +arc.y.toFixed(1) } };
    },
    /** The arc is exported so a test can prove it takes nothing but a fraction. */
    pathAt(p) { pathAt(p); return { x: arc.x, y: arc.y, tilt: arc.tilt }; },
    dispose() {
      clearInterval(clockTimer);
      scene.remove(clock.group, puffs.mesh, fire.mesh, debris.mesh, scorch, dot, glow);
      clock.dispose();
      for (const p of pools) p.dispose();
      innerGeo.dispose(); flameInner.material.dispose(); flameOuter.material.dispose();
      scorchGeo.dispose(); scorchMat.dispose(); dot.geometry.dispose(); dotMat.dispose();
      flashEl.remove();
    },
  };
}

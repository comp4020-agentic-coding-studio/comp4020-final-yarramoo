// Scene entry. mountScene(container, { sequenceId, roles }) builds the open pad,
// the rocket for this sequence and a ring of stations, puts the camera at your
// seat, and returns { update(state), dispose(), setInsets(), invalidate() }.
//
// It is fed PUBLIC data only (see boot.js): the lobby message (phase, seats,
// outcome), the roles this browser holds and the selected seat. It never sees
// a console view, so there is nothing private here to leak.
import * as THREE from "three";
import { buildPad, MOUNT_TOP } from "./pad.js";
import { buildRocket } from "./rocket.js";
import { buildStations, RING_RADIUS, EYE_HEIGHT } from "./stations.js";
import { createLook } from "./look.js";
import { PALETTE as P } from "./palette.js";

const SPECTATOR = { radius: 64, height: 20 };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const WRECKED = new Set(["explosion", "terminated", "range_violation"]);

function skyTexture() {
  const c = document.createElement("canvas");
  c.width = 4; c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, P.skyTop);
  grad.addColorStop(0.55, P.skyMid);
  grad.addColorStop(0.85, P.skyHorizon);
  grad.addColorStop(1, P.skyHorizon);
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function mountScene(container, opts) {
  const roles = opts.roles || [];
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const sky = skyTexture();
  scene.background = sky;
  scene.fog = new THREE.Fog(P.fog, 70, 330);
  scene.add(new THREE.HemisphereLight("#cfe0f5", "#6c6b58", 2.1));
  const sun = new THREE.DirectionalLight("#fff0d4", 2.6);
  sun.position.set(-60, 90, 40);
  scene.add(sun);

  const rocket = buildRocket(opts.sequenceId);
  const stations = buildStations(roles);
  // Lamp masts go between stations (and on the empty north side), never in front of a seat.
  const mastThetas = stations.angles.slice(1).map((a, i) => (a + stations.angles[i]) / 2);
  mastThetas.push(Math.PI);
  const pad = buildPad({ rocketHeight: rocket.height, mastThetas });
  rocket.group.position.y = MOUNT_TOP;
  scene.add(pad.group, rocket.group, stations.group);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 900);
  camera.rotation.order = "YXZ";

  // ------------------------------------------------------------- camera rig
  // The rig is polar around the pad: theta (angle on the ring), radius, height.
  // Seat changes tween along the ring so the camera never cuts through the pad.
  let rig = { theta: 0, radius: SPECTATOR.radius, height: SPECTATOR.height };
  let tween = null;
  let seatRole = undefined; // undefined = not placed yet; null = spectator

  const homePitch = (r) => Math.max(-0.2, Math.min(0.6, Math.atan2(rocket.height * (camera.aspect < 0.9 ? 0.62 : 0.48) - r.height, r.radius)));
  const rigFor = (role) => (role && stations.hasRole(role)
    ? { theta: stations.theta(role), radius: RING_RADIUS, height: EYE_HEIGHT }
    : { theta: 0, radius: SPECTATOR.radius, height: SPECTATOR.height });

  const look = createLook(container, {
    radPerPx: () => (camera.fov * Math.PI) / 180 / Math.max(300, container.clientHeight),
    onChange: () => invalidate(),
  });

  function placeCamera() {
    camera.position.set(rig.radius * Math.sin(rig.theta), rig.height, rig.radius * Math.cos(rig.theta));
    camera.rotation.set(look.pitch, rig.theta + look.yaw, 0);
  }

  function goTo(role, instant) {
    const to = rigFor(role);
    const pitch = homePitch(to);
    if (instant) {
      rig = to; look.set(0, pitch); tween = null;
    } else {
      tween = {
        t0: performance.now(), dur: 900, from: { ...rig, yaw: look.yaw, pitch: look.pitch },
        to: { ...to, yaw: 0, pitch },
      };
    }
    invalidate();
  }

  function stepTween(now) {
    if (!tween) return false;
    const k = Math.min(1, (now - tween.t0) / tween.dur);
    const e = ease(k);
    const { from, to } = tween;
    rig = {
      theta: from.theta + angDiff(from.theta, to.theta) * e,
      radius: from.radius + (to.radius - from.radius) * e,
      height: from.height + (to.height - from.height) * e,
    };
    look.set(from.yaw + (to.yaw - from.yaw) * e, from.pitch + (to.pitch - from.pitch) * e);
    if (k >= 1) { rig = { ...to }; tween = null; return false; }
    return true;
  }

  // ------------------------------------------------------------ public state
  let phase = "lobby";
  let outcomeKind = null;
  let blinkOn = false;
  let blinkTimer = 0;

  function applyBeacons() {
    const m = pad.beacons.mat;
    if (phase === "hold") m.color.set(blinkOn ? P.beaconOn : P.beaconOff);
    else if (phase === "count") m.color.set(P.beaconOn);
    else if (phase === "done" && outcomeKind === "pad_abort") m.color.set(P.beaconAbort);
    else m.color.set(P.beaconOff);
  }

  function applyPhase() {
    rocket.flame.visible = phase === "ascent";
    rocket.group.visible = !(phase === "done" && (outcomeKind === "success" || WRECKED.has(outcomeKind)));
    clearInterval(blinkTimer);
    blinkTimer = 0;
    if (phase === "hold") {
      blinkOn = true;
      blinkTimer = setInterval(() => { blinkOn = !blinkOn; applyBeacons(); invalidate(); }, 450);
    }
    applyBeacons();
  }

  let lastKey = "";
  function update(state) {
    if (disposed || !state) return;
    const lobby = state.lobby || null;
    const mine = state.myRoles || [];
    const wanted = state.activeRole && mine.includes(state.activeRole) ? state.activeRole : mine[0] || null;
    const seats = (lobby && lobby.seats) || {};
    const ph = (lobby && lobby.phase) || "lobby";
    const oc = (lobby && lobby.outcome && lobby.outcome.kind) || null;
    const key = JSON.stringify([ph, oc, seats, wanted]);
    if (key === lastKey) return; // lobby messages repeat; nothing visible changed
    lastKey = key;
    if (ph !== phase || oc !== outcomeKind) { phase = ph; outcomeKind = oc; applyPhase(); }
    if (seatRole === undefined) { seatRole = wanted; goTo(wanted, true); }
    else if (wanted !== seatRole) { seatRole = wanted; goTo(wanted, false); }
    dbg.figures = stations.setSeats(seats, seatRole);
    invalidate();
  }

  // ------------------------------------------------- sizing and view offset
  const insets = { right: 0, bottom: 0 };
  let width = 0, height = 0, dpr = 1;
  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    dpr = Math.min(window.devicePixelRatio || 1, w < 700 ? 1.5 : 2);
    if (w === width && h === height && renderer.getPixelRatio() === dpr) { applyOffset(); return; }
    width = w; height = h;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.9 ? 74 : 68; // portrait phones need a taller field
    applyOffset();
    invalidate();
  }
  // The overlay covers part of the canvas; shift the projection so the view's
  // centre is the middle of what you can actually see.
  function applyOffset() {
    const ox = insets.right / 2, oy = insets.bottom / 2;
    if (ox === 0 && oy === 0) camera.clearViewOffset();
    else camera.setViewOffset(width, height, ox, oy, width, height);
    camera.updateProjectionMatrix();
  }
  function setInsets(right, bottom) {
    right = Math.max(0, Math.round(right || 0)); bottom = Math.max(0, Math.round(bottom || 0));
    if (right === insets.right && bottom === insets.bottom) return;
    insets.right = right; insets.bottom = bottom;
    applyOffset(); invalidate();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // -------------------------------------------------------------- the loop
  let disposed = false, raf = 0, lastT = 0, benching = 0;
  const frames = [];
  const dbg = {
    fps: 0, figures: 0, drawCalls: 0, triangles: 0, geometries: 0, frames: 0,
    phase, seat: null, sequenceId: opts.sequenceId, roles: roles.slice(),
    camera: { theta: 0, yaw: 0, pitch: 0, fov: 60 },
    bench(ms = 2000) {
      return new Promise((resolve) => {
        benching = performance.now() + ms; frames.length = 0; invalidate();
        setTimeout(() => resolve({ fps: dbg.fps, drawCalls: dbg.drawCalls, triangles: dbg.triangles }), ms + 100);
      });
    },
  };

  function invalidate() { if (!raf && !disposed && !document.hidden) raf = requestAnimationFrame(frame); }

  function frame(now) {
    raf = 0;
    if (disposed) return;
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016;
    lastT = now;
    const moving = look.step(dt) || stepTween(now);
    placeCamera();
    renderer.render(scene, camera);
    // Debug figures: fps only means something while frames are continuous.
    frames.push(now);
    while (frames.length > 40 || (frames.length > 2 && now - frames[0] > 2000)) frames.shift();
    if (frames.length > 3) dbg.fps = Math.round(((frames.length - 1) * 1000) / (now - frames[0]));
    const info = renderer.info;
    dbg.drawCalls = info.render.calls; dbg.triangles = info.render.triangles; dbg.geometries = info.memory.geometries;
    dbg.frames++; dbg.phase = phase; dbg.seat = seatRole;
    dbg.camera = { theta: +rig.theta.toFixed(3), yaw: +look.yaw.toFixed(3), pitch: +look.pitch.toFixed(3), fov: camera.fov };
    if (moving || now < benching) invalidate(); else lastT = 0;
  }

  const onVis = () => { if (!document.hidden) { lastT = 0; invalidate(); } else if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  const onLost = (e) => { e.preventDefault(); };
  const onRestored = () => invalidate();
  document.addEventListener("visibilitychange", onVis);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  window.__scene = dbg;
  resize();
  update(opts.initial || { lobby: null, myRoles: [], activeRole: null });
  if (seatRole === undefined) { seatRole = null; goTo(null, true); }
  invalidate();

  return {
    update,
    setInsets,
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(blinkTimer);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      look.dispose();
      rocket.dispose(); pad.dispose(); stations.dispose();
      sky.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      if (window.__scene === dbg) delete window.__scene;
    },
  };
}

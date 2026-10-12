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
import { buildEffects } from "./effects.js";

const SPECTATOR = { radius: 64, height: 20 };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

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
  const hemi = new THREE.HemisphereLight("#cfe0f5", "#6c6b58", 2.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#fff0d4", 2.6);
  sun.position.set(-60, 90, 40);
  scene.add(sun);

  const rocket = buildRocket(opts.sequenceId);
  const stations = buildStations(roles);
  // Lamp masts stand on the empty north side only: a mast between two stations
  // sits right on the sight line from one to the other and hides that figure.
  const mastThetas = roles.length >= 5 ? [Math.PI] : [Math.PI - 0.45, Math.PI, Math.PI + 0.45];
  const pad = buildPad({ rocketHeight: rocket.height, mastThetas });
  rocket.group.position.y = MOUNT_TOP;
  scene.add(pad.group, rocket.group, stations.group);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1800);
  camera.rotation.order = "YXZ";

  // The launch moment (P3): clock, atmosphere, liftoff, outcomes. Public state only.
  const reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const fx = buildEffects({
    scene, container, rocket, pad, stations, sequenceId: opts.sequenceId, ascentSec: opts.ascentSec, reduced,
    lights: { hemi, sun, hemi0: hemi.intensity, sun0: sun.intensity },
    invalidate: () => invalidate(),
  });
  let lastInput = -1e9; // last time the player dragged or pressed an arrow key

  // ------------------------------------------------------------- camera rig
  // The rig is polar around the pad: theta (angle on the ring), radius, height.
  // Seat changes tween along the ring so the camera never cuts through the pad.
  let rig = { theta: 0, radius: SPECTATOR.radius, height: SPECTATOR.height };
  let tween = null;
  let sentLook = null;
  let seatRole = undefined; // undefined = not placed yet; null = spectator

  const homePitch = (r) => Math.max(-0.2, Math.min(0.6, Math.atan2(rocket.height * (camera.aspect < 0.9 ? 0.62 : 0.48) - r.height, r.radius)));
  const rigFor = (role) => (role && stations.hasRole(role)
    ? { theta: stations.theta(role), radius: RING_RADIUS, height: EYE_HEIGHT }
    : { theta: 0, radius: SPECTATOR.radius, height: SPECTATOR.height });

  // Zoom narrows the field of view (68 or 74 degrees at 1x down to about 25) so a
  // figure across the ring can be made out. Drags get finer as you zoom, since
  // they are measured in field of view.
  const MAX_ZOOM = 2.8;
  let zoom = 1, baseFov = 68;
  const setZoom = (z) => {
    zoom = clamp(z, 1, MAX_ZOOM);
    camera.fov = baseFov / zoom;
    camera.updateProjectionMatrix();
    lastInput = performance.now();
    invalidate();
  };
  const recentre = () => { tween = null; look.stop(); look.set(0, homePitch(rig)); lastInput = -1e9; setZoom(1); };
  const look = createLook(container, {
    radPerPx: () => (camera.fov * Math.PI) / 180 / Math.max(300, container.clientHeight),
    onChange: () => { lastInput = performance.now(); invalidate(); },
    onZoom: (ratio) => setZoom(zoom * ratio),
    onReset: recentre,
  });

  function placeCamera() {
    camera.position.set(rig.radius * Math.sin(rig.theta), rig.height, rig.radius * Math.cos(rig.theta));
    camera.rotation.set(look.pitch, rig.theta + look.yaw, 0);
    const s = fx.out.shake;
    if (s > 0) { // launch shake, scaled by distance in effects.js; skipped under reduced motion
      const t = performance.now();
      camera.rotation.x += s * Math.sin(t * 0.093);
      camera.rotation.y += s * Math.sin(t * 0.071 + 1.3);
      camera.rotation.z += s * 0.6 * Math.sin(t * 0.117 + 2.1);
      camera.position.y += s * 14 * Math.sin(t * 0.083);
    }
  }

  function goTo(role, instant) {
    sentLook = null; // a new seat: say where I am looking from it
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
    clearInterval(blinkTimer);
    blinkTimer = 0;
    if (phase === "hold") {
      blinkOn = true;
      blinkTimer = setInterval(() => { blinkOn = !blinkOn; applyBeacons(); invalidate(); }, 450);
    }
    applyBeacons();
  }

  let lastKey = "";
  let previewing = false;
  // Debug and test hook: show a synthetic PUBLIC state locally ({phase, tMs, outcome, since}).
  // It changes only this browser's visuals and sends nothing; preview(null) returns to the live state.
  function preview(p) {
    if (disposed) return;
    if (!p) { previewing = false; lastKey = ""; return; }
    previewing = true;
    const now = performance.now();
    phase = p.phase; outcomeKind = (p.outcome && p.outcome.kind) || null;
    applyPhase();
    fx.setState(p.phase, p.tMs || 0, now, p.outcome || null, now, { force: true, live: true, since: p.since });
    invalidate();
  }
  function update(state) {
    if (disposed || !state || previewing) return;
    const lobby = state.lobby || null;
    const mine = state.myRoles || [];
    const wanted = state.activeRole && mine.includes(state.activeRole) ? state.activeRole : mine[0] || null;
    const seats = (lobby && lobby.seats) || {};
    const ph = (lobby && lobby.phase) || "lobby";
    const oc = (lobby && lobby.outcome && lobby.outcome.kind) || null;
    const present = (lobby && lobby.present) || null;
    if (!previewing) {
      // The clock from console.js (already extrapolated there) is public; use it only while it is the same phase.
      const same = state.clockPhase === ph && Number.isFinite(state.clockMs);
      fx.setState(ph, same ? state.clockMs : (lobby ? lobby.tMs : 0), same ? state.clockAt : performance.now(), (lobby && lobby.outcome) || null, performance.now());
    }
    const key = JSON.stringify([ph, oc, seats, wanted, present]);
    if (key === lastKey) return; // lobby messages repeat; nothing visible changed
    lastKey = key;
    if (ph !== phase || oc !== outcomeKind) { phase = ph; outcomeKind = oc; applyPhase(); }
    if (seatRole === undefined) { seatRole = wanted; goTo(wanted, true); }
    else if (wanted !== seatRole) { seatRole = wanted; goTo(wanted, false); }
    dbg.figures = stations.setSeats(seats, seatRole, present);
    fx.boardBeside(seatRole && stations.hasRole(seatRole) ? Math.sin(stations.theta(seatRole)) : 0); // pad board: on your side of the tower
    invalidate();
  }

  // Other players' public gestures and head directions (mc:gesture, mc:look).
  // A gesture on my own seat is ignored: that figure is not drawn.
  function gesture(role, kind) {
    if (disposed || role === seatRole) return;
    stations.gesture(role, kind);
    invalidate();
  }
  // Idle fidgets: during the count every other figure taps its desk now and
  // then. A fix step can only be pressed while its fault is active, so without
  // this noise a "press" from a seat with nothing else to do would give the
  // fault away. Random and local to each viewer, so it carries no information.
  const fidgetTimer = setInterval(() => {
    if (disposed || document.hidden || (phase !== "count" && phase !== "hold")) return;
    let any = false;
    for (const role of roles) if (role !== seatRole && Math.random() < 0.12) { stations.gesture(role, "press"); any = true; }
    if (any) invalidate();
  }, 1000);
  function looks(heads) {
    if (disposed) return;
    stations.look(heads);
    invalidate();
  }
  // My own head direction goes out as mc:mylook (console.js throttles and posts it).
  // yaw is relative to facing the pad, positive turning left; pitch positive looks up.
  function emitMyLook() {
    if (!seatRole) return;
    const y = look.yaw, p = look.pitch;
    if (sentLook && Math.abs(y - sentLook[0]) < 0.004 && Math.abs(p - sentLook[1]) < 0.004) return;
    sentLook = [y, p];
    window.dispatchEvent(new CustomEvent("mc:mylook", { detail: { yaw: y, pitch: p } }));
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
    baseFov = w / h < 0.9 ? 74 : 68; // portrait phones need a taller field
    camera.fov = baseFov / zoom;
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
    figureState: () => stations.debug(),
    preview: (p) => preview(p),
    fx: () => fx.debug(),
    arc: (p) => fx.pathAt(p),
    gesture: (role, kind) => gesture(role, kind),
    camera: { theta: 0, yaw: 0, pitch: 0, fov: 60 },
    zoomBy: (r) => setZoom(zoom * r),
    recentre: () => recentre(),
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
    let moving = look.step(dt) || stepTween(now);
    // After a quiet 3 s the camera tilts up to follow the climb; any drag or key takes it back.
    if (fx.out.following && !tween && !look.dragging && now - lastInput > 3000) {
      const cx = rig.radius * Math.sin(rig.theta), cz = rig.radius * Math.cos(rig.theta);
      const f = fx.out.focus, want = Math.atan2(f.y - rig.height, Math.hypot(f.x - cx, f.z - cz));
      look.pitch += (clamp(want, -0.2, 1.3) - look.pitch) * (1 - Math.exp(-dt * 2.5));
      moving = true;
    }
    placeCamera();
    emitMyLook();
    const animating = fx.tick(dt, now, camera) | stations.tick(dt, now, camera);
    renderer.render(scene, camera);
    // Debug figures: fps only means something while frames are continuous.
    frames.push(now);
    while (frames.length > 40 || (frames.length > 2 && now - frames[0] > 2000)) frames.shift();
    if (frames.length > 3) dbg.fps = Math.round(((frames.length - 1) * 1000) / (now - frames[0]));
    const info = renderer.info;
    dbg.drawCalls = info.render.calls; dbg.triangles = info.render.triangles; dbg.geometries = info.memory.geometries;
    dbg.frames++; dbg.phase = phase; dbg.seat = seatRole;
    dbg.camera = { theta: +rig.theta.toFixed(3), yaw: +look.yaw.toFixed(3), pitch: +look.pitch.toFixed(3), fov: camera.fov };
    if (moving || animating || now < benching) invalidate(); else lastT = 0;
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
    gesture,
    looks,
    setInsets,
    zoomBy: (ratio) => setZoom(zoom * ratio),
    recentre,
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(blinkTimer);
      clearInterval(fidgetTimer);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      look.dispose();
      fx.dispose();
      rocket.dispose(); pad.dispose(); stations.dispose();
      sky.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      if (window.__scene === dbg) delete window.__scene;
    },
  };
}

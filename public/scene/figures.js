// A crew figure: low-poly, jointed just enough to turn its head and gesture.
// Built from a few merged primitive meshes parented on joints (hips, neck, two
// shoulders, two elbows), so five figures cost about 35 draw calls.
//
// Frame of a figure (set by the station that parents it): the figure sits at the
// origin facing -z (towards the pad), x to its right, y up.
//
// HEAD CONVENTION (defined once, here). The wire carries, per seat, [yaw, pitch]
// in radians, taken from that player's camera:
//   yaw   = the camera's heading relative to "facing the pad", positive turning
//           LEFT (counter-clockwise seen from above, the same sense as three.js
//           rotation.y). 0 = looking at the pad centre. Wrapped to (-pi, pi].
//           World yaw of the camera = the seat's ring angle + yaw.
//   pitch = positive looks UP, 0 is the horizon, clamped to [-1.2, 1.2].
// Because it is relative to the seat, every viewer applies it in the figure's
// own frame, so `neck.rotation.y = yaw` and `neck.rotation.x = pitch` (Euler
// order YXZ) with no knowledge of the ring layout. The neck stops at +-1.3 rad
// of yaw, since a head does not turn all the way round on a seated body.
//
// A figure only ever receives PUBLIC information: present or not, a coarse
// gesture kind, a head direction. Nothing here can show a console's state.
import * as THREE from "three";
import { Batch } from "./builder.js";
import { PALETTE as P, ROLE_COLORS } from "./palette.js";

// Figures are drawn bigger than life so they read across the ring (25 units).
export const FIGURE_SCALE = 2.0;
export const FIGURE_LIFT = 0.12;
export const FIGURE_BACK = 0.25; // slid back from the desk so the boots clear it
const HIP = { y: 0.56, z: 0.1 };
const STAND = 0.46; // how far the hips rise when the figure stands
const NECK_YAW_MAX = 1.3;
const SMOOTH = 11; // 1/s: how fast the pose chases its target

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (t) => t * t * (3 - 2 * t);

const suit = (color) => new THREE.Color(color).lerp(new THREE.Color("#2a3140"), 0.4).getStyle();

// ------------------------------------------------------------------ poses
// Arms: x swings forward (0 hangs down, pi/2 forward, pi straight up), z swings
// outward (positive), e bends the elbow forward by the same sense as x.
const rest = () => ({
  lean: 0, stand: 0, nod: 0, absent: 0,
  r: [0.95, 0.08, 0.55], l: [0.95, 0.08, 0.55],
});
const POSE_KEYS = ["lean", "stand", "nod", "absent"];

const keep = (o) => ({ ...rest(), ...o });
/** Gestures: keyframes of a partial pose, eased between, 0.5 to 1.5 s long. */
export const GESTURES = {
  press: { dur: 0.8, keys: [ // lean in and tap the desk twice
    [0, {}],
    [0.2, { lean: -0.5, r: [1.75, 0.05, 0.25] }],
    [0.35, { lean: -0.58, r: [1.3, 0.05, 0.1] }],
    [0.5, { lean: -0.5, r: [1.8, 0.05, 0.25] }],
    [0.62, { lean: -0.58, r: [1.3, 0.05, 0.1] }],
    [0.8, {}],
  ] },
  call_poll: { dur: 1.5, keys: [ // stand and raise an arm
    [0, {}],
    [0.35, { stand: 1, r: [1.9, 0.2, 0.3] }],
    [0.55, { stand: 1, r: [3.0, 0.25, 0.1] }],
    [1.15, { stand: 1, r: [3.0, 0.25, 0.1] }],
    [1.5, {}],
  ] },
  report_go: { dur: 1.2, keys: [ // arm up, fist, thumb
    [0, {}],
    [0.3, { r: [1.7, 0.3, 1.5], lean: -0.05 }],
    [0.95, { r: [1.7, 0.3, 1.5], lean: -0.05 }],
    [1.2, {}],
  ] },
  report_nogo: { dur: 1.2, keys: [ // both forearms crossed in front of the chest
    [0, {}],
    [0.3, { r: [1.9, -0.5, 1.45], l: [1.9, -0.5, 1.45], lean: 0.05 }],
    [0.95, { r: [1.9, -0.5, 1.45], l: [1.9, -0.5, 1.45], lean: 0.05 }],
    [1.2, {}],
  ] },
  hold: { dur: 1.3, keys: [ // both hands up, palms out
    [0, {}],
    [0.35, { r: [2.9, 0.3, 0.1], l: [2.9, 0.3, 0.1] }],
    [1.0, { r: [2.9, 0.3, 0.1], l: [2.9, 0.3, 0.1] }],
    [1.3, {}],
  ] },
  resume: { dur: 1.2, keys: [ // sit back and nod twice
    [0, { lean: 0.12 }],
    [0.2, { lean: 0.14 }],
    [0.4, { lean: 0.1, nod: -0.32 }],
    [0.6, { lean: 0.1, nod: 0.05 }],
    [0.8, { lean: 0.05, nod: -0.32 }],
    [1.2, {}],
  ] },
  scrub: { dur: 1.5, keys: [ // slump
    [0, {}],
    [0.5, { lean: -0.62, nod: -0.55, r: [0.2, 0.1, 0.1], l: [0.2, 0.1, 0.1] }],
    [1.2, { lean: -0.62, nod: -0.55, r: [0.2, 0.1, 0.1], l: [0.2, 0.1, 0.1] }],
    [1.5, { lean: -0.2, nod: -0.2 }],
  ] },
  start: { dur: 1.2, keys: [ // stand, fist pump
    [0, {}],
    [0.25, { stand: 1, r: [2.6, 0.2, 0.9] }],
    [0.45, { stand: 1, r: [3.0, 0.2, 0.2] }],
    [0.65, { stand: 1, r: [2.4, 0.2, 0.9] }],
    [0.85, { stand: 1, r: [3.0, 0.2, 0.2] }],
    [1.2, {}],
  ] },
  terminate: { dur: 1.0, keys: [ // raise the fist, slam it down
    [0, {}],
    [0.35, { lean: 0.1, r: [3.0, 0.15, 0.2] }],
    [0.5, { lean: -0.45, r: [1.35, 0.1, 0.05] }],
    [0.6, { lean: -0.4, r: [1.4, 0.1, 0.05] }],
    [1.0, {}],
  ] },
  // Reactions to the launch moment (driven by public outcome state, not the wire).
  // `look` overrides the head target while the gesture runs: [yaw, pitch].
  watch: { dur: 5, look: [0, 1.0], keys: [ // stand and look up at the rocket
    [0, {}],
    [0.6, { stand: 1, r: [0.3, 0.1, 0.25], l: [0.3, 0.1, 0.25] }],
    [4.4, { stand: 1, r: [0.3, 0.1, 0.25], l: [0.3, 0.1, 0.25] }],
    [5, {}],
  ] },
  flinch: { dur: 2.6, look: [0, -0.3], keys: [ // duck and cover
    [0, {}],
    [0.15, { lean: -0.6, nod: -0.4, r: [2.3, -0.3, 1.9], l: [2.3, -0.3, 1.9] }],
    [2.0, { lean: -0.6, nod: -0.4, r: [2.3, -0.3, 1.9], l: [2.3, -0.3, 1.9] }],
    [2.6, {}],
  ] },
  cheer: { dur: 4, look: [0, 0.9], keys: [ // stand, both arms up, bounce
    [0, {}],
    [0.4, { stand: 1, r: [3.0, 0.5, 0.1], l: [3.0, 0.5, 0.1] }],
    [0.9, { stand: 1, r: [2.7, 0.9, 0.1], l: [3.1, 0.2, 0.1] }],
    [1.4, { stand: 1, r: [3.1, 0.2, 0.1], l: [2.7, 0.9, 0.1] }],
    [1.9, { stand: 1, r: [2.7, 0.9, 0.1], l: [3.1, 0.2, 0.1] }],
    [3.5, { stand: 1, r: [3.0, 0.5, 0.1], l: [3.0, 0.5, 0.1] }],
    [4, {}],
  ] },
};
const keyed = (g) => g.keys.map(([t, p]) => [t, keep(p)]);
for (const g of Object.values(GESTURES)) g.frames = keyed(g);

const lerp = (a, b, k) => a + (b - a) * k;
function evalGesture(g, t) {
  const f = g.frames;
  if (t >= g.dur) return f[f.length - 1][1];
  let i = 0;
  while (i < f.length - 2 && t > f[i + 1][0]) i++;
  const [t0, a] = f[i], [t1, b] = f[i + 1];
  const k = smooth(clamp((t - t0) / (t1 - t0 || 1), 0, 1));
  const out = { r: [0, 0, 0], l: [0, 0, 0] };
  for (const key of POSE_KEYS) out[key] = lerp(a[key], b[key], k);
  for (const arm of ["r", "l"]) for (let j = 0; j < 3; j++) out[arm][j] = lerp(a[arm][j], b[arm][j], k);
  return out;
}

// ------------------------------------------------------------- geometry
function parts(role) {
  const color = ROLE_COLORS[role] || "#888888";
  const c = suit(color);
  const mk = (fn) => { const b = new Batch(); fn(b); const geo = b.geometry(); return { geo, tri: b.triangles }; };
  const legs = mk((b) => {
    for (const s of [-1, 1]) {
      b.box(0.21, 0.18, 0.54, { x: s * 0.15, y: 0.56, z: -0.12 }, c); // thigh
      b.box(0.18, 0.5, 0.18, { x: s * 0.15, y: 0.3, z: -0.4 }, c); // shin
      b.box(0.21, 0.1, 0.32, { x: s * 0.15, y: 0.05, z: -0.48 }, P.rocketBlack); // boot
    }
  });
  const legsStand = mk((b) => {
    for (const s of [-1, 1]) {
      b.box(0.21, 0.96, 0.21, { x: s * 0.15, y: 0.54, z: HIP.z }, c);
      b.box(0.21, 0.1, 0.32, { x: s * 0.15, y: 0.05, z: HIP.z - 0.06 }, P.rocketBlack);
    }
  });
  const torso = mk((b) => {
    b.box(0.5, 0.66, 0.32, { y: 0.36 }, c);
    b.box(0.52, 0.13, 0.34, { y: 0.5 }, color); // role-colour chest band
    b.box(0.5, 0.18, 0.32, { y: 0.03 }, c); // pelvis
  });
  const head = mk((b) => {
    b.ico(0.25, 1, { y: 0.14 }, P.skin); // helmet
    b.box(0.3, 0.11, 0.1, { y: 0.15, z: -0.2 }, P.screen); // visor
    b.box(0.1, 0.05, 0.34, { y: 0.38 }, color); // role-colour crest
  });
  const upper = mk((b) => {
    b.box(0.15, 0.38, 0.15, { y: -0.19 }, c);
    b.box(0.19, 0.08, 0.19, { y: 0.0 }, color); // shoulder pad
  });
  const fore = mk((b) => {
    b.box(0.13, 0.34, 0.13, { y: -0.17 }, c);
    b.box(0.17, 0.14, 0.17, { y: -0.4 }, P.skin); // fist
    b.box(0.06, 0.09, 0.06, { x: 0, y: -0.51, z: -0.02 }, P.skin); // thumb, up when the forearm is raised
  });
  return { legs, legsStand, torso, head, upper, fore };
}

// ---------------------------------------------------------------- label
const LABEL_W = 512, LABEL_H = 128;
function labelCanvas() {
  const c = document.createElement("canvas");
  c.width = LABEL_W; c.height = LABEL_H;
  return c;
}
function drawLabel(canvas, text, color, away) {
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, LABEL_W, LABEL_H);
  let size = 60;
  g.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  while (g.measureText(text).width > LABEL_W - 56 && size > 24) { size -= 4; g.font = `700 ${size}px system-ui, sans-serif`; }
  const w = Math.min(LABEL_W - 8, g.measureText(text).width + 44);
  const x = (LABEL_W - w) / 2;
  g.fillStyle = "rgba(14,20,30,0.72)";
  g.beginPath();
  if (g.roundRect) g.roundRect(x, 8, w, away ? 108 : 82, 16);
  else g.rect(x, 8, w, away ? 108 : 82); // older Safari/Chrome lack roundRect; a square plate beats a dead scene
  g.fill();
  g.fillStyle = "#f2f5f9";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, LABEL_W / 2, 44);
  g.fillStyle = color;
  g.fillRect(x + 16, 72, w - 32, 7); // role-colour underline
  if (away) {
    g.fillStyle = "#c8d0da";
    g.font = "italic 600 26px system-ui, sans-serif";
    g.fillText("away", LABEL_W / 2, 98);
  }
}

// --------------------------------------------------------------- figure
/** `frame` is the station's matrix. Returns the figure; see the methods at the bottom. */
export function buildFigure(role, frame) {
  const color = ROLE_COLORS[role] || "#888888";
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const g = parts(role);
  const mesh = (p) => { const m = new THREE.Mesh(p.geo, mat); m.frustumCulled = false; return m; };
  let triangles = 0;
  for (const p of Object.values(g)) triangles += p.tri;

  const root = new THREE.Group();
  const body = new THREE.Group(); // scaled and lifted: everything but the label
  body.scale.setScalar(FIGURE_SCALE);
  body.position.set(0, FIGURE_LIFT, FIGURE_BACK);
  root.add(body);
  const legs = mesh(g.legs), legsStand = mesh(g.legsStand);
  legsStand.visible = false;
  const hips = new THREE.Group();
  hips.position.set(0, HIP.y, HIP.z);
  const torso = mesh(g.torso);
  const neck = new THREE.Group();
  neck.position.set(0, 0.72, -0.04);
  neck.rotation.order = "YXZ";
  neck.add(mesh(g.head));
  hips.add(torso, neck);
  const arms = {};
  for (const [key, side] of [["r", 1], ["l", -1]]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.34, 0.6, 0);
    const elbow = new THREE.Group();
    elbow.position.y = -0.38;
    elbow.add(mesh(g.fore));
    shoulder.add(mesh(g.upper), elbow);
    hips.add(shoulder);
    arms[key] = { shoulder, elbow, side };
  }
  body.add(legs, legsStand, hips);

  // The callsign label: always faces the camera, role-colour underline.
  const canvas = labelCanvas();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.renderOrder = 10;
  root.add(sprite);
  root.applyMatrix4(frame);

  const st = {
    callsign: "", present: true, labelKey: "",
    cur: rest(), target: rest(),
    gesture: null, gestureKind: null, t0: 0,
    head: null, // [yaw, pitch] last received, or null: idle, glancing at the rocket
    yaw: 0, pitch: 0.18,
    animating: false,
  };
  const worldPos = new THREE.Vector3();

  function setLabel() {
    const key = `${st.callsign}|${st.present}`;
    if (key === st.labelKey) return;
    st.labelKey = key;
    drawLabel(canvas, st.callsign, color, !st.present);
    tex.needsUpdate = true;
  }

  function applyPose() {
    const p = st.cur;
    const standing = p.stand > 0.3;
    legs.visible = !standing;
    legsStand.visible = standing;
    hips.position.y = HIP.y + STAND * p.stand;
    hips.rotation.x = p.lean;
    const hy = clamp(st.yaw, -NECK_YAW_MAX, NECK_YAW_MAX);
    neck.rotation.set(clamp(st.pitch + p.nod - p.lean * 0.6, -1.3, 1.3), hy, 0);
    for (const key of ["r", "l"]) {
      const a = arms[key], [x, z, e] = p[key];
      a.shoulder.rotation.set(x, 0, z * a.side);
      a.elbow.rotation.set(e, 0, 0);
    }
    const o = 1 - 0.68 * p.absent;
    mat.opacity = o;
    mat.transparent = o < 0.99;
    mat.depthWrite = o > 0.9;
    spriteMat.opacity = 1 - 0.3 * p.absent;
    headTop = (HIP.y + 0.72 + 0.4) * FIGURE_SCALE + FIGURE_LIFT + STAND * p.stand * FIGURE_SCALE - Math.max(0, -p.lean) * 0.35;
  }
  let headTop = 2.3;

  return {
    group: root,
    triangles,
    get present() { return st.present; },
    setCallsign(name) { if (name !== st.callsign) { st.callsign = name; setLabel(); } },
    setPresent(v) { v = !!v; if (v !== st.present) { st.present = v; setLabel(); } },
    setHead(yaw, pitch) { st.head = [yaw, pitch]; },
    gesture(kind, now = performance.now()) {
      if (!GESTURES[kind]) return;
      st.gesture = GESTURES[kind]; st.gestureKind = kind; st.t0 = now;
    },
    /** Advance to `now` (ms) / `dt` (s). True while anything is still moving. */
    tick(dt, now, camera) {
      // target
      let tgt;
      if (!st.present) {
        tgt = keep({ lean: -0.55, nod: -0.5, absent: 1, r: [0.15, 0.1, 0.1], l: [0.15, 0.1, 0.1] });
      } else if (st.gesture) {
        const t = Math.max(0, (now - st.t0) / 1000);
        tgt = evalGesture(st.gesture, t);
        if (t >= st.gesture.dur) { st.gesture = null; st.gestureKind = null; }
      } else tgt = rest();
      const k = 1 - Math.exp(-dt * SMOOTH);
      let moving = st.gesture !== null;
      const c = st.cur;
      for (const key of POSE_KEYS) { const d = tgt[key] - c[key]; c[key] += d * k; if (Math.abs(d) > 0.004) moving = true; }
      for (const arm of ["r", "l"]) for (let j = 0; j < 3; j++) { const d = tgt[arm][j] - c[arm][j]; c[arm][j] += d * k; if (Math.abs(d) > 0.004) moving = true; }
      // head: toward what was received (or a glance at the rocket), smoothed
      const lk = st.gesture && st.gesture.look;
      const [hy, hp] = lk || st.head || [0, 0.18];
      const kh = 1 - Math.exp(-dt * 9);
      const dy = Math.atan2(Math.sin(hy - st.yaw), Math.cos(hy - st.yaw)), dp = hp - st.pitch;
      st.yaw += dy * kh; st.pitch += dp * kh;
      if (Math.abs(dy) > 0.004 || Math.abs(dp) > 0.004) moving = true;
      applyPose();
      st.animating = moving;
      // label size: mostly constant on screen, growing a little with distance
      if (camera) {
        sprite.getWorldPosition(worldPos);
        const d = worldPos.distanceTo(camera.position);
        const h = 0.3 + 0.042 * d;
        sprite.scale.set(h * (LABEL_W / LABEL_H), h, 1);
        sprite.position.set(0, headTop + 0.22 * h + 0.06, 0.06); // the plate sits in the upper part of the canvas
      }
      return moving;
    },
    debug() {
      return {
        present: st.present, callsign: st.callsign, gesture: st.gestureKind,
        head: st.head, yaw: +st.yaw.toFixed(3), pitch: +st.pitch.toFixed(3),
        lean: +st.cur.lean.toFixed(3), stand: +st.cur.stand.toFixed(3), absent: +st.cur.absent.toFixed(3),
        opacity: +mat.opacity.toFixed(3), rArm: st.cur.r.map((x) => +x.toFixed(2)),
      };
    },
    dispose() {
      for (const p of Object.values(g)) p.geo.dispose();
      mat.dispose(); spriteMat.dispose(); tex.dispose();
    },
  };
}

// The ring of control stations. One per role in the sequence, evenly spaced on
// a circle around the pad, each facing the rocket. A station is a low desk with
// a dark screen and a role-colour stripe, a chair, and a flag post. Another
// seat's screen is a silhouette on purpose: no lamps, no values.
//
// Local frame of a station: the player sits at the origin facing -z (towards the
// pad), x to their right, y up. The group is rotated by `theta` about y so that
// local -z points at the pad centre.
import * as THREE from "three";
import { Batch, litMaterial } from "./builder.js";
import { PALETTE as P, ROLE_COLORS } from "./palette.js";

export const RING_RADIUS = 25;
export const EYE_HEIGHT = 1.3;

/** Angle (radians from +z, towards +x) of each station. */
export function stationAngles(n) {
  const spacing = Math.min((75 * Math.PI) / 180, (2 * Math.PI) / Math.max(n, 1));
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * spacing);
}

const frame = (theta) => new THREE.Matrix4().makeRotationY(theta).setPosition(RING_RADIUS * Math.sin(theta), 0, RING_RADIUS * Math.cos(theta));

function suit(color) {
  return new THREE.Color(color).lerp(new THREE.Color("#2a3140"), 0.45).getStyle();
}

function figureGeometry(role) {
  const b = new Batch();
  const c = suit(ROLE_COLORS[role] || "#888888");
  for (const s of [-1, 1]) {
    b.box(0.2, 0.17, 0.52, { x: s * 0.15, y: 0.56, z: -0.12 }, c); // thigh
    b.box(0.17, 0.5, 0.17, { x: s * 0.15, y: 0.3, z: -0.4 }, c); // shin
    b.box(0.2, 0.09, 0.3, { x: s * 0.15, y: 0.05, z: -0.48 }, P.rocketBlack); // boot
    b.box(0.12, 0.12, 0.5, { x: s * 0.31, y: 0.98, z: -0.28, rx: -0.6 }, c); // arm to the desk
  }
  b.box(0.5, 0.62, 0.3, { y: 0.9, z: 0.1 }, c); // torso
  b.box(0.52, 0.12, 0.32, { y: 1.03, z: 0.1 }, ROLE_COLORS[role] || "#888888"); // role-colour chest band
  b.ico(0.19, 1, { y: 1.38, z: 0.06 }, P.skin); // helmet
  b.box(0.22, 0.09, 0.08, { y: 1.38, z: -0.1 }, P.screen); // visor
  const g = b.geometry();
  return { geo: g, triangles: b.triangles };
}

/**
 * Builds the ring. Returns { group, angles, seatPose(role), setSeats(occupied, hideRole), dispose }.
 * `occupied` maps role -> callsign|null (public lobby data); a figure is drawn only for a held seat.
 */
export function buildStations(roles) {
  const angles = stationAngles(roles.length);
  const b = new Batch();
  const mat = litMaterial();
  const group = new THREE.Group();
  const figures = {};
  const disposables = [];
  let triangles = 0;

  // The ring road the stations sit on.
  b.setBase(new THREE.Matrix4());
  b.ring(RING_RADIUS - 3.6, RING_RADIUS + 3.6, 64, { rx: -Math.PI / 2, y: 0.05 }, P.concreteDark);

  roles.forEach((role, i) => {
    const color = ROLE_COLORS[role] || "#888888";
    b.setBase(frame(angles[i]));
    b.cyl(2.8, 2.8, 0.1, 20, { y: 0.08, z: -0.9 }, P.concrete); // paving
    // desk and screen: low and wide, so the pad stays in view over them
    b.box(2.8, 0.5, 1.0, { y: 0.25, z: -1.5 }, P.steelDark);
    b.box(2.9, 0.06, 1.1, { y: 0.53, z: -1.5 }, P.steel);
    b.box(2.8, 0.14, 0.04, { y: 0.38, z: -0.98 }, color); // role stripe
    b.box(2.5, 0.72, 0.07, { y: 0.78, z: -1.9, rx: -0.85 }, P.bezel);
    b.box(2.25, 0.54, 0.05, { y: 0.8, z: -1.86, rx: -0.85 }, P.screen);
    // chair
    b.cyl(0.33, 0.33, 0.05, 8, { y: 0.06 }, P.steelDark);
    b.cyl(0.05, 0.05, 0.4, 6, { y: 0.25 }, P.steelDark);
    b.box(0.58, 0.09, 0.55, { y: 0.46, z: 0.02 }, P.bezel);
    b.box(0.58, 0.7, 0.08, { y: 0.84, z: 0.3 }, P.bezel);
    // flag post to the side, tall enough to be seen from across the ring
    b.cyl(0.05, 0.06, 3.4, 6, { x: 2.6, y: 1.7, z: -2.4 }, P.steelDark);
    b.box(0.95, 0.55, 0.05, { x: 3.1, y: 3.0, z: -2.4 }, color);
  });
  const geo = b.geometry();
  triangles += b.triangles;
  const staticMesh = new THREE.Mesh(geo, mat);
  staticMesh.frustumCulled = false;
  group.add(staticMesh);

  // Seated figures: one small mesh per seat, shown only when someone holds it.
  roles.forEach((role, i) => {
    const { geo: fg, triangles: t } = figureGeometry(role);
    triangles += t;
    const mesh = new THREE.Mesh(fg, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.applyMatrix4(frame(angles[i]));
    group.add(mesh);
    figures[role] = mesh;
    disposables.push(fg);
  });

  return {
    group,
    angles,
    triangles,
    figureCount: roles.length,
    theta: (role) => angles[roles.indexOf(role)],
    hasRole: (role) => roles.includes(role),
    setSeats(occupied, hideRole) {
      let shown = 0;
      for (const role of roles) { const v = !!occupied[role] && role !== hideRole; figures[role].visible = v; if (v) shown++; }
      return shown;
    },
    dispose() { geo.dispose(); mat.dispose(); for (const g of disposables) g.dispose(); },
  };
}

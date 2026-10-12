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
import { buildFigure, FIGURE_BACK, FIGURE_LIFT, FIGURE_SCALE } from "./figures.js";

export const RING_RADIUS = 25;
export const EYE_HEIGHT = 1.3;

/** Angle (radians from +z, towards +x) of each station. */
export function stationAngles(n) {
  const spacing = Math.min((75 * Math.PI) / 180, (2 * Math.PI) / Math.max(n, 1));
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * spacing);
}

const frame = (theta) => new THREE.Matrix4().makeRotationY(theta).setPosition(RING_RADIUS * Math.sin(theta), 0, RING_RADIUS * Math.cos(theta));

/**
 * Builds the ring. Returns { group, angles, setSeats(occupied, hideRole, present), gesture, look, tick, dispose }.
 * `occupied` maps role -> callsign|null and `present` role -> boolean (public lobby data); a figure is
 * drawn only for a held seat, upright when its holder is connected and slumped and faint when not.
 */
export function buildStations(roles) {
  const angles = stationAngles(roles.length);
  const b = new Batch();
  const mat = litMaterial();
  const group = new THREE.Group();
  const figures = {};
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
    // chair, sized to the figure: the seat top meets the underside of its thighs
    const seatTop = 0.47 * FIGURE_SCALE + FIGURE_LIFT, backZ = 0.26 * FIGURE_SCALE + FIGURE_BACK + 0.12;
    b.cyl(0.4, 0.4, 0.05, 8, { y: 0.06 }, P.steelDark);
    b.cyl(0.06, 0.06, seatTop, 6, { y: seatTop / 2 }, P.steelDark);
    b.box(0.46 * FIGURE_SCALE, 0.1, 0.5 * FIGURE_SCALE, { y: seatTop - 0.05, z: FIGURE_BACK - 0.02 }, P.bezel);
    b.box(0.46 * FIGURE_SCALE, 0.7 * FIGURE_SCALE, 0.09, { y: seatTop + 0.35 * FIGURE_SCALE, z: backZ }, P.bezel);
    // flag post to the side, tall enough to be seen from across the ring
    b.cyl(0.05, 0.06, 3.4, 6, { x: 2.6, y: 1.7, z: -2.4 }, P.steelDark);
    b.box(0.95, 0.55, 0.05, { x: 3.1, y: 3.0, z: -2.4 }, color);
  });
  const geo = b.geometry();
  triangles += b.triangles;
  const staticMesh = new THREE.Mesh(geo, mat);
  staticMesh.frustumCulled = false;
  group.add(staticMesh);

  // Crew figures: one per seat, shown only when someone holds it.
  roles.forEach((role, i) => {
    const f = buildFigure(role, frame(angles[i]));
    triangles += f.triangles;
    f.group.visible = false;
    group.add(f.group);
    figures[role] = f;
  });

  return {
    group,
    angles,
    triangles,
    figureCount: roles.length,
    theta: (role) => angles[roles.indexOf(role)],
    hasRole: (role) => roles.includes(role),
    setSeats(occupied, hideRole, present) {
      let shown = 0;
      for (const role of roles) {
        const f = figures[role], name = occupied[role];
        const v = !!name && role !== hideRole;
        f.group.visible = v;
        if (name) f.setCallsign(name);
        f.setPresent(!present || present[role] !== false); // no presence data: assume here
        if (v) shown++;
      }
      return shown;
    },
    gesture(role, kind) { if (figures[role] && figures[role].group.visible) figures[role].gesture(kind); },
    look(heads) { for (const [role, h] of Object.entries(heads || {})) if (figures[role] && Array.isArray(h)) figures[role].setHead(h[0], h[1]); },
    /** Advance every visible figure; true while any is still moving. */
    tick(dt, now, camera) {
      let moving = false;
      for (const role of roles) if (figures[role].group.visible && figures[role].tick(dt, now, camera)) moving = true;
      return moving;
    },
    debug() {
      const out = {};
      for (const role of roles) out[role] = { visible: figures[role].group.visible, ...figures[role].debug() };
      return out;
    },
    dispose() { geo.dispose(); mat.dispose(); for (const f of Object.values(figures)) f.dispose(); },
  };
}

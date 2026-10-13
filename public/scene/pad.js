// The open pad: ground and hills, the concrete apron, launch mount, flame
// trench, service tower with its beacons, tanks, fence and lamp masts. All of
// it merges into one static mesh; only the beacons are separate so they can
// blink. Nothing here depends on game state except the tower's height.
import * as THREE from "three";
import { Batch, litMaterial } from "./builder.js";
import { PALETTE as P } from "./palette.js";

export const MOUNT_TOP = 2.2;
export const FENCE_RADIUS = 56;

/** A small deterministic generator so every client builds the same hills. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function buildPad({ rocketHeight, mastThetas = [0.9, 2.3, 4.1, 5.3] }) {
  const b = new Batch();
  const rand = rng(7);
  const towerH = Math.round(rocketHeight * 0.85);

  // Ground and distant hills (fog turns them blue-grey).
  b.cyl(520, 520, 0.4, 48, { y: -0.2 }, P.ground);
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + rand() * 0.2;
    const d = 190 + rand() * 150;
    const h = 22 + rand() * 48;
    const r = 40 + rand() * 50;
    b.cone(r, h, 6 + Math.floor(rand() * 3), { x: Math.cos(a) * d, y: h / 2 - 0.2, z: Math.sin(a) * d, ry: rand() * 3 }, rand() > 0.5 ? P.groundDark : "#707a62");
  }
  // Scrub: a few dark low cones scattered outside the fence.
  for (let i = 0; i < 40; i++) {
    const a = rand() * Math.PI * 2;
    const d = 70 + rand() * 90;
    const h = 1.6 + rand() * 2.4;
    b.cone(0.9 + rand() * 0.9, h, 5, { x: Math.cos(a) * d, y: h / 2, z: Math.sin(a) * d }, "#5b6a4c");
  }

  // Apron, inner ring, scorch, flame trench running east.
  b.cyl(17, 17, 0.4, 32, { y: 0.1 }, P.concrete);
  b.cyl(11, 11, 0.44, 32, { y: 0.12 }, P.concreteDark);
  b.box(24, 0.06, 5.2, { x: 12, y: 0.34 }, P.trench);
  b.box(24, 0.35, 0.4, { x: 12, y: 0.45, z: 2.8 }, P.concrete);
  b.box(24, 0.35, 0.4, { x: 12, y: 0.45, z: -2.8 }, P.concrete);

  // Launch mount: a table on four legs, hold-down posts at the corners.
  b.box(6.4, 0.5, 6.4, { y: MOUNT_TOP - 0.25 }, P.steel);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(0.9, MOUNT_TOP - 0.4, 0.9, { x: sx * 2.6, y: (MOUNT_TOP - 0.4) / 2 + 0.3, z: sz * 2.6 }, P.steelDark);
    b.box(0.5, 0.7, 0.5, { x: sx * 1.9, y: MOUNT_TOP + 0.35, z: sz * 1.9 }, P.steelDark);
  }

  // Service tower to the north (the side with no stations): four legs, rings and
  // diagonals every 4 m, a swing arm reaching south to the rocket.
  const tb = new Batch(), ab = new Batch(); // tower and arm are their own meshes so they can tilt and swing
  const TX = 0, TZ = -9, half = 1.7;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    tb.box(0.5, towerH, 0.5, { x: TX + sx * half, y: towerH / 2, z: TZ + sz * half }, P.steel);
  }
  for (let y = 4; y <= towerH; y += 4) {
    tb.box(half * 2, 0.3, 0.3, { x: TX, y, z: TZ + half }, P.steelDark);
    tb.box(half * 2, 0.3, 0.3, { x: TX, y, z: TZ - half }, P.steelDark);
    tb.box(0.3, 0.3, half * 2, { x: TX + half, y, z: TZ }, P.steelDark);
    tb.box(0.3, 0.3, half * 2, { x: TX - half, y, z: TZ }, P.steelDark);
    if (y > 4) {
      const l = Math.hypot(half * 2, 4);
      const a = Math.atan2(4, half * 2);
      tb.box(l, 0.2, 0.2, { x: TX, y: y - 2, z: TZ + half, rz: a }, P.steelDark);
      tb.box(l, 0.2, 0.2, { x: TX, y: y - 2, z: TZ - half, rz: -a }, P.steelDark);
    }
  }
  tb.box(half * 2 + 1.4, 0.5, half * 2 + 1.4, { x: TX, y: towerH + 0.25, z: TZ }, P.concreteDark);
  tb.cyl(0.08, 0.14, 7, 6, { x: TX, y: towerH + 4, z: TZ }, P.steelDark);
  const armY = Math.round(towerH * 0.68);
  const armLen = -(TZ + half) - 1.9;
  tb.box(1.1, 1.1, armLen, { x: TX, y: armY, z: TZ + half + armLen / 2 }, P.steel);
  b.box(1.4, 1.5, 1.2, { x: TX, y: armY, z: TZ + half + armLen }, P.steelDark);

  // Fuel tanks, a service building and a windsock pole, all at the edges, away from the stations.
  b.ico(3.4, 1, { x: 42, y: 6.4, z: -13 }, P.rocketWhite);
  b.ico(3.0, 1, { x: 47, y: 6.0, z: -3 }, P.rocketWhite);
  for (const [x, z] of [[42, -13], [47, -3]]) {
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      b.cyl(0.18, 0.18, 4.2, 5, { x: x + Math.cos(a) * 2, y: 2.1, z: z + Math.sin(a) * 2 }, P.steelDark);
    }
  }
  b.cyl(2.2, 2.2, 14, 12, { x: -42, y: 2.2, z: -13, rz: Math.PI / 2, ry: 0.4 }, P.rocketGrey);
  b.box(12, 5, 7, { x: 33, y: 2.5, z: -33, ry: -0.7 }, P.concreteDark);
  b.box(12.6, 0.5, 7.6, { x: 33, y: 5.2, z: -33, ry: -0.7 }, P.steelDark);
  b.box(3, 2, 0.2, { x: 30.1, y: 2.6, z: -29.6, ry: -0.7 }, P.screen);
  b.cyl(0.1, 0.1, 6, 5, { x: 36, y: 3, z: -8 }, P.steelDark);
  b.cone(0.5, 2.2, 6, { x: 37.1, y: 5.6, z: -8, rz: -Math.PI / 2 }, "#ff7a3d");

  // Lamp masts at the edge of the apron, placed between stations so none stands in front of a seat.
  for (const th of mastThetas) {
    const x = Math.sin(th) * 20, z = Math.cos(th) * 20;
    b.cyl(0.18, 0.28, 14, 6, { x, y: 7, z }, P.steel);
    b.box(2.2, 0.5, 0.9, { x, y: 14.2, z, ry: th }, "#f3efd8");
  }

  // Perimeter fence: posts and two rails per span.
  const N = 72;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = Math.cos(a) * FENCE_RADIUS, z = Math.sin(a) * FENCE_RADIUS;
    b.box(0.22, 2.6, 0.22, { x, y: 1.3, z }, P.steelDark);
    const span = 2 * FENCE_RADIUS * Math.sin(Math.PI / N);
    const mx = Math.cos(a + Math.PI / N) * FENCE_RADIUS * Math.cos(Math.PI / N);
    const mz = Math.sin(a + Math.PI / N) * FENCE_RADIUS * Math.cos(Math.PI / N);
    b.box(span, 0.1, 0.1, { x: mx, y: 2.3, z: mz, ry: -(a + Math.PI / N) + Math.PI / 2 }, P.steel);
    b.box(span, 0.1, 0.1, { x: mx, y: 1.2, z: mz, ry: -(a + Math.PI / N) + Math.PI / 2 }, P.steel);
  }

  const group = new THREE.Group();
  const geo = b.geometry();
  const mat = litMaterial();
  const staticMesh = new THREE.Mesh(geo, mat);
  staticMesh.frustumCulled = false;
  group.add(staticMesh);

  // Tower: one group (tower, beacons, arm) so P3 can lean it after an explosion;
  // the arm swings on a pivot at the tower corner.
  const tower = new THREE.Group();
  const towerGeo = tb.geometry();
  // Its own material, so the scene can fade the tower when it stands between a
  // seat and the climbing rocket (a local view tweak; nothing private).
  const towerMat = litMaterial();
  const towerMesh = new THREE.Mesh(towerGeo, towerMat);
  towerMesh.frustumCulled = false;
  const armGeo = ab.geometry();
  const armMesh = new THREE.Mesh(armGeo, towerMat);
  armMesh.frustumCulled = false;
  const arm = new THREE.Group();
  arm.position.set(TX, armY, TZ + half);
  arm.add(armMesh);
  tower.add(towerMesh, arm);
  group.add(tower);

  // Beacons: amber boxes on the tower corners and the arm tip. One merged
  // mesh with one basic material, so blinking is a colour change.
  const bb = new Batch();
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    bb.box(0.7, 0.7, 0.7, { x: TX + sx * half, y: towerH + 0.9, z: TZ + sz * half }, "#ffffff");
  }
  for (const sz of [-1, 1]) bb.box(0.6, 0.6, 0.6, { x: TX + half, y: Math.round(towerH * 0.4), z: TZ + sz * half }, "#ffffff");
  bb.box(0.7, 0.7, 0.7, { x: TX, y: towerH + 7.4, z: TZ }, "#ffffff");
  const beaconGeo = bb.geometry();
  beaconGeo.deleteAttribute("color");
  const beaconMat = new THREE.MeshBasicMaterial({ color: P.beaconOff });
  const beacons = new THREE.Mesh(beaconGeo, beaconMat);
  beacons.frustumCulled = false;
  tower.add(beacons);

  return {
    group,
    towerHeight: towerH,
    tower: { group: tower, base: new THREE.Vector3(TX, 0, TZ), arm, mat: towerMat },
    beacons: { mesh: beacons, mat: beaconMat },
    triangles: b.triangles + bb.triangles + tb.triangles + ab.triangles,
    dispose() { geo.dispose(); towerGeo.dispose(); armGeo.dispose(); mat.dispose(); towerMat.dispose(); beaconGeo.dispose(); beaconMat.dispose(); },
  };
}

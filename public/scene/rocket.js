// The rocket: primitives only, one merged mesh. Its base sits at y = 0 in its
// own group; the pad puts the group on the launch mount. It varies by
// sequence id. P1 shows public state only; cinematics come later.
import * as THREE from "three";
import { Batch, litMaterial } from "./builder.js";
import { PALETTE as P } from "./palette.js";

const ACCENT = { mvp: "#ff7a3d", kestrel2: "#2fa8ff", kestrel3: "#ffc531" };

function fins(b, r, n, span, hgt, y, color) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / 4;
    const d = r + span * 0.4;
    b.box(0.14, hgt, span, { x: Math.cos(a) * d, y, z: Math.sin(a) * d, ry: -a + Math.PI / 2 }, color);
  }
}

function engines(b, r, n) {
  b.cyl(r * 0.7, r * 0.85, 0.5, 10, { y: 0.25 }, P.rocketBlack);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const d = n > 1 ? r * 0.45 : 0;
    b.cone(r * 0.32, 1.1, 8, { x: Math.cos(a) * d, y: -0.1, z: Math.sin(a) * d, rx: Math.PI }, P.steelDark);
  }
}

/** Returns { group, height, flame, dispose }. */
export function buildRocket(sequenceId) {
  const accent = ACCENT[sequenceId] || ACCENT.mvp;
  const b = new Batch();
  let height;

  if (sequenceId === "kestrel3") {
    // Taller, with a cargo fairing and two strap-on boosters.
    engines(b, 1.5, 5);
    b.cyl(1.5, 1.5, 19, 14, { y: 0.5 + 9.5 }, P.rocketWhite);
    b.cyl(1.52, 1.52, 1.4, 14, { y: 6 }, accent);
    b.cyl(1.52, 1.52, 0.5, 14, { y: 17 }, P.rocketBlack);
    b.cyl(1.3, 1.5, 1, 14, { y: 20.0 }, P.rocketBlack);
    b.cyl(1.3, 1.3, 9, 14, { y: 25 }, P.rocketWhite);
    b.cyl(1.9, 1.3, 1.2, 14, { y: 30.1 }, P.rocketGrey);
    b.cyl(1.9, 1.9, 6, 14, { y: 33.7 }, P.rocketWhite); // cargo fairing
    for (const a of [0.6, 2.1, 3.9]) {
      b.box(0.5, 0.6, 0.12, { x: Math.sin(a) * 1.9, y: 33.9, z: Math.cos(a) * 1.9, ry: a }, P.screen);
    }
    b.cyl(1.92, 1.92, 0.5, 14, { y: 31.4 }, accent);
    b.cone(1.9, 6, 14, { y: 39.7 }, P.rocketWhite);
    b.cone(0.3, 1.2, 8, { y: 43.3 }, accent);
    for (const s of [-1, 1]) {
      b.cyl(0.8, 0.8, 14, 10, { x: s * 2.7, y: 7.5 }, P.rocketWhite);
      b.cone(0.8, 2.6, 10, { x: s * 2.7, y: 15.8 }, accent);
      b.cone(0.45, 0.9, 8, { x: s * 2.7, y: 0.2, rx: Math.PI }, P.steelDark);
    }
    fins(b, 1.5, 4, 2.2, 4.5, 2.2, accent);
    height = 43.9;
  } else if (sequenceId === "kestrel2") {
    // Two stage: a fat first stage, a black interstage, a narrower second stage.
    engines(b, 1.25, 3);
    b.cyl(1.25, 1.25, 17, 14, { y: 0.5 + 8.5 }, P.rocketWhite);
    b.cyl(1.27, 1.27, 1.3, 14, { y: 5.5 }, accent);
    b.cyl(1.27, 1.27, 0.7, 14, { y: 17.8 }, P.rocketBlack);
    b.cyl(1.0, 1.25, 1.1, 14, { y: 18.7 }, P.rocketGrey);
    b.cyl(1.0, 1.0, 8.5, 14, { y: 23.5 }, P.rocketWhite);
    b.cyl(1.02, 1.02, 0.5, 14, { y: 27.2 }, accent);
    b.cone(1.0, 5, 14, { y: 30.25 }, P.rocketWhite);
    b.cone(0.2, 0.8, 8, { y: 33.15 }, accent);
    fins(b, 1.25, 4, 2.0, 4, 2.0, accent);
    height = 33.6;
  } else {
    // Kestrel-1: a small single stage suborbital.
    engines(b, 0.95, 1);
    b.cyl(0.95, 0.95, 10.5, 12, { y: 0.5 + 5.25 }, P.rocketWhite);
    b.cyl(0.97, 0.97, 1.2, 12, { y: 4.2 }, accent);
    b.cyl(0.97, 0.97, 0.5, 12, { y: 9.8 }, P.rocketBlack);
    b.cone(0.95, 4, 12, { y: 13 }, P.rocketWhite);
    b.cone(0.18, 0.7, 8, { y: 15.35 }, accent);
    fins(b, 0.95, 4, 1.6, 3, 1.6, accent);
    height = 15.8;
  }

  const group = new THREE.Group();
  const geo = b.geometry();
  const mat = litMaterial();
  const body = new THREE.Mesh(geo, mat);
  body.frustumCulled = false;
  group.add(body);

  // The exhaust cone, shown only while the vehicle is in ascent.
  const flameGeo = new THREE.ConeGeometry(1.1, 7, 10);
  flameGeo.rotateX(Math.PI);
  flameGeo.translate(0, -3.7, 0);
  const flameMat = new THREE.MeshBasicMaterial({ color: "#ffa33a" });
  const flame = new THREE.Mesh(flameGeo, flameMat);
  flame.visible = false;
  group.add(flame);

  return {
    group,
    height,
    body,
    flame,
    triangles: b.triangles,
    dispose() { geo.dispose(); mat.dispose(); flameGeo.dispose(); flameMat.dispose(); },
  };
}

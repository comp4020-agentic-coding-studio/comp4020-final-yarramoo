// The pad clock: a low-poly countdown board on two legs near the pad. The face is
// a canvas texture redrawn only when its text changes (the caller throttles to
// four times a second). It shows public clock state only: T-/T+, the phase word,
// and amber HOLD while holding.
import * as THREE from "three";
import { Batch, litMaterial } from "./builder.js";
import { PALETTE as P } from "./palette.js";

const W = 512, H = 200;
// Hung on a boom off the service tower, high up and 10 m to the side of the
// rocket's axis, so from no seat does it stand between you and the rocket or the
// tower, and every seat on the ring has the tower in view. The board turns about
// its own vertical axis to face whoever is looking.
const OFF_X = -10, TOWER_Z = -9;


export function buildClock(rocketHeight = 40) {
  const towerH = Math.round(rocketHeight * 0.85), Y = Math.round(towerH * 0.74);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const faceMat = new THREE.MeshBasicMaterial({ map: tex });

  const group = new THREE.Group(); // static: the boom
  const board = new THREE.Group(); // turns to face the viewer
  const b = new Batch();
  b.box(8.6, 3.5, 0.5, { y: 0 }, P.bezel);
    const geo = b.geometry();
  const litMat = litMaterial();
  const frame = new THREE.Mesh(geo, litMat);
  frame.frustumCulled = false;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(8.1, 3.15), faceMat);
  face.position.set(0, 0, 0.27);
  face.frustumCulled = false;
  board.add(frame, face);
  board.position.set(OFF_X, Y, TOWER_Z);
  // The boom, with a brace, on either side of the tower: you see it on your own side,
  // so the tower never stands between you and the board.
  const mk = (X) => {
    const bb = new Batch();
    bb.box(Math.abs(X), 0.5, 0.5, { x: X / 2, y: Y - 2.1, z: TOWER_Z }, P.steelDark);
    const m = new THREE.Mesh(bb.geometry(), litMat);
    m.frustumCulled = false;
    return m;
  };
  const booms = { "-1": mk(-Math.abs(OFF_X)), "1": mk(Math.abs(OFF_X)) }; // keyed by the board's side of the tower
  const setSide = (sgn) => {
    const sd = sgn > 0 ? 1 : -1;
    booms["-1"].visible = sd < 0; booms["1"].visible = sd > 0;
    board.position.x = sd * Math.abs(OFF_X);
  };
  group.add(booms["-1"], booms["1"], board);
  setSide(-1);

  let key = "";
  /** text like "T-04:00"; sub is the status word; amber paints the status amber. */
  function draw(text, sub, tone) {
    const k = `${text}|${sub}|${tone}`;
    if (k === key) return false;
    key = k;
    g.fillStyle = "#0b1118"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "#26323f"; g.lineWidth = 6; g.strokeRect(5, 5, W - 10, H - 10);
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = "700 112px ui-monospace, Menlo, Consolas, monospace";
    g.fillStyle = tone === "hold" ? "#ffb020" : tone === "bad" ? "#ff4d5a" : tone === "good" ? "#3ddc84" : "#f2f6fa";
    g.fillText(text, W / 2, 84);
    g.font = "700 40px ui-monospace, Menlo, Consolas, monospace";
    g.fillStyle = tone === "hold" ? "#ffb020" : tone === "bad" ? "#ff4d5a" : tone === "good" ? "#3ddc84" : "#8fa6bf";
    g.fillText(sub, W / 2, 160);
    tex.needsUpdate = true;
    return true;
  }
  draw("T-00:00", "STANDBY", "");

  return {
    group,
    draw,
    /** Put the board on the same side of the tower as the given x (your seat): the tower is then never in the way. */
    beside(x) { setSide(x > 0.2 ? 1 : -1); },
    /** Turn the face toward the camera (about y only). */
    faceTo(camera) {
      board.rotation.y = Math.atan2(camera.position.x - board.position.x, camera.position.z - TOWER_Z);
    },
    dispose() { geo.dispose(); booms["-1"].geometry.dispose(); booms["1"].geometry.dispose(); litMat.dispose(); face.geometry.dispose(); faceMat.dispose(); tex.dispose(); },
  };
}

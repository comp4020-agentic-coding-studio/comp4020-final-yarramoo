// The pad clock: a low-poly countdown board on two legs near the pad. The face is
// a canvas texture redrawn only when its text changes (the caller throttles to
// four times a second). It shows public clock state only: T-/T+, the phase word,
// and amber HOLD while holding.
import * as THREE from "three";
import { Batch, litMaterial } from "./builder.js";
import { PALETTE as P } from "./palette.js";

const W = 512, H = 200;
export const BOARD_POS = { x: -19, z: 0 };

export function buildClock() {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const faceMat = new THREE.MeshBasicMaterial({ map: tex });

  const group = new THREE.Group();
  const b = new Batch();
  b.box(0.35, 4.4, 0.35, { x: -3.2, y: 2.2 }, P.steelDark);
  b.box(0.35, 4.4, 0.35, { x: 3.2, y: 2.2 }, P.steelDark);
  b.box(8.6, 3.5, 0.5, { y: 6.1 }, P.bezel);
  const geo = b.geometry();
  const litMat = litMaterial();
  const frame = new THREE.Mesh(geo, litMat);
  frame.frustumCulled = false;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(8.1, 3.15), faceMat);
  face.position.set(0, 6.1, 0.27);
  face.frustumCulled = false;
  group.add(frame, face);
  group.position.set(BOARD_POS.x, 0, BOARD_POS.z);
  group.scale.setScalar(0.8);

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
    /** Turn the face toward the camera (about y only). */
    faceTo(camera) {
      group.rotation.y = Math.atan2(camera.position.x - BOARD_POS.x, camera.position.z - BOARD_POS.z);
    },
    dispose() { geo.dispose(); litMat.dispose(); face.geometry.dispose(); faceMat.dispose(); tex.dispose(); },
  };
}

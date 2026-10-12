// Geometry batching: primitives go in with a colour and a transform, one merged
// vertex-coloured BufferGeometry comes out. A whole pad is a handful of draw
// calls this way. Every triangle gets its own normal (flat shading, the
// low-poly look) because the geometry is de-indexed before normals are made.
import * as THREE from "three";

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

export class Batch {
  constructor() {
    this.pos = [];
    this.col = [];
    this.base = new THREE.Matrix4();
  }

  /** Every later add() is placed relative to this matrix (e.g. one station's frame). */
  setBase(m) { this.base.copy(m || tmpM.identity()); return this; }

  add(geo, t, color) {
    t = t || {};
    tmpE.set(t.rx || 0, t.ry || 0, t.rz || 0);
    tmpQ.setFromEuler(tmpE);
    tmpP.set(t.x || 0, t.y || 0, t.z || 0);
    tmpS.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
    tmpM.compose(tmpP, tmpQ, tmpS).premultiply(this.base);
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(tmpM);
    const p = g.attributes.position.array;
    tmpC.set(color);
    for (let i = 0; i < p.length; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      this.col.push(tmpC.r, tmpC.g, tmpC.b);
    }
    g.dispose();
    geo.dispose();
    return this;
  }

  box(w, h, d, t, color) { return this.add(new THREE.BoxGeometry(w, h, d), t, color); }
  cyl(rTop, rBot, h, seg, t, color) { return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), t, color); }
  cone(r, h, seg, t, color) { return this.add(new THREE.ConeGeometry(r, h, seg), t, color); }
  ico(r, detail, t, color) { return this.add(new THREE.IcosahedronGeometry(r, detail), t, color); }
  ring(inner, outer, seg, t, color) { return this.add(new THREE.RingGeometry(inner, outer, seg), t, color); }

  /** Triangle count so far, for the debug overlay. */
  get triangles() { return this.pos.length / 9; }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export const litMaterial = () => new THREE.MeshLambertMaterial({ vertexColors: true });

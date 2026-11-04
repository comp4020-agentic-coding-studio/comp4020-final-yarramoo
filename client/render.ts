// WebGL2 renderer, shared by the worker (OffscreenCanvas) and the main-thread fallback.
import { DEEP_TOP, paletteTable, SHALLOW_TOP } from "./materials.ts";

/** The window of the world to draw, in cells. */
export interface Camera {
  x: number;
  y: number;
  vw: number;
  vh: number;
}

const VERT = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uMat;
uniform usampler2D uAux;
uniform vec3 uPal[32];
uniform float uTime;
uniform vec2 uWorld;
uniform vec2 uCam;
uniform vec2 uView;
uniform vec3 uBands; // x: 1 in a game world, else 0; y: SHALLOW_TOP; z: DEEP_TOP
uniform usampler2D uSurf; // per column: y of the surface (first solid cell from the top), refreshed a few times a second
uniform vec2 uSky; // x: sky kind 0..4, y: 1 when motion is allowed (0 under prefers-reduced-motion)
in vec2 uv;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// The open-air sky behind a cell: a pure function of the screen cell, the kind and the time. Drawn, never simulated.
vec3 skyColor(vec2 uvp, vec2 cs) {
  float kind = uSky.x;
  float t = uTime * uSky.y;
  float g = uvp.y; // 0 top, 1 bottom
  if (kind < 0.5 || kind > 3.5) {
    vec3 col = mix(vec3(0.015, 0.03, 0.10), vec3(0.07, 0.10, 0.22), g);
    float s = hash(cs);
    if (s > 0.991) col += vec3(0.55 + 0.45 * sin(t * 0.9 + s * 400.0)) * (kind > 3.5 ? 0.5 : 1.0);
    if (kind > 3.5) {
      float band = sin(uvp.x * 6.0 + sin(uvp.x * 2.3 + t * 0.15) * 1.8 + t * 0.1);
      float m = smoothstep(0.0, 1.0, band * 0.5 + 0.5) * smoothstep(0.65, 0.1, g) * smoothstep(0.0, 0.2, g);
      col += mix(vec3(0.1, 0.8, 0.45), vec3(0.55, 0.25, 0.85), g * 2.0) * m * 0.55;
    }
    return col;
  }
  if (kind < 1.5) {
    vec3 col = mix(vec3(0.36, 0.60, 0.92), vec3(0.74, 0.88, 0.97), g);
    float d = length((uvp - vec2(0.78, 0.2)) * vec2(1.7, 1.0));
    col += vec3(1.0, 0.95, 0.75) * (exp(-d * 7.0) * 0.5 + step(d, 0.045));
    return col;
  }
  if (kind < 2.5) {
    vec3 col = mix(vec3(0.20, 0.20, 0.42), vec3(0.98, 0.52, 0.30), pow(g, 1.6));
    col = mix(col, vec3(1.0, 0.80, 0.45), smoothstep(0.75, 1.0, g) * 0.6);
    float d = length((uvp - vec2(0.3, 0.95)) * vec2(1.7, 1.0));
    col += vec3(1.0, 0.7, 0.3) * exp(-d * 4.0) * 0.5;
    return col;
  }
  vec3 col = mix(vec3(0.27, 0.30, 0.35), vec3(0.46, 0.49, 0.53), g);
  float cx = floor(cs.x + cs.y * 0.2);
  float h1 = hash(vec2(cx, 3.0));
  float yy = cs.y + t * (50.0 + 40.0 * h1) + h1 * 300.0;
  float seg = mod(yy, 36.0);
  if (seg < 5.0 && hash(vec2(cx, floor(yy / 36.0))) > 0.75) col += vec3(0.20, 0.22, 0.28) * (1.0 - seg / 6.0);
  return col;
}

void main() {
  ivec2 c = clamp(ivec2(floor(uCam + uv * uView)), ivec2(0), ivec2(uWorld) - 1);
  uint m = texelFetch(uMat, c, 0).r;
  float a = float(texelFetch(uAux, c, 0).r);
  float h = hash(vec2(c));
  vec3 bg = vec3(0.043, 0.055, 0.078) + vec3(0.02, 0.025, 0.04) * (1.0 - uv.y);
  // Open air only: in a game world a cell is sky when it is above the first solid cell of its column (caves stay
  // dark); the sandbox has no ground to speak of, so all of it is sky.
  if (uBands.x < 0.5 || c.y < int(texelFetch(uSurf, ivec2(c.x, 0), 0).r)) bg = skyColor(uv, floor(uv * uView));
  vec3 col = uPal[m];
  if (m == 0u) {
    outColor = vec4(bg, 1.0);
    return;
  }
  if (m == 10u) {
    // Fire: flicker between red/orange/yellow, fading as the lifetime in aux runs out.
    float f = fract(h * 7.0 + uTime * 5.0 + a * 0.37);
    vec3 hot = mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.9, 0.3), f);
    float life = clamp(a / 60.0, 0.35, 1.0);
    outColor = vec4(mix(bg, hot, life), 1.0);
    return;
  }
  if (m == 14u) {
    float w = 0.5 + 0.5 * sin(uTime * 2.0 + float(c.x) * 0.35 + float(c.y) * 0.21 + h * 3.0);
    outColor = vec4(mix(vec3(0.62, 0.1, 0.02), vec3(1.0, 0.62, 0.12), w * (0.6 + 0.4 * h)), 1.0);
    return;
  }
  if (m == 17u) {
    // Gas: faint, slowly shimmering, so a pocket reads as a haze against the rock.
    float sh = 0.5 + 0.5 * sin(uTime * 1.2 + float(c.x) * 0.3 + float(c.y) * 0.17 + h * 4.0);
    outColor = vec4(mix(bg, col, 0.28 + 0.14 * sh), 1.0);
    return;
  }
  if (m == 11u || m == 12u) {
    float alpha = m == 11u ? 0.75 : 0.55;
    alpha *= clamp(a / 40.0, 0.25, 1.0);
    outColor = vec4(mix(bg, col * (0.85 + 0.3 * h), alpha), 1.0);
    return;
  }
  float v = 0.9 + 0.2 * h;
  if (uBands.x > 0.5 && (m == 2u || m == 3u)) {
    // Depth look (cosmetic, game world only): warm brown at the surface, grey-brown in the shallows, cold
    // blue-black deep down, blended over 80 cells at each boundary. A pure function of the cell: no flicker.
    float y = float(c.y);
    float s1 = smoothstep(uBands.y - 40.0, uBands.y + 40.0, y);
    float s2 = smoothstep(uBands.z - 40.0, uBands.z + 40.0, y);
    vec3 tint = mix(mix(vec3(1.18, 0.96, 0.78), vec3(0.95, 0.93, 0.88), s1), vec3(0.50, 0.62, 0.95), s2);
    float dark = mix(1.0, 0.62, s2);
    // Two scales of hash noise so big faces are not flat.
    float n = 0.80 + 0.28 * h + 0.14 * (hash(vec2(c / 3) + 17.0) - 0.5);
    col = col * tint * dark;
    if (m == 2u) {
      // Moss: rock touching water, speckled by hash.
      bool wet = texelFetch(uMat, c + ivec2(0, -1), 0).r == 5u || texelFetch(uMat, c + ivec2(-1, 0), 0).r == 5u
        || texelFetch(uMat, c + ivec2(1, 0), 0).r == 5u || texelFetch(uMat, c + ivec2(0, 1), 0).r == 5u;
      if (wet && h > 0.35) col = mix(col, vec3(0.20, 0.45, 0.16), 0.6);
    }
    outColor = vec4(col * n, 1.0);
    return;
  }
  if (m == 5u) v = 0.88 + 0.12 * sin(uTime * 1.5 + float(c.x) * 0.2 + h * 2.0) + 0.06 * h;
  if (m == 1u) v = 0.8 + 0.4 * hash(vec2(c / 4));
  if (m == 8u) v = 0.8 + 0.3 * h;
  outColor = vec4(col * v, 1.0);
}`;

/** A coloured rectangle in cell coordinates (top-left x, y; width, height), drawn over the world. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  g: number;
  b: number;
  /** Opacity 0..1 (default 1). */
  a?: number;
}

const RECT_VERT = `#version 300 es
uniform vec4 uRect;
uniform vec2 uCam;
uniform vec2 uView;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 cell = uRect.xy + c * uRect.zw;
  vec2 p = (cell - uCam) / uView;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}`;
const RECT_FRAG = `#version 300 es
precision mediump float;
uniform vec4 uCol;
out vec4 outColor;
void main() { outColor = uCol; }`;

const SANDBOX_H = 512;

export class Renderer {
  private gl: WebGL2RenderingContext;
  private matTex: WebGLTexture;
  private auxTex: WebGLTexture;
  private uTime: WebGLUniformLocation | null;
  private uWorld: WebGLUniformLocation | null;
  private uCam: WebGLUniformLocation | null;
  private uView: WebGLUniformLocation | null;
  private uBands: WebGLUniformLocation | null;
  private uSky: WebGLUniformLocation | null;
  private surfTex: WebGLTexture | null = null;
  private surf = new Uint16Array(0);
  private surfFrame = 0;
  private surfX0 = -1;
  private surfX1 = -1;
  private sky = 0;
  private motion = 1;
  private prog: WebGLProgram;
  private rectProg: WebGLProgram;
  private rRect: WebGLUniformLocation | null;
  private rCam: WebGLUniformLocation | null;
  private rView: WebGLUniformLocation | null;
  private rCol: WebGLUniformLocation | null;
  private cam: Camera = { x: 0, y: 0, vw: 1, vh: 1 };
  /** Cave terrain: sky only above the surface, depth bands on. Otherwise every empty cell is sky. */
  private caves = false;
  /** Size of the world the textures are allocated for (0 until `setWorld`). */
  private ww = 0;
  private wh = 0;

  private canvas: HTMLCanvasElement | OffscreenCanvas;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    const prog = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VERT],
      [gl.FRAGMENT_SHADER, FRAG],
    ] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s));
      gl.attachShader(prog, s);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.prog = prog;
    const rp = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, RECT_VERT],
      [gl.FRAGMENT_SHADER, RECT_FRAG],
    ] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("rect shader: " + gl.getShaderInfoLog(sh));
      gl.attachShader(rp, sh);
    }
    gl.linkProgram(rp);
    if (!gl.getProgramParameter(rp, gl.LINK_STATUS)) throw new Error("rect link: " + gl.getProgramInfoLog(rp));
    this.rectProg = rp;
    this.rRect = gl.getUniformLocation(rp, "uRect");
    this.rCam = gl.getUniformLocation(rp, "uCam");
    this.rView = gl.getUniformLocation(rp, "uView");
    this.rCol = gl.getUniformLocation(rp, "uCol");
    this.matTex = this.makeTex(0, 1, 1);
    this.auxTex = this.makeTex(1, 1, 1);
    gl.uniform1i(gl.getUniformLocation(prog, "uMat"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "uAux"), 1);
    this.uWorld = gl.getUniformLocation(prog, "uWorld");
    this.uCam = gl.getUniformLocation(prog, "uCam");
    this.uView = gl.getUniformLocation(prog, "uView");
    this.uBands = gl.getUniformLocation(prog, "uBands");
    this.uSky = gl.getUniformLocation(prog, "uSky");
    gl.uniform1i(gl.getUniformLocation(prog, "uSurf"), 2);
    const pal = new Float32Array(96);
    paletteTable().forEach((c, i) => {
      pal[i * 3] = ((c >> 16) & 255) / 255;
      pal[i * 3 + 1] = ((c >> 8) & 255) / 255;
      pal[i * 3 + 2] = (c & 255) / 255;
    });
    gl.uniform3fv(gl.getUniformLocation(prog, "uPal"), pal);
    this.uTime = gl.getUniformLocation(prog, "uTime");
  }

  /** Pick the sky (an index into SKY_KINDS) and whether it may move (false under prefers-reduced-motion). */
  setSky(kind: number, motion = true) {
    this.sky = kind;
    this.motion = motion ? 1 : 0;
    this.gl.useProgram(this.prog);
    this.gl.uniform2f(this.uSky, kind, this.motion);
  }

  /**
   * Refresh the per-column surface heights for the columns on screen. A column's surface is the first cell
   * from the top that starts a run of 3 solid cells (so a single falling grain does not count). About 100k
   * byte reads, done 5 times a second or when the window moves sideways: nothing per frame.
   */
  private updateSurface(mat: Uint8Array, x0: number, x1: number) {
    if (!this.caves) return;
    if (x0 === this.surfX0 && x1 === this.surfX1 && ++this.surfFrame % 12 !== 0) return;
    const { ww, wh, surf } = this;
    for (let x = x0; x < x1; x++) {
      let y = 0;
      for (; y < wh - 2; y++) {
        const i = y * ww + x;
        if (mat[i] !== 0 && mat[i + ww] !== 0 && mat[i + 2 * ww] !== 0) break;
      }
      surf[x] = y;
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.surfTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, 0, x1 - x0, 1, gl.RED_INTEGER, gl.UNSIGNED_SHORT, surf.subarray(x0, x1));
    this.surfX0 = x0;
    this.surfX1 = x1;
  }

  /** Allocate textures for a world of `w` by `h` cells (a no-op if the size is unchanged). */
  /** `caves`: the world has cave terrain (a surface, bands, sky only above ground). Defaults to the old height
   * guess (taller than the sandbox), which is wrong for a size-S cave room: callers that know the config pass it. */
  setWorld(w: number, h: number, caves = h > SANDBOX_H) {
    if (caves !== this.caves) {
      this.caves = caves;
      this.surfX0 = this.surfX1 = -1;
      if (this.ww) this.gl.uniform3f(this.uBands, caves ? 1 : 0, SHALLOW_TOP, DEEP_TOP);
    }
    if (w === this.ww && h === this.wh) return;
    const gl = this.gl;
    gl.deleteTexture(this.matTex);
    gl.deleteTexture(this.auxTex);
    this.matTex = this.makeTex(0, w, h);
    this.auxTex = this.makeTex(1, w, h);
    this.ww = w;
    this.wh = h;
    if (this.surfTex) gl.deleteTexture(this.surfTex);
    gl.activeTexture(gl.TEXTURE2);
    this.surfTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.surfTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, w, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.surf = new Uint16Array(w);
    this.surfX0 = this.surfX1 = -1;
    gl.uniform2f(this.uWorld, w, h);
    // The sandbox is 512 tall and has no bands: only a taller world gets the depth look.
    gl.uniform3f(this.uBands, this.caves ? 1 : 0, SHALLOW_TOP, DEEP_TOP);
  }

  private makeTex(unit: number, w: number, h: number): WebGLTexture {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  setCamera(c: Camera) {
    this.cam = c;
  }

  resize(w: number, h: number) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /** Cells uploaded by the last `draw` (both planes count once): lets the browser checks see the saving. */
  lastUploadCells = 0;

  /**
   * Upload the part of both grids the camera can see (plus a 2-cell margin), then draw it. A game
   * world is 3 MB per plane, so uploading only the window is the difference between about 2 and 0.13
   * megabytes a frame. Everything outside the window is stale on the GPU, which is fine: it is never
   * sampled until the camera moves there, and the next frame uploads it.
   */
  draw(mat: Uint8Array, aux: Uint8Array, seconds: number, cam: Camera = this.cam, rects: readonly Rect[] = []) {
    if (!this.ww) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    const x0 = Math.max(0, Math.floor(cam.x) - 2);
    const y0 = Math.max(0, Math.floor(cam.y) - 2);
    const x1 = Math.min(this.ww, Math.ceil(cam.x + cam.vw) + 2);
    const y1 = Math.min(this.wh, Math.ceil(cam.y + cam.vh) + 2);
    const w = x1 - x0;
    const h = y1 - y0;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.ww);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, mat);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.auxTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, aux);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    this.lastUploadCells = w * h;
    this.updateSurface(mat, x0, x1);
    this.present(seconds, cam);
    if (rects.length) this.drawRects(rects, cam);
  }

  /** Overlay rectangles (avatars, pickups) in the camera's cell space; nearest-neighbour like everything else. */
  private drawRects(rects: readonly Rect[], cam: Camera) {
    const gl = this.gl;
    gl.useProgram(this.rectProg);
    gl.uniform2f(this.rCam, cam.x, cam.y);
    gl.uniform2f(this.rView, cam.vw, cam.vh);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (const r of rects) {
      gl.uniform4f(this.rRect, r.x, r.y, r.w, r.h);
      gl.uniform4f(this.rCol, r.r, r.g, r.b, r.a ?? 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
  }

  private present(seconds: number, cam: Camera) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uTime, seconds);
    gl.uniform2f(this.uCam, cam.x, cam.y);
    gl.uniform2f(this.uView, cam.vw, cam.vh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

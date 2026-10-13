// WebGL2 renderer, shared by the worker (OffscreenCanvas) and the main-thread fallback.
import { paletteTable, WORLD } from "./materials.ts";

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
uniform vec3 uPal[16];
uniform float uTime;
uniform float uWorld;
in vec2 uv;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  ivec2 c = ivec2(floor(uv * uWorld));
  uint m = texelFetch(uMat, c, 0).r;
  float a = float(texelFetch(uAux, c, 0).r);
  float h = hash(vec2(c));
  vec3 bg = vec3(0.043, 0.055, 0.078) + vec3(0.02, 0.025, 0.04) * (1.0 - uv.y);
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
  if (m == 11u || m == 12u) {
    float alpha = m == 11u ? 0.75 : 0.55;
    alpha *= clamp(a / 40.0, 0.25, 1.0);
    outColor = vec4(mix(bg, col * (0.85 + 0.3 * h), alpha), 1.0);
    return;
  }
  float v = 0.9 + 0.2 * h;
  if (m == 5u) v = 0.88 + 0.12 * sin(uTime * 1.5 + float(c.x) * 0.2 + h * 2.0) + 0.06 * h;
  if (m == 1u) v = 0.8 + 0.4 * hash(vec2(c / 4));
  if (m == 8u) v = 0.8 + 0.3 * h;
  outColor = vec4(col * v, 1.0);
}`;

export class Renderer {
  private gl: WebGL2RenderingContext;
  private matTex: WebGLTexture;
  private auxTex: WebGLTexture;
  private uTime: WebGLUniformLocation | null;

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
    this.matTex = this.makeTex(0);
    this.auxTex = this.makeTex(1);
    gl.uniform1i(gl.getUniformLocation(prog, "uMat"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "uAux"), 1);
    gl.uniform1f(gl.getUniformLocation(prog, "uWorld"), WORLD);
    const pal = new Float32Array(48);
    paletteTable().forEach((c, i) => {
      pal[i * 3] = ((c >> 16) & 255) / 255;
      pal[i * 3 + 1] = ((c >> 8) & 255) / 255;
      pal[i * 3 + 2] = (c & 255) / 255;
    });
    gl.uniform3fv(gl.getUniformLocation(prog, "uPal"), pal);
    this.uTime = gl.getUniformLocation(prog, "uTime");
  }

  private makeTex(unit: number): WebGLTexture {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, WORLD, WORLD);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  resize(w: number, h: number) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /** Full upload of both grids every frame. Future: upload only `dirty_rects` once the sim reports them. */
  draw(mat: Uint8Array, aux: Uint8Array, seconds: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WORLD, WORLD, gl.RED_INTEGER, gl.UNSIGNED_BYTE, mat);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.auxTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WORLD, WORLD, gl.RED_INTEGER, gl.UNSIGNED_BYTE, aux);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uTime, seconds);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

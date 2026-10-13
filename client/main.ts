// Main thread: DOM (palette, brush), pointer forwarding, and the main-thread render fallback.
import { MATERIALS, WORLD } from "./materials.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { Renderer } from "./render.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("stage");
const info = $("info");
const note = $("note");

let selected = 4;
let radius = 4;

// Palette
const palette = $("palette");
for (const m of MATERIALS) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.id = String(m.id);
  b.setAttribute("aria-pressed", String(m.id === selected));
  const sw = document.createElement("span");
  sw.className = "sw";
  sw.style.background = "#" + m.color.toString(16).padStart(6, "0");
  const label = document.createElement("span");
  label.textContent = m.name;
  b.append(sw, label);
  b.onclick = () => {
    selected = m.id;
    for (const o of palette.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
  };
  palette.append(b);
}
const brush = $<HTMLInputElement>("brush");
brush.oninput = () => {
  radius = Number(brush.value);
  $("brushOut").textContent = brush.value;
};

// Canvas: integer scale of the 512 world where it fits, otherwise fit the space.
let canvas = makeCanvas();
function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.id = "view";
  stage.replaceChildren(c);
  attachPointer(c);
  return c;
}

function layout(): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const avail = Math.max(64, Math.min(stage.clientWidth, stage.clientHeight));
  let css = avail;
  const k = Math.floor(avail / WORLD);
  if (k >= 1) css = WORLD * k;
  const px = Math.max(1, Math.round(css * dpr));
  canvas.style.width = canvas.style.height = css + "px";
  return { w: px, h: px };
}

function attachPointer(c: HTMLCanvasElement) {
  const toCell = (e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * WORLD, y: ((e.clientY - r.top) / r.height) * WORLD };
  };
  const post = (kind: "down" | "move" | "up", e: PointerEvent) => {
    const p = toCell(e);
    send({ type: "pointer", kind, x: p.x, y: p.y, mat: selected, radius });
  };
  let down = false;
  c.addEventListener("pointerdown", (e) => {
    down = true;
    c.setPointerCapture(e.pointerId);
    post("down", e);
    e.preventDefault();
  });
  c.addEventListener("pointermove", (e) => {
    if (!down) return;
    // Coalesced events keep fast drags smooth.
    for (const ce of e.getCoalescedEvents?.() ?? [e]) post("move", ce);
  });
  const end = (e: PointerEvent) => {
    if (!down) return;
    down = false;
    post("up", e);
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
}

// Worker
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
function send(m: ToWorker, transfer: Transferable[] = []) {
  worker.postMessage(m, transfer);
}

let fallback: Renderer | null = null;
let path = "";

function setPath(p: string) {
  path = p;
  console.log(`[main] render path: ${p}`);
}

function startFallback(reason: string) {
  canvas = makeCanvas();
  const { w, h } = layout();
  canvas.width = w;
  canvas.height = h;
  try {
    fallback = new Renderer(canvas);
  } catch (e) {
    note.hidden = false;
    note.textContent = "WebGL2 is not available in this browser, so nothing can be drawn.";
    console.error("[main] no WebGL2 on the main thread either", e);
    return;
  }
  setPath(`main-thread WebGL2 fallback (${reason})`);
  send({ type: "frames" });
}

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "ready":
      if (m.path === "worker-webgl2") setPath("WebGL2 on OffscreenCanvas in worker");
      break;
    case "render-failed":
      console.warn("[main] worker rendering failed:", m.error);
      startFallback("worker WebGL2 failed");
      break;
    case "frame":
      fallback?.draw(m.mat, m.aux, performance.now() / 1000);
      break;
    case "stats":
      info.textContent = `${m.stepsPerSec.toFixed(0)} steps/s · tick ${m.tick}`;
      break;
    case "error":
      console.error("[worker]", m.error);
      info.textContent = "worker error";
      break;
  }
};
worker.onerror = (e) => console.error("[worker] uncaught", e.message);

const wasmUrl = new URL("sim.wasm", document.baseURI).href;
const { w, h } = layout();
if ("OffscreenCanvas" in window && "transferControlToOffscreen" in canvas) {
  canvas.width = w;
  canvas.height = h;
  const off = canvas.transferControlToOffscreen();
  send({ type: "init", wasmUrl, canvas: off, width: w, height: h }, [off]);
} else {
  send({ type: "init", wasmUrl, width: w, height: h });
  startFallback("no OffscreenCanvas");
}

new ResizeObserver(() => {
  const s = layout();
  if (fallback) {
    fallback.resize(s.w, s.h);
  } else if (path) {
    send({ type: "resize", width: s.w, height: s.h });
  }
}).observe(stage);

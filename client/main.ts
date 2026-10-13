// Main thread: DOM (palette, brush), pointer forwarding, and the main-thread render fallback.
import { GAME_VIEW, MATERIALS, SANDBOX } from "./materials.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { Renderer, type Camera } from "./render.ts";

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

// Dev route: ?world=game runs a LOCAL single-player sim of the game world (no networking, the dev-only
// wasm where Paint works). The networked path is untouched and stays on the sandbox.
const params = new URLSearchParams(location.search);
// Dev-only: the production build serves no sim-dev.wasm, so the route must not exist there.
const localKind = import.meta.env.DEV && params.get("world") === "game" ? 1 : null;

// The world and the camera. The camera is client-only state: it is never an input (invariant 9).
let worldW = SANDBOX;
let worldH = SANDBOX;
let worldKind = 0;
let overview = false;
const camera: Camera = { x: 0, y: 0, vw: SANDBOX, vh: SANDBOX };

/** The window of the world on screen: the whole world for the sandbox, 480 x 270 cells for a game world. */
function applyCamera() {
  if (worldKind === 0 || overview) {
    camera.vw = worldW;
    camera.vh = worldH;
  } else {
    camera.vw = GAME_VIEW.w;
    camera.vh = GAME_VIEW.h;
  }
  camera.x = Math.max(0, Math.min(worldW - camera.vw, camera.x));
  camera.y = Math.max(0, Math.min(worldH - camera.vh, camera.y));
  send({ type: "camera", x: Math.round(camera.x), y: Math.round(camera.y), vw: camera.vw, vh: camera.vh });
  fallback?.setCamera(camera);
  (window as unknown as { __view: unknown }).__view = { ...camera, worldW, worldH, worldKind, overview };
  layout();
}

// Canvas: fit the camera's aspect into the stage; whole multiples of the view where they fit.
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
  const aw = Math.max(64, stage.clientWidth);
  const ah = Math.max(64, stage.clientHeight);
  const fit = Math.min(aw / camera.vw, ah / camera.vh);
  const k = Math.floor(fit);
  const scale = k >= 1 ? k : fit;
  const cssW = Math.round(camera.vw * scale);
  const cssH = Math.round(camera.vh * scale);
  const px = { w: Math.max(1, Math.round(cssW * dpr)), h: Math.max(1, Math.round(cssH * dpr)) };
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  return px;
}

function attachPointer(c: HTMLCanvasElement) {
  const toCell = (e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    return {
      x: camera.x + ((e.clientX - r.left) / r.width) * camera.vw,
      y: camera.y + ((e.clientY - r.top) / r.height) * camera.vh,
    };
  };
  const post = (kind: "down" | "move" | "up", e: PointerEvent) => {
    const p = toCell(e);
    send({ type: "pointer", kind, x: p.x, y: p.y, mat: selected, radius });
  };
  let down = false;
  let panning = false;
  let last = { x: 0, y: 0 };
  const touches = new Map<number, { x: number; y: number }>();
  const panBy = (dxPx: number, dyPx: number) => {
    const r = c.getBoundingClientRect();
    camera.x -= (dxPx / r.width) * camera.vw;
    camera.y -= (dyPx / r.height) * camera.vh;
    applyCamera();
  };
  const mid = () => {
    const v = [...touches.values()];
    return { x: (v[0].x + v[1].x) / 2, y: (v[0].y + v[1].y) / 2 };
  };
  c.addEventListener("pointerdown", (e) => {
    c.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        // A second finger turns the gesture into a pan; cancel any stroke in progress.
        if (down) post("up", e);
        down = false;
        panning = true;
        last = mid();
        return;
      }
    }
    if (e.button === 1) {
      panning = true;
      last = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    down = true;
    post("down", e);
  });
  c.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (panning && touches.size >= 2) {
        const m = mid();
        panBy(m.x - last.x, m.y - last.y);
        last = m;
        return;
      }
    } else if (panning) {
      panBy(e.clientX - last.x, e.clientY - last.y);
      last = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!down) return;
    // Coalesced events keep fast drags smooth.
    // An empty list (synthetic events, some browsers) must still paint the event itself.
    const evs = e.getCoalescedEvents?.() ?? [];
    for (const ce of evs.length ? evs : [e]) post("move", ce);
  });
  const end = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2 && e.pointerType === "touch") panning = false;
    if (e.button === 1) panning = false;
    if (!down) return;
    down = false;
    post("up", e);
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
}

// Keyboard pan (arrows / WASD, Shift for faster); Tab or O toggles the whole-world overview (game worlds).
const held = new Set<string>();
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d"].includes(k)) {
    held.add(k);
    e.preventDefault();
  } else if (k === "o" && worldKind !== 0) {
    overview = !overview;
    applyCamera();
  }
});
addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));
addEventListener("blur", () => held.clear());
setInterval(() => {
  if (!held.size || overview || worldKind === 0) return;
  const v = (held.has("shift") ? 6 : 3);
  const dx = (held.has("arrowright") || held.has("d") ? 1 : 0) - (held.has("arrowleft") || held.has("a") ? 1 : 0);
  const dy = (held.has("arrowdown") || held.has("s") ? 1 : 0) - (held.has("arrowup") || held.has("w") ? 1 : 0);
  if (dx || dy) {
    camera.x += dx * v;
    camera.y += dy * v;
    applyCamera();
  }
}, 16);
addEventListener("keydown", (e) => {
  if (e.key === "Shift") held.add("shift");
});
addEventListener("keyup", (e) => {
  if (e.key === "Shift") held.delete("shift");
});

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
    fallback.setWorld(worldW, worldH);
    fallback.setCamera(camera);
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
      fallback?.draw(m.mat, m.aux, performance.now() / 1000, camera);
      break;
    case "world":
      worldW = m.width;
      worldH = m.height;
      worldKind = m.kind;
      // Start the game-world camera on the spawn point: the centre of the surface.
      if (m.kind !== 0) {
        camera.x = worldW / 2 - GAME_VIEW.w / 2;
        camera.y = 230 - GAME_VIEW.h / 2 - 40;
      }
      fallback?.setWorld(worldW, worldH);
      applyCamera();
      if (m.kind !== 0) $("title").textContent = "Game world (local, single player)";
      break;
    case "stats":
      lastStats = m;
      renderInfo();
      break;
    case "net":
      lastNet = m;
      renderInfo();
      break;
    case "error":
      console.error("[worker]", m.error);
      info.textContent = "worker error";
      break;
  }
};
let lastStats: Extract<FromWorker, { type: "stats" }> | null = null;
let lastNet: Extract<FromWorker, { type: "net" }> | null = null;

function renderInfo() {
  const n = lastNet;
  if (!n) return;
  let status: string;
  switch (n.state) {
    case "connecting": status = "connecting"; break;
    case "reconnecting": status = "reconnecting"; break;
    case "catching-up": status = `${n.resyncs ? "resyncing" : "catching up"} ${Math.round(n.progress * 100)}%`; break;
    case "rejected": status = n.reason.includes("reload") ? "new version, reload" : n.reason; break;
    default: status = `live · ${n.players} player${n.players === 1 ? "" : "s"}`;
  }
  info.textContent = `${status}${lastStats && n.state === "live" ? ` · tick ${lastStats.tick}` : ""}${
    lastStats && localKind !== null
      ? ` · step p50 ${lastStats.stepP50.toFixed(2)} p95 ${lastStats.stepP95.toFixed(2)} ms · ${lastStats.ranChunks} chunks · ${Math.round(lastStats.uploadCells / 1000)}k cells uploaded`
      : ""
  }`;
  (window as unknown as { __stats: unknown }).__stats = lastStats;
  note.hidden = n.state !== "rejected" && !(n.state === "reconnecting");
  if (!note.hidden) note.textContent = n.state === "rejected" ? status : "Connection lost, reconnecting and replaying the world...";
  // Debug/measurement hook for the browser checks; read-only.
  (window as unknown as { __net: unknown }).__net = { ...n, tick: lastStats?.tick ?? 0, buffered: lastStats?.buffered ?? 0 };
}

worker.onerror = (e) => console.error("[worker] uncaught", e.message);

const wasmUrl = new URL(localKind !== null ? "sim-dev.wasm" : "sim.wasm", document.baseURI).href;
// Same origin as the page by default; ?server=host:port points a dev build at a separate server.
const serverParam = new URLSearchParams(location.search).get("server");
const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${serverParam ?? location.host}/ws`;
const { w, h } = layout();
const local = localKind !== null ? { kind: localKind, seed: params.get("seed") ?? "1" } : undefined;
if ("OffscreenCanvas" in window && "transferControlToOffscreen" in canvas) {
  canvas.width = w;
  canvas.height = h;
  const off = canvas.transferControlToOffscreen();
  send({ type: "init", wasmUrl, wsUrl, canvas: off, width: w, height: h, local }, [off]);
} else {
  send({ type: "init", wasmUrl, wsUrl, width: w, height: h, local });
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
// Dev hooks for the browser checks (read-only or client-only).
(window as unknown as Record<string, unknown>).__setCam = (x: number, y: number, ov = false) => {
  camera.x = x;
  camera.y = y;
  overview = ov;
  applyCamera();
};
(window as unknown as Record<string, unknown>).__setSleep = (on: boolean) => send({ type: "sleep", on });

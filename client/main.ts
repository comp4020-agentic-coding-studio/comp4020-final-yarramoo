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
// The same client serves both worlds: "/sandbox" is world 0, everything else is the game world (world 1).
const worldId = location.pathname.replace(/\/+$/, "") === "/sandbox" ? 0 : 1;
const TOKEN_KEY = "sand.token";
const NAME_KEY = "sand.name";
const store = {
  get: (k: string): string => {
    try {
      return localStorage.getItem(k) ?? "";
    } catch {
      return "";
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode: the player lasts for this tab only
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      // nothing stored
    }
  },
};
// A phone watches the game world; it does not play in it (D-011). ?spectate=1 forces it for testing.
const spectate = worldId === 1 && (params.get("spectate") === "1" || (matchMedia("(pointer: coarse)").matches && innerWidth < 900));
document.body.classList.toggle("game", worldId === 1);
// Dev-only: the production build serves no sim-dev.wasm, so the route must not exist there.
const localKind = import.meta.env.DEV && params.get("world") === "game" ? 1 : null;
if (localKind === null) $("title").textContent = worldId === 1 ? "Game world" : "Sandbox";
$("navGame").setAttribute("aria-current", worldId === 1 ? "page" : "false");
$("navSandbox").setAttribute("aria-current", worldId === 0 ? "page" : "false");

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
    // The game world has no painting: Paint is sandbox-only (the dev route aside).
    if (worldKind !== 0 && localKind === null) return;
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
/** In the networked game world with an avatar, movement keys steer it; everywhere else they pan the camera. */
const steersAvatar = () => worldId === 1 && !spectate && localKind === null;
let following = true;
function sendKeys() {
  send({
    type: "keys",
    left: held.has("arrowleft") || held.has("a"),
    right: held.has("arrowright") || held.has("d"),
    up: held.has("arrowup") || held.has("w") || held.has(" "),
  });
}
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d", " "].includes(k)) {
    if (k === " " && !steersAvatar()) return;
    held.add(k);
    e.preventDefault();
    if (steersAvatar()) sendKeys();
    else if (worldId === 1 && !following) return;
    else if (worldId === 1 && localKind === null) {
      following = false;
      send({ type: "follow", on: false });
    }
  } else if (k === "o" && worldKind !== 0) {
    overview = !overview;
    applyCamera();
  } else if (k === "f" && worldId === 1 && !steersAvatar() && localKind === null) {
    following = true;
    send({ type: "follow", on: true });
  }
});
addEventListener("keyup", (e) => {
  held.delete(e.key.toLowerCase());
  if (steersAvatar()) sendKeys();
});
addEventListener("blur", () => {
  held.clear();
  if (steersAvatar()) sendKeys();
});
setInterval(() => {
  if (!held.size || overview || worldKind === 0 || steersAvatar()) return;
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
      fallback?.draw(m.mat, m.aux, performance.now() / 1000, camera, m.rects);
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
      if (localKind !== null) $("title").textContent = "Game world (local, single player)";
      break;
    case "players":
      onPlayers(m);
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
// Player labels and the levitation bar (DOM over the canvas; render-only, never an input).
const labels = document.createElement("div");
labels.id = "labels";
stage.append(labels);
const hud = document.createElement("div");
hud.id = "hud";
hud.hidden = true;
hud.innerHTML = '<span>Levitate</span><div class="bar"><i></i></div>';
stage.append(hud);
const labelEls = new Map<number, HTMLSpanElement>();
let lastPlayers: Extract<FromWorker, { type: "players" }> | null = null;

function onPlayers(m: Extract<FromWorker, { type: "players" }>) {
  lastPlayers = m;
  if (m.following && !overview) {
    camera.x = m.cam.x;
    camera.y = m.cam.y;
    (window as unknown as { __view: unknown }).__view = { ...camera, worldW, worldH, worldKind, overview };
  }
  placeLabels();
  hud.hidden = !steersAvatar();
  (hud.querySelector("i") as HTMLElement).style.width = `${Math.round((m.energy / m.energyMax) * 100)}%`;
  (window as unknown as { __players: unknown }).__players = m.list;
}

function placeLabels() {
  const m = lastPlayers;
  if (!m) return;
  const r = canvas.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const sx = r.width / camera.vw;
  const sy = r.height / camera.vh;
  const seen = new Set<number>();
  for (const p of m.list) {
    seen.add(p.id);
    let el = labelEls.get(p.id);
    if (!el) {
      el = document.createElement("span");
      labelEls.set(p.id, el);
      labels.append(el);
    }
    el.textContent = p.name; // textContent: a name is never HTML
    el.className = p.me ? "me" : "";
    const x = r.left - sr.left + (p.x - camera.x) * sx;
    const y = r.top - sr.top + (p.y - 10 - 2 - camera.y) * sy;
    el.style.display = x < -40 || x > sr.width + 40 || y < -20 || y > sr.height + 20 ? "none" : "";
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
  }
  for (const [id, el] of labelEls) {
    if (!seen.has(id)) {
      el.remove();
      labelEls.delete(id);
    }
  }
}
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
    case "rejected":
      status = n.reason.includes("reload") ? "new version, reload" : n.reason;
      if (n.reason.includes("unknown token")) {
        // The server's database was reset: this token means nothing now. Register again.
        store.del(TOKEN_KEY);
        location.reload();
      }
      break;
    default: status = `live · ${n.players} player${n.players === 1 ? "" : "s"}`;
  }
  info.textContent = `${status}${lastStats && n.state === "live" ? ` · tick ${lastStats.tick}` : ""}${
    lastStats && (localKind !== null || params.has("stats"))
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
const httpBase = serverParam ? `${location.protocol}//${serverParam}` : "";
const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${serverParam ?? location.host}/ws`;
const local = localKind !== null ? { kind: localKind, seed: params.get("seed") ?? "1" } : undefined;

/** Ask the server for a token for this display name (plan 8, 9.1). Resolves to the token and the cleaned name. */
async function register(name: string): Promise<{ token: string; name: string }> {
  const r = await fetch(`${httpBase}/api/players`, { method: "POST", body: JSON.stringify({ display_name: name }) });
  if (!r.ok) throw new Error(r.status === 429 ? "The server is busy; try again in a minute." : `registration failed (${r.status})`);
  const j = (await r.json()) as { token: string; display_name: string };
  return { token: j.token, name: j.display_name };
}

function start(token: string, name: string) {
  const { w, h } = layout();
  const base = { wasmUrl, wsUrl, width: w, height: h, local, worldId, token, name, spectate };
  if ("OffscreenCanvas" in window && "transferControlToOffscreen" in canvas) {
    canvas.width = w;
    canvas.height = h;
    const off = canvas.transferControlToOffscreen();
    send({ type: "init", ...base, canvas: off }, [off]);
  } else {
    send({ type: "init", ...base });
    startFallback("no OffscreenCanvas");
  }
}

// The sandbox and spectators need no identity; a game-world player needs a token, from the join form the first time.
if (worldId === 1 && !spectate && localKind === null) {
  const token = store.get(TOKEN_KEY);
  if (/^[0-9a-f]{64}$/.test(token)) start(token, store.get(NAME_KEY));
  else {
    const dlg = $("join");
    dlg.hidden = false;
    const input = $<HTMLInputElement>("name");
    input.focus();
    $("joinForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = $("joinForm").querySelector("button") as HTMLButtonElement;
      btn.disabled = true;
      register(input.value)
        .then((r) => {
          store.set(TOKEN_KEY, r.token);
          store.set(NAME_KEY, r.name);
          dlg.hidden = true;
          start(r.token, r.name);
        })
        .catch((err) => {
          btn.disabled = false;
          note.hidden = false;
          note.textContent = String(err.message ?? err);
        });
    });
  }
} else {
  start("", "");
}

new ResizeObserver(() => {
  const s = layout();
  placeLabels();
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

// The room/game page: the sandbox, the fixed game world (`/game`, back-compat), and a real room joined by
// numeric id (`/r/<code>`, R3). DOM (palette, brush), pointer forwarding, and the main-thread render fallback.
// This is the pre-R3 client/main.ts, generalized: every "is this the avatar world" decision now reads the
// room's own config (`cfg.avatars === 1`) instead of comparing a URL-derived worldId to the literal 1, since a
// real room's id is never 1 (R3 brief, "The real-room join path").
import { etaText, replayRate, type Sample } from "./catchup.ts";
import { fadeAlpha, nearestPlayer, sortPlayers, stripToCamera, viewBracket, worldToStrip } from "./social.ts";
import { GAME_VIEW, MATERIALS, SANDBOX } from "./materials.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { BAR, DIG_REACH, DIG_RADIUS, HEALTH_MAX, INFINITE, SPELLS, quantiseAngle } from "./spells.ts";
import { Renderer, type Camera } from "./render.ts";
import { isMuted, play, setMuted, unlock } from "./sfx.ts";
import { formatAchievement } from "./toasts.ts";
import { CLASSIC_SANDBOX, CAVES_PVP, decodeConfig, type RoomConfig } from "../shared/room.ts";
import { HINT_SEEN_PREFIX, NAME_KEY, TOKEN_KEY, store } from "./storage.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface RoomTarget {
  /** The numeric world/room id to HELLO with. */
  worldId: number;
  /** The room's config, known before the worker connects (static for /sandbox and /game, fetched for /r/<code>). */
  cfg: RoomConfig;
  /** A display name for the header, when known (a real room's own name; null for the two fixed worlds). */
  name: string | null;
  /** Share link info for a real room, so a freshly created/joined room can show the share bar (commit 3). */
  code: string | null;
}

/** Resolve what to join from the current path: /sandbox (id 0), /game (id 1, back-compat for the old cave-world
 * deep link, see docs/research/r3-worker-report.md's "Architectural decisions" for why it moved off "/"), or
 * /r/<code> (a real room, fetched from the R2 API). Throws with a user-facing message on an unknown code. */
export async function resolveRoomTarget(pathname: string): Promise<RoomTarget> {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean === "/sandbox") return { worldId: 0, cfg: CLASSIC_SANDBOX, name: null, code: null };
  if (clean === "/game") return { worldId: 1, cfg: CAVES_PVP, name: null, code: null };
  const m = /^\/r\/([A-Za-z0-9]{1,6})$/.exec(clean);
  if (m) {
    const code = m[1];
    const res = await fetch(`/api/rooms/${code}`);
    if (!res.ok) throw new Error("No room has that code.");
    const j = (await res.json()) as { id: number; code: string; name: string; mode: string; visibility: string; config: string };
    const cfg = decodeConfig(Uint8Array.from(atob(j.config), (c) => c.charCodeAt(0)));
    if (!cfg) throw new Error("That room's config looked wrong.");
    return { worldId: j.id, cfg, name: j.name, code: j.code };
  }
  // Fallback: an unrecognised room-ish path still joins the sandbox rather than failing outright.
  return { worldId: 0, cfg: CLASSIC_SANDBOX, name: null, code: null };
}

export async function startRoom(target: RoomTarget): Promise<void> {
  const stage = $("stage");
  const info = $("info");
  const note = $("note");
  const catchupCard = $("catchup");
  const catchupSamples: Sample[] = [];

  let selected = 4;
  let radius = 4;
  let fillEmpty = false;

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
  // Fill-empty toggle (R4): paint sand without erasing rock. Client-side state only — the flag rides in
  // the Paint input's mat byte (shared/inputs.ts's encodePaint, sim/src/input.rs's FILL_EMPTY_BIT).
  const fillEmptyEl = document.getElementById("fillEmpty") as HTMLInputElement | null;
  if (fillEmptyEl) {
    fillEmptyEl.onchange = () => {
      fillEmpty = fillEmptyEl.checked;
    };
  }

  // Brush/spell-bar switch (R4): Creative is the first room with both avatars and brushes on at once
  // (cfg.brushes === 1 && cfg.avatars === 1), so the two panels need a way to coexist without one hiding
  // the other outright. Defaults to Brush; the switch itself only shows when both panels would otherwise
  // compete (see `body.dual-tools` below), which the config check after `cfg` is known sets.
  let toolMode: "brush" | "spells" = "brush";
  const toolBrushBtn = document.getElementById("toolBrush") as HTMLButtonElement | null;
  const toolSpellsBtn = document.getElementById("toolSpells") as HTMLButtonElement | null;
  function applyToolMode() {
    const showBrush = toolMode === "brush";
    palette.hidden = !showBrush;
    const brushRow = document.querySelector(".brush-row") as HTMLElement | null;
    if (brushRow) brushRow.hidden = !showBrush;
    toolBrushBtn?.setAttribute("aria-pressed", String(showBrush));
    toolSpellsBtn?.setAttribute("aria-pressed", String(!showBrush));
  }
  if (toolBrushBtn && toolSpellsBtn) {
    toolBrushBtn.onclick = () => {
      toolMode = "brush";
      applyToolMode();
      spellBar.hidden = true;
    };
    toolSpellsBtn.onclick = () => {
      toolMode = "spells";
      applyToolMode();
      spellBar.hidden = !steersAvatar() || !(lastPlayers?.spells ?? false);
    };
  }

  // Dev route: ?world=game runs a LOCAL single-player sim of the game world (no networking, the dev-only
  // wasm where Paint works). The networked path is untouched and stays on the sandbox.
  const params = new URLSearchParams(location.search);
  const worldId = target.worldId;
  const cfg = target.cfg;
  /** Is this an avatar-capable room (Deathmatch, Survival, Creative-with-avatars, or the old fixed game world)?
   * R3: the only sound test of "is this the avatar world" is the room's own config, never the id — a real
   * room's id is never 1. (`worldId === 1` survives only as a numeric join target below, never as a check.) */
  const avatarCapable = cfg.avatars === 1;
  // A phone watches an avatar room; it does not play in it (D-011, generalized: any avatars===1 room, not just
  // the old fixed id 1). ?spectate=1 forces it for testing.
  const spectate = avatarCapable && (params.get("spectate") === "1" || (matchMedia("(pointer: coarse)").matches && innerWidth < 900));
  document.body.classList.toggle("game", avatarCapable);
  // R4: Creative is the first room with both avatars and brushes on at once. Only then does the brush/
  // spell-bar switch need to show; every other room still has exactly one of the two panels, as before.
  const dualTools = avatarCapable && cfg.brushes === 1 && !spectate;
  document.body.classList.toggle("dual-tools", dualTools);
  if (dualTools) applyToolMode();
  // Dev-only: the production build serves no sim-dev.wasm, so the route must not exist there.
  const localKind = import.meta.env.DEV && params.get("world") === "game" ? 1 : null;
  /** Dev route + ?avatar=1: a local avatar (player 1) that can cast and die; painting then goes through window.__devPaint. */
  const devAvatar = localKind !== null && params.get("avatar") === "1";
  if (localKind === null) $("title").textContent = target.name ?? (avatarCapable ? "Game world" : "Sandbox");
  const menuLink = document.getElementById("menuLink");
  if (menuLink) menuLink.setAttribute("href", "/");

  // Share bar (commit 3): shown once inside a real, just-created or just-joined room.
  // Sound: the context may only start from a gesture (phone autoplay rules), so the first pointer or key resumes it.
  for (const ev of ["pointerdown", "keydown"] as const) addEventListener(ev, unlock, { capture: true });
  const muteBtn = $<HTMLButtonElement>("muteBtn");
  const showMute = () => {
    muteBtn.textContent = isMuted() ? "Sound off" : "Sound on";
    muteBtn.setAttribute("aria-pressed", String(isMuted()));
  };
  showMute();
  muteBtn.onclick = () => {
    unlock();
    setMuted(!isMuted());
    showMute();
  };
  const shareBtn = document.getElementById("shareBtn") as HTMLButtonElement | null;
  if (shareBtn && target.code) {
    shareBtn.hidden = false;
    shareBtn.onclick = async () => {
      const link = `${location.origin}/r/${target.code}`;
      try {
        await navigator.clipboard.writeText(link);
        shareBtn.textContent = "Copied!";
        setTimeout(() => (shareBtn.textContent = "Share"), 1500);
      } catch {
        prompt("Copy this link:", link);
      }
    };
  }

  // First-visit hint (commit 5): per mode (keyed by terrain+avatars+brushes, a decent proxy for "mode" without
  // threading the room's `mode` string from the server through every fixed-world path too).
  const hintEl = document.getElementById("hint") as HTMLDivElement | null;
  const hintTextEl = document.getElementById("hintText");
  if (hintEl && hintTextEl) {
    const modeKey = `${cfg.terrain}-${cfg.avatars}-${cfg.brushes}`;
    const seenKey = HINT_SEEN_PREFIX + modeKey;
    if (localKind === null && !store.get(seenKey)) {
      const text = cfg.brushes === 1 ? "Paint: pick a material, drag to place it." : avatarCapable ? "Move: WASD/arrows. Cast: click and aim. Dig through caves." : "Paint: pick a material, drag to place it.";
      hintTextEl.textContent = text;
      hintEl.hidden = false;
      const dismiss = () => {
        hintEl.hidden = true;
        store.set(seenKey, "1");
      };
      hintEl.addEventListener("pointerdown", dismiss, { once: true });
      addEventListener("keydown", dismiss, { once: true });
    }
  }

  // The world and the camera. The camera is client-only state: it is never an input (invariant 9).
  let worldW = SANDBOX;
  let worldH = SANDBOX;
  let worldKind = 0;
  let overview = false;
  /** Game-world zoom: 1, 2 or 3 times closer, as whole divisors of the 480 x 270 view so pixels stay crisp. Client-only. */
  let zoom = 1;
  const ZOOM_MAX = 3;
  const camera: Camera = { x: 0, y: 0, vw: SANDBOX, vh: SANDBOX };

  /** The window of the world on screen: the whole world for the sandbox, 480 x 270 cells for a game world. */
  function applyCamera() {
    if (worldKind === 0 || overview) {
      camera.vw = worldW;
      camera.vh = worldH;
    } else {
      camera.vw = GAME_VIEW.w / zoom;
      camera.vh = GAME_VIEW.h / zoom;
    }
    camera.x = Math.max(0, Math.min(worldW - camera.vw, camera.x));
    camera.y = Math.max(0, Math.min(worldH - camera.vh, camera.y));
    send({ type: "camera", x: Math.round(camera.x), y: Math.round(camera.y), vw: camera.vw, vh: camera.vh });
    fallback?.setCamera(camera);
    (window as unknown as { __view: unknown }).__view = { ...camera, worldW, worldH, worldKind, overview, zoom };
    zoomEl.hidden = worldKind === 0;
    zoomOut.disabled = zoom <= 1;
    zoomIn.disabled = zoom >= ZOOM_MAX;
    zoomLabel.textContent = zoom + "x";
    layout();
  }

  /** Change zoom by `d` levels around the current view centre (the worker keeps following the avatar). */
  function setZoom(next: number) {
    next = Math.max(1, Math.min(ZOOM_MAX, next));
    if (next === zoom || worldKind === 0) return;
    const cx = camera.x + camera.vw / 2;
    const cy = camera.y + camera.vh / 2;
    zoom = next;
    camera.x = cx - GAME_VIEW.w / zoom / 2;
    camera.y = cy - GAME_VIEW.h / zoom / 2;
    applyCamera();
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

  // Casting (M4b). The selected slot and the aim live here; the worker turns a "cast" message into an input.
  let selectedSpell = 0;
  let castHeld = false;
  let aimAt: { x: number; y: number } | null = null;
  /** Only a player in an avatar-capable room casts; the sandbox paints and a spectator watches. In a
   * dual-tools room (Creative), the brush/spell switch decides which the click does. */
  const castsOnClick = () => avatarCapable && !spectate && (localKind === null || devAvatar) && worldKind === 1 && (!dualTools || toolMode === "spells");

  /** Angle from my chest to the pointer, quantised to u16 here so the input never carries a float (invariant 2). */
  function castNow() {
    const me = lastPlayers?.list.find((p) => p.me);
    if (!me || !aimAt) return;
    const r = canvas.getBoundingClientRect();
    const wx = camera.x + ((aimAt.x - r.left) / r.width) * camera.vw;
    const wy = camera.y + ((aimAt.y - r.top) / r.height) * camera.vh;
    const angle = quantiseAngle(wx - me.x, wy - (me.y - 5));
    send({ type: "cast", spell: selectedSpell, angle });
  }
  // Holding the button keeps casting; the worker and the sim's cooldown pace it.
  setInterval(() => {
    if (castHeld) castNow();
  }, 100);

  let lastWheel = 0;
  function attachPointer(c: HTMLCanvasElement) {
    c.addEventListener(
      "wheel",
      (e) => {
        if (worldKind === 0) return;
        e.preventDefault();
        const now = performance.now();
        if (now - lastWheel < 120) return; // one level per notch, not per event of a trackpad flick
        lastWheel = now;
        setZoom(zoom + (e.deltaY < 0 ? 1 : -1));
      },
      { passive: false },
    );
    const toCell = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return {
        x: camera.x + ((e.clientX - r.left) / r.width) * camera.vw,
        y: camera.y + ((e.clientY - r.top) / r.height) * camera.vh,
      };
    };
    const post = (kind: "down" | "move" | "up", e: PointerEvent) => {
      // A plain avatar room has no painting (Paint is sandbox-only, the dev route aside); a dual-tools
      // room (Creative) paints whenever the brush/spell switch is set to Brush (R4).
      const paintsHere = worldKind === 0 || (dualTools && toolMode === "brush");
      if (!paintsHere && localKind === null) return;
      if (devAvatar) return;
      const p = toCell(e);
      send({ type: "pointer", kind, x: p.x, y: p.y, mat: selected, radius, fillEmpty });
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
      if (castsOnClick()) {
        // The game world: the left button casts the selected spell (aim is quantised here, before it is an input).
        aimAt = { x: e.clientX, y: e.clientY };
        castHeld = true;
        castNow();
        return;
      }
      down = true;
      post("down", e);
    });
    c.addEventListener("pointermove", (e) => {
      hoverAt = { x: e.clientX, y: e.clientY };
      placeDigPreview();
      if (castHeld) aimAt = { x: e.clientX, y: e.clientY };
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
      if (e.button === 0) castHeld = false;
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
  /** In an avatar-capable room with an avatar, movement keys steer it; everywhere else they pan the camera. */
  const steersAvatar = () => avatarCapable && !spectate && (localKind === null || devAvatar);
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
    if (castsOnClick() && k >= "1" && k <= String(BAR.length)) {
      selectedSpell = BAR[Number(k) - 1];
      placeDigPreview();
      renderSpellBar();
      return;
    }
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d", " "].includes(k)) {
      if (k === " " && !steersAvatar()) return;
      held.add(k);
      e.preventDefault();
      if (steersAvatar()) sendKeys();
      else if (avatarCapable && !following) return;
      else if (avatarCapable && localKind === null) {
        following = false;
        send({ type: "follow", on: false });
      }
    } else if ((k === "+" || k === "=") && worldKind !== 0) {
      setZoom(zoom + 1);
    } else if ((k === "-" || k === "_") && worldKind !== 0) {
      setZoom(zoom - 1);
    } else if (k === "o" && worldKind !== 0) {
      overview = !overview;
      applyCamera();
    } else if (k === "f" && avatarCapable && !steersAvatar() && localKind === null) {
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
      case "sfx":
        play(m.name, m.vol, m.pan, m.mag);
        break;
      case "toast":
        addToast(m.text);
        break;
      case "achievement": {
        const text = formatAchievement(m.id);
        if (text) addToast(text, true);
        break;
      }
      case "stats":
        lastStats = m;
        renderInfo();
        break;
      case "net":
        lastNet = m;
        renderCatchup(m);
        renderInfo();
        break;
      case "error":
        console.error("[worker]", m.error);
        info.textContent = "worker error";
        break;
    }
  };
  // Player labels and the levitation bar (DOM over the canvas; render-only, never an input).
  // Zoom control (game world only): - / level / +.
  const zoomEl = document.createElement("div");
  zoomEl.id = "zoom";
  zoomEl.hidden = true;
  const zoomOut = document.createElement("button");
  const zoomIn = document.createElement("button");
  const zoomLabel = document.createElement("span");
  zoomOut.textContent = "−";
  zoomIn.textContent = "+";
  for (const [b, label, d] of [[zoomOut, "Zoom out", -1], [zoomIn, "Zoom in", 1]] as const) {
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.onclick = () => setZoom(zoom + d);
  }
  zoomEl.append(zoomOut, zoomLabel, zoomIn);
  stage.append(zoomEl);
  const labels = document.createElement("div");
  labels.id = "labels";
  stage.append(labels);
  // Dig preview: a faint capsule outline where the dig will land (render only; the sim decides what is dug).
  const digEl = document.createElement("div");
  digEl.id = "digPreview";
  digEl.hidden = true;
  stage.append(digEl);
  let hoverAt: { x: number; y: number } | null = null;
  function placeDigPreview() {
    const me = lastPlayers?.list.find((p) => p.me);
    const pt = castHeld && aimAt ? aimAt : hoverAt;
    if (!me || me.dead || !pt || selectedSpell !== 6 || !castsOnClick()) {
      digEl.hidden = true;
      return;
    }
    const r = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const sx = r.width / camera.vw;
    const sy = r.height / camera.vh;
    const wx = camera.x + ((pt.x - r.left) / r.width) * camera.vw;
    const wy = camera.y + ((pt.y - r.top) / r.height) * camera.vh;
    const ox = me.x;
    const oy = me.y - 5; // the chest, where the sim aims from
    const len = Math.hypot(wx - ox, wy - oy) || 1;
    // A capsule: the segment from the chest DIG_REACH along the aim, thickened by DIG_RADIUS. Drawn as a rounded
    // rectangle centred on the segment's midpoint and turned to the aim.
    const cx = ox + ((wx - ox) / len) * (DIG_REACH / 2);
    const cy = oy + ((wy - oy) / len) * (DIG_REACH / 2);
    digEl.hidden = false;
    digEl.style.width = `${(DIG_REACH + 2 * DIG_RADIUS) * sx}px`;
    digEl.style.height = `${2 * DIG_RADIUS * sy}px`;
    digEl.style.borderRadius = `${DIG_RADIUS * sy}px`;
    digEl.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(wy - oy, wx - ox)}rad)`;
    digEl.style.left = `${r.left - sr.left + (cx - camera.x) * sx}px`;
    digEl.style.top = `${r.top - sr.top + (cy - camera.y) * sy}px`;
  }
  const hud = document.createElement("div");
  hud.id = "hud";
  hud.hidden = true;
  hud.innerHTML = '<span>Levitate</span><div class="bar"><i></i></div><span>Health</span><div class="bar hp"><i></i></div>';
  stage.append(hud);
  // Death overlay (dims the canvas and counts down), the death toast feed, and bag charge counts. All render-only.
  const deathEl = document.createElement("div");
  deathEl.id = "death";
  deathEl.hidden = true;
  stage.append(deathEl);
  const toastsEl = document.createElement("div");
  toastsEl.id = "toasts";
  toastsEl.setAttribute("aria-live", "polite");
  stage.append(toastsEl);
  const bagLabels = document.createElement("div");
  bagLabels.id = "bags";
  stage.append(bagLabels);
  const TOAST_MAX = 5;
  const TOAST_MS = 6000;
  function addToast(text: string, achievement = false) {
    const el = document.createElement("div");
    if (achievement) el.className = "ach";
    el.textContent = text; // textContent only: a name is never HTML
    toastsEl.append(el);
    while (toastsEl.children.length > TOAST_MAX) toastsEl.firstElementChild?.remove();
    setTimeout(() => el.classList.add("fade"), TOAST_MS - 600);
    setTimeout(() => el.remove(), TOAST_MS);
  }
  const spellBar = document.createElement("div");
  spellBar.id = "spells";
  spellBar.hidden = true;
  stage.append(spellBar);
  const slotEls = BAR.map((spell, i) => {
    const el = document.createElement("div");
    el.className = "slot";
    const sw = document.createElement("i");
    sw.className = "sw";
    sw.style.background = SPELLS[spell].colour.map((v) => Math.round(v * 255)).reduce((a, v, j) => a + v.toString(16).padStart(2, "0"), "#");
    const key = document.createElement("span");
    key.className = "key";
    key.textContent = String(i + 1);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = SPELLS[spell].name;
    const ch = document.createElement("span");
    ch.className = "ch";
    const cd = document.createElement("div");
    cd.className = "cd";
    el.append(cd, sw, key, nm, ch);
    spellBar.append(el);
    return { el, ch, cd, spell };
  });
  function renderSpellBar() {
    const v = lastPlayers?.spells ?? null;
    slotEls.forEach((s) => {
      const charges = v ? v.charges[s.spell] : 0;
      s.el.classList.toggle("sel", s.spell === selectedSpell);
      s.el.classList.toggle("empty", charges === 0);
      s.ch.textContent = charges === INFINITE ? "inf" : String(charges);
      const left = v ? v.cooldown[s.spell] : 0;
      s.cd.style.height = `${Math.min(100, Math.round((left / SPELLS[s.spell].cooldown) * 100))}%`;
    });
  }
  /** Name tags: fully solid within FADE_NEAR cells of the view centre, fading to a floor by FADE_FAR. */
  const FADE_NEAR = 110;
  const FADE_FAR = 300;
  const labelEls = new Map<number, HTMLSpanElement>();
  let lastPlayers: Extract<FromWorker, { type: "players" }> | null = null;

  function onPlayers(m: Extract<FromWorker, { type: "players" }>) {
    lastPlayers = m;
    if (m.following && !overview) {
      camera.x = m.cam.x;
      camera.y = m.cam.y;
      (window as unknown as { __view: unknown }).__view = { ...camera, worldW, worldH, worldKind, overview, zoom };
    }
    placeLabels();
    placeDigPreview();
    socialTick(false);
    hud.hidden = !steersAvatar();
    // In a dual-tools room (Creative), the spell bar only shows while the switch is set to Spells, so it
    // never competes with the brush panel for the same screen space.
    spellBar.hidden = !steersAvatar() || !m.spells || (dualTools && toolMode !== "spells");
    renderSpellBar();
    const bars = hud.querySelectorAll<HTMLElement>(".bar i");
    bars[0].style.width = `${Math.round((m.energy / m.energyMax) * 100)}%`;
    const hp = m.me ? m.me.health / HEALTH_MAX : 1;
    bars[1].style.width = `${Math.round(hp * 100)}%`;
    bars[1].style.background = healthColour(hp);
    const dead = steersAvatar() && !!m.me?.dead;
    deathEl.hidden = !dead;
    canvas.classList.toggle("dim", dead);
    if (dead) deathEl.textContent = m.me?.respawnTicks == null ? "You died: respawning" : `You died: respawning in ${Math.ceil(m.me.respawnTicks / 60)} s`;
    placeBags(m);
    (window as unknown as { __players: unknown }).__players = m.list;
    (window as unknown as { __spells: unknown }).__spells = { selected: selectedSpell, ...m.spells };
  }

  /** Green at full health through yellow to red at none. */
  function healthColour(f: number): string {
    const k = Math.max(0, Math.min(1, f));
    return `hsl(${Math.round(k * 120)}, 70%, 48%)`;
  }

  const bagEls: HTMLSpanElement[] = [];
  /** A charge count over each bag, only when zoomed in (zoom 2 or more), where the number is readable. */
  function placeBags(m: Extract<FromWorker, { type: "players" }>) {
    const show = zoom >= 2 && !overview;
    const r = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const sx = r.width / camera.vw;
    const sy = r.height / camera.vh;
    const bags = show ? m.bags : [];
    while (bagEls.length < bags.length) {
      const el = document.createElement("span");
      bagLabels.append(el);
      bagEls.push(el);
    }
    bagEls.forEach((el, i) => {
      const b = bags[i];
      if (!b) {
        el.style.display = "none";
        return;
      }
      const x = r.left - sr.left + (b.x - camera.x) * sx;
      const y = r.top - sr.top + (b.y - 5 - camera.y) * sy;
      el.textContent = String(b.total);
      el.style.display = x < -20 || x > sr.width + 20 || y < -20 || y > sr.height + 20 ? "none" : "";
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    });
  }

  function placeLabels() {
    const m = lastPlayers;
    if (!m) return;
    const r = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const sx = r.width / camera.vw;
    const sy = r.height / camera.vh;
    const seen = new Set<number>();
    const cx = camera.x + camera.vw / 2;
    const cy = camera.y + camera.vh / 2;
    for (const p of m.list) {
      seen.add(p.id);
      let el = labelEls.get(p.id);
      if (!el) {
        el = document.createElement("span");
        labelEls.set(p.id, el);
        labels.append(el);
      }
      let nm = el.firstElementChild as HTMLSpanElement | null;
      let bar = el.lastElementChild as HTMLElement | null;
      if (!nm || nm === bar) {
        el.replaceChildren();
        nm = document.createElement("span");
        nm.className = "nm";
        bar = document.createElement("i");
        bar.className = "hpbar";
        bar.append(document.createElement("b"));
        el.append(nm, bar);
      }
      nm.textContent = p.name; // textContent: a name is never HTML
      el.className = (p.me ? "me" : "") + (p.dead ? " dead" : "");
      // A thin bar under the name, only when hurt; nothing for the dead (their label greys out instead).
      const hurt = p.health < HEALTH_MAX && !p.dead;
      bar!.style.display = hurt ? "" : "none";
      if (hurt) {
        const f = p.health / HEALTH_MAX;
        const fill = bar!.firstElementChild as HTMLElement;
        fill.style.width = `${Math.round(f * 100)}%`;
        fill.style.background = healthColour(f);
      }
      const x = r.left - sr.left + (p.x - camera.x) * sx;
      const y = r.top - sr.top + (p.y - 10 - 2 - camera.y) * sy;
      el.style.display = x < -40 || x > sr.width + 40 || y < -20 || y > sr.height + 20 ? "none" : "";
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      // Far labels fade so a crowded screen stays readable; yours and near ones stay solid.
      const a = p.me ? 1 : fadeAlpha(Math.hypot(p.x - cx, p.y - cy), FADE_NEAR, FADE_FAR);
      const op = a >= 1 ? "" : a.toFixed(2);
      if (el.style.opacity !== op) el.style.opacity = op;
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

  function renderCatchup(n: Extract<FromWorker, { type: "net" }>) {
    const on = n.state === "catching-up";
    catchupCard.hidden = !on;
    if (!on) {
      catchupSamples.length = 0;
      return;
    }
    const now = performance.now();
    const lastS = catchupSamples[catchupSamples.length - 1];
    if (lastS && n.tick < lastS.tick) catchupSamples.length = 0; // a resync restarted the replay
    catchupSamples.push({ ms: now, tick: n.tick });
    while (catchupSamples.length > 40) catchupSamples.shift();
    const pct = Math.round(n.progress * 100);
    $("catchupTitle").textContent = n.resyncs ? "Resyncing…" : "Catching up with the world…";
    $("catchupFill").style.width = `${pct}%`;
    $("catchupBar").setAttribute("aria-valuenow", String(pct));
    $("catchupTicks").textContent = `${n.tick.toLocaleString()} of ${n.target.toLocaleString()} ticks`;
    $("catchupEta").textContent = `Time left: ${etaText(n.target - n.tick, replayRate(catchupSamples))}`;
  }

  function renderInfo() {
    const n = lastNet;
    if (!n) return;
    let status: string;
    switch (n.state) {
      case "connecting": status = "connecting"; break;
      case "reconnecting": status = "reconnecting"; break;
      case "catching-up": status = n.resyncs ? "resyncing" : "catching up"; break;
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
  const local = localKind !== null ? { kind: localKind, seed: params.get("seed") ?? "1", avatar: devAvatar } : undefined;

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

  // Every visitor (painter, player, phone spectator) gets a name from the join form the first time; local dev skips it.
  if (localKind === null) {
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
  (window as unknown as Record<string, unknown>).__devPaint = (x: number, y: number, mat: number, r: number) => {
    if (!devAvatar) return;
    send({ type: "pointer", kind: "down", x, y, mat, radius: r, fillEmpty: false });
    send({ type: "pointer", kind: "up", x, y, mat, radius: r, fillEmpty: false });
  };
  if (import.meta.env.DEV) {
    // Dev route only: walk the local avatar onto the nearest pickup (4 = Fire bolt, 5 = Bomb) to see those visuals.
    (window as unknown as Record<string, unknown>).__devGoto = (spell: number) => {
      if (devAvatar) send({ type: "devgoto", spell });
    };
    (window as unknown as Record<string, unknown>).__devMe = () => lastPlayers?.list.find((p) => p.me) ?? null;
  }
  (window as unknown as Record<string, unknown>).__setSleep = (on: boolean) => send({ type: "sleep", on });

  // Who's online and the minimap (game world only). Camera moves only: never an input (invariant 9, D-055).
  const miniEl = document.createElement("div");
  miniEl.id = "minimap";
  miniEl.hidden = true;
  miniEl.setAttribute("aria-label", "World minimap: click to move the camera");
  const miniView = document.createElement("div");
  miniView.className = "view";
  miniEl.append(miniView);
  stage.append(miniEl);
  const whoBtn = document.createElement("button");
  whoBtn.id = "whoBtn";
  whoBtn.type = "button";
  whoBtn.hidden = true;
  whoBtn.setAttribute("aria-expanded", "false");
  const whoEl = document.createElement("div");
  whoEl.id = "who";
  whoEl.hidden = true;
  stage.append(whoBtn, whoEl);
  const miniDots = new Map<number, HTMLElement>();
  let whoKey = "";
  let lastSocial = 0;

  /** Move the camera to `cx, cy` (cells, view top-left already computed). A spectator can follow a player instead. */
  function jumpCamera(x: number, y: number, followPlayer?: number) {
    overview = false;
    if (avatarCapable) {
      if (spectate && followPlayer !== undefined) {
        following = true;
        send({ type: "follow", on: true, id: followPlayer });
      } else if (localKind === null) {
        following = false;
        send({ type: "follow", on: false });
      }
    }
    camera.x = x;
    camera.y = y;
    applyCamera();
    socialTick(true);
  }

  function jumpTo(p: { id: number; x: number; y: number }) {
    const vw = GAME_VIEW.w / zoom;
    const vh = GAME_VIEW.h / zoom;
    jumpCamera(p.x - vw / 2, p.y - 10 - vh / 2, p.id);
  }

  function setWho(open: boolean) {
    whoEl.hidden = !open;
    whoBtn.setAttribute("aria-expanded", String(open));
    whoKey = "";
    socialTick(true);
  }
  whoBtn.onclick = () => setWho(!!whoEl.hidden);
  whoEl.onclick = (e) => {
    const b = (e.target as HTMLElement).closest("button");
    const p = b && lastPlayers?.list.find((q) => q.id === Number(b.dataset.id));
    if (p) jumpTo(p);
  };
  miniEl.addEventListener("pointerdown", (e) => {
    const r = miniEl.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    // Jump to (and, for a spectator, follow) the player nearest the tap; with nobody, slide sideways and keep depth.
    const near = nearestPlayer(lastPlayers?.list ?? [], px, py, worldW, worldH, r.width, r.height);
    if (near) return jumpTo(near);
    jumpCamera(stripToCamera(px, r.width, worldW, GAME_VIEW.w / zoom), camera.y);
  });

  /** Rebuild the list only when it changed, move the minimap a few times a second (not every frame). */
  function socialTick(force: boolean) {
    const on = worldKind === 1;
    miniEl.hidden = whoBtn.hidden = !on;
    if (!on) {
      whoEl.hidden = true;
      return;
    }
    const now = performance.now();
    if (!force && now - lastSocial < 250) return;
    lastSocial = now;
    const list = lastPlayers?.list ?? [];
    whoBtn.textContent = `Who (${list.length})`;
    whoBtn.setAttribute("aria-label", `Who is online: ${list.length}`);
    const r = miniEl.getBoundingClientRect();
    const seen = new Set<number>();
    for (const p of list) {
      seen.add(p.id);
      let d = miniDots.get(p.id);
      if (!d) {
        d = document.createElement("i");
        d.className = "dot";
        miniEl.append(d);
        miniDots.set(p.id, d);
      }
      d.className = "dot" + (p.me ? " me" : "") + (p.dead ? " dead" : "");
      d.style.left = `${worldToStrip(p.x, worldW, r.width).toFixed(1)}px`;
      d.style.top = `${worldToStrip(p.y, worldH, r.height).toFixed(1)}px`; // depth: deeper is lower in the strip
    }
    for (const [id, d] of miniDots) if (!seen.has(id)) (d.remove(), miniDots.delete(id));
    const b = viewBracket(camera.x, camera.vw, worldW, r.width);
    miniView.style.left = `${b.left.toFixed(1)}px`;
    miniView.style.width = `${b.width.toFixed(1)}px`;
    if (whoEl.hidden) return;
    const sorted = sortPlayers(list);
    const key = sorted.map((p) => `${p.id}\u0000${p.name}\u0000${p.me}\u0000${p.dead}`).join("\u0001");
    if (key === whoKey) return;
    whoKey = key;
    whoEl.replaceChildren();
    if (!sorted.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "Nobody here yet";
      whoEl.append(e);
    }
    for (const p of sorted) {
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.id = String(p.id);
      row.className = p.dead ? "dead" : "";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = p.name; // textContent: a name is never HTML
      const st = document.createElement("span");
      st.className = "st";
      st.textContent = (p.me ? "you, " : "") + (p.dead ? "dead" : "alive");
      row.append(nm, st);
      whoEl.append(row);
    }
  }
  setInterval(() => socialTick(false), 250);
}

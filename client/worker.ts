// Owns the sim, the WebSocket and the playout buffer; steps only through closed ticks from the server,
// and (when it can) renders with WebGL2 into an OffscreenCanvas.
import { KIND_CAST, KIND_JOIN, KIND_LEAVE, KIND_PAINT, KIND_POS, encodeCast, encodePaint, encodePos } from "../shared/inputs.ts";
import {
  PAINT_PAYLOAD_LEN,
  decodeServer,
  encodeHash,
  encodeHello,
  encodeInput,
  encodePing,
  encodeSnapshotUpload,
} from "../shared/protocol.ts";
import {
  ENT_PICKUP,
  ENT_PLAYER,
  ENT_PROJECTILE,
  EV_CAST,
  EV_CAST_REJECTED,
  EV_IMPACT,
  EV_KNOCK,
  loadSim,
  simBuildHash,
  type EntityView,
  type Sim,
  type SimEvent,
} from "../shared/sim.ts";
import { CAST_MIN_INTERVAL_MS, CAST_PAYLOAD_LEN, POS_SEND_EVERY_TICKS } from "../shared/avatar.ts";
import { Particles, newPoseState, pushSprite, spriteFor, updatePose, type PoseState } from "./fx.ts";
import { SPELLS } from "./spells.ts";
import { Avatar, BOX_H, BOX_W, ENERGY_MAX } from "./avatar.ts";
import { Lockstep, knockIsFresh, reactToTick } from "./lockstep.ts";
import type { FromWorker, NetState, ToWorker } from "./protocol.ts";
import { Renderer, type Camera, type Rect } from "./render.ts";

const STEP_MS = 1000 / 60;
const MAX_FRAME_STEPS = 4;
const FF_BUDGET_MS = 12;
const SEND_EVERY_MS = 33; // ~30 paint inputs/s, under the server's 40/s cap
const RECONNECT_MS = [500, 1000, 2000, 4000];

interface WorkerScope {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
}
const ctx = self as unknown as WorkerScope;
const send = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let wasmBytes: Uint8Array;
let buildHash: Uint8Array;
let wsUrl = "";
let worldId = 0;
let token = new Uint8Array(32);
let myName = "";
let spectate = false;
let renderer: Renderer | null = null;
let sendFrames = false;
let cam: Camera = { x: 0, y: 0, vw: 512, vh: 512 };
// Local single-player mode (dev route ?world=game): no networking, the worker steps its own sim at 60 Hz.
let localSim: Sim | null = null;
const stepTimes: number[] = [];
let ranChunks = 0;

// Per-connection state; discarded on reconnect (the replay rebuilds it).
let ws: WebSocket | null = null;
let ls: Lockstep | null = null;
let myId = 0;
let seedInfo: { seed: bigint; kind: number } | null = null;
let players = 0;
let net: NetState = "connecting";
let attempt = 0;
let inputSeq = 0;
let sentAt: number[] = []; // send times of my paints not yet seen applied
let latencyMs = 0;
let pingMs = 0;
let rejected = "";
let resyncs = 0;
let wantSnapshotAt = 0;

// Game world (M4a). The avatar is predicted locally and reaches the sim only as Pos inputs (invariant 1).
const names = new Map<number, string>();
let avatar: Avatar | null = null;
let avatarReady = false;
const keys = { left: false, right: false, up: false };
let followCam = true;
let isFollowing = false;
const camF = { x: 0, y: 0 };
let avAcc = 0;
let avTicks = 0;
let sinceSentPos = 0;
let lastSentPos = "";
let lastPlayersPost = 0;
/** Smoothed display positions of other players, in cells: official positions arrive about a round trip late. */
const shown = new Map<number, { x: number; y: number }>();
const POS_KEEPALIVE_TICKS = 30;
const PLAYER_COLOURS: [number, number, number][] = [
  [0.89, 0.36, 0.32], [0.33, 0.62, 0.9], [0.4, 0.78, 0.4], [0.93, 0.76, 0.3],
  [0.7, 0.45, 0.85], [0.3, 0.8, 0.8], [0.95, 0.55, 0.25], [0.85, 0.5, 0.7],
];
const SPELL_COLOURS: Record<number, [number, number, number]> = {
  2: [0.35, 0.6, 1], 3: [1, 0.45, 0.7], 4: [1, 0.6, 0.15], 5: [0.75, 0.2, 0.2],
};

// Casting and animation (M4b). Everything below is cosmetic or an input source; none of it writes sim state.
let castSeq = 0;
/** Cast preview ghosts: drawn at once from the predicted avatar, removed when the real bolt (same cast_seq) shows up. */
const ghosts: { seq: number; spell: number; x: number; y: number; vx: number; vy: number; bornMs: number }[] = [];
const GHOST_MAX_MS = 600;
let lastCastAt = 0;
const fx = new Particles();
const poses = new Map<number, PoseState>();
/** Events from applied ticks waiting for the next frame, which knows where everyone is drawn. Bounded. */
let pendingEvents: SimEvent[] = [];
let avatarLife = -1;
let lastFxAt = 0;

// Paint stroke assembly: a drag sends one segment per SEND_EVERY_MS from the last sent point.
let anchor: { x: number; y: number } | null = null;
let latest: { x: number; y: number; mat: number; radius: number } | null = null;
let dirty = false;
let lastSend = 0;

function setNet(n: NetState) {
  net = n;
  postStatus();
}

function postStatus() {
  send({
    type: "net",
    state: net,
    players,
    playerId: myId,
    reason: rejected,
    progress: ls ? ls.progress : 0,
    latencyMs,
    pingMs,
    resyncs,
  });
}

function sendPaint(mat: number, x0: number, y0: number, x1: number, y1: number, radius: number) {
  if (localSim) {
    localSim.pushInput(encodePaint(0, mat, x0, y0, x1, y1, radius));
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN || net !== "live") return;
  const payload = encodePaint(0, mat, x0, y0, x1, y1, radius).subarray(5);
  if (payload.length !== PAINT_PAYLOAD_LEN) return;
  ws.send(encodeInput(++inputSeq, KIND_PAINT, payload) as BufferSource);
  sentAt.push(performance.now());
}

function flushStroke(force: boolean) {
  if (!dirty || !anchor || !latest) return;
  const now = performance.now();
  if (!force && now - lastSend < SEND_EVERY_MS) return;
  sendPaint(latest.mat, anchor.x, anchor.y, latest.x, latest.y, latest.radius);
  anchor = { x: latest.x, y: latest.y };
  dirty = false;
  lastSend = now;
}

function worldSize(): { w: number; h: number } {
  const s = localSim ?? ls?.sim;
  return s ? { w: s.width(), h: s.height() } : { w: 512, h: 512 };
}

function onPointer(m: Extract<ToWorker, { type: "pointer" }>) {
  const { w, h } = worldSize();
  const x = Math.max(0, Math.min(w - 1, Math.round(m.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(m.y)));
  if (m.kind === "up") {
    flushStroke(true);
    anchor = latest = null;
    return;
  }
  if (m.kind === "down" || !anchor) {
    anchor = { x, y };
    latest = { x, y, mat: m.mat, radius: m.radius };
    dirty = true;
    flushStroke(true);
    return;
  }
  latest = { x, y, mat: m.mat, radius: m.radius };
  dirty = true;
  flushStroke(false);
}

function stepP95Now(): number {
  if (!stepTimes.length) return 0;
  const sorted = [...stepTimes].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function onTickApplied(tick: number, inputs: { player: number; kind: number }[]) {
  // A Join of mine after the replay means the sim has (re)activated my entity: re-place the avatar on it.
  if (ls && !ls.fastForwarding) for (const i of inputs) if (i.player === myId && i.kind === KIND_JOIN) avatarReady = false;
  if (ls && ws && ws.readyState === WebSocket.OPEN) {
    const r = reactToTick(ls, tick, wantSnapshotAt);
    if (r.hash !== undefined) ws.send(encodeHash(tick, r.hash, stepP95Now(), ls.buffered) as BufferSource);
    if (r.snapshot) {
      wantSnapshotAt = 0;
      ws.send(encodeSnapshotUpload(tick, r.snapshot.hash, r.snapshot.data) as BufferSource);
    }
  }
  // Render-only reads of the sim's events (invariant 9), except Knock, which plan 6.7 says the victim applies.
  if (ls && !ls.fastForwarding && ls.sim.width() > 512) {
    for (const e of ls.sim.events()) {
      if (e.kind === EV_KNOCK && e.player === myId && knockIsFresh(tick, ls.latestClosed) && avatar && avatarReady && !spectate) avatar.knock(e.a, e.b);
      if (pendingEvents.length < 300) pendingEvents.push(e);
    }
  }
  for (const i of inputs) {
    if (i.player === myId && i.kind === KIND_PAINT) {
      const t = sentAt.shift();
      if (t !== undefined) latencyMs = performance.now() - t;
    }
  }
}

// Presence is counted from the tick stream as it arrives (UI only; never feeds the sim).
function countPresence(inputs: { kind: number }[]) {
  for (const i of inputs) {
    if (i.kind === KIND_JOIN) players++;
    else if (i.kind === KIND_LEAVE) players--;
  }
}

/** A fresh sim per connection or resync; it is restored from the snapshot (if any) and fast-forwarded. */
function beginReplay(seed: bigint, worldKind: number, target: number, playersAtBase: number) {
  const sim: Sim = loadSim(wasmBytes);
  sim.init(seed, worldKind);
  names.clear();
  shown.clear();
  avatar = null;
  avatarReady = false;
  avatarLife = -1;
  poses.clear();
  ghosts.length = 0;
  pendingEvents = [];
  ls = new Lockstep(sim);
  ls.catchUpTarget = target;
  ls.onStepped = onTickApplied;
  players = playersAtBase;
  wantSnapshotAt = 0;
  setNet(target > 0 ? "catching-up" : "live");
  send({ type: "world", width: sim.width(), height: sim.height(), kind: worldKind });
  renderer?.setWorld(sim.width(), sim.height());
}

function connect() {
  ls = null;
  myId = 0;
  players = 0;
  sentAt = [];
  anchor = latest = null;
  setNet(attempt === 0 ? "connecting" : "reconnecting");
  const sock = new WebSocket(wsUrl);
  sock.binaryType = "arraybuffer";
  ws = sock;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  sock.onopen = () => sock.send(encodeHello(buildHash, worldId, token, spectate ? 1 : 0) as BufferSource);
  sock.onmessage = (e) => {
    if (sock !== ws) return;
    const m = decodeServer(new Uint8Array(e.data as ArrayBuffer));
    if (!m) return sock.close();
    switch (m.t) {
      case "welcome": {
        seedInfo = { seed: m.seed, kind: m.worldKind };
        beginReplay(m.seed, m.worldKind, m.tick, m.playersAtBase);
        myId = m.playerId;
        attempt = 0;
        pingTimer = setInterval(() => sock.send(encodePing(Math.round(performance.now()) >>> 0) as BufferSource), 2000);
        break;
      }
      case "snapshot":
        if (!ls) return sock.close();
        try {
          ls.loadSnapshot(m.data, m.tick);
        } catch (err) {
          console.error("[worker]", err);
          return sock.close();
        }
        break;
      case "resync":
        if (!seedInfo) return sock.close();
        resyncs++;
        beginReplay(seedInfo.seed, seedInfo.kind, m.tick, m.playersAtBase);
        break;
      case "request-snapshot":
        wantSnapshotAt = m.tick;
        break;
      case "tick":
        if (!ls) return sock.close();
        try {
          ls.push(m.tick, m.inputs);
        } catch (err) {
          console.error("[worker]", err);
          return sock.close();
        }
        countPresence(m.inputs);
        break;
      case "player-name":
        names.set(m.player, m.name);
        break;
      case "pong":
        pingMs = (performance.now() >>> 0) - m.ts;
        break;
      case "reject":
        rejected = m.reason;
        setNet("rejected");
        break;
    }
  };
  sock.onclose = (ev) => {
    clearInterval(pingTimer);
    if (sock !== ws) return;
    ls = null;
    if (ev.code === 4000) {
      // Another tab took this player over. Reconnecting would just take it back, so two tabs would fight forever.
      rejected = "This player is open in another tab";
      setNet("rejected");
      return;
    }
    if (net === "rejected") return; // do not hammer a server that said reload
    const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
    attempt++;
    setNet("reconnecting");
    setTimeout(connect, delay);
  };
  sock.onerror = () => {};
}

/** Place, step and send the avatar; return the overlay rectangles and steer the camera. Game world only. */
function gameFrame(sim: Sim, dt: number, now: number): Rect[] {
  const ents = sim.entities();
  const w = sim.width();
  const h = sim.height();
  const mine = ents.find((e) => e.type === ENT_PLAYER && e.id === myId && e.active);
  // Re-place the avatar whenever the sim's `life` for me changes (a respawn, D-073), not just on my own Join:
  // otherwise my next Pos would carry the new life with the old position and undo the respawn.
  if (avatarReady && mine && mine.a !== avatarLife) avatarReady = false;
  if (!spectate && mine && !avatarReady) {
    if (avatar) avatar.teleport(mine.x / 16, mine.y / 16);
    else avatar = new Avatar(mine.x / 16, mine.y / 16);
    avatarLife = mine.a;
    avatarReady = true;
    avAcc = 0;
    poses.delete(myId);
  }
  if (avatar && avatarReady && mine) {
    const grid = { mat: sim.matView(), w, h };
    avAcc += dt;
    const n = Math.min(Math.floor(avAcc / STEP_MS), MAX_FRAME_STEPS);
    avAcc -= Math.floor(avAcc / STEP_MS) * STEP_MS;
    for (let i = 0; i < n; i++) {
      avatar.step(keys, grid);
      // Pos every 2 ticks, quantised to 1/16 cell, with the current life; a keepalive while standing still.
      if (++avTicks % POS_SEND_EVERY_TICKS === 0) {
        const q = avatar.quantised();
        const sig = `${q.x},${q.y},${q.facing}`;
        if (sig !== lastSentPos || ++sinceSentPos >= POS_KEEPALIVE_TICKS / 2) {
          if (ws && ws.readyState === WebSocket.OPEN && net === "live") {
            ws.send(encodeInput(++inputSeq, KIND_POS, encodePos(0, mine.a, q.x, q.y, q.facing).subarray(5)) as BufferSource);
          }
          lastSentPos = sig;
          sinceSentPos = 0;
        }
      }
    }
  }

  // Other players (and, for a spectator, everyone) from their official positions, smoothed.
  const k = 1 - Math.exp(-dt / 70);
  const rects: Rect[] = [];
  const list: { id: number; name: string; x: number; y: number; me: boolean }[] = [];
  const seen = new Set<number>();
  let firstOther: EntityView | null = null;
  for (const e of ents) {
    if (e.type !== ENT_PLAYER || !e.active) continue;
    const isMe = e.id === myId && avatar !== null && avatarReady;
    let px = e.x / 16;
    let py = e.y / 16;
    if (isMe) {
      px = avatar!.x;
      py = avatar!.y;
    } else {
      seen.add(e.id);
      if (!firstOther && e.id !== myId) firstOther = e;
      const s = shown.get(e.id);
      if (!s || Math.abs(s.x - px) + Math.abs(s.y - py) > 80) shown.set(e.id, { x: px, y: py });
      else {
        s.x += (px - s.x) * k;
        s.y += (py - s.y) * k;
        px = s.x;
        py = s.y;
      }
    }
    list.push({ id: e.id, name: names.get(e.id) ?? (e.id === myId ? myName : `#${e.id}`), x: px, y: py, me: e.id === myId });
    let ps = poses.get(e.id);
    if (!ps) poses.set(e.id, (ps = newPoseState(px, py, (isMe ? avatar!.facing : e.sub) === 1)));
    if (Math.abs(px - ps.x) + Math.abs(py - ps.y) > 30) ps.x = px, ps.y = py;
    updatePose(ps, px, py, dt, now, isMe ? avatar!.onGround : null, isMe ? keys.up && !avatar!.onGround && avatar!.energy > 0 : null);
    // A figure that has not moved takes its facing from the official record (others turn without walking).
    if (!isMe && Math.abs(ps.vx) < 0.05) ps.facingRight = e.sub === 1;
    if (isMe) ps.facingRight = avatar!.facing === 1;
    pushSprite(rects, px, py, spriteFor(ps.pose, ps.pose === "walk" ? ps.walkPhase : now / 16.7), ps.facingRight, PLAYER_COLOURS[e.id % PLAYER_COLOURS.length]);
    if (isMe) rects.push({ x: Math.round(px) - 1, y: Math.round(py), w: 3, h: 1, r: 1, g: 1, b: 1 });
  }
  for (const id of shown.keys()) if (!seen.has(id)) shown.delete(id);
  for (const id of poses.keys()) if (!seen.has(id) && !(id === myId && avatar)) poses.delete(id);
  // Pickups, only the available ones in or near the view.
  for (const e of ents) {
    if (e.type !== ENT_PICKUP || !e.active) continue;
    const cx = e.x / 16;
    const cy = e.y / 16 - 1;
    if (cx < cam.x - 8 || cx > cam.x + cam.vw + 8 || cy < cam.y - 8 || cy > cam.y + cam.vh + 8) continue;
    const c = SPELL_COLOURS[e.sub] ?? [1, 1, 1];
    const pulse = 0.75 + 0.25 * Math.sin(now / 250 + e.id);
    const x0 = Math.floor(cx) - 1;
    const y0 = Math.floor(cy) - 2 - (Math.sin(now / 400 + e.id) > 0.3 ? 1 : 0);
    rects.push({ x: x0, y: y0, w: 3, h: 3, r: c[0] * pulse, g: c[1] * pulse, b: c[2] * pulse });
    rects.push({ x: x0 + 1, y: y0 + 1, w: 1, h: 1, r: 1, g: 1, b: 1 });
  }

  spellFx(ents, dt, now, rects);

  // Camera: the avatar, or for a spectator the first other player; the main thread pans freely otherwise.
  let following = false;
  const target = avatar && avatarReady ? { x: avatar.x, y: avatar.y } : spectate && firstOther ? shown.get((firstOther as EntityView).id) ?? null : null;
  if (followCam && target && cam.vw < w) {
    const tx = Math.max(0, Math.min(w - cam.vw, target.x - cam.vw / 2));
    const ty = Math.max(0, Math.min(h - cam.vh, target.y - BOX_H / 2 - cam.vh / 2));
    const f = 1 - Math.exp(-dt / 90);
    camF.x = Math.abs(tx - camF.x) > 400 ? tx : camF.x + (tx - camF.x) * f;
    camF.y = Math.abs(ty - camF.y) > 400 ? ty : camF.y + (ty - camF.y) * f;
    // Whole cells for the renderer, so the pixels do not shimmer.
    cam = { x: Math.round(camF.x), y: Math.round(camF.y), vw: cam.vw, vh: cam.vh };
    following = true;
  }
  isFollowing = following;
  if (now - lastPlayersPost >= 33) {
    lastPlayersPost = now;
    send({ type: "players", list, cam: { x: cam.x, y: cam.y }, following, energy: avatar?.energy ?? 0, energyMax: ENERGY_MAX, spells: spectate ? null : sim.playerView(myId) });
  }
  return rects;
}

const chestOf = (id: number): { x: number; y: number } | null => {
  if (id === myId && avatar && avatarReady) return { x: avatar.x, y: avatar.y - 5 };
  const p = shown.get(id);
  return p ? { x: p.x, y: p.y - 5 } : null;
};

/** Turn the queued sim events, the entities() view and the cast ghosts into particles and rectangles. */
function spellFx(ents: EntityView[], dt: number, now: number, rects: Rect[]) {
  const evs = pendingEvents;
  pendingEvents = [];
  for (const e of evs) {
    if (e.kind === EV_CAST) {
      const c = chestOf(e.player);
      const col = SPELLS[e.a]?.colour ?? [1, 1, 1];
      const ang = (e.b / 65536) * Math.PI * 2;
      if (c) {
        if (e.a === 1) fx.cone(c.x, c.y, ang, col);
        else fx.flash(c.x, c.y, ang, col);
      }
      const ps = poses.get(e.player);
      if (ps) {
        ps.castUntil = now + 220;
        if (e.player !== myId) ps.facingRight = Math.cos(ang) >= 0;
      }
      if (e.player === myId) dropGhost(e.c);
    } else if (e.kind === EV_CAST_REJECTED) {
      if (e.player === myId) dropGhost(e.c);
    } else if (e.kind === EV_KNOCK) {
      const ps = poses.get(e.player);
      if (ps) ps.hitUntil = now + 380;
      const c = chestOf(e.player);
      if (c) fx.streak(c.x, c.y, e.a, e.b);
    } else if (e.kind === EV_IMPACT) {
      fx.burst(e.a + 0.5, e.b + 0.5, SPELLS[e.c]?.colour ?? [1, 1, 1], e.c === 2 ? 20 : 14);
    }
  }
  // Real bolts: a body and a trail puff each frame.
  for (const q of ents) {
    if (q.type !== ENT_PROJECTILE) continue;
    const col = SPELLS[q.sub]?.colour ?? [1, 1, 1];
    const x = q.x / 16;
    const y = q.y / 16;
    if (q.id === myId) dropGhost(q.a);
    fx.trail(x, y, col);
    rects.push({ x: Math.round(x) - 1, y: Math.round(y) - 1, w: 2, h: 2, r: col[0], g: col[1], b: col[2] });
    rects.push({ x: Math.round(x) - 1, y: Math.round(y) - 1, w: 1, h: 1, r: 1, g: 1, b: 1 });
  }
  // Ghosts: the same flight, predicted from the avatar's position at click time, drawn at once.
  const ticks = dt / (1000 / 60);
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i];
    if (now - g.bornMs > GHOST_MAX_MS) {
      ghosts.splice(i, 1);
      continue;
    }
    const col = SPELLS[g.spell]?.colour ?? [1, 1, 1];
    g.vy += SPELLS[g.spell].gravity * ticks;
    g.x += g.vx * ticks;
    g.y += g.vy * ticks;
    const blast = g.spell === 1;
    const size = blast ? 3 : 2;
    rects.push({ x: Math.round(g.x) - 1, y: Math.round(g.y) - 1, w: size, h: size, r: col[0], g: col[1], b: col[2], a: 0.55 });
  }
  fx.update(Math.min(now - lastFxAt, 100));
  lastFxAt = now;
  fx.toRects(rects);
}

function dropGhost(seq: number) {
  const i = ghosts.findIndex((g) => g.seq === seq);
  if (i >= 0) ghosts.splice(i, 1);
}

/** The cast message from the main thread: quantised angle in, an input out, and a ghost drawn now. */
function onCast(spell: number, angle: number) {
  if (spectate || !avatar || !avatarReady || !ws || ws.readyState !== WebSocket.OPEN || net !== "live") return;
  const now = performance.now();
  if (now - lastCastAt < CAST_MIN_INTERVAL_MS) return; // Pos + casts stay under the server's rate limit
  lastCastAt = now;
  if (spell < 0 || spell >= SPELLS.length) return;
  const seq = ++castSeq & 0xffff;
  const payload = encodeCast(0, spell, angle & 0xffff, seq).subarray(5);
  if (payload.length !== CAST_PAYLOAD_LEN) return;
  ws.send(encodeInput(++inputSeq, KIND_CAST, payload) as BufferSource);
  const rad = ((angle & 0xffff) / 65536) * Math.PI * 2;
  avatar.facing = Math.cos(rad) >= 0 ? 1 : 0;
  const ps = poses.get(myId);
  if (ps) {
    ps.castUntil = now + 220;
    ps.facingRight = avatar.facing === 1;
  }
  // The ghost only when the HUD says the cast will go through (cosmetic; the input was sent regardless).
  const v = ls?.sim.playerView(myId);
  const ready = !v || (v.charges[spell] > 0 && v.cooldown[spell] === 0);
  if (ready && SPELLS[spell].enabled) {
    const sp = SPELLS[spell];
    ghosts.push({ seq, spell, x: avatar.x, y: avatar.y - 5, vx: Math.cos(rad) * sp.speed, vy: Math.sin(rad) * sp.speed, bornMs: now });
  }
}

let acc = 0;
let last = 0;
let statSteps = 0;
let statStart = 0;

function frame(now: number) {
  const dt = Math.min(now - last, 250);
  last = now;
  flushStroke(false);
  if (localSim) {
    acc += dt;
    const n = Math.min(Math.floor(acc / STEP_MS), MAX_FRAME_STEPS);
    acc -= Math.floor(acc / STEP_MS) * STEP_MS;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      localSim.step();
      stepTimes.push(performance.now() - t0);
      if (stepTimes.length > 600) stepTimes.shift();
      statSteps++;
    }
    ranChunks = localSim.ranChunks();
    if (renderer) {
      renderer.draw(localSim.matView(), localSim.auxView(), now / 1000, cam);
    } else if (sendFrames) {
      const m = localSim.matView().slice();
      const a = localSim.auxView().slice();
      send({ type: "frame", mat: m, aux: a, tick: localSim.tick(), rects: [] }, [m.buffer, a.buffer]);
    }
  } else if (ls) {
    if (net === "catching-up") {
      ls.fastForward(FF_BUDGET_MS);
      statSteps = 0;
      if (!ls.fastForwarding) {
        acc = 0;
        setNet("live");
      }
    } else {
      acc += dt;
      const base = Math.min(Math.floor(acc / STEP_MS), MAX_FRAME_STEPS);
      acc -= Math.floor(acc / STEP_MS) * STEP_MS;
      const t0 = performance.now();
      const ran = ls.run(ls.plan(base));
      if (ran > 0) {
        stepTimes.push((performance.now() - t0) / ran);
        if (stepTimes.length > 600) stepTimes.shift();
      }
      statSteps += ran;
    }
    if (ls) {
      ranChunks = ls.sim.ranChunks();
      const rects = net === "live" && ls.sim.width() > 512 ? gameFrame(ls.sim, dt, now) : [];
      if (renderer) {
        renderer.draw(ls.sim.matView(), ls.sim.auxView(), now / 1000, cam, rects);
      } else if (sendFrames) {
        const m = ls.sim.matView().slice();
        const a = ls.sim.auxView().slice();
        send({ type: "frame", mat: m, aux: a, tick: ls.simTick, rects }, [m.buffer, a.buffer]);
      }
    }
  }
  if (now - statStart > 500) {
    const sorted = [...stepTimes].sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
    send({
      type: "stats",
      tick: localSim ? localSim.tick() : ls ? ls.simTick : 0,
      stepsPerSec: (statSteps * 1000) / (now - statStart),
      buffered: ls ? ls.buffered : 0,
      stepP50: q(0.5),
      stepP95: q(0.95),
      ranChunks,
      uploadCells: renderer?.lastUploadCells ?? 0,
    });
    postStatus();
    statSteps = 0;
    statStart = now;
  }
}

function loop() {
  const tickFn = (t: number) => {
    frame(t);
    schedule();
  };
  const schedule = () => {
    if (renderer && typeof ctx.requestAnimationFrame === "function") ctx.requestAnimationFrame(tickFn);
    else setTimeout(() => tickFn(performance.now()), 16);
  };
  last = statStart = performance.now();
  schedule();
}

async function init(m: Extract<ToWorker, { type: "init" }>) {
  wasmBytes = new Uint8Array(await (await fetch(m.wasmUrl)).arrayBuffer());
  buildHash = new Uint8Array(32);
  const hex = await simBuildHash(wasmBytes);
  for (let i = 0; i < 32; i++) buildHash[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  wsUrl = m.wsUrl;
  worldId = m.worldId;
  myName = m.name;
  spectate = m.spectate;
  for (let i = 0; i < 32; i++) token[i] = parseInt(m.token.slice(2 * i, 2 * i + 2), 16) || 0;
  if (m.canvas) {
    try {
      m.canvas.width = m.width;
      m.canvas.height = m.height;
      renderer = new Renderer(m.canvas);
      console.log("[worker] render path: WebGL2 on OffscreenCanvas in worker");
      send({ type: "ready", path: "worker-webgl2" });
    } catch (e) {
      send({ type: "render-failed", error: String(e) });
    }
  } else {
    sendFrames = true;
    send({ type: "ready", path: "main-thread-fallback" });
  }
  if (m.local) {
    const sim = loadSim(wasmBytes);
    sim.init(BigInt(m.local.seed), m.local.kind);
    localSim = sim;
    setNet("live");
    send({ type: "world", width: sim.width(), height: sim.height(), kind: m.local.kind });
    renderer?.setWorld(sim.width(), sim.height());
  } else {
    connect();
  }
  loop();
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "init":
      init(m).catch((err) => send({ type: "error", error: String(err?.stack ?? err) }));
      break;
    case "resize":
      renderer?.resize(m.width, m.height);
      break;
    case "frames":
      renderer = null;
      sendFrames = true;
      break;
    case "pointer":
      onPointer(m);
      break;
    case "camera":
      // While the worker steers the camera it keeps its own position; the main thread still sets the view size.
      cam = isFollowing ? { ...cam, vw: m.vw, vh: m.vh } : { x: m.x, y: m.y, vw: m.vw, vh: m.vh };
      if (!isFollowing) {
        camF.x = m.x;
        camF.y = m.y;
      }
      break;
    case "sleep":
      localSim?.setSleepEnabled(m.on);
      break;
    case "cast":
      onCast(m.spell, m.angle);
      break;
    case "keys":
      keys.left = m.left;
      keys.right = m.right;
      keys.up = m.up;
      break;
    case "follow":
      followCam = m.on;
      break;
  }
};

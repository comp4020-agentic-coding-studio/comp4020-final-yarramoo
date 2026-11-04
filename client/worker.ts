// Owns the sim, the WebSocket and the playout buffer; steps only through closed ticks from the server,
// and (when it can) renders with WebGL2 into an OffscreenCanvas.
import { KIND_CAST, KIND_JOIN, KIND_LEAVE, KIND_PAINT, KIND_POS, KIND_READY, encodeCast, encodeJoin, encodePaint, encodePos, encodeReady } from "../shared/inputs.ts";
import {
  PAINT_PAYLOAD_LEN,
  decodeServer,
  encodeClaim,
  encodeClaimEvent,
  CLAIM_KILL,
  CLAIM_ROUND_START,
  CLAIM_ROUND_END,
  encodeChunkHashes,
  encodeHash,
  encodeHello,
  encodeLive,
  encodeInput,
  encodePing,
  encodeSnapshotUpload,
} from "../shared/protocol.ts";
import { resolveSky } from "./sky.ts";
import { decodeConfig, encodeConfig, SURVIVAL } from "../shared/room.ts";
import {
  ENT_BAG,
  ENT_HEAL,
  EV_HEAL,
  ENT_ENEMY,
  ENT_READY,
  ENT_ROUND,
  EV_ROUND_START,
  ENT_PICKUP,
  ENT_PLAYER,
  ENT_PROJECTILE,
  EV_CAST,
  EV_BAG_PICKUP,
  EV_CAST_REJECTED,
  EV_DEATH,
  EV_ENEMY_DEATH,
  EV_ENEMY_HURT,
  EV_ROUND_END,
  EV_EXPLODE,
  EV_IMPACT,
  EV_KNOCK,
  EV_PICKUP,
  EV_RESPAWN,
  loadSim,
  simBuildHash,
  type EntityView,
  type Sim,
  type SimEvent,
} from "../shared/sim.ts";
import { CAST_MIN_INTERVAL_MS, CAST_PAYLOAD_LEN, POS_SEND_EVERY_TICKS } from "../shared/avatar.ts";
import type { SfxName } from "./sfx.ts";
import { pushColossus, Particles, newPoseState, pushBag, pushHeal, pushBolt, pushBomb, pushBoss, pushEnemy, pushSprite, spriteFor, updatePose, type PoseState } from "./fx.ts";
import { BOMB_RADIUS, DEATH_TICKS, SPELL_QUAKE, SPELL_WALL, SPELLS } from "./spells.ts";
import { lookupHover } from "./hover.ts";
import { UNKNOWN_NAME, formatDeath, youDiedText } from "./toasts.ts";
import { Avatar, BOX_H, BOX_W, ENERGY_MAX } from "./avatar.ts";
import { Lockstep, driveFrame, knockIsFresh, reactToTick } from "./lockstep.ts";
import type { FromWorker, NetState, ToWorker } from "./protocol.ts";
import { Renderer, type Camera, type Rect } from "./render.ts";
import { hitboxTouchesLava, shouldSizzle } from "./hazard.ts";
import { MATERIAL_CLASS } from "../shared/names.ts";

let STEP_MS = 1000 / 60;
let paused = false;
const MAX_FRAME_STEPS = 4;
const FF_BUDGET_MS = 12;
/** While replaying, draw the world at most this often so the visitor sees it evolve without the draw eating replay time. */
const FF_DRAW_INTERVAL_MS = 250;
let lastFfDraw = -Infinity;
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
/** Debug view: outline the active box (plan 6.5), mirrored from sim/src/tuning.rs and grid.rs (pinned by a net test). */
let showActiveBox = false;
const ACTIVE_W = 576;
const ACTIVE_H = 320;
const CHUNK = 64;

// Per-connection state; discarded on reconnect (the replay rebuilds it).
let ws: WebSocket | null = null;
let ls: Lockstep | null = null;
let myId = 0;
/** The real config bytes from WELCOME, kept for a resync's beginReplay (R3: a real room has no bare "kind"). */
let skyOverride: string | undefined;
let skyReduced = false;
let seedInfo: { seed: bigint; cfg: Uint8Array } | null = null;
/** The networked room has avatars (its config's `avatars` byte); set in `beginReplay`. Decides the game frame. */
let netAvatars = false;
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
/** A spectator's chosen player to follow (camera only, never an input); null: the first other player. */
let followId: number | null = null;
let isFollowing = false;
const camF = { x: 0, y: 0 };
let avAcc = 0;
let avTicks = 0;
let sinceSentPos = 0;
let lastSentPos = "";
let lastPlayersPost = 0;
let lastTerrainPost = 0;
const TERRAIN_COLS = 256;
const TERRAIN_ROWS = 24;
/** Minimap silhouette: each mask cell is solid when the middle of its block holds a solid material. A 4x4 sample per block, once a second:
 * 256 x 24 x 16 = ~98k reads, never the full grid. Render-only. */
function postTerrain(mat: Uint8Array, w: number, h: number) {
  const mask = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS);
  const bw = w / TERRAIN_COLS;
  const bh = h / TERRAIN_ROWS;
  for (let r = 0; r < TERRAIN_ROWS; r++) {
    for (let c = 0; c < TERRAIN_COLS; c++) {
      let solid = 0;
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const m = mat[Math.min(h - 1, Math.floor((r + (j + 0.5) / 4) * bh)) * w + Math.min(w - 1, Math.floor((c + (i + 0.5) / 4) * bw))];
          // The one material table (D-154), so a new solid shows here without another list: Ice, Glass and Coal did not.
          if (MATERIAL_CLASS[m] === "solid") solid++;
        }
      }
      mask[r * TERRAIN_COLS + c] = solid >= 8 ? 1 : 0;
    }
  }
  send({ type: "terrain", cols: TERRAIN_COLS, rows: TERRAIN_ROWS, mask }, [mask.buffer]);
}
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
/** The tab is hidden: no Pos, no casts. Not a Leave (that would reset lobby countdowns for an alt-tab). */
let tabHidden = false;
/** Cast preview ghosts: drawn at once from the predicted avatar, removed when the real bolt (same cast_seq) shows up. */
const ghosts: { seq: number; spell: number; x: number; y: number; vx: number; vy: number; bornMs: number }[] = [];
const GHOST_MAX_MS = 600;
let lastCastAt = 0;
const fx = new Particles();
const poses = new Map<number, PoseState>();
/** Events from applied ticks waiting for the next frame, which knows where everyone is drawn. Bounded. */
let pendingEvents: SimEvent[] = [];
/** Render-side copy of the damage-relevant events, posted with the players list for the soak script (`__evLog`). Never read back. */
let evLogOut: { k: number; p: number; a: number; b: number; c: number }[] = [];
let avatarLife = -1;
/** Sim tick of my latest EV_DEATH, for the respawn countdown only (UI; the sim owns the real deadline). Null: unknown. */
let myDeathTick: number | null = null;
/** Text for my latest death ("Killed by a Fire imp"), and the deepest y any player has been seen at (cells). Display only. */
let myDeathText: string | null = null;
let deepestSeen = 0;
/** Screen shake: whole-cell camera offsets until this time. Render-only. */
let shakeUntil = 0;
let shakeMag = 0;
let shakeDur = 320;
/** Raise the shake to at least `mag` cells for `ms`; a weaker shake never cuts a stronger one short. */
function shake(now: number, mag: number, ms: number) {
  if (now < shakeUntil && mag < shakeMag * ((shakeUntil - now) / shakeDur)) return;
  shakeUntil = now + ms;
  shakeMag = mag;
  shakeDur = ms;
}
let explosionsThisFrame = 0;
let iAmDead = false;
/** The room has one life (`death` 1): a dead player spectates a living teammate. Render-only (camera). */
let oneLife = false;
/** The round banner has been posted once (from state or from the event). */
let roundShown = false;
/** F6b: the late-arrival check runs once per connection, the first time my player appears in the sim. */
let lateChecked = false;
let lateOffer = false;
/** Last seen y of each enemy and when it was hit (ms), for the squash/stretch and the white flash. Render-only. */
const enemySeen = new Map<number, { x: number; y: number; vy: number; hitAt: number; kind: number }>();
/** Last time (ms) a worm rumble played, and the max hp of each enemy kind (render-only table mirroring tuning.rs). */
let lastRumble = 0;
/** Enemy owners with a bolt in flight last frame, so each new bolt crackles once (pruned every frame). */
let enemyBoltSeen = new Set<number>();
let bossPhase = 0;
let bossHud: { kind: number; hp: number; max: number; phase: number; x: number; y: number } | null = null;
const ENEMY_MAX_HP = [20, 30, 60, 90, 800, 40, 30, 600];
/** Dev route only: the local single-player sim has an avatar for this player id. */
const DEV_ID = 1;
let lastFxAt = 0;

// Paint stroke assembly: a drag sends one segment per SEND_EVERY_MS from the last sent point.
let anchor: { x: number; y: number } | null = null;
let latest: { x: number; y: number; mat: number; radius: number; fillEmpty: boolean } | null = null;
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
    tick: ls ? ls.simTick : 0,
    target: ls ? ls.catchUpTarget : 0,
    latencyMs,
    pingMs,
    resyncs,
  });
}

function sendPaint(mat: number, x0: number, y0: number, x1: number, y1: number, radius: number, fillEmpty: boolean) {
  if (localSim) {
    localSim.pushInput(encodePaint(0, mat, x0, y0, x1, y1, radius, fillEmpty));
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN || net !== "live") return;
  const payload = encodePaint(0, mat, x0, y0, x1, y1, radius, fillEmpty).subarray(5);
  if (payload.length !== PAINT_PAYLOAD_LEN) return;
  ws.send(encodeInput(++inputSeq, KIND_PAINT, payload) as BufferSource);
  sentAt.push(performance.now());
}

function flushStroke(force: boolean) {
  if (!dirty || !anchor || !latest) return;
  const now = performance.now();
  if (!force && now - lastSend < SEND_EVERY_MS) return;
  sendPaint(latest.mat, anchor.x, anchor.y, latest.x, latest.y, latest.radius, latest.fillEmpty);
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
    latest = { x, y, mat: m.mat, radius: m.radius, fillEmpty: m.fillEmpty };
    dirty = true;
    flushStroke(true);
    return;
  }
  latest = { x, y, mat: m.mat, radius: m.radius, fillEmpty: m.fillEmpty };
  dirty = true;
  flushStroke(false);
}

function stepP95Now(): number {
  if (!stepTimes.length) return 0;
  const sorted = [...stepTimes].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/** Tell the server this client has caught up, so it can stop holding the world's clock for it (D-122). */
function sendLive() {
  if (ls && ws && ws.readyState === WebSocket.OPEN) ws.send(encodeLive(ls.sim.tick()) as BufferSource);
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
  if (ls && !ls.fastForwarding && netAvatars) {
    for (const e of ls.sim.events()) {
      if (e.kind === EV_DEATH && e.player === myId) myDeathTick = tick; // countdown display only
      // A report to the server, never a sim input (invariant 9, D-120). Only past the replay target, like HASH (D-038):
      // a replaying client would re-claim every old death. Spectators claim too: they run the same sim.
      if (e.kind === EV_DEATH && ws && ws.readyState === WebSocket.OPEN && tick > ls.catchUpTarget) ws.send(encodeClaim(tick, e.player, e.a, e.b, e.c) as BufferSource);
      // F7: the other outcomes the server cannot see (it never steps the sim). The same rules as a death claim: reports only.
      if (ws && ws.readyState === WebSocket.OPEN && tick > ls.catchUpTarget) {
        if (e.kind === EV_ENEMY_DEATH) ws.send(encodeClaimEvent(CLAIM_KILL, tick, e.player, e.a, e.b, e.c) as BufferSource);
        else if (e.kind === EV_ROUND_START) ws.send(encodeClaimEvent(CLAIM_ROUND_START, tick, e.a, 0, 0, 0) as BufferSource);
        else if (e.kind === EV_ROUND_END) {
          // The sim's own alive set: a player entity with health above zero (a living player who disconnected still counts, D-160).
          const players = ls.sim.entities().filter((q) => q.type === ENT_PLAYER);
          ws.send(encodeClaimEvent(CLAIM_ROUND_END, tick, e.a, players.length, 0, 0, players.filter((q) => q.health > 0).map((q) => q.id).sort((x, y) => x - y)) as BufferSource);
        }
      }
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

/**
 * A fresh sim per connection or resync; it is restored from the snapshot (if any) and fast-forwarded.
 * `cfg` is WELCOME's real 16-byte room config (R3), not the derived bare `worldKind` byte — a real joined
 * room's config never matches either fixed world's, so initing from the bare kind would hand the sim the
 * wrong world entirely. `shared/sim.ts`'s `init` already accepts a `Uint8Array` config directly.
 */
function applySky(seed: bigint): { sky: number; skyMotion: boolean } {
  const sky = resolveSky(seed, skyOverride);
  renderer?.setSky(sky, !skyReduced);
  return { sky, skyMotion: !skyReduced };
}

function beginReplay(seed: bigint, cfg: Uint8Array, target: number, playersAtBase: number) {
  const sim: Sim = loadSim(wasmBytes);
  sim.init(seed, cfg);
  roundShown = false;
  lateChecked = false;
  lateOffer = false;
  names.clear();
  shown.clear();
  avatar = null;
  avatarReady = false;
  avatarLife = -1;
  myDeathTick = null;
  poses.clear();
  ghosts.length = 0;
  pendingEvents = [];
  ls = new Lockstep(sim);
  ls.catchUpTarget = target;
  ls.onStepped = onTickApplied;
  players = playersAtBase;
  wantSnapshotAt = 0;
  setNet(target > 0 ? "catching-up" : "live");
  if (target === 0) sendLive(); // nothing to replay: live at once (after a reset or on a fresh world)
  // `kind` here is just "has avatars" (0/1), kept for main.ts's existing worldKind !== 0 render checks; the
  // real per-mode decisions (casting, damage, brushes...) read `cfg` itself, decoded below.
  const rc = decodeConfig(cfg);
  oneLife = rc?.death === 1;
  const kind = rc?.avatars === 1 ? 1 : 0;
  netAvatars = kind === 1;
  send({ type: "world", width: sim.width(), height: sim.height(), kind, cfg: rc, caves: rc?.terrain === 0, ...applySky(seed) });
  renderer?.setWorld(sim.width(), sim.height(), rc?.terrain === 0);
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
        seedInfo = { seed: m.seed, cfg: m.cfg };
        beginReplay(m.seed, m.cfg, m.tick, m.playersAtBase);
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
        beginReplay(seedInfo.seed, seedInfo.cfg, m.tick, m.playersAtBase);
        break;
      case "request-snapshot":
        wantSnapshotAt = m.tick;
        break;
      case "request-chunk-hashes":
        // A diagnosis (D-126): the server wants this checkpoint's per-chunk hashes. An empty reply says it has left the ring.
        if (ls) sock.send(encodeChunkHashes(m.tick, ls.chunkHashesAt(m.tick) ?? new BigUint64Array(0)) as BufferSource);
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
      case "achievement":
        send({ type: "achievement", id: m.id });
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
    if (ev.code === 4001) {
      // F7: the server's resync budget ran out (3 a minute). Reconnecting would just desync again; say so and stop.
      rejected = "Out of sync, reload";
      setNet("rejected");
      return;
    }
    // 4002 (the server saw nothing from us for 10 s) is a dead link, not a refusal: fall through and reconnect as usual.
    if (net === "rejected") return; // do not hammer a server that said reload
    const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
    attempt++;
    setNet("reconnecting");
    setTimeout(connect, delay);
  };
  sock.onerror = () => {};
}

/** My health last frame, or null when there was none (not joined, dead, spectating): a spawn is not a hit. */
let prevHealth: number | null = null;
let lastCombatPost = -1e9;
/** Tell the main thread the local player is in a fight (music only); throttled, and silent while replaying. */
function combatSignal(now: number, quiet: boolean) {
  if (quiet || now - lastCombatPost < 500) return;
  lastCombatPost = now;
  send({ type: "combat" });
}
let lastSizzle = -1e9;
/** Place, step and send the avatar; return the overlay rectangles and steer the camera. Game world only. */
function gameFrame(sim: Sim, dt: number, now: number): Rect[] {
  const ents = sim.entities();
  const w = sim.width();
  const h = sim.height();
  const mine = ents.find((e) => e.type === ENT_PLAYER && e.id === myId && e.active);
  const dead = !!mine && mine.health === 0;
  iAmDead = dead;
  if (mine && !dead) myDeathTick = null;
  // Lava sizzle (display only): my health fell while lava touches my hitbox. Rate-limited; silent while replaying.
  if (mine && !dead && !spectate) {
    const hurt = prevHealth !== null && prevHealth > mine.health;
    const touching = hurt && hitboxTouchesLava(sim.matView(), w, h, mine.x, mine.y);
    if (hurt && !touching) combatSignal(now, net === "catching-up" || !!ls?.fastForwarding);
    if (prevHealth !== null && shouldSizzle(prevHealth, mine.health, touching, now, lastSizzle)) {
      lastSizzle = now;
      if (evLogOut.length < 100) evLogOut.push({ k: 900, p: myId, a: mine.health, b: 0, c: 0 }); // dev-route log only: a sizzle was requested
      sfxBudget = Math.max(sfxBudget, 1);
      sfxSelf("sizzle", net === "catching-up" || !!ls?.fastForwarding);
    }
  }
  prevHealth = mine && !dead && !spectate ? mine.health : null;
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
  // While dead the controller is frozen: no steps, no Pos (the sim ignores Pos while dead anyway; this just stops a
  // visible rubber-band). Nothing is ever sent BECAUSE of a death: this only stops sending.
  if (dead) avAcc = 0;
  if (tabHidden) avAcc = 0;
  if (avatar && avatarReady && mine && !dead && !tabHidden) {
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
          if (localSim) {
            localSim.pushInput(encodePos(myId, mine.a, q.x, q.y, q.facing));
          } else if (ws && ws.readyState === WebSocket.OPEN && net === "live") {
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
  const list: { id: number; name: string; x: number; y: number; me: boolean; health: number; dead: boolean; rgb: [number, number, number] }[] = [];
  const seen = new Set<number>();
  let firstOther: EntityView | null = null;
  let firstAlive: EntityView | null = null;
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
      if (!firstAlive && e.id !== myId && e.health > 0) firstAlive = e;
      const s = shown.get(e.id);
      if (!s || Math.abs(s.x - px) + Math.abs(s.y - py) > 80) shown.set(e.id, { x: px, y: py });
      else {
        s.x += (px - s.x) * k;
        s.y += (py - s.y) * k;
        px = s.x;
        py = s.y;
      }
    }
    if (e.health > 0 && py > deepestSeen) deepestSeen = py;
    list.push({ id: e.id, name: nameOf(e.id) ?? UNKNOWN_NAME, x: px, y: py, me: e.id === myId, health: e.health, dead: e.health === 0, rgb: PLAYER_COLOURS[e.id % PLAYER_COLOURS.length].map((v) => Math.round(v * 255)) as [number, number, number] });
    let ps = poses.get(e.id);
    if (!ps) poses.set(e.id, (ps = newPoseState(px, py, (isMe ? avatar!.facing : e.sub) === 1)));
    if (Math.abs(px - ps.x) + Math.abs(py - ps.y) > 30) ps.x = px, ps.y = py;
    updatePose(ps, px, py, dt, now, isMe ? avatar!.onGround : null, isMe ? keys.up && !avatar!.onGround && avatar!.energy > 0 : null);
    // A figure that has not moved takes its facing from the official record (others turn without walking).
    if (!isMe && Math.abs(ps.vx) < 0.05) ps.facingRight = e.sub === 1;
    if (isMe) ps.facingRight = avatar!.facing === 1;
    // White flash for the first 120 ms after a knock.
    const hf = Math.max(0, 1 - (now - ps.hitAt) / 120);
    const bc = PLAYER_COLOURS[e.id % PLAYER_COLOURS.length];
    const body: [number, number, number] = hf > 0 ? [bc[0] + (1 - bc[0]) * hf, bc[1] + (1 - bc[1]) * hf, bc[2] + (1 - bc[2]) * hf] : bc;
    if (e.health > 0) pushSprite(rects, px, py, spriteFor(ps.pose, ps.pose === "walk" ? ps.walkPhase : now / 16.7), ps.facingRight, body, ps.castCol, now / 16.7);
    if (isMe && e.health > 0) {
      rects.push({ x: Math.round(px) - 1, y: Math.round(py), w: 3, h: 1, r: 1, g: 1, b: 1 });
      // A small white chevron above the head marks me among the others (the sprite is 10 rows tall from the feet).
      const mx = Math.round(px) - 1;
      const my = Math.round(py) - 14;
      rects.push({ x: mx, y: my, w: 3, h: 1, r: 1, g: 1, b: 1, a: 0.9 });
      rects.push({ x: mx + 1, y: my + 1, w: 1, h: 1, r: 1, g: 1, b: 1, a: 0.9 });
    }
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
    // A soft two-step halo (7x7 then 5x5, low alpha) so a 3 px pickup is findable at 1x.
    rects.push({ x: x0 - 2, y: y0 - 2, w: 7, h: 7, r: c[0], g: c[1], b: c[2], a: 0.12 * pulse });
    rects.push({ x: x0 - 1, y: y0 - 1, w: 5, h: 5, r: c[0], g: c[1], b: c[2], a: 0.22 * pulse });
    rects.push({ x: x0, y: y0, w: 3, h: 3, r: c[0] * pulse, g: c[1] * pulse, b: c[2] * pulse });
    rects.push({ x: x0 + 1, y: y0 + 1, w: 1, h: 1, r: 1, g: 1, b: 1 });
  }

  // Dropped bags: drawn from entities() (position and total only; render-only), keyed by position, never by id.
  const bags: { x: number; y: number; total: number }[] = [];
  for (const e of ents) {
    if (e.type !== ENT_BAG) continue;
    const cx = e.x / 16;
    const cy = e.y / 16;
    bags.push({ x: cx, y: cy, total: e.a });
    if (cx < cam.x - 8 || cx > cam.x + cam.vw + 8 || cy < cam.y - 8 || cy > cam.y + cam.vh + 8) continue;
    pushBag(rects, cx, cy, now);
  }

  // Heals dropped by killed enemies (Brief E): render-only, drawn from the entity view.
  for (const e of ents) {
    if (e.type !== ENT_HEAL) continue;
    const cx = e.x / 16;
    const cy = e.y / 16;
    if (cx < cam.x - 8 || cx > cam.x + cam.vw + 8 || cy < cam.y - 8 || cy > cam.y + cam.vh + 8) continue;
    pushHeal(rects, cx, cy, now);
  }

  // Enemies: a slime sprite per ENT_ENEMY, hp bar when hurt. Render-only (invariants 1 and 9).
  const liveEnemies = new Set<number>();
  for (const e of ents) {
    if (e.type !== ENT_ENEMY) continue;
    liveEnemies.add(e.id);
    const ex = e.x / 16;
    const ey = e.y / 16;
    let es = enemySeen.get(e.id);
    if (!es) enemySeen.set(e.id, (es = { x: ex, y: ey, vy: 0, hitAt: -1e9, kind: e.sub }));
    es.x = ex;
    es.vy = ey - es.y;
    es.y = ey;
    if (ex < cam.x - 8 || ex > cam.x + cam.vw + 8 || ey < cam.y - 8 || ey > cam.y + cam.vh + 8) continue;
    const air = (e.health & 2) === 0 ? "ground" : es.vy < 0 ? "rising" : "falling";
    if (e.sub === 4) {
      // The Deep Mage: phase from the view's state bits 2..3; a phase change roars (the view is state, so no event is needed).
      const phase = (e.health >> 2) & 3;
      if (bossPhase !== phase) {
        if (bossPhase !== 0) { sfxAt("roar", ex, ey, 1, net === "catching-up" || !!ls?.fastForwarding); fx.burst(ex, ey - 8, [1, 0.5, 0.2], 40, 0.1); }
        bossPhase = phase;
      }
      bossHud = { kind: 4, hp: e.a, max: ENEMY_MAX_HP[4], phase, x: ex, y: ey };
      pushBoss(rects, ex, ey, phase, now - es.hitAt < 120, now);
      continue;
    }
    if (e.sub === 7) {
      // The Sand Colossus: the other boss (chosen per seed); same phase bits and bar as the Mage.
      const phase = (e.health >> 2) & 3;
      if (bossPhase !== phase) {
        if (bossPhase !== 0) { sfxAt("roar", ex, ey, 1, net === "catching-up" || !!ls?.fastForwarding); fx.burst(ex, ey - 6, [0.85, 0.7, 0.4], 50, 0.1); }
        bossPhase = phase;
      }
      bossHud = { kind: 7, hp: e.a, max: ENEMY_MAX_HP[7], phase, x: ex, y: ey };
      pushColossus(rects, ex, ey, phase, now - es.hitAt < 120, now);
      continue;
    }
    pushEnemy(rects, e.sub, ex, ey, air, now - es.hitAt < 120, e.a / (ENEMY_MAX_HP[e.sub] ?? 20), ENEMY_MAX_HP[e.sub] ?? 20, (e.health & 1) === 1, now);
    // A worm tunnelling near the camera rumbles, at most twice a second.
    if (e.sub === 3 && (e.health & 1) === 1 && now - lastRumble > 500) {
      lastRumble = now;
      sfxAt("rumble", ex, ey, 0.5, net === "catching-up" || !!ls?.fastForwarding);
    }
  }
  for (const id of enemySeen.keys()) if (!liveEnemies.has(id)) enemySeen.delete(id);
  if (!ents.some((e) => e.type === ENT_ENEMY && (e.sub === 4 || e.sub === 7))) bossHud = null;
  // The round banner comes from state (a client that caught up or reconnected never saw the one-shot event).
  const round = ents.find((e) => e.type === ENT_ROUND);
  if (round && round.a === 1 && !roundShown && net === "live") {
    roundShown = true;
    send({ type: "round", win: round.sub === 1 });
  }

  // F6b: the lobby (from the entities view) and the late-arrival offer. Both render-only.
  let lobby: { running: boolean; left: number; majorityLeft: number; list: { id: number; name: string; ready: boolean; me: boolean }[] } | null = null;
  if (round) {
    const running = (round.health & 1) === 1;
    lobby = { running, left: round.x, majorityLeft: round.y, list: running ? [] : ents.filter((e) => e.type === ENT_READY).map((e) => ({ id: e.id, name: nameOf(e.id) ?? "Player", ready: e.active, me: e.id === myId })) };
    if (!lateChecked && mine && net === "live" && !spectate) {
      lateChecked = true;
      lateOffer = running && round.a === 0 && mine.health === 0;
    }
    if (round.a === 1) lateOffer = false;
  }

  spellFx(ents, dt, now, rects);

  // Camera: the avatar, or for a spectator the first other player; the main thread pans freely otherwise.
  let following = false;
  // One life: when I am dead the camera follows a living teammate (camera only, never an input).
  const deadFollow = oneLife && dead && !spectate && firstAlive ? (shown.get((firstAlive as EntityView).id) ?? null) : null;
  const target = deadFollow ?? (avatar && avatarReady ? { x: avatar.x, y: avatar.y } : spectate && firstOther ? (followId !== null ? shown.get(followId) : undefined) ?? shown.get((firstOther as EntityView).id) ?? null : null);
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
    send({ type: "players", list, cam: { x: cam.x, y: cam.y }, following, energy: avatar?.energy ?? 0, energyMax: ENERGY_MAX, boss: bossHud, spells: spectate ? null : sim.playerView(myId), bags, lobby, late: lateOffer, evlog: evLogOut.splice(0),
      me: spectate || !mine ? null : { health: mine.health, dead, respawnTicks: dead && myDeathTick !== null ? Math.max(0, DEATH_TICKS - (sim.tick() - myDeathTick)) : null, deathText: dead ? myDeathText : null }, deepest: Math.floor(deepestSeen) });
  }
  if (now - lastTerrainPost >= 1000) {
    lastTerrainPost = now;
    postTerrain(sim.matView(), w, h);
  }
  if (showActiveBox) pushActiveBox(rects, ents, w, h);
  return rects;
}

/**
 * Debug view of the sim's active set (`Grid::set_active_around`): every chunk that intersects the
 * ACTIVE_W x ACTIVE_H rectangle around an active player's official (sim) position steps; every other chunk
 * is frozen. Frozen chunks are tinted, each player's rectangle is outlined in yellow and the active chunks'
 * edges in green. Read from `entities()` only, so it shows what the sim does, not the local prediction.
 */
function pushActiveBox(rects: Rect[], ents: EntityView[], w: number, h: number): void {
  const centres = ents.filter((e) => e.type === ENT_PLAYER && e.active).map((e) => ({ x: e.x >> 4, y: e.y >> 4 }));
  const cw = Math.ceil(w / CHUNK);
  const ch = Math.ceil(h / CHUNK);
  const hw = ACTIVE_W / 2;
  const hh = ACTIVE_H / 2;
  const x0v = Math.max(0, Math.floor(cam.x / CHUNK));
  const y0v = Math.max(0, Math.floor(cam.y / CHUNK));
  const x1v = Math.min(cw - 1, Math.floor((cam.x + cam.vw) / CHUNK));
  const y1v = Math.min(ch - 1, Math.floor((cam.y + cam.vh) / CHUNK));
  const active = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) return false;
    const [x0, y0] = [cx * CHUNK, cy * CHUNK];
    return centres.some((p) => x0 < p.x + hw && x0 + CHUNK > p.x - hw && y0 < p.y + hh && y0 + CHUNK > p.y - hh);
  };
  for (let cy = y0v; cy <= y1v; cy++) {
    for (let cx = x0v; cx <= x1v; cx++) {
      const [x, y] = [cx * CHUNK, cy * CHUNK];
      if (!active(cx, cy)) {
        rects.push({ x, y, w: CHUNK, h: CHUNK, r: 0.1, g: 0.3, b: 1, a: 0.22 });
        continue;
      }
      // Faint chunk grid inside the active area, so a shape that lines up with chunk edges is easy to see.
      rects.push({ x, y, w: CHUNK, h: 1, r: 1, g: 1, b: 1, a: 0.12 });
      rects.push({ x, y, w: 1, h: CHUNK, r: 1, g: 1, b: 1, a: 0.12 });
      // Green edge wherever an active chunk meets a frozen one: the line liquid can cross and stop at.
      if (!active(cx - 1, cy)) rects.push({ x, y, w: 1, h: CHUNK, r: 0.2, g: 1, b: 0.3, a: 0.9 });
      if (!active(cx + 1, cy)) rects.push({ x: x + CHUNK - 1, y, w: 1, h: CHUNK, r: 0.2, g: 1, b: 0.3, a: 0.9 });
      if (!active(cx, cy - 1)) rects.push({ x, y, w: CHUNK, h: 1, r: 0.2, g: 1, b: 0.3, a: 0.9 });
      if (!active(cx, cy + 1)) rects.push({ x, y: y + CHUNK - 1, w: CHUNK, h: 1, r: 0.2, g: 1, b: 0.3, a: 0.9 });
    }
  }
  for (const p of centres) {
    const [x, y] = [p.x - hw, p.y - hh];
    rects.push({ x, y, w: ACTIVE_W, h: 1, r: 1, g: 0.9, b: 0.2, a: 0.8 });
    rects.push({ x, y: y + ACTIVE_H - 1, w: ACTIVE_W, h: 1, r: 1, g: 0.9, b: 0.2, a: 0.8 });
    rects.push({ x, y, w: 1, h: ACTIVE_H, r: 1, g: 0.9, b: 0.2, a: 0.8 });
    rects.push({ x: x + ACTIVE_W - 1, y, w: 1, h: ACTIVE_H, r: 1, g: 0.9, b: 0.2, a: 0.8 });
  }
}

const nameOf = (id: number): string | undefined => names.get(id) ?? (id === myId && myName ? myName : undefined);

const chestOf = (id: number): { x: number; y: number } | null => {
  if (id === myId && avatar && avatarReady) return { x: avatar.x, y: avatar.y - 5 };
  const p = shown.get(id);
  return p ? { x: p.x, y: p.y - 5 } : null;
};

/** Sounds still allowed this frame: the main thread caps voices too; this just bounds the message rate. */
let sfxBudget = 0;
/** Ask the main thread for a sound at cell (x, y): quieter and panned by distance from the camera centre. Silent while replaying. */
function sfxAt(name: SfxName, x: number, y: number, mag = 0.5, quiet = false) {
  if (quiet || sfxBudget <= 0) return;
  const hw = cam.vw / 2;
  const dx = (x - (cam.x + hw)) / hw;
  const dy = (y - (cam.y + cam.vh / 2)) / hw;
  const d = Math.hypot(dx, dy);
  const vol = Math.max(0, 1 - d / 2.2);
  if (vol < 0.03) return;
  sfxBudget--;
  send({ type: "sfx", name, vol: vol * vol, pan: Math.max(-1, Math.min(1, dx * 0.8)), mag });
}
/** The same, with no distance falloff, for my own actions. */
const sfxSelf = (name: SfxName, quiet: boolean) => {
  if (quiet || sfxBudget <= 0) return;
  sfxBudget--;
  send({ type: "sfx", name, vol: 1, pan: 0, mag: 0.5 });
};
const SPELL_SFX: SfxName[] = ["push", "blast", "water", "rose", "fire", "bomb", "dig", "flask", "flask", "wall", "flask", "hole"];

/** Turn the queued sim events, the entities() view and the cast ghosts into particles and rectangles. */
function spellFx(ents: EntityView[], dt: number, now: number, rects: Rect[]) {
  const evs = pendingEvents;
  pendingEvents = [];
  explosionsThisFrame = 0;
  // A replaying client (catch-up, or a localSim-less fast-forward) must not play hundreds of old sounds.
  const quiet = net === "catching-up" || !!ls?.fastForwarding;
  sfxBudget = 24;
  for (const e of evs) {
    // Combat signals for the music: I hurt an enemy, or knocked another player (c = attacker). Being hurt is the health drop in gameFrame.
    if ((e.kind === EV_ENEMY_HURT && e.player === myId) || (e.kind === EV_KNOCK && e.c === myId && e.player !== myId)) combatSignal(now, quiet);
    if ((e.kind === EV_EXPLODE || e.kind === EV_DEATH || (e.kind === EV_KNOCK && e.player === myId)) && evLogOut.length < 100) evLogOut.push({ k: e.kind, p: e.player, a: e.a, b: e.b, c: e.c });
    if (e.kind === EV_CAST) {
      const c = chestOf(e.player);
      const col = SPELLS[e.a]?.colour ?? [1, 1, 1];
      const ang = (e.b / 65536) * Math.PI * 2;
      if (c) {
        if (e.a === 1) fx.cone(c.x, c.y, ang, col);
        else if (e.a === 6 || e.a === 9) fx.dust(c.x, c.y, ang, col);
        else fx.flash(c.x, c.y, ang, col);
      }
      const ps = poses.get(e.player);
      if (ps) {
        ps.castUntil = now + 220;
        ps.castCol = col;
        if (e.player !== myId) ps.facingRight = Math.cos(ang) >= 0;
      }
      if (e.player === myId) dropGhost(e.c);
      if (c) {
        if (e.player === myId) sfxSelf(SPELL_SFX[e.a] ?? "push", quiet);
        else sfxAt(SPELL_SFX[e.a] ?? "push", c.x, c.y, 0.5, quiet);
      }
      if (e.player === myId && e.a === 1) shake(now, 1, 160);
    } else if (e.kind === EV_CAST_REJECTED) {
      if (e.player === myId) {
        dropGhost(e.c);
        sfxSelf("reject", quiet);
      }
    } else if (e.kind === EV_KNOCK) {
      const ps = poses.get(e.player);
      // A Black Hole pulls with a knock every tick for up to 150 ticks; flash, shake and sound at most every 250 ms.
      const fresh = !ps || now - ps.hitAt >= 250;
      if (ps) {
        ps.hitUntil = now + 380;
        if (fresh) ps.hitAt = now; // for the white flash
      }
      const c = chestOf(e.player);
      if (c && fresh) {
        fx.streak(c.x, c.y, e.a, e.b);
        if (e.player === myId) {
          sfxSelf("knock", quiet);
          shake(now, 2, 220);
        } else sfxAt("knock", c.x, c.y, 0.5, quiet);
      }
    } else if (e.kind === EV_IMPACT) {
      // Drawn from the event, not the grid: a Fire bolt's fire has already risen by the time we look.
      sfxAt("impact", e.a, e.b, 0.5, quiet);
      if (e.c === 4) fx.embers(e.a + 0.5, e.b + 0.5);
      else if (e.c === 7 || e.c === 8 || e.c === 10) fx.burst(e.a + 0.5, e.b + 0.5, SPELLS[e.c].colour, 28, 0.07);
      else if (e.c === 11) fx.burst(e.a + 0.5, e.b + 0.5, SPELLS[e.c].colour, 24, 0.09);
      else if (e.c !== 5) fx.burst(e.a + 0.5, e.b + 0.5, SPELLS[e.c]?.colour ?? [1, 1, 1], e.c === 2 ? 20 : 14);
    } else if (e.kind === EV_EXPLODE) {
      if (explosionsThisFrame++ < 16) fx.explosion(e.a + 0.5, e.b + 0.5, e.c);
      const inView = e.a >= cam.x - 8 && e.a <= cam.x + cam.vw + 8 && e.b >= cam.y - 8 && e.b <= cam.y + cam.vh + 8;
      sfxAt("explode", e.a, e.b, Math.min(1, e.c / BOMB_RADIUS), quiet);
      // Shake scales with radius and falls off with distance; under one cell it is not worth doing.
      const dist = Math.hypot(e.a - (cam.x + cam.vw / 2), e.b - (cam.y + cam.vh / 2)) / cam.vw;
      const mag = (e.c / BOMB_RADIUS) * 3 * Math.max(0, 1 - dist * 1.5);
      if (inView && mag >= 1) shake(now, Math.min(4, Math.round(mag)), 200 + 20 * Math.min(10, e.c));
    } else if (e.kind === EV_DEATH) {
      send({ type: "toast", text: formatDeath({ victim: e.player, killer: e.a, cause: e.b, bagDropped: e.c === 1 }, nameOf) });
      if (e.player === myId) myDeathText = youDiedText(e.b, e.a, myId, nameOf);
      const c = chestOf(e.player);
      if (c) {
        fx.burst(c.x, c.y, [0.9, 0.2, 0.2], 18, 0.04);
        if (e.player === myId) sfxSelf("death", quiet);
        else sfxAt("death", c.x, c.y, 0.5, quiet);
      }
    } else if (e.kind === EV_RESPAWN) {
      fx.respawn(e.a / 16, e.b / 16 - 5);
      if (e.player === myId) sfxSelf("respawn", quiet);
      else sfxAt("respawn", e.a / 16, e.b / 16 - 5, 0.5, quiet);
    } else if (e.kind === EV_ENEMY_HURT) {
      const es = enemySeen.get(e.a);
      if (es) {
        es.hitAt = now;
        const col: [number, number, number] = es.kind === 7 ? [0.85, 0.7, 0.4] : es.kind === 4 ? [0.7, 0.4, 1] : es.kind === 1 ? [1, 0.5, 0.15] : es.kind === 2 ? [0.6, 0.85, 0.2] : es.kind === 3 ? [0.85, 0.5, 0.5] : [0.4, 0.9, 0.4];
        fx.burst(es.x, es.y - 2, col, 8, 0.04);
        sfxAt(es.kind === 2 ? "hiss" : "squelch", es.x, es.y, 0.4, quiet);
      }
    } else if (e.kind === EV_ENEMY_DEATH) {
      const dcol: [number, number, number] = e.c === 1 ? [1, 0.5, 0.15] : e.c === 2 ? [0.6, 0.85, 0.2] : e.c === 3 ? [0.85, 0.5, 0.5] : [0.3, 0.85, 0.3];
      fx.burst(e.a / 16, e.b / 16 - 2, dcol, e.c === 4 || e.c === 7 ? 90 : 22, 0.06);
      if (e.c === 4) fx.burst(e.a / 16, e.b / 16 - 8, [1, 0.8, 0.3], 80, 0.12);
      sfxAt(e.c === 4 || e.c === 7 ? "bossdeath" : e.c === 1 ? "screech" : e.c === 3 ? "crunch" : "splat", e.a / 16, e.b / 16, 0.6, quiet);
    } else if (e.kind === EV_ROUND_START) {
      if (!quiet) {
        send({ type: "toast", text: "Descend!" });
        sfxSelf("descend", false);
      }
    } else if (e.kind === EV_ROUND_END) {
      if (!quiet && !roundShown) {
        roundShown = true;
        send({ type: "round", win: e.a === 1 });
      }
    } else if (e.kind === EV_BAG_PICKUP) {
      fx.pickup(e.a + 0.5, e.b + 0.5);
      if (e.player === myId) sfxSelf("bag", quiet);
      else sfxAt("bag", e.a + 0.5, e.b + 0.5, 0.5, quiet);
    } else if (e.kind === EV_HEAL) {
      fx.burst(e.b + 0.5, e.c - 1, [1, 0.3, 0.35], 10, 0.03);
      if (e.player === myId) {
        sfxSelf("heal", quiet);
        if (!quiet) send({ type: "toast", text: `+${e.a} health` });
      } else sfxAt("heal", e.b + 0.5, e.c + 0.5, 0.4, quiet);
    } else if (e.kind === EV_PICKUP) {
      if (e.player === myId) sfxSelf("pickup", quiet);
    }
  }
  // Real bolts: a body and a trail puff each frame.
  const enemyBoltNow = new Set<number>();
  for (const q of ents) {
    if (q.type !== ENT_PROJECTILE) continue;
    const col = SPELLS[q.sub]?.colour ?? [1, 1, 1];
    const x = q.x / 16;
    const y = q.y / 16;
    if (q.id === myId) dropGhost(q.a);
    // An enemy-owned bolt has the owner's high bit set (never equal to a player id). An imp has at most one bolt in
    // flight (90-tick cooldown), so a bolt from an owner with none last frame is a new cast: it crackles once.
    if (q.id >= 0x80000000 && q.a === 0) {
      if (!enemyBoltSeen.has(q.id)) sfxAt("crackle", q.x / 16, q.y / 16, 0.4, net === "catching-up" || !!ls?.fastForwarding);
      enemyBoltNow.add(q.id);
    }
    if (q.sub === 11) {
      // Black Hole: a dark core with particles falling in from a ring.
      rects.push({ x: Math.round(x) - 2, y: Math.round(y) - 2, w: 5, h: 5, r: 0.05, g: 0, b: 0.1, a: 1 });
      rects.push({ x: Math.round(x) - 3, y: Math.round(y) - 3, w: 7, h: 7, r: col[0], g: col[1], b: col[2], a: 0.35 });
      fx.swirlIn(x, y, col);
    } else if (q.sub === 5) {
      // A lobbed bomb: round body and a fuse that spits sparks.
      pushBomb(rects, x, y, now);
      fx.fuseSpark(x, y - 2);
    } else {
      if (q.sub === 4) fx.fireTrail(x, y);
      else fx.trail(x, y, col);
      pushBolt(rects, x, y, col, q.sub === 4, now);
    }
  }
  enemyBoltSeen = enemyBoltNow;
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
    const blast = g.spell === 1 || g.spell === 6 || g.spell === 9;
    const size = blast ? 3 : 2;
    rects.push({ x: Math.round(g.x) - 1, y: Math.round(g.y) - 1, w: size, h: size, r: col[0], g: col[1], b: col[2], a: 0.55 });
  }
  fx.update(Math.min(now - lastFxAt, 100));
  lastFxAt = now;
  fx.toRects(rects);
}

/** The camera with this frame's shake applied (whole cells, so pixels stay crisp). Render-only. */
function shakenCam(now: number): Camera {
  if (now >= shakeUntil) return cam;
  const k = (shakeUntil - now) / shakeDur;
  const m = Math.max(1, Math.round(shakeMag * k));
  return { ...cam, x: cam.x + (Math.floor(now / 30) % 2 ? m : -m), y: cam.y + (Math.floor(now / 45) % 2 ? 1 : -1) };
}

function dropGhost(seq: number) {
  const i = ghosts.findIndex((g) => g.seq === seq);
  if (i >= 0) ghosts.splice(i, 1);
}

/** The cast message from the main thread: quantised angle in, an input out, and a ghost drawn now. */
function onCast(spell: number, angle: number) {
  if (spectate || !avatar || !avatarReady || net !== "live" || tabHidden) return;
  if (!localSim && (!ws || ws.readyState !== WebSocket.OPEN)) return;
  if (iAmDead) return; // the sim would only reject it; nothing is sent because of a death, this only withholds
  const now = performance.now();
  if (now - lastCastAt < CAST_MIN_INTERVAL_MS) return; // Pos + casts stay under the server's rate limit
  lastCastAt = now;
  if (spell < 0 || spell >= SPELLS.length) return;
  const seq = ++castSeq & 0xffff;
  const payload = encodeCast(0, spell, angle & 0xffff, seq).subarray(5);
  if (payload.length !== CAST_PAYLOAD_LEN) return;
  if (localSim) localSim.pushInput(encodeCast(myId, spell, angle & 0xffff, seq));
  else ws!.send(encodeInput(++inputSeq, KIND_CAST, payload) as BufferSource);
  const rad = ((angle & 0xffff) / 65536) * Math.PI * 2;
  avatar.facing = Math.cos(rad) >= 0 ? 1 : 0;
  const ps = poses.get(myId);
  if (ps) {
    ps.castUntil = now + 220;
    ps.castCol = SPELLS[spell]?.colour ?? [1, 1, 1];
    ps.facingRight = avatar.facing === 1;
  }
  // The ghost only when the HUD says the cast will go through (cosmetic; the input was sent regardless).
  const v = (localSim ?? ls?.sim)?.playerView(myId);
  const ready = !v || (v.charges[spell] > 0 && v.cooldown[spell] === 0);
  // Wall is instant (no flight): no ghost. Black Hole has no gravity, so the straight-line ghost is right.
  if (ready && SPELLS[spell].enabled && spell !== SPELL_WALL && spell !== SPELL_QUAKE) {
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
  if (paused) return;
  flushStroke(false);
  if (localSim) {
    acc += dt;
    const n = Math.min(Math.floor(acc / STEP_MS), MAX_FRAME_STEPS);
    acc -= Math.floor(acc / STEP_MS) * STEP_MS;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      localSim.step();
      if (localSim.width() > 512) {
        for (const e of localSim.events()) {
          if (e.kind === EV_DEATH && e.player === myId) myDeathTick = localSim.tick();
          if (pendingEvents.length < 300) pendingEvents.push(e);
        }
      }
      stepTimes.push(performance.now() - t0);
      if (stepTimes.length > 600) stepTimes.shift();
      statSteps++;
    }
    ranChunks = localSim.ranChunks();
    const rects = localSim.width() > 512 ? gameFrame(localSim, dt, now) : [];
    if (renderer) {
      renderer.draw(localSim.matView(), localSim.auxView(), now / 1000, shakenCam(now), rects);
    } else if (sendFrames) {
      const m = localSim.matView().slice();
      const a = localSim.auxView().slice();
      send({ type: "frame", mat: m, aux: a, tick: localSim.tick(), rects }, [m.buffer, a.buffer]);
    }
  } else if (ls) {
    // A tab that was hidden stays "live" but falls far behind: driveFrame switches it to the fast-forward path
    // (target = the tick received so far) and the overlay shows. The avatar is paused while catching up because
    // gameFrame (stepping, Pos) only runs when net is "live".
    const wasCatching = net === "catching-up";
    const base = Math.min(Math.floor((acc += dt) / STEP_MS), MAX_FRAME_STEPS);
    if (wasCatching) acc = 0;
    else acc -= Math.floor(acc / STEP_MS) * STEP_MS;
    const t0 = performance.now();
    const r = driveFrame(ls, wasCatching, base, FF_BUDGET_MS);
    if (r.entered) {
      acc = 0;
      setNet("catching-up");
    }
    if (r.catching) {
      statSteps = 0;
    } else if (wasCatching) {
      acc = 0;
      setNet("live");
      sendLive(); // same moment HASH starts to count (past the replay target); also after a resync or reconnect
    } else if (r.ran > 0) {
      stepTimes.push((performance.now() - t0) / r.ran);
      if (stepTimes.length > 600) stepTimes.shift();
      statSteps += r.ran;
    }
    if (ls && (net !== "catching-up" || now - lastFfDraw >= FF_DRAW_INTERVAL_MS)) {
      if (net === "catching-up") lastFfDraw = now;
      ranChunks = ls.sim.ranChunks();
      // From the room's config, not the world's width: a size-S game room is 512 wide, the same as the sandbox,
      // and the old `width() > 512` test drew every S room as a sandbox (no players, HUD or lobby).
      const rects = net === "live" && netAvatars ? gameFrame(ls.sim, dt, now) : [];
      if (renderer) {
        renderer.draw(ls.sim.matView(), ls.sim.auxView(), now / 1000, shakenCam(now), rects);
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
  skyOverride = m.sky;
  skyReduced = !!m.reduced;
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
    sim.init(BigInt(m.local.seed), m.local.cfg === "survival" ? encodeConfig(SURVIVAL) : m.local.kind);
    oneLife = m.local.cfg === "survival";
    localSim = sim;
    if (sim.width() > 512 && m.local.avatar) {
      // Dev route only: one local player so damage, death and bags can be seen without a second client.
      myId = DEV_ID;
      myName = "You";
      sim.pushInput(encodeJoin(DEV_ID));
      // F6b: the dev route must not sit in the Survival lobby: the dev avatar readies at once (the round starts 3 s later).
      if (m.local.cfg === "survival") sim.pushInput(encodeReady(DEV_ID, 1));
    }
    setNet("live");
    send({ type: "world", width: sim.width(), height: sim.height(), kind: m.local.kind, cfg: null, caves: m.local.kind !== 0, ...applySky(BigInt(m.local.seed)) });
    renderer?.setWorld(sim.width(), sim.height(), m.local.kind !== 0);
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
    case "devgoto":
      // Dev route only (stripped from production builds): put the local controller on the nearest deep pickup of
      // this spell. The avatar then reports it through the normal Pos path, as tools/inputgen-m5.ts does (D-114).
      // A real room too, when the server said dev teleport is on (GET /api/rooms/:code): the avatar's Pos then jumps
      // and the server's gate (server/devteleport.ts) decides; on any other server the Pos is rejected as a teleport.
      const gsim = localSim ?? ls?.sim ?? null;
      if (gsim && avatar && (import.meta.env.DEV || m.remote)) {
        // spell -1: the nearest enemy instead (dev only, `__devGotoEnemy`).
        // spell <= -2: the nearest enemy of kind (-2 - spell), standing at its height (an imp hovers in open air).
        const list = gsim.entities().filter((e) => (m.spell < 0 ? e.type === ENT_ENEMY && (m.spell === -1 || e.sub === -2 - m.spell) : e.type === ENT_PICKUP && e.sub === m.spell && e.active));
        const me = gsim.entities().find((e) => e.type === ENT_PLAYER && e.id === myId);
        list.sort((a, b) => Math.abs(a.x - (me?.x ?? 0)) + Math.abs(a.y - (me?.y ?? 0)) - (Math.abs(b.x - (me?.x ?? 0)) + Math.abs(b.y - (me?.y ?? 0))));
        // The boss (kind 4): 14 cells beside it, at its height (feet y minus 7 puts the avatar's feet at its centre line), in open arena air.
        if (list[0]) avatar.teleport(list[0].x / 16 - (m.spell === -6 ? -(m.dist ?? 14) : m.spell < 0 ? (m.dist ?? 12) : 0), list[0].y / 16 - (m.spell === -3 ? 4 : m.spell === -6 ? 2 : 0));
      }
      break;
    case "pace":
      paused = m.paused;
      STEP_MS = m.stepMs;
      break;
    case "pointer":
      onPointer(m);
      break;
    case "hover": {
      // Display only: look up on request (the main thread asks once the mouse rests), never per frame, never during catch-up.
      const gsim = localSim ?? ls?.sim ?? null;
      const busy = net === "catching-up" || !!ls?.fastForwarding || !gsim;
      send({ type: "hover", text: busy ? null : lookupHover(m.x, m.y, gsim.entities(), gsim.matView(), gsim.width(), gsim.height(), nameOf) });
      break;
    }
    case "camera":
      // While the worker steers the camera it keeps its own position; the main thread still sets the view size.
      cam = isFollowing ? { ...cam, vw: m.vw, vh: m.vh } : { x: m.x, y: m.y, vw: m.vw, vh: m.vh };
      if (!isFollowing) {
        camF.x = m.x;
        camF.y = m.y;
      }
      break;
    case "devbosshp": {
      // Dev route only: patch the boss's hp in a snapshot and restore it (the screenshots of each phase). Local avatar rooms only.
      if (import.meta.env.DEV && localSim && avatar) {
        const b = localSim.entities().find((e) => e.type === ENT_ENEMY && (e.sub === 4 || e.sub === 7));
        if (b) {
          const snap = localSim.snapshot();
          const dv = new DataView(snap.buffer, snap.byteOffset, snap.byteLength);
          // enemy record: id u16, kind u8 (4), x i32, y i32, vx i16, vy i16, hp u16
          for (let i = 0; i + 15 <= snap.length; i++) {
            if (snap[i] === b.sub && dv.getInt32(i + 1, true) === b.x && dv.getInt32(i + 5, true) === b.y && dv.getUint16(i + 13, true) === b.a) {
              dv.setUint16(i + 13, Math.max(1, Math.min(m.hp, 65535)), true);
              localSim.restore(snap);
              break;
            }
          }
        }
      }
      break;
    }
    case "ready":
      if (spectate || !avatar || !avatarReady || net !== "live") break;
      if (localSim) localSim.pushInput(encodeReady(myId, m.ready ? 1 : 0));
      else if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeInput(++inputSeq, KIND_READY, encodeReady(0, m.ready ? 1 : 0).subarray(5)) as BufferSource);
      break;
    case "sleep":
      localSim?.setSleepEnabled(m.on);
      break;
    case "activebox":
      showActiveBox = m.on;
      break;
    case "cast":
      onCast(m.spell, m.angle);
      break;
    case "keys":
      keys.left = m.left;
      keys.right = m.right;
      keys.up = m.up;
      break;
    case "hidden":
      tabHidden = m.hidden;
      if (m.hidden) { keys.left = false; keys.right = false; keys.up = false; }
      break;
    case "follow":
      followCam = m.on;
      if (m.id !== undefined) followId = m.id;
      break;
  }
};

// Lockstep server: tick clock, input sequencer, closed-tick broadcast, static client. Never steps the sim.
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { WebSocketServer, type WebSocket } from "ws";
import { KIND_CAST, KIND_PAINT, KIND_POS } from "../shared/inputs.ts";
import { CAST_PAYLOAD_LEN, INPUT_RATE_LIMIT, POS_PAYLOAD_LEN } from "../shared/avatar.ts";
import {
  cleanName,
  decodeClient,
  encodePong,
  encodeReject,
  HELLO_SPECTATE,
  maxUploadFrameFor,
  MAX_SOCKET_PAYLOAD,
  PAINT_PAYLOAD_LEN,
  PROTOCOL_VERSION,
  WORLD_GAME,
  encodeAchievement,
} from "../shared/protocol.ts";
import { GameDb } from "./db.ts";
import { Identity, MAX_REGISTERED } from "./identity.ts";
import { EventLog } from "./log.ts";
import { createDashboard } from "./dashboard.ts";
import { PlayerStats, type ConnTiming, type InputCounts } from "./stats.ts";
import {
  castStat,
  compactCounts,
  depthCells,
  materialKey,
  paintStat,
  spellKey,
  STAT_MAX_DEPTH,
  STAT_PLAY_MS,
  STAT_POS_REJECTED,
  STAT_SESSIONS,
} from "../shared/stats.ts";
import { Achievements } from "./achievements.ts";
import { SnapshotVerifier } from "./verify.ts";
import { GAME_ID, SANDBOX_ID, World, worldKindOf, type Peer } from "./world.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const WASM_PATH = join(ROOT, "sim/target/wasm32-unknown-unknown/release/sim.wasm");
const CLIENT_DIR = join(ROOT, "dist/client");
export const MAX_INPUTS_PER_SEC = INPUT_RATE_LIMIT;
/** Connections per world, spectators included (plan 14: 8 players; the rest is headroom for spectators). */
export const MAX_MEMBERS_PER_WORLD = 64;
/** Concurrent sockets per client address. */
export const MAX_CONNS_PER_IP = 12;
const MAX_FRAME_BYTES = 256;
const TIMER_MS = 4;
const HELLO_TIMEOUT_MS = 10_000;
export const INPUT_SUMMARY_MS = 10_000;
const STATS_FLUSH_MS = 1000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const README_CSS = `:root{color-scheme:dark}body{margin:0;background:#0b0e14;color:#e6e9f0;font:17px/1.6 system-ui,sans-serif}
main{max-width:68ch;margin:0 auto;padding:24px 16px 64px}a{color:#6ea8ff}h1,h2{line-height:1.2}h2{margin-top:2em;border-top:1px solid #2a3142;padding-top:.8em}
code{background:#151a24;padding:1px 4px;border-radius:4px}nav{margin-bottom:1.5em}`;

/** README.md rendered to HTML on each request, so the page never lags the file. */
function readmePage(): string {
  const body = marked.parse(readFileSync(join(ROOT, "README.md"), "utf8"), { async: false });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>README</title><style>${README_CSS}</style></head><body><main><nav><a href="/">&larr; Back to the game</a> &middot; <a href="/dashboard">Dashboard</a></nav>${body}</main></body></html>`;
}

/** Per-connection figures for the dashboard: plain data, JSON-safe (undefined fields are omitted by JSON). */
export interface ConnInfo {
  world: number;
  conn: number;
  who: string;
  role: string;
  visitorId: number;
  connectedS: number;
  /** Server-measured ws ping round trip, ms. undefined until the first pong. */
  rttMs?: number;
  rttP95Ms?: number;
  /** Closed tick minus the tick of the connection's last HASH. Sawtooths up to HASH_EVERY; undefined until its first HASH. */
  tickLag?: number;
  /** The client's own step p95 (ms) and playout buffer length, from its last HASH. */
  stepP95Ms?: number;
  buffered?: number;
  /** Inputs in the current input.summary window (since the last summary). */
  window: { casts: number; paints: number; pos: number; rejected: number };
  /** Session totals. */
  total: { casts: number; paints: number; pos: number; rejected: number; maxDepth: number; resyncs: number; posRejected: number };
}

export interface WorldSummary {
  world: number;
  online: number;
  lastTick: number;
  /** Closed ticks per second over the last 10 s (fewer samples right after start). */
  ticksPerSec: number;
  hashPasses: number;
  hashFails: number;
  resyncs: number;
  snapshotsAccepted: number;
  snapshotsRejected: number;
  /** Compressed bytes and tick of the latest verified snapshot; 0 when none. */
  snapshotBytes: number;
  snapshotTick: number;
  /** Closed ticks since the latest snapshot (or since tick 0): the log a joiner must replay. Equals log.length. */
  ticksSinceSnapshot: number;
  lastVerifyMs: number;
  incidents: number;
  flushes: number;
  posRejected: number;
}

export interface ServerSummary {
  worlds: WorldSummary[];
  process: {
    rssMb: number;
    heapMb: number;
    /** Event-loop delay p99 in ms since the monitor was last reset. */
    lagP99Ms: number;
    uptimeS: number;
    /** game.db and its -wal on disk, bytes; undefined when there is no dataDir. */
    dbBytes?: number;
    walBytes?: number;
  };
}

export interface RunningServer {
  port: number;
  /** The sandbox (world 0). */
  world: World;
  /** The game world (world 1). */
  game: World;
  worlds: Map<number, World>;
  identity: Identity;
  /** Per-player counters, flushed to player_stats once a second and on shutdown. */
  playerStats: PlayerStats;
  achievements: Achievements;
  /** The structured event log: ring buffer, subscribers, stdout JSON lines. */
  log: EventLog;
  verifier: SnapshotVerifier | undefined;
  db: GameDb | null;
  stats: { droppedRate: number; rejected: number; originRefused: number; capRefused: number };
  /** One row per joined connection. */
  connections(): ConnInfo[];
  /** Per-world and process figures. `resetLag` also restarts the event-loop histogram (process.minute does). */
  summary(opts?: { resetLag?: boolean }): ServerSummary;
  close(): Promise<void>;
}

export function buildHash(wasmPath = WASM_PATH): Buffer {
  return createHash("sha256").update(readFileSync(wasmPath)).digest();
}

export interface ServerOptions {
  port?: number;
  wasmPath?: string;
  clientDir?: string;
  /** Where game.db lives. Default: DATA_DIR, else ./.data. Pass null for a memory-only world (no persistence). */
  dataDir?: string | null;
  snapshotEveryTicks?: number;
  /** Override World's log-length warning and cap (tests). */
  maxLogTicks?: number;
  warnLogTicks?: number;
  /** Override the snapshot-verification timeout (tests). */
  verifyTimeoutMs?: number;
  verifierWorkerUrl?: URL;
  quiet?: boolean;
  /** Extra Origins allowed to POST /api/players (a dev client on another port). Same-origin is always allowed. */
  allowedOrigins?: string[];
  maxConnsPerIp?: number;
  maxMembersPerWorld?: number;
  /** input.summary period (tests shorten it). Default INPUT_SUMMARY_MS. */
  inputSummaryMs?: number;
  /** Admin token for /dashboard. Default ADMIN_TOKEN. Unset or empty disables the admin view. */
  adminToken?: string;
}

/** ws ping period for the server-measured RTT. */
const PING_MS = 2000;
const round2 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const wasmPath = opts.wasmPath ?? WASM_PATH;
  const hash = buildHash(wasmPath);
  const clientDir = opts.clientDir ?? CLIENT_DIR;
  const log = new EventLog({ quiet: opts.quiet });
  const dataDir = opts.dataDir === undefined ? (process.env.DATA_DIR ?? join(ROOT, ".data")) : opts.dataDir;
  const db = dataDir === null ? null : new GameDb(dataDir);
  const verifier = db ? new SnapshotVerifier(wasmPath, { timeoutMs: opts.verifyTimeoutMs, workerUrl: opts.verifierWorkerUrl }) : undefined;
  const playerStats = new PlayerStats(db, log);
  const mk = (id: number) =>
    new World({
      id,
      now: () => performance.now(),
      db: db ?? undefined,
      verifier,
      simBuild: hash.toString("hex"),
      snapshotEveryTicks: opts.snapshotEveryTicks,
      maxLogTicks: opts.maxLogTicks,
      warnLogTicks: opts.warnLogTicks,
      log,
      stats: playerStats,
    });
  const worlds = new Map<number, World>([[SANDBOX_ID, mk(SANDBOX_ID)], [GAME_ID, mk(GAME_ID)]]);
  const world = worlds.get(SANDBOX_ID)!;
  const game = worlds.get(GAME_ID)!;
  for (const w of worlds.values()) await w.load();
  const identity = new Identity(db, log);
  // Delivery goes through `live` (declared below; only called from message handlers, after it exists).
  const achievements = new Achievements(db, playerStats, log, (visitorId, id, tick) => {
    const frame = encodeAchievement(id, tick);
    for (const l of live.values()) if (l.visitorId === visitorId && l.ws.readyState === l.ws.OPEN) l.ws.send(frame, { binary: true });
  });
  const stats = { droppedRate: 0, rejected: 0, originRefused: 0, capRefused: 0 };
  const allowedOrigins = new Set(opts.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : []));
  const maxPerIp = opts.maxConnsPerIp ?? MAX_CONNS_PER_IP;
  const connsByIp = new Map<string, number>();

  // Late-bound: the dashboard reads summary() and connections() from the object returned at the end.
  let running!: RunningServer;
  const dashboard = createDashboard({
    log,
    summary: () => running.summary(),
    connections: () => running.connections(),
    build: hash.toString("hex").slice(0, 12),
    adminToken: opts.adminToken ?? process.env.ADMIN_TOKEN,
  });

  /** Same-origin rule as /api/players: no Origin (a script) passes, a browser page on another site does not. */
  const originOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    return origin === undefined || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}` || allowedOrigins.has(origin);
  };

  /** POST /api/admin/reset {world}: a deliberate reset of one world to its generated start (D-097). */
  function adminReset(req: IncomingMessage, res: ServerResponse): void {
    const ipTag = log.ipTag(String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress ?? "?"));
    // Limited per address: an unauthenticated loop of POSTs must not push real events out of the ring.
    const refuse = (status: number, reason: string, body: string) => {
      log.limited(`admin:${ipTag}`, 10_000, "admin.refused", { action: "reset", reason, status, ip_tag: ipTag }, "warn");
      res.writeHead(status, { "content-type": "text/plain" }).end(body);
    };
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    if (!originOk(req)) return refuse(403, "origin", "cross-origin reset refused");
    // Header only: a token in the query string of a destructive request ends up in logs and history.
    if (!String(req.headers.authorization ?? "").startsWith("Bearer ") || !dashboard.isAdmin(req)) return refuse(403, "not_admin", "forbidden");
    const chunks: Buffer[] = [];
    let size = 0;
    let dead = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1024 && !dead) {
        dead = true;
        refuse(413, "too_large", "body too large");
        req.destroy();
      } else if (!dead) chunks.push(c);
    });
    req.on("end", () => {
      if (dead) return;
      let id: unknown;
      try {
        id = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { world?: unknown }).world;
      } catch {
        return refuse(400, "bad_body", "bad request");
      }
      const w = typeof id === "number" ? worlds.get(id) : undefined;
      if (!w) return refuse(400, "unknown_world", "unknown world");
      try {
        const r = w.reset(`admin@${ipTag}`);
        tickSamples.delete(w.id); // pre-reset tick numbers would make ticks/s hugely negative for 10 s
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, world: w.id, oldTick: r.oldTick }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
  }

  const http: Server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    } catch {
      // A malformed escape like "/%" threw out of the handler and took the whole server down.
      res.writeHead(400).end("bad request");
      return;
    }
    if (path === "/api/players") {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      // A browser always sends Origin on a POST, so a page on another site is recognised and refused; a request
      // with no Origin is not a browser (a script or a test), which a drive-by page cannot forge. Review M4a S2.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}` && !allowedOrigins.has(origin)) {
        stats.originRefused++;
        log.event("register.refused", { reason: "origin", origin: origin.slice(0, 80) }, "warn");
        res.writeHead(403).end("cross-origin registration refused");
        return;
      }
      // Body is a tiny JSON object; anything bigger is refused before it is parsed.
      const chunks: Buffer[] = [];
      let size = 0;
      let dead = false;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 1024 && !dead) {
          dead = true;
          res.writeHead(413).end();
          req.destroy();
        } else if (!dead) chunks.push(c);
      });
      req.on("end", () => {
        if (dead) return;
        let name: unknown = "";
        try {
          name = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { display_name?: unknown }).display_name;
        } catch {
          res.writeHead(400).end();
          return;
        }
        const r = identity.register(name, performance.now());
        if (!r) {
          log.event("register.refused", { reason: identity.count >= MAX_REGISTERED ? "cap" : "rate" }, "warn");
          res.writeHead(429).end();
          return;
        }
        log.event("player.registered", { player: r.id });
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ token: Buffer.from(r.token).toString("hex"), player_id: r.id, display_name: r.name }));
      });
      return;
    }
    if (path === "/api/admin/reset") {
      adminReset(req, res);
      return;
    }
    if (dashboard.handle(req, res, path)) return;
    if (path === "/readme") {
      res.writeHead(301, { location: "/readme/" }).end();
      return;
    }
    if (path === "/readme/") {
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        res.end(readmePage());
      } catch {
        res.writeHead(404).end("not found");
      }
      return;
    }
    // The same client serves both worlds: "/" is the game world, "/sandbox" the sandbox (it reads its URL).
    if (path === "/sandbox/") {
      res.writeHead(301, { location: "/sandbox" }).end(); // the client's assets are relative to "/sandbox"
      return;
    }
    let file = normalize(join(clientDir, path === "/" || path === "/sandbox" ? "index.html" : path));
    if (file !== clientDir && !file.startsWith(clientDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  // One cap for the socket, because ws checks it before we see the tag byte: the largest upload of any world
  // (a game snapshot). onMessage then enforces MAX_FRAME_BYTES for everything except SNAPSHOT_UPLOAD, and the
  // world's own upload cap (sandbox 1 MiB) for uploads.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SOCKET_PAYLOAD });
  http.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    // Fly sets Fly-Client-IP (and replaces any client-supplied one); elsewhere it is the socket address.
    const ip = String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress ?? "?");
    if ((connsByIp.get(ip) ?? 0) >= maxPerIp) {
      stats.capRefused++;
      log.limited(`cap:${log.ipTag(ip)}`, 10_000, "register.refused", { reason: "cap", scope: "ws_per_ip", ip_tag: log.ipTag(ip) }, "warn");
      socket.write("HTTP/1.1 429 Too Many Requests\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    connsByIp.set(ip, (connsByIp.get(ip) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (connsByIp.get(ip) ?? 1) - 1;
      if (n <= 0) connsByIp.delete(ip);
      else connsByIp.set(ip, n);
    };
    socket.on("close", release);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, String(req.headers["user-agent"] ?? "").slice(0, 200), log.ipTag(ip)));
  });

  function reject(ws: WebSocket, reason: string, fields: { world?: number; ipTag?: string } = {}) {
    stats.rejected++;
    log.event("hello.rejected", { reason, world: fields.world, ip_tag: fields.ipTag }, "warn");
    ws.send(encodeReject(reason), () => ws.close(1008, "rejected"));
  }

  /** Every joined connection, for the 10 s input.summary timer and the shutdown path. */
  interface Live {
    world: World;
    conn: number;
    visitorId: number;
    who: string;
    role: string;
    counts: InputCounts;
    /** The same object the world's Member holds. */
    timing: ConnTiming;
    ws: WebSocket;
    /** performance.now() of the outstanding ws ping, 0 when none. */
    pingAt: number;
    at: number;
    finish(code: number): void;
  }
  /** Keyed `world:conn`: connection ids are per world, so a bare conn would collide across worlds. */
  const live = new Map<string, Live>();
  const liveKey = (worldId: number, conn: number) => `${worldId}:${conn}`;
  const timingFields = (l: Live) => ({
    rtt_p95_ms: round2(l.timing.rttP95()),
    lag: l.timing.lag(l.world.clock.lastClosed),
    step_p95_ms: round2(l.timing.stepP95Ms),
  });
  const summaryFields = (l: Live, w: { casts: Map<string, number>; paints: Map<string, number>; pos: number; rejected: number }) => ({
    world: l.world.id,
    who: l.who,
    conn: l.conn,
    casts: compactCounts(w.casts),
    paints: compactCounts(w.paints),
    pos: w.pos,
    rejected: w.rejected,
    ...timingFields(l),
  });
  /** One timer over all connections (not one per connection): a summary for each that sent anything. */
  const summaryTimer = setInterval(() => {
    for (const l of live.values()) {
      const w = l.counts.takeWindow();
      if (w) log.event("input.summary", summaryFields(l, w));
    }
  }, opts.inputSummaryMs ?? INPUT_SUMMARY_MS);
  // One timer pings every joined socket; the pong handler times it. No protocol change: ws ping frames are
  // answered by the browser itself, so this measures the network path, not the client's main thread or worker.
  const pingTimer = setInterval(() => {
    const t = performance.now();
    for (const l of live.values()) {
      if (l.ws.readyState !== l.ws.OPEN) continue;
      l.pingAt = t;
      try {
        l.ws.ping();
      } catch {
        // closing; its close handler cleans up
      }
    }
  }, PING_MS);
  // Closed ticks sampled once a second, for ticks/s over the last 10 s.
  const tickSamples = new Map<number, { t: number; tick: number }[]>();
  const sampleTicks = () => {
    const t = performance.now();
    for (const w of worlds.values()) {
      let a = tickSamples.get(w.id);
      if (!a) tickSamples.set(w.id, (a = []));
      a.push({ t, tick: w.clock.lastClosed });
      while (a.length > 1 && t - a[0].t > 10_500) a.shift();
    }
  };
  sampleTicks();
  const sampleTimer = setInterval(sampleTicks, 1000);
  // Shared by summary() and process.minute. Disabled in close().
  const loopLag = monitorEventLoopDelay({ resolution: 20 });
  loopLag.enable();
  // Stats are written in one transaction a second, never per input.
  const statsTimer = setInterval(() => playerStats.flush(), STATS_FLUSH_MS);

  function roleOf(w: World, playerId: number): string {
    return w.kind === WORLD_GAME ? (playerId ? "player" : "spectator") : "painter";
  }

  /** An input the server refused: counted, and logged at most once per connection per 10 s. */
  function badInput(w: World, conn: number, reason: string, kind: number): void {
    stats.rejected++;
    live.get(liveKey(w.id, conn))?.counts.reject();
    log.limited(`bad:${conn}`, 10_000, "input.rejected", { world: w.id, conn, who: w.whoOfConn(conn), reason, kind }, "warn");
  }

  function onConnection(ws: WebSocket, userAgent: string, ipTag: string) {
    let joined: { world: World; conn: number; playerId: number; visitorId: number; visitorName: string; counts: InputCounts; at: number } | null = null;
    ws.on("pong", () => {
      if (!joined) return;
      const l = live.get(liveKey(joined.world.id, joined.conn));
      if (!l || !l.pingAt) return;
      l.timing.addRtt(performance.now() - l.pingAt);
      l.pingAt = 0;
    });
    const rej = (reason: string, worldId?: number) => reject(ws, reason, { world: worldId, ipTag });
    let windowStart = performance.now();
    let inWindow = 0;
    const helloTimer = setTimeout(() => ws.close(1008, "no hello"), HELLO_TIMEOUT_MS);
    const peer: Peer = {
      send: (f) => ws.send(f, { binary: true }),
      buffered: () => ws.bufferedAmount,
      close: (code, reason) => ws.close(code, reason),
      userAgent,
    };

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return ws.close(1003, "binary only");
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      const msg = decodeClient(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      if (!msg) return ws.close(1002, "bad frame");
      if (!joined) {
        if (msg.t !== "hello") return ws.close(1002, "hello first");
        if (buf.length > MAX_FRAME_BYTES) return ws.close(1009, "frame too large");
        clearTimeout(helloTimer);
        const w = worlds.get(msg.worldId);
        if (msg.version !== PROTOCOL_VERSION) return rej("protocol version mismatch: new version, reload", msg.worldId);
        if (!Buffer.from(msg.buildHash).equals(hash)) return rej("sim build mismatch: new version, reload", msg.worldId);
        if (!w || worldKindOf(msg.worldId) === null) return rej("unknown world", msg.worldId);
        if (w.closing) return rej("server is shutting down", msg.worldId);
        // A full log used to refuse joins, but then nobody could take the snapshot that shortens it (D-100).
        if (w.playerCount >= (opts.maxMembersPerWorld ?? MAX_MEMBERS_PER_WORLD)) {
          stats.capRefused++;
          log.event("register.refused", { reason: "cap", scope: "world_members", world: w.id }, "warn");
          return rej("world is full; try again later", msg.worldId);
        }
        // Identity for every world and role. A game-world player must hold a known token (its id is the sim id);
        // a painter or spectator with an unknown or zero token is accepted as anonymous (visitorId 0). An
        // anonymous resolve touches nothing in the database. Identity never reaches the sim.
        const spectating = !!(msg.flags & HELLO_SPECTATE);
        const gamePlayer = w.kind === WORLD_GAME && !spectating;
        const who = identity.resolve(msg.token, gamePlayer);
        if (who === "unknown" && gamePlayer) return rej("unknown token", msg.worldId);
        const visitorId = who === "unknown" ? 0 : who.id;
        const visitorName = who === "unknown" ? "" : who.name;
        const j = w.join(peer, { playerId: gamePlayer ? visitorId : undefined, name: gamePlayer ? visitorName : "", spectate: spectating, visitorId, visitorName });
        const me = { world: w, conn: j.conn, playerId: j.playerId, visitorId, visitorName, counts: j.counts, at: Date.now() };
        joined = me;
        playerStats.bump(visitorId, STAT_SESSIONS);
        const entry: Live = {
          world: w,
          conn: j.conn,
          visitorId,
          who: j.who,
          role: roleOf(w, j.playerId),
          counts: j.counts,
          timing: j.timing,
          ws,
          pingAt: 0,
          at: me.at,
          finish: (code) => {
            if (!live.delete(liveKey(w.id, j.conn))) return;
            w.leave(j.conn);
            log.forget(`rate:${j.conn}`);
            log.forget(`pos:${j.conn}`);
            log.forget(`bad:${j.conn}`);
            const ms = Date.now() - me.at;
            playerStats.bump(visitorId, STAT_PLAY_MS, ms);
            if (j.counts.pos > 0) playerStats.max(visitorId, STAT_MAX_DEPTH, j.counts.maxDepth);
            // The line to read at the crit: one per session, with its totals.
            log.event("leave", {
              world: w.id,
              who: j.who,
              conn: j.conn,
              role: entry.role,
              online: w.playerCount,
              tick: w.clock.lastClosed,
              duration_s: Math.round(ms / 1000),
              code,
              casts: compactCounts(j.counts.casts),
              paints: compactCounts(j.counts.paints),
              max_depth: j.counts.maxDepth,
              resyncs: j.counts.resyncs,
              pos_rejected: j.counts.posRejected,
              ...timingFields(entry),
              ip_tag: ipTag,
            });
            const rest = j.counts.takeWindow();
            if (rest) log.event("input.summary", { ...summaryFields(entry, rest), final: true });
          },
        };
        live.set(liveKey(w.id, j.conn), entry);
        log.event("join", {
          world: w.id,
          who: j.who,
          visitor: visitorId,
          name: visitorName || undefined,
          conn: j.conn,
          role: roleOf(w, j.playerId),
          online: w.playerCount,
          tick: w.clock.lastClosed,
          ip_tag: ipTag,
          ua: userAgent.slice(0, 80),
        });
        return;
      }
      const w = joined.world;
      if (w.closing) return;
      // A replaced tab (same token, newer connection) stays open until its socket closes; it must not stamp or count.
      if (!w.hasMember(joined.conn)) return;
      // Everything but a snapshot upload is small; uploads have a per-world ceiling (a game snapshot is MBs).
      if (msg.t === "snapshot-upload" ? buf.length > maxUploadFrameFor(w.kind) : buf.length > MAX_FRAME_BYTES) return ws.close(1009, "frame too large");

      switch (msg.t) {
        case "ping":
          ws.send(encodePong(msg.ts), { binary: true });
          return;
        case "input": {
          const now = performance.now();
          if (now - windowStart >= 1000) {
            windowStart = now;
            inWindow = 0;
          }
          if (++inWindow > MAX_INPUTS_PER_SEC) {
            stats.droppedRate++;
            joined.counts.reject();
            log.limited(`rate:${joined.conn}`, 10_000, "input.rate_limited", { world: w.id, conn: joined.conn, who: w.whoOfConn(joined.conn), limit: MAX_INPUTS_PER_SEC }, "warn");
            return;
          }
          if (w.kind === WORLD_GAME) {
            // Game world: only Pos (validated) and Cast. Join/Leave are the server's; Paint is sandbox-only.
            if (!joined.playerId) return void badInput(w, joined.conn, "spectator_input", msg.kind);
            if (msg.kind === KIND_POS && msg.payload.length === POS_PAYLOAD_LEN) {
              if (!w.acceptPos(joined.conn, msg.payload)) {
                stats.rejected++;
                joined.counts.reject();
                joined.counts.posRejected++;
                playerStats.bump(joined.visitorId, STAT_POS_REJECTED);
                log.limited(`pos:${joined.conn}`, 10_000, "pos.rejected", { world: w.id, conn: joined.conn, who: w.whoOfConn(joined.conn), tick: w.clock.lastClosed }, "warn");
                return;
              }
              // Pos payload after kind and player: life u16, x i32, y i32, facing u8.
              const depth = depthCells(new DataView(msg.payload.buffer, msg.payload.byteOffset, msg.payload.byteLength).getInt32(6, true));
              joined.counts.position(depth);
              // Only a deeper maximum can newly satisfy Spelunker, so most Pos inputs stop here.
              if (playerStats.max(joined.visitorId, STAT_MAX_DEPTH, depth)) achievements.onStat(joined.visitorId, STAT_MAX_DEPTH, { name: joined.visitorName, world: w.id, tick: w.clock.lastClosed });
            } else if (!(msg.kind === KIND_CAST && msg.payload.length === CAST_PAYLOAD_LEN)) return void badInput(w, joined.conn, "bad_kind_or_length", msg.kind);
            else {
              // Counted as an attempt (plan 10). Never one log line per cast: input.summary carries the counts.
              joined.counts.cast(spellKey(msg.payload[0]));
              playerStats.bump(joined.visitorId, castStat(msg.payload[0]));
              achievements.onStat(joined.visitorId, castStat(msg.payload[0]), { name: joined.visitorName, world: w.id, tick: w.clock.lastClosed });
            }
            w.stamp({ player: joined.playerId, kind: msg.kind, payload: msg.payload });
            return;
          }
          // Sandbox: Paint only. Join/Leave are stamped by the server; Pos/Cast have no meaning here.
          if (msg.kind !== KIND_PAINT || msg.payload.length !== PAINT_PAYLOAD_LEN) return void badInput(w, joined.conn, "bad_kind_or_length", msg.kind);
          joined.counts.paint(materialKey(msg.payload[0]));
          playerStats.bump(joined.visitorId, paintStat(msg.payload[0]));
          // The player id is ours, never the client's.
          w.stamp({ player: joined.playerId, kind: msg.kind, payload: msg.payload });
          return;
        }
        case "hash":
          w.onHash(joined.conn, msg.tick, msg.hash, msg.stepP95, msg.buffered);
          return;
        case "snapshot-upload":
          w.onUpload(joined.conn, msg.tick, msg.hash, msg.data);
          return;
        default:
          return ws.close(1002, "unexpected message");
      }
    });
    ws.on("close", (code) => {
      clearTimeout(helloTimer);
      if (joined) live.get(liveKey(joined.world.id, joined.conn))?.finish(code);
    });
    ws.on("error", () => ws.terminate());
  }

  const timer = setInterval(() => {
    for (const w of worlds.values()) w.tick();
  }, TIMER_MS);
  let closed: Promise<void> | null = null;
  const sum = (m: ReadonlyMap<string, number>) => {
    let n = 0;
    for (const v of m.values()) n += v;
    return n;
  };
  const fileBytes = (path: string): number | undefined => {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  };
  await new Promise<void>((ok) => http.listen(opts.port ?? 0, ok));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  running = {
    port,
    world,
    game,
    worlds,
    identity,
    playerStats,
    achievements,
    log,
    verifier,
    db,
    stats,
    connections: () =>
      [...live.values()].map((l): ConnInfo => {
        const win = l.counts.peekWindow();
        return {
          world: l.world.id,
          conn: l.conn,
          who: l.who,
          role: l.role,
          visitorId: l.visitorId,
          connectedS: Math.round((Date.now() - l.at) / 100) / 10,
          rttMs: round2(l.timing.rttMs),
          rttP95Ms: round2(l.timing.rttP95()),
          tickLag: l.timing.lag(l.world.clock.lastClosed),
          stepP95Ms: l.timing.stepP95Ms,
          buffered: l.timing.buffered,
          window: { casts: sum(win.casts), paints: sum(win.paints), pos: win.pos, rejected: win.rejected },
          total: { casts: sum(l.counts.casts), paints: sum(l.counts.paints), pos: l.counts.pos, rejected: l.counts.rejected, maxDepth: l.counts.maxDepth, resyncs: l.counts.resyncs, posRejected: l.counts.posRejected },
        };
      }),
    summary: (o = {}) => {
      const now = performance.now();
      const mem = process.memoryUsage();
      const out: ServerSummary = {
        worlds: [...worlds.values()].map((w): WorldSummary => {
          const a = tickSamples.get(w.id) ?? [];
          const first = a[0];
          const dt = first ? now - first.t : 0;
          return {
            world: w.id,
            online: w.playerCount,
            lastTick: w.clock.lastClosed,
            ticksPerSec: first && dt >= 500 ? Math.round(((w.clock.lastClosed - first.tick) * 10_000) / dt) / 10 : 0,
            hashPasses: w.stats.hashPasses,
            hashFails: w.stats.hashFails,
            resyncs: w.stats.resyncs,
            snapshotsAccepted: w.stats.snapshotsAccepted,
            snapshotsRejected: w.stats.snapshotsRejected,
            snapshotBytes: w.snapshot?.data.length ?? 0,
            snapshotTick: w.snapshot?.tick ?? 0,
            ticksSinceSnapshot: w.clock.lastClosed - (w.snapshot?.tick ?? w.logBase),
            lastVerifyMs: Math.round(w.stats.lastVerifyMs),
            incidents: w.stats.incidents,
            flushes: w.stats.flushes,
            posRejected: w.stats.posRejected,
          };
        }),
        process: {
          rssMb: Math.round(mem.rss / 1048576),
          heapMb: Math.round(mem.heapUsed / 1048576),
          lagP99Ms: Math.round(loopLag.percentile(99) / 1e4) / 100,
          uptimeS: Math.round(process.uptime()),
          dbBytes: dataDir === null ? undefined : fileBytes(join(dataDir, "game.db")),
          walBytes: dataDir === null ? undefined : fileBytes(join(dataDir, "game.db-wal")),
        },
      };
      if (o.resetLag) loopLag.reset();
      return out;
    },
    /** Shutdown (plan 9.3): stop inputs, close the open tick, flush tick_log, close the DB. Safe to call twice. */
    close: () =>
      (closed ??= new Promise<void>((ok) => {
        clearInterval(timer);
        clearInterval(summaryTimer);
        clearInterval(statsTimer);
        clearInterval(pingTimer);
        clearInterval(sampleTimer);
        loopLag.disable();
        dashboard.closeAll();
        log.event("server.shutdown", { online: [...worlds.values()].reduce((n, w) => n + w.playerCount, 0), uptime_s: Math.round(process.uptime()) });
        // Finish every session first (leave events, play_ms), then flush stats, then close the DB.
        for (const l of [...live.values()]) l.finish(1001);
        for (const w of worlds.values()) w.shutdown();
        playerStats.flush();
        db?.close();
        void verifier?.close();
        for (const c of wss.clients) c.terminate();
        http.close(() => ok());
        http.closeAllConnections();
      })),
  };
  return running;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Registered only when run as the server, so test runners keep their own (failing) unhandled-rejection reporting.
  // Logs the cause loudly, then rethrows so the process still exits and the platform restarts it.
  let s: RunningServer | undefined;
  process.on("unhandledRejection", (e) => {
    s?.log.event("server.unhandled_rejection", { error: e instanceof Error ? (e.stack ?? e.message).slice(0, 500) : String(e) }, "error");
    throw e;
  });
  const port = Number(process.env.PORT ?? 8080);
  s = await startServer({ port });
  const srv = s;
  // process.minute: health once a minute. The RSS warning is this event at warn level.
  setInterval(() => {
    const sm = srv.summary({ resetLag: true });
    const f: Record<string, number | string> = {
      rss_mb: sm.process.rssMb,
      heap_mb: sm.process.heapMb,
      lag_p99_ms: sm.process.lagP99Ms,
      uptime_s: sm.process.uptimeS,
      dropped_rate: srv.stats.droppedRate,
      rejected: srv.stats.rejected,
      origin_refused: srv.stats.originRefused,
      cap_refused: srv.stats.capRefused,
    };
    if (sm.process.dbBytes !== undefined) f.db_bytes = sm.process.dbBytes;
    if (sm.process.walBytes !== undefined) f.wal_bytes = sm.process.walBytes;
    for (const w of sm.worlds) {
      f[`online_w${w.world}`] = w.online;
      f[`tick_w${w.world}`] = w.lastTick;
      f[`ticks_per_s_w${w.world}`] = w.ticksPerSec;
      f[`hash_pass_w${w.world}`] = w.hashPasses;
      f[`hash_fail_w${w.world}`] = w.hashFails;
      f[`resyncs_w${w.world}`] = w.resyncs;
      f[`snapshots_accepted_w${w.world}`] = w.snapshotsAccepted;
      f[`snapshots_rejected_w${w.world}`] = w.snapshotsRejected;
      f[`incidents_w${w.world}`] = w.incidents;
      f[`flushes_w${w.world}`] = w.flushes;
      f[`pos_rejected_w${w.world}`] = w.posRejected;
      f[`verify_ms_w${w.world}`] = w.lastVerifyMs;
      f[`log_ticks_w${w.world}`] = w.ticksSinceSnapshot;
    }
    if (sm.process.rssMb > 200) f.warning = "rss over 200 MB";
    srv.log.event("process.minute", f, sm.process.rssMb > 200 ? "warn" : "info");
  }, 60_000).unref();
  srv.log.event("server.start", { port: srv.port, build: buildHash().toString("hex").slice(0, 12), protocol: PROTOCOL_VERSION, pid: process.pid, node: process.version });
  const stop = () => void srv.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

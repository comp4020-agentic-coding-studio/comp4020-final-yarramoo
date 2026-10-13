// Lockstep server: tick clock, input sequencer, closed-tick broadcast, static client. Never steps the sim.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
} from "../shared/protocol.ts";
import { GameDb } from "./db.ts";
import { Identity } from "./identity.ts";
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>README</title><style>${README_CSS}</style></head><body><main><nav><a href="/">&larr; Back to the game</a></nav>${body}</main></body></html>`;
}

export interface RunningServer {
  port: number;
  /** The sandbox (world 0). */
  world: World;
  /** The game world (world 1). */
  game: World;
  worlds: Map<number, World>;
  identity: Identity;
  verifier: SnapshotVerifier | undefined;
  db: GameDb | null;
  stats: { droppedRate: number; rejected: number; originRefused: number; capRefused: number };
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
  /** Override the snapshot-verification timeout (tests). */
  verifyTimeoutMs?: number;
  verifierWorkerUrl?: URL;
  quiet?: boolean;
  /** Extra Origins allowed to POST /api/players (a dev client on another port). Same-origin is always allowed. */
  allowedOrigins?: string[];
  maxConnsPerIp?: number;
  maxMembersPerWorld?: number;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const wasmPath = opts.wasmPath ?? WASM_PATH;
  const hash = buildHash(wasmPath);
  const clientDir = opts.clientDir ?? CLIENT_DIR;
  const say = opts.quiet ? () => {} : (m: string) => console.log(m);
  const dataDir = opts.dataDir === undefined ? (process.env.DATA_DIR ?? join(ROOT, ".data")) : opts.dataDir;
  const db = dataDir === null ? null : new GameDb(dataDir);
  const verifier = db ? new SnapshotVerifier(wasmPath, { timeoutMs: opts.verifyTimeoutMs, workerUrl: opts.verifierWorkerUrl }) : undefined;
  const mk = (id: number) =>
    new World({
      id,
      now: () => performance.now(),
      db: db ?? undefined,
      verifier,
      simBuild: hash.toString("hex"),
      snapshotEveryTicks: opts.snapshotEveryTicks,
      log: say,
    });
  const worlds = new Map<number, World>([[SANDBOX_ID, mk(SANDBOX_ID)], [GAME_ID, mk(GAME_ID)]]);
  const world = worlds.get(SANDBOX_ID)!;
  const game = worlds.get(GAME_ID)!;
  for (const w of worlds.values()) await w.load();
  const identity = new Identity(db, say);
  const stats = { droppedRate: 0, rejected: 0, originRefused: 0, capRefused: 0 };
  const allowedOrigins = new Set(opts.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : []));
  const maxPerIp = opts.maxConnsPerIp ?? MAX_CONNS_PER_IP;
  const connsByIp = new Map<string, number>();

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
          res.writeHead(429).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ token: Buffer.from(r.token).toString("hex"), player_id: r.id, display_name: r.name }));
      });
      return;
    }
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
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, String(req.headers["user-agent"] ?? "").slice(0, 200)));
  });

  function reject(ws: WebSocket, reason: string) {
    stats.rejected++;
    ws.send(encodeReject(reason), () => ws.close(1008, "rejected"));
  }

  function onConnection(ws: WebSocket, userAgent: string) {
    let joined: { world: World; conn: number; playerId: number } | null = null;
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
        if (msg.version !== PROTOCOL_VERSION) return reject(ws, "protocol version mismatch: new version, reload");
        if (!Buffer.from(msg.buildHash).equals(hash)) return reject(ws, "sim build mismatch: new version, reload");
        if (!w || worldKindOf(msg.worldId) === null) return reject(ws, "unknown world");
        if (w.closing) return reject(ws, "server is shutting down");
        if (w.full) return reject(ws, "world log is full; try again later");
        if (w.playerCount >= (opts.maxMembersPerWorld ?? MAX_MEMBERS_PER_WORLD)) {
          stats.capRefused++;
          return reject(ws, "world is full; try again later");
        }
        let playerId: number | undefined;
        let name = "";
        if (w.kind === WORLD_GAME && !(msg.flags & HELLO_SPECTATE)) {
          const who = identity.resolve(msg.token);
          if (who === "unknown") return reject(ws, "unknown token");
          playerId = who.id;
          name = who.name;
        }
        const j = w.join(peer, { playerId, name, spectate: !!(msg.flags & HELLO_SPECTATE) });
        joined = { world: w, conn: j.conn, playerId: j.playerId };
        console.log(`[server] world ${w.id}: ${j.playerId ? `player ${j.playerId}` : "spectator"} joined (${w.playerCount} online, tick ${w.clock.lastClosed})`);
        return;
      }
      const w = joined.world;
      if (w.closing) return;
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
            return;
          }
          if (w.kind === WORLD_GAME) {
            // Game world: only Pos (validated) and Cast. Join/Leave are the server's; Paint is sandbox-only.
            if (!joined.playerId) return void stats.rejected++; // spectators send nothing
            if (msg.kind === KIND_POS && msg.payload.length === POS_PAYLOAD_LEN) {
              if (!w.acceptPos(joined.conn, msg.payload)) return void stats.rejected++;
            } else if (!(msg.kind === KIND_CAST && msg.payload.length === CAST_PAYLOAD_LEN)) return void stats.rejected++;
            w.stamp({ player: joined.playerId, kind: msg.kind, payload: msg.payload });
            return;
          }
          // Sandbox: Paint only. Join/Leave are stamped by the server; Pos/Cast have no meaning here.
          if (msg.kind !== KIND_PAINT || msg.payload.length !== PAINT_PAYLOAD_LEN) return void stats.rejected++;
          // The player id is ours, never the client's.
          w.stamp({ player: joined.playerId, kind: msg.kind, payload: msg.payload });
          return;
        }
        case "hash":
          w.onHash(joined.conn, msg.tick, msg.hash);
          return;
        case "snapshot-upload":
          w.onUpload(joined.conn, msg.tick, msg.hash, msg.data);
          return;
        default:
          return ws.close(1002, "unexpected message");
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (joined) {
        joined.world.leave(joined.conn);
        console.log(`[server] world ${joined.world.id}: ${joined.playerId ? `player ${joined.playerId}` : "spectator"} left (${joined.world.playerCount} online)`);
      }
    });
    ws.on("error", () => ws.terminate());
  }

  const timer = setInterval(() => {
    for (const w of worlds.values()) w.tick();
  }, TIMER_MS);
  let closed: Promise<void> | null = null;
  await new Promise<void>((ok) => http.listen(opts.port ?? 0, ok));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    world,
    game,
    worlds,
    identity,
    verifier,
    db,
    stats,
    /** Shutdown (plan 9.3): stop inputs, close the open tick, flush tick_log, close the DB. Safe to call twice. */
    close: () =>
      (closed ??= new Promise<void>((ok) => {
        clearInterval(timer);
        for (const w of worlds.values()) w.shutdown();
        db?.close();
        void verifier?.close();
        for (const c of wss.clients) c.terminate();
        http.close(() => ok());
        http.closeAllConnections();
      })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Registered only when run as the server, so test runners keep their own (failing) unhandled-rejection reporting.
  // Logs the cause loudly, then rethrows so the process still exits and the platform restarts it.
  process.on("unhandledRejection", (e) => {
    console.error("[server] UNHANDLED REJECTION", e);
    throw e;
  });
  const port = Number(process.env.PORT ?? 8080);
  const s = await startServer({ port });
  setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > 200 * 1024 * 1024) console.warn(`[server] RSS ${(rss / 1048576).toFixed(0)} MB is over the 200 MB warning line`);
  }, 30_000).unref();
  console.log(`[server] http://localhost:${s.port}/  build ${buildHash().toString("hex").slice(0, 12)}`);
  const stop = () => void s.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Lockstep server: tick clock, input sequencer, closed-tick broadcast, static client. Never steps the sim.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { WebSocketServer, type WebSocket } from "ws";
import { KIND_PAINT } from "../shared/inputs.ts";
import {
  decodeClient,
  encodePong,
  encodeReject,
  MAX_UPLOAD_FRAME,
  PAINT_PAYLOAD_LEN,
  PROTOCOL_VERSION,
} from "../shared/protocol.ts";
import { GameDb } from "./db.ts";
import { SnapshotVerifier } from "./verify.ts";
import { World, type Peer } from "./world.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const WASM_PATH = join(ROOT, "sim/target/wasm32-unknown-unknown/release/sim.wasm");
const CLIENT_DIR = join(ROOT, "dist/client");
export const MAX_INPUTS_PER_SEC = 40;
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sandbox: README</title><style>${README_CSS}</style></head><body><main><nav><a href="/">&larr; Back to the sandbox</a></nav>${body}</main></body></html>`;
}

export interface RunningServer {
  port: number;
  world: World;
  db: GameDb | null;
  stats: { droppedRate: number; rejected: number };
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
  quiet?: boolean;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const wasmPath = opts.wasmPath ?? WASM_PATH;
  const hash = buildHash(wasmPath);
  const clientDir = opts.clientDir ?? CLIENT_DIR;
  const say = opts.quiet ? () => {} : (m: string) => console.log(m);
  const dataDir = opts.dataDir === undefined ? (process.env.DATA_DIR ?? join(ROOT, ".data")) : opts.dataDir;
  const db = dataDir === null ? null : new GameDb(dataDir);
  const world = new World({
    now: () => performance.now(),
    db: db ?? undefined,
    verifier: db ? new SnapshotVerifier(wasmPath) : undefined,
    simBuild: hash.toString("hex"),
    snapshotEveryTicks: opts.snapshotEveryTicks,
    log: say,
  });
  const stats = { droppedRate: 0, rejected: 0 };

  const http: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
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
    let file = normalize(join(clientDir, path === "/" ? "index.html" : path));
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

  // One cap for the socket, because ws checks it before we see the tag byte; onMessage then enforces
  // MAX_FRAME_BYTES for everything except SNAPSHOT_UPLOAD.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_UPLOAD_FRAME });
  http.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, String(req.headers["user-agent"] ?? "").slice(0, 200)));
  });

  function reject(ws: WebSocket, reason: string) {
    stats.rejected++;
    ws.send(encodeReject(reason), () => ws.close(1008, "rejected"));
  }

  function onConnection(ws: WebSocket, userAgent: string) {
    let playerId = 0;
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
      if (world.closing) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      const msg = decodeClient(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      if (!msg) return ws.close(1002, "bad frame");
      if (msg.t !== "snapshot-upload" && buf.length > MAX_FRAME_BYTES) return ws.close(1009, "frame too large");

      if (!playerId) {
        if (msg.t !== "hello") return ws.close(1002, "hello first");
        clearTimeout(helloTimer);
        if (msg.version !== PROTOCOL_VERSION) return reject(ws, "protocol version mismatch: new version, reload");
        if (!Buffer.from(msg.buildHash).equals(hash)) return reject(ws, "sim build mismatch: new version, reload");
        if (msg.worldId !== 0) return reject(ws, "unknown world");
        if (world.closing) return reject(ws, "server is shutting down");
        if (world.full) return reject(ws, "world log is full; try again later");
        playerId = world.join(peer);
        console.log(`[server] player ${playerId} joined (${world.playerCount} online, tick ${world.clock.lastClosed})`);
        return;
      }

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
          // Sandbox: Paint only. Join/Leave are stamped by the server; Pos/Cast have no meaning here.
          if (msg.kind !== KIND_PAINT || msg.payload.length !== PAINT_PAYLOAD_LEN) return void stats.rejected++;
          // The player id is ours, never the client's.
          world.stamp({ player: playerId, kind: msg.kind, payload: msg.payload });
          return;
        }
        case "hash":
          world.onHash(playerId, msg.tick, msg.hash);
          return;
        case "snapshot-upload":
          world.onUpload(playerId, msg.tick, msg.hash, msg.data);
          return;
        default:
          return ws.close(1002, "unexpected message");
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (playerId) {
        world.leave(playerId);
        console.log(`[server] player ${playerId} left (${world.playerCount} online)`);
      }
    });
    ws.on("error", () => ws.terminate());
  }

  const timer = setInterval(() => world.tick(), TIMER_MS);
  let closed: Promise<void> | null = null;
  await new Promise<void>((ok) => http.listen(opts.port ?? 0, ok));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    world,
    db,
    stats,
    /** Shutdown (plan 9.3): stop inputs, close the open tick, flush tick_log, close the DB. Safe to call twice. */
    close: () =>
      (closed ??= new Promise<void>((ok) => {
        clearInterval(timer);
        world.shutdown();
        db?.close();
        for (const c of wss.clients) c.terminate();
        http.close(() => ok());
        http.closeAllConnections();
      })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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

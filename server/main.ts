// Lockstep server: tick clock, input sequencer, closed-tick broadcast, static client. Never steps the sim.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { KIND_PAINT } from "../shared/inputs.ts";
import {
  decodeClient,
  encodePong,
  encodeReject,
  PAINT_PAYLOAD_LEN,
  PROTOCOL_VERSION,
} from "../shared/protocol.ts";
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

export interface RunningServer {
  port: number;
  world: World;
  stats: { droppedRate: number; rejected: number };
  close(): Promise<void>;
}

export function buildHash(wasmPath = WASM_PATH): Buffer {
  return createHash("sha256").update(readFileSync(wasmPath)).digest();
}

export async function startServer(opts: { port?: number; wasmPath?: string; clientDir?: string } = {}): Promise<RunningServer> {
  const hash = buildHash(opts.wasmPath);
  const clientDir = opts.clientDir ?? CLIENT_DIR;
  const world = new World(() => performance.now());
  const stats = { droppedRate: 0, rejected: 0 };

  const http: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
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

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  http.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function reject(ws: WebSocket, reason: string) {
    stats.rejected++;
    ws.send(encodeReject(reason), () => ws.close(1008, "rejected"));
  }

  function onConnection(ws: WebSocket) {
    let playerId = 0;
    let windowStart = performance.now();
    let inWindow = 0;
    const helloTimer = setTimeout(() => ws.close(1008, "no hello"), HELLO_TIMEOUT_MS);
    const peer: Peer = {
      send: (f) => ws.send(f, { binary: true }),
      buffered: () => ws.bufferedAmount,
      close: (code, reason) => ws.close(code, reason),
    };

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return ws.close(1003, "binary only");
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      const msg = decodeClient(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      if (!msg) return ws.close(1002, "bad frame");

      if (!playerId) {
        if (msg.t !== "hello") return ws.close(1002, "hello first");
        clearTimeout(helloTimer);
        if (msg.version !== PROTOCOL_VERSION) return reject(ws, "protocol version mismatch: new version, reload");
        if (!Buffer.from(msg.buildHash).equals(hash)) return reject(ws, "sim build mismatch: new version, reload");
        if (msg.worldId !== 0) return reject(ws, "unknown world");
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
  await new Promise<void>((ok) => http.listen(opts.port ?? 0, ok));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    world,
    stats,
    close: () =>
      new Promise<void>((ok) => {
        clearInterval(timer);
        for (const c of wss.clients) c.terminate();
        http.close(() => ok());
        http.closeAllConnections();
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const s = await startServer({ port });
  console.log(`[server] http://localhost:${s.port}/  build ${buildHash().toString("hex").slice(0, 12)}`);
  const stop = () => void s.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

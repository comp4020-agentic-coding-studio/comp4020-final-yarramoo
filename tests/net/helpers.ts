// A real-protocol test client: real sim, shared playout module, WebSocket to the real server.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { Lockstep, reactToTick } from "../../client/lockstep.ts";
import { encodePaint, KIND_PAINT } from "../../shared/inputs.ts";
import { decodeServer, encodeHash, encodeHello, encodeInput, encodeSnapshotUpload } from "../../shared/protocol.ts";
import { loadSim, simBuildHash } from "../../shared/sim.ts";

export const WASM = "sim/target/wasm32-unknown-unknown/release/sim.wasm";
export const wasmBytes = new Uint8Array(readFileSync(WASM));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
export const buildHashHex = () => simBuildHash(wasmBytes);

export interface TestClient {
  ws: WebSocket;
  ls: Lockstep;
  hashes: Map<number, bigint>;
  playerId: number;
  /** Frames received, by kind. */
  counts: { ticks: number; snapshots: number; resyncs: number; requests: number };
  snapshotTicks: number[];
  /** When false the client does not answer REQUEST_SNAPSHOT. */
  uploads: boolean;
  lie: boolean;
  /** Called instead of uploading when `uploads` is false, so a test can send something else. */
  onDue: ((tick: number, honest: { hash: bigint; data: Uint8Array }) => void) | null;
  paint(mat: number, x0: number, y0: number, x1: number, y1: number, r: number): void;
  drain(): void;
  close(): void;
}

export async function connect(port: number, hashHex: string, opts: { uploads?: boolean; manual?: boolean } = {}): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { "user-agent": "vitest-client" } });
  ws.binaryType = "nodebuffer";
  let seq = 0;
  let seed = 0n;
  let kind = 0;
  let wantAt = 0;
  let corrupt = false;
  const c = {
    ws,
    /** Test hook: make every outgoing HASH wrong (a client whose sim diverged). */
    set lie(v: boolean) {
      corrupt = v;
    },
    hashes: new Map<number, bigint>(),
    playerId: 0,
    counts: { ticks: 0, snapshots: 0, resyncs: 0, requests: 0 },
    snapshotTicks: [] as number[],
    uploads: opts.uploads ?? true,
    onDue: null,
  } as unknown as TestClient;

  const fresh = (target: number) => {
    const sim = loadSim(wasmBytes);
    sim.init(seed, kind);
    c.ls = new Lockstep(sim);
    c.ls.catchUpTarget = target;
    c.ls.onStepped = (tick) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (tick % 20 === 0) c.hashes.set(tick, c.ls.sim.stateHash()); // local record, for comparing clients
      const r = reactToTick(c.ls, tick, wantAt);
      if (r.hash !== undefined) ws.send(encodeHash(tick, corrupt ? r.hash ^ 1n : r.hash));
      if (r.snapshot) {
        wantAt = 0;
        if (c.uploads) ws.send(encodeSnapshotUpload(tick, r.snapshot.hash, r.snapshot.data));
        else c.onDue?.(tick, r.snapshot);
      }
    };
  };

  await new Promise<void>((ok, bad) => {
    ws.on("open", () => ws.send(encodeHello(unhex(hashHex), 0)));
    ws.on("error", bad);
    ws.on("message", (d: Buffer) => {
      const m = decodeServer(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      if (!m) throw new Error("undecodable server frame");
      switch (m.t) {
        case "welcome":
          seed = m.seed;
          kind = m.worldKind;
          fresh(m.tick);
          c.playerId = m.playerId;
          ok();
          break;
        case "snapshot":
          c.counts.snapshots++;
          c.snapshotTicks.push(m.tick);
          c.ls.loadSnapshot(m.data, m.tick);
          break;
        case "resync":
          c.counts.resyncs++;
          fresh(m.tick);
          break;
        case "request-snapshot":
          c.counts.requests++;
          wantAt = m.tick;
          break;
        case "tick":
          c.counts.ticks++;
          c.ls.push(m.tick, m.inputs);
          if (!opts.manual) c.ls.run(100000); // apply as fast as ticks arrive
          break;
        case "reject":
          bad(new Error(m.reason));
          break;
      }
    });
  });
  c.paint = (mat, x0, y0, x1, y1, r) =>
    ws.send(encodeInput(++seq, KIND_PAINT, encodePaint(0, mat, x0, y0, x1, y1, r).subarray(5)));
  c.drain = () => void c.ls.run(1_000_000);
  c.close = () => ws.close();
  return c;
}

/** Paint reactive stuff from several clients for `ms`, a few strokes each ~30 ms. */
export async function paintFor(clients: TestClient[], ms: number): Promise<void> {
  const mats = [4, 5, 6, 7, 8, 9, 10];
  const end = performance.now() + ms;
  let i = 0;
  while (performance.now() < end) {
    clients.forEach((c, k) => c.paint(mats[(i + k * 3) % mats.length], 60 + ((i * 7 + k * 120) % 380), 40 + ((i * 3) % 60), 80 + ((i * 7 + k * 120) % 380), 60 + ((i * 3) % 60), 6));
    i++;
    await sleep(30);
  }
}

export async function waitFor(cond: () => boolean, ms = 20000, what = "condition"): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

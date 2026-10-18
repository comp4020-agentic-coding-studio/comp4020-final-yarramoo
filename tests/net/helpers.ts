// A real-protocol test client: real sim, shared playout module, WebSocket to the real server.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { Lockstep, reactToTick } from "../../client/lockstep.ts";
import { encodeCast, encodePaint, encodePos, KIND_CAST, KIND_PAINT, KIND_POS } from "../../shared/inputs.ts";
import { decodeServer, encodeClaim, encodeHash, encodeHello, encodeInput, encodeLive, encodeSnapshotUpload } from "../../shared/protocol.ts";
import { EV_DEATH, loadSim, simBuildHash } from "../../shared/sim.ts";

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
  /** When true the client never sends LIVE (a client that is slow or hostile). Set before the replay finishes. */
  holdLive: boolean;
  /** Send LIVE now, at the sim's current tick. */
  sendLive(): void;
  /** When true (default) the client sends a CLAIM for every EV_DEATH its sim emits past the replay target. */
  claims: boolean;
  /** The step p95 (ms) this client puts in its HASH frames. */
  reportStepP95: number;
  /** Called instead of uploading when `uploads` is false, so a test can send something else. */
  onDue: ((tick: number, honest: { hash: bigint; data: Uint8Array }) => void) | null;
  paint(mat: number, x0: number, y0: number, x1: number, y1: number, r: number): void;
  /** Send a Pos (cells, converted to 1/16) for the game world. */
  move(xCells: number, yCells: number, facing?: number, life?: number): void;
  /** Send a Cast for the game world: `angle` is already a u16 (65536 per turn, 0 along +x, growing downwards). */
  cast(spell: number, angle: number, seq: number): void;
  /** Names the server told this client about, by player id. */
  names: Map<number, string>;
  /** Achievements the server sent this client, in order. */
  achievements: { id: string; tick: number }[];
  drain(): void;
  close(): void;
}

export async function connect(
  port: number,
  hashHex: string,
  opts: { uploads?: boolean; manual?: boolean; holdLive?: boolean; world?: number; token?: Uint8Array; spectate?: boolean } = {},
): Promise<TestClient> {
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
    names: new Map<number, string>(),
    achievements: [] as { id: string; tick: number }[],
    counts: { ticks: 0, snapshots: 0, resyncs: 0, requests: 0 },
    snapshotTicks: [] as number[],
    uploads: opts.uploads ?? true,
    claims: true,
    holdLive: opts.holdLive ?? false,
    onDue: null,
    reportStepP95: 1.5,
  } as unknown as TestClient;

  const fresh = (target: number) => {
    const sim = loadSim(wasmBytes);
    sim.init(seed, kind);
    c.ls = new Lockstep(sim);
    c.ls.catchUpTarget = target;
    c.ls.onStepped = (tick) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (tick % 20 === 0) c.hashes.set(tick, c.ls.sim.stateHash()); // local record, for comparing clients
      // Like the real client (D-120): one CLAIM per EV_DEATH past the replay target, never for a replayed tick.
      if (c.claims && tick > c.ls.catchUpTarget && c.ls.sim.width() > 512) {
        for (const e of c.ls.sim.events()) if (e.kind === EV_DEATH) ws.send(encodeClaim(tick, e.player, e.a, e.b, e.c));
      }
      // Like the real client: LIVE the moment the replay target is reached (D-122). `holdLive` lets a test withhold it.
      if (tick === c.ls.catchUpTarget && !c.holdLive) ws.send(encodeLive(tick));
      const r = reactToTick(c.ls, tick, wantAt);
      if (r.hash !== undefined) ws.send(encodeHash(tick, corrupt ? r.hash ^ 1n : r.hash, c.reportStepP95, c.ls.buffered));
      if (r.snapshot) {
        wantAt = 0;
        if (c.uploads) ws.send(encodeSnapshotUpload(tick, r.snapshot.hash, r.snapshot.data));
        else c.onDue?.(tick, r.snapshot);
      }
    };
  };

  await new Promise<void>((ok, bad) => {
    ws.on("open", () => ws.send(encodeHello(unhex(hashHex), opts.world ?? 0, opts.token, opts.spectate ? 1 : 0)));
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
          if (m.tick === 0 && !c.holdLive) ws.send(encodeLive(0));
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
          if (m.tick === 0 && !c.holdLive) ws.send(encodeLive(0));
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
        case "player-name":
          c.names.set(m.player, m.name);
          break;
        case "achievement":
          c.achievements.push({ id: m.id, tick: m.tick });
          break;
        case "reject":
          bad(new Error(m.reason));
          break;
      }
    });
  });
  c.paint = (mat, x0, y0, x1, y1, r) =>
    ws.send(encodeInput(++seq, KIND_PAINT, encodePaint(0, mat, x0, y0, x1, y1, r).subarray(5)));
  c.move = (x, y, facing = 0, life = 0) =>
    ws.send(encodeInput(++seq, KIND_POS, encodePos(0, life, Math.round(x * 16), Math.round(y * 16), facing).subarray(5)));
  c.cast = (spell, angle, castSeq) => ws.send(encodeInput(++seq, KIND_CAST, encodeCast(0, spell, angle, castSeq).subarray(5)));
  c.sendLive = () => ws.send(encodeLive(c.ls.sim.tick()));
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

/** Register a player over HTTP and return its token (32 bytes) and id. */
export async function register(port: number, name: string): Promise<{ token: Uint8Array; id: number; name: string }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/players`, { method: "POST", body: JSON.stringify({ display_name: name }) });
  if (!r.ok) throw new Error(`register failed: ${r.status}`);
  const j = (await r.json()) as { token: string; player_id: number; display_name: string };
  return { token: unhex(j.token), id: j.player_id, name: j.display_name };
}

export async function waitFor(cond: () => boolean, ms = 20000, what = "condition"): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

import WebSocket from "ws";
import { expect, inject, it } from "vitest";
import { Lockstep } from "../client/lockstep.ts";
import { encodePaint, encodePos, KIND_PAINT, KIND_POS } from "../shared/inputs.ts";
import { decodeServer, encodeHello, encodeInput } from "../shared/protocol.ts";
import { loadSim, simBuildHash } from "../shared/sim.ts";

// Both worlds, checked against the RUNNING app: the page, the wasm it loads, and the
// lockstep claim itself (two clients, same ordered inputs, same world hash). World 0 is the
// sandbox (Paint), world 1 the game world (players with identity, Pos).
const baseUrl = inject("baseUrl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

it("serves the client page at /", async () => {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain('<script type="module"');
  expect(html).toContain("/readme/");
});

it("serves the same client at /sandbox", async () => {
  const res = await fetch(new URL("/sandbox", baseUrl));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('<script type="module"');
});

it("serves /readme/ and redirects /readme", async () => {
  expect((await fetch(new URL("/readme/", baseUrl))).status).toBe(200);
  const res = await fetch(new URL("/readme", baseUrl), { redirect: "manual" });
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("/readme/");
});

it("survives a malformed URL escape and keeps serving", async () => {
  const bad = await fetch(new URL("/%", baseUrl));
  expect(bad.status).toBe(400);
  const after = await fetch(new URL("/", baseUrl));
  expect(after.status).toBe(200);
});

it("serves sim.wasm as application/wasm", async () => {
  const res = await fetch(new URL("sim.wasm", baseUrl));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/wasm");
  expect(new Uint8Array(await res.arrayBuffer()).length).toBeGreaterThan(1000);
});

interface Peer {
  ws: WebSocket;
  ls: Lockstep;
  hashes: Map<number, bigint>;
  paint(): void;
  move(xCells: number, yCells: number): void;
  id: number;
}

async function join(wasm: Uint8Array, hashHex: string, world = 0, token?: Uint8Array): Promise<Peer> {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  ws.binaryType = "nodebuffer";
  const peer = { ws, hashes: new Map<number, bigint>(), id: 0 } as Peer;
  let seq = 0;
  await new Promise<void>((ok, bad) => {
    ws.on("open", () => ws.send(encodeHello(unhex(hashHex), world, token)));
    ws.on("error", bad);
    ws.on("message", (d: Buffer) => {
      const m = decodeServer(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      if (!m) return bad(new Error("undecodable server frame"));
      switch (m.t) {
        case "welcome": {
          peer.id = m.playerId;
          const sim = loadSim(wasm);
          sim.init(m.seed, m.worldKind);
          peer.ls = new Lockstep(sim);
          peer.ls.catchUpTarget = m.tick;
          peer.ls.onStepped = (tick) => {
            if (tick % 5 === 0) peer.hashes.set(tick, sim.stateHash());
          };
          ok();
          break;
        }
        case "snapshot":
          peer.ls.loadSnapshot(m.data, m.tick);
          break;
        case "tick":
          peer.ls.push(m.tick, m.inputs);
          peer.ls.run(100000);
          break;
        case "reject":
          bad(new Error(m.reason));
          break;
      }
    });
  });
  peer.move = (x, y) => ws.send(encodeInput(++seq, KIND_POS, encodePos(0, 0, Math.round(x * 16), Math.round(y * 16), 0).subarray(5)));
  peer.paint = () => ws.send(encodeInput(++seq, KIND_PAINT, encodePaint(0, 5, 100, 50, 140, 50, 8).subarray(5)));
  return peer;
}

it("two clients agree on the world after a paint lands", { timeout: 20_000 }, async () => {
  const wasm = new Uint8Array(await (await fetch(new URL("sim.wasm", baseUrl))).arrayBuffer());
  const hashHex = await simBuildHash(wasm);
  const [a, b] = [await join(wasm, hashHex), await join(wasm, hashHex)];
  try {
    await sleep(300);
    const before = a.ls.sim.stateHash();
    a.paint();
    const deadline = performance.now() + 10_000;
    while (a.ls.sim.stateHash() === before && performance.now() < deadline) await sleep(50);
    expect(a.ls.sim.stateHash(), "the paint never changed client A's world").not.toBe(before);

    // Let several more ticks apply, then compare every hash recorded at a common tick after the paint.
    const from = a.ls.simTick;
    await sleep(1000);
    const common = [...a.hashes.keys()].filter((t) => t > from && b.hashes.has(t));
    expect(common.length, "no common ticks to compare").toBeGreaterThan(3);
    for (const t of common) expect(b.hashes.get(t), `clients disagree at tick ${t}`).toBe(a.hashes.get(t));
  } finally {
    a.ws.close();
    b.ws.close();
  }
});

async function register(name: string): Promise<{ token: Uint8Array; id: number }> {
  const r = await fetch(new URL("/api/players", baseUrl), { method: "POST", body: JSON.stringify({ display_name: name }) });
  expect(r.status).toBe(200);
  const j = (await r.json()) as { token: string; player_id: number };
  return { token: unhex(j.token), id: j.player_id };
}

it("game world: two players with their own identities see each other move and agree on the state hash", { timeout: 60_000 }, async () => {
  const wasm = new Uint8Array(await (await fetch(new URL("sim.wasm", baseUrl))).arrayBuffer());
  const hashHex = await simBuildHash(wasm);
  const [ra, rb] = [await register("spec-a"), await register("spec-b")];
  const [a, b] = [await join(wasm, hashHex, 1, ra.token), await join(wasm, hashHex, 1, rb.token)];
  try {
    expect(a.id).toBe(ra.id);
    expect(b.id).toBe(rb.id);
    expect(a.id).not.toBe(b.id);
    await sleep(300);
    const spawn = a.ls.sim.entities().find((e) => e.type === 1 && e.id === a.id)!;
    const x0 = Math.round(spawn.x / 16);
    for (let i = 1; i <= 20; i++) {
      a.move(x0 + i, spawn.y / 16);
      await sleep(40);
    }
    await sleep(500);
    // B sees A at the new place, and both hash the same world (players are in the hash).
    const seen = b.ls.sim.entities().find((e) => e.type === 1 && e.id === a.id)!;
    expect(seen.x).toBe((x0 + 20) * 16);
    const common = [...a.hashes.keys()].filter((t) => b.hashes.has(t) && t > a.ls.simTick - 200);
    expect(common.length, "no common ticks to compare").toBeGreaterThan(3);
    for (const t of common) expect(b.hashes.get(t), `clients disagree at tick ${t}`).toBe(a.hashes.get(t));
  } finally {
    a.ws.close();
    b.ws.close();
  }
});

import WebSocket from "ws";
import { expect, inject, it } from "vitest";
import { Lockstep } from "../client/lockstep.ts";
import { encodePaint, KIND_PAINT } from "../shared/inputs.ts";
import { decodeServer, encodeHello, encodeInput } from "../shared/protocol.ts";
import { loadSim, simBuildHash } from "../shared/sim.ts";

// The sandbox, checked against the RUNNING app: the page, the wasm it loads, and
// the lockstep claim itself (two clients, same ordered inputs, same world hash).
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

it("serves /readme/ and redirects /readme", async () => {
  expect((await fetch(new URL("/readme/", baseUrl))).status).toBe(200);
  const res = await fetch(new URL("/readme", baseUrl), { redirect: "manual" });
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("/readme/");
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
}

async function join(wasm: Uint8Array, hashHex: string): Promise<Peer> {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  ws.binaryType = "nodebuffer";
  const peer = { ws, hashes: new Map<number, bigint>() } as Peer;
  let seq = 0;
  await new Promise<void>((ok, bad) => {
    ws.on("open", () => ws.send(encodeHello(unhex(hashHex), 0)));
    ws.on("error", bad);
    ws.on("message", (d: Buffer) => {
      const m = decodeServer(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      if (!m) return bad(new Error("undecodable server frame"));
      switch (m.t) {
        case "welcome": {
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

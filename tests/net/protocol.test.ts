import { describe, expect, it } from "vitest";
import { encodePaint, KIND_JOIN, KIND_PAINT } from "../../shared/inputs.ts";
import {
  decodeClient,
  decodeServer,
  compressSnapshot,
  decompressSnapshot,
  encodeClaim,
  encodeHash,
  PROTOCOL_VERSION,
  C_CHUNK_HASHES,
  S_REQUEST_CHUNK_HASHES,
  chunkCountFor,
  encodeChunkHashes,
  encodeRequestChunkHashes,
  maxChunkHashesFrameFor,
  C_CLAIM,
  C_LIVE,
  encodeLive,
  encodeHello,
  encodeRequestSnapshot,
  encodeResync,
  encodeSnapshot,
  encodeSnapshotUpload,
  splitTickFrames,
  encodeInput,
  encodePing,
  encodePong,
  encodeReject,
  encodeTick,
  encodeWelcome,
  PAINT_PAYLOAD_LEN,
  simInputBytes,
} from "../../shared/protocol.ts";
import { CAVES_PVP, CLASSIC_SANDBOX, encodeConfig } from "../../shared/room.ts";

const hash = Uint8Array.from({ length: 32 }, (_, i) => i);
const sandboxCfg = encodeConfig(CLASSIC_SANDBOX);

describe("protocol codec", () => {
  it("round-trips HELLO, INPUT, PING", () => {
    const h = decodeClient(encodeHello(hash, 7));
    expect(h).toMatchObject({ t: "hello", version: PROTOCOL_VERSION, worldId: 7, flags: 0 });
    expect(h && h.t === "hello" && Array.from(h.buildHash)).toEqual(Array.from(hash));
    const payload = encodePaint(0, 4, -3, 5, 100, 200, 6).subarray(5);
    expect(payload.length).toBe(PAINT_PAYLOAD_LEN);
    const i = decodeClient(encodeInput(99, KIND_PAINT, payload));
    expect(i).toMatchObject({ t: "input", seq: 99, kind: KIND_PAINT });
    expect(decodeClient(encodePing(123456))).toEqual({ t: "ping", ts: 123456 });
  });

  it("round-trips WELCOME, REJECT, PONG", () => {
    expect(decodeServer(encodeWelcome(5, 1n, sandboxCfg, 60, 4242))).toEqual({
      t: "welcome", playerId: 5, seed: 1n, cfg: sandboxCfg, worldKind: 0, tickHz: 60, tick: 4242, playersAtBase: 0,
    });
    expect(decodeServer(encodeReject("new version, reload"))).toEqual({ t: "reject", reason: "new version, reload" });
    expect(decodeServer(encodePong(77))).toEqual({ t: "pong", ts: 77 });
  });

  it("round-trips TICK, empty and full, and an empty one is 7 bytes", () => {
    expect(encodeTick(1, []).length).toBe(7);
    expect(decodeServer(encodeTick(1, []))).toEqual({ t: "tick", tick: 1, inputs: [] });
    const inputs = [
      { player: 3, kind: KIND_JOIN, payload: new Uint8Array(0) },
      { player: 3, kind: KIND_PAINT, payload: encodePaint(0, 4, 1, 2, 3, 4, 5).subarray(5) },
    ];
    const m = decodeServer(encodeTick(0xfffffff0, inputs));
    expect(m).toEqual({ t: "tick", tick: 0xfffffff0, inputs });
  });

  it("rebuilds the sim's canonical input bytes", () => {
    const full = encodePaint(9, 4, 1, 2, 3, 4, 5);
    expect(simInputBytes({ player: 9, kind: KIND_PAINT, payload: full.subarray(5) })).toEqual(full);
  });

  it("rejects truncated, padded and unknown frames", () => {
    const frames = [
      encodeHello(hash),
      encodeInput(1, KIND_PAINT, new Uint8Array(10)),
      encodePing(1),
      encodeWelcome(1, 1n, sandboxCfg, 60, 0),
      encodePong(1),
      encodeTick(5, [{ player: 1, kind: 5, payload: new Uint8Array(10) }]),
    ];
    for (const f of frames) {
      const dec = f[0] < 0x80 ? decodeClient : decodeServer;
      expect(dec(f)).not.toBeNull();
      expect(dec(new Uint8Array(0))).toBeNull();
      // Every proper prefix is invalid, except an INPUT whose payload is just shorter (length checked by the server).
      if (f[0] !== 0x02) for (let n = 1; n < f.length; n++) expect(dec(f.subarray(0, n))).toBeNull();
      if (f[0] !== 0x02) expect(dec(Uint8Array.from([...f, 0]))).toBeNull();
    }
    expect(decodeClient(Uint8Array.from([0x02, 1, 2, 3]))).toBeNull();
    expect(decodeClient(Uint8Array.from([0x55]))).toBeNull();
    expect(decodeServer(Uint8Array.from([0x55]))).toBeNull();
    // A TICK that claims more inputs than it carries.
    const lie = encodeTick(1, []);
    lie[5] = 3;
    expect(decodeServer(lie)).toBeNull();
  });

  it("round-trips HASH and SNAPSHOT_UPLOAD, including the top bit of the u64", () => {
    expect(decodeClient(encodeHash(600, 0xfedcba9876543210n))).toEqual({ t: "hash", tick: 600, hash: 0xfedcba9876543210n, stepP95: 0, buffered: 0 });
    expect(decodeClient(encodeHash(600, 5n, 1.234, 7))).toEqual({ t: "hash", tick: 600, hash: 5n, stepP95: 1.23, buffered: 7 });
    // Clamped to the field widths, and never negative or NaN.
    expect(decodeClient(encodeHash(1, 1n, 9999, 9999))).toMatchObject({ stepP95: 655.35, buffered: 255 });
    expect(decodeClient(encodeHash(1, 1n, -3, -1))).toMatchObject({ stepP95: 0, buffered: 0 });
    expect(decodeClient(encodeHash(1, 1n, NaN, NaN))).toMatchObject({ stepP95: 0, buffered: 0 });
    // A v3 HASH (13 bytes) is refused.
    expect(decodeClient(encodeHash(1, 1n).subarray(0, 13))).toBeNull();
    const data = Uint8Array.from({ length: 300 }, (_, i) => i * 7);
    const u = decodeClient(encodeSnapshotUpload(1800, 0x8000000000000001n, data));
    expect(u).toMatchObject({ t: "snapshot-upload", tick: 1800, hash: 0x8000000000000001n });
    expect(u && u.t === "snapshot-upload" && Array.from(u.data)).toEqual(Array.from(data));
    expect(decodeClient(encodeHash(1, 1n).subarray(0, 15))).toBeNull();
    expect(decodeClient(encodeSnapshotUpload(1, 1n, new Uint8Array(0)).subarray(0, 13))).toBeNull();
  });

  it("round-trips SNAPSHOT, REQUEST_SNAPSHOT, RESYNC", () => {
    const data = new Uint8Array([9, 8, 7]);
    expect(decodeServer(encodeSnapshot(60, data))).toEqual({ t: "snapshot", tick: 60, data });
    expect(decodeServer(encodeRequestSnapshot(1920))).toEqual({ t: "request-snapshot", tick: 1920 });
    expect(decodeServer(encodeResync(4000, 3))).toEqual({ t: "resync", tick: 4000, playersAtBase: 3 });
    expect(decodeServer(encodeResync(4000).subarray(0, 5))).toBeNull();
  });

  it("compresses snapshots and refuses a decompression bomb", () => {
    const raw = new Uint8Array(100_000).fill(3);
    const z = compressSnapshot(raw);
    expect(z.length).toBeLessThan(1000);
    expect(Array.from(decompressSnapshot(z).subarray(0, 5))).toEqual([3, 3, 3, 3, 3]);
    expect(decompressSnapshot(z).length).toBe(100_000);
    expect(() => decompressSnapshot(compressSnapshot(new Uint8Array(5_000_000)))).toThrow();
    expect(() => decompressSnapshot(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it("splits a tick_log batch back into frames and rejects truncation", () => {
    const a = encodeTick(5, []);
    const b = encodeTick(6, [{ player: 1, kind: KIND_PAINT, payload: new Uint8Array(10) }]);
    const cat = new Uint8Array([...a, ...b]);
    expect(splitTickFrames(cat)?.map((f) => f.length)).toEqual([a.length, b.length]);
    expect(splitTickFrames(cat.subarray(0, cat.length - 1))).toBeNull();
  });

  it("round-trips CLAIM at protocol v6 and refuses any other length", () => {
    expect(PROTOCOL_VERSION).toBe(9);
    expect(C_CLAIM).toBe(6);
    const f = encodeClaim(123456, 7, 9, 4, 1);
    expect(f.length).toBe(15);
    expect(decodeClient(f)).toEqual({ t: "claim", tick: 123456, victim: 7, killer: 9, cause: 4, bag: 1 });
    expect(decodeClient(encodeClaim(0xffffffff, 0xffffffff, 0, 255, 255))).toEqual({ t: "claim", tick: 0xffffffff, victim: 0xffffffff, killer: 0, cause: 255, bag: 255 });
    for (const n of [1, 5, 14]) expect(decodeClient(f.subarray(0, n))).toBeNull();
    expect(decodeClient(new Uint8Array([...f, 0]))).toBeNull();
    expect(decodeClient(new Uint8Array(1000).fill(C_CLAIM))).toBeNull();
  });

  it("round-trips LIVE and refuses any other length", () => {
    expect(C_LIVE).toBe(7);
    const f = encodeLive(123456);
    expect(Array.from(f)).toEqual([7, 0x40, 0xe2, 0x01, 0x00]);
    expect(decodeClient(f)).toEqual({ t: "live", tick: 123456 });
    expect(decodeClient(encodeLive(0xffffffff))).toEqual({ t: "live", tick: 0xffffffff });
    for (const n of [1, 2, 4]) expect(decodeClient(f.subarray(0, n))).toBeNull();
    expect(decodeClient(new Uint8Array([...f, 0]))).toBeNull();
    expect(decodeClient(new Uint8Array(1000).fill(C_LIVE))).toBeNull();
  });

  it("never throws on random bytes, whatever the tag or length", () => {
    let x = 12345;
    const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296;
    for (let k = 0; k < 5000; k++) {
      const b = new Uint8Array(Math.floor(rnd() * 40));
      for (let i = 0; i < b.length; i++) b[i] = Math.floor(rnd() * 256);
      if (b.length && k % 2) b[0] = k % 4 === 1 ? C_CLAIM : C_LIVE;
      expect(() => decodeClient(b)).not.toThrow();
      const m = decodeClient(b);
      if (m?.t === "claim") expect(b.length).toBe(15);
      if (m?.t === "live") expect(b.length).toBe(5);
    }
  });

  it("round-trips REQUEST_CHUNK_HASHES and CHUNK_HASHES at protocol v8", () => {
    expect(PROTOCOL_VERSION).toBe(9);
    expect(C_CHUNK_HASHES).toBe(8);
    expect(S_REQUEST_CHUNK_HASHES).toBe(0x8a);
    const rq = encodeRequestChunkHashes(0x01020304);
    expect(Array.from(rq)).toEqual([0x8a, 4, 3, 2, 1]);
    expect(decodeServer(rq)).toEqual({ t: "request-chunk-hashes", tick: 0x01020304 });
    for (const n of [1, 2, 4]) expect(decodeServer(rq.subarray(0, n))).toBeNull();
    expect(decodeServer(new Uint8Array([...rq, 0]))).toBeNull();
    const hs = BigUint64Array.from([1n, 0xffffffffffffffffn, 0x0102030405060708n]);
    const f = encodeChunkHashes(600, hs);
    expect(f.length).toBe(7 + 8 * 3);
    expect(decodeClient(f)).toEqual({ t: "chunk-hashes", tick: 600, hashes: hs });
    expect(decodeClient(encodeChunkHashes(600, new BigUint64Array(0)))).toEqual({ t: "chunk-hashes", tick: 600, hashes: new BigUint64Array(0) });
    // Any length other than 7 + 8 * count is refused.
    expect(decodeClient(f.subarray(0, f.length - 1))).toBeNull();
    expect(decodeClient(new Uint8Array([...f, 0]))).toBeNull();
    expect(decodeClient(f.subarray(0, 6))).toBeNull();
    const lie = f.slice();
    lie[5] = 4; // claims 4 hashes, carries 3
    expect(decodeClient(lie)).toBeNull();
    const huge = new Uint8Array(7);
    huge[0] = C_CHUNK_HASHES;
    huge[5] = 0xff;
    huge[6] = 0xff; // count 65535 with no body
    expect(decodeClient(huge)).toBeNull();
  });

  it("has a per-world CHUNK_HASHES frame cap that fits a full array exactly", () => {
    expect(chunkCountFor(CLASSIC_SANDBOX)).toBe(64);
    expect(chunkCountFor(CAVES_PVP)).toBe(768);
    expect(maxChunkHashesFrameFor(CLASSIC_SANDBOX)).toBe(7 + 8 * 64);
    expect(maxChunkHashesFrameFor(CAVES_PVP)).toBe(7 + 8 * 768);
    expect(encodeChunkHashes(1, new BigUint64Array(768)).length).toBe(maxChunkHashesFrameFor(CAVES_PVP));
    expect(encodeChunkHashes(1, new BigUint64Array(768)).length).toBeGreaterThan(maxChunkHashesFrameFor(CLASSIC_SANDBOX));
    expect(() => encodeChunkHashes(1, new BigUint64Array(5000))).toThrow();
  });

  it("never throws decoding random CHUNK_HASHES and REQUEST_CHUNK_HASHES bytes", () => {
    let x = 777;
    const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296;
    for (let k = 0; k < 5000; k++) {
      const b = new Uint8Array(Math.floor(rnd() * 80));
      for (let i = 0; i < b.length; i++) b[i] = Math.floor(rnd() * 256);
      if (b.length) b[0] = k % 2 ? C_CHUNK_HASHES : S_REQUEST_CHUNK_HASHES;
      if (b.length >= 7 && k % 3 === 0) {
        b[5] = ((b.length - 7) >> 3) & 255; // sometimes a self-consistent count
        b[6] = 0;
      }
      expect(() => decodeClient(b)).not.toThrow();
      expect(() => decodeServer(b)).not.toThrow();
      const m = decodeClient(b);
      if (m?.t === "chunk-hashes") expect(b.length).toBe(7 + 8 * m.hashes.length);
    }
  });
});

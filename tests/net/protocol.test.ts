import { describe, expect, it } from "vitest";
import { encodePaint, KIND_JOIN, KIND_PAINT } from "../../shared/inputs.ts";
import {
  decodeClient,
  decodeServer,
  encodeHello,
  encodeInput,
  encodePing,
  encodePong,
  encodeReject,
  encodeTick,
  encodeWelcome,
  PAINT_PAYLOAD_LEN,
  simInputBytes,
} from "../../shared/protocol.ts";

const hash = Uint8Array.from({ length: 32 }, (_, i) => i);

describe("protocol codec", () => {
  it("round-trips HELLO, INPUT, PING", () => {
    const h = decodeClient(encodeHello(hash, 7));
    expect(h).toMatchObject({ t: "hello", version: 1, worldId: 7 });
    expect(h && h.t === "hello" && Array.from(h.buildHash)).toEqual(Array.from(hash));
    const payload = encodePaint(0, 4, -3, 5, 100, 200, 6).subarray(5);
    expect(payload.length).toBe(PAINT_PAYLOAD_LEN);
    const i = decodeClient(encodeInput(99, KIND_PAINT, payload));
    expect(i).toMatchObject({ t: "input", seq: 99, kind: KIND_PAINT });
    expect(decodeClient(encodePing(123456))).toEqual({ t: "ping", ts: 123456 });
  });

  it("round-trips WELCOME, REJECT, PONG", () => {
    expect(decodeServer(encodeWelcome(5, 1n, 0, 60, 4242))).toEqual({
      t: "welcome", playerId: 5, seed: 1n, worldKind: 0, tickHz: 60, tick: 4242,
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
      encodeWelcome(1, 1n, 0, 60, 0),
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
});

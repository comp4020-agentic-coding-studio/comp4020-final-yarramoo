// Binary WebSocket protocol (plan 7.2). Little-endian, u8 type tag first. Shared by client and server.
// Pure and environment-free. Decoders return null for a malformed or truncated frame; they never throw.

export const PROTOCOL_VERSION = 1;
export const TICK_HZ = 60;

// Client -> server tags
export const C_HELLO = 0x01;
export const C_INPUT = 0x02;
export const C_PING = 0x03;
// Server -> client tags
export const S_WELCOME = 0x81;
export const S_REJECT = 0x82;
export const S_TICK = 0x83;
export const S_PONG = 0x84;

export const HASH_LEN = 32;
export const TOKEN_LEN = 32;
export const MAX_REASON_BYTES = 200;
/** Paint payload after the sim's kind and player fields: mat u8, x0 y0 x1 y1 i16, radius u8. */
export const PAINT_PAYLOAD_LEN = 10;

/** One input in a closed tick. `payload` is the sim input without its kind and player fields. */
export interface TickInput {
  player: number;
  kind: number;
  payload: Uint8Array;
}

export type ClientMsg =
  | { t: "hello"; version: number; buildHash: Uint8Array; token: Uint8Array; worldId: number }
  | { t: "input"; seq: number; kind: number; payload: Uint8Array }
  | { t: "ping"; ts: number };

export type ServerMsg =
  | { t: "welcome"; playerId: number; seed: bigint; worldKind: number; tickHz: number; tick: number }
  | { t: "reject"; reason: string }
  | { t: "tick"; tick: number; inputs: TickInput[] }
  | { t: "pong"; ts: number };

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export function encodeHello(buildHash: Uint8Array, worldId = 0, token: Uint8Array = new Uint8Array(TOKEN_LEN)): Uint8Array {
  if (buildHash.length !== HASH_LEN || token.length !== TOKEN_LEN) throw new Error("bad hello field length");
  const b = new Uint8Array(1 + 1 + HASH_LEN + TOKEN_LEN + 4);
  b[0] = C_HELLO;
  b[1] = PROTOCOL_VERSION;
  b.set(buildHash, 2);
  b.set(token, 2 + HASH_LEN);
  view(b).setUint32(2 + HASH_LEN + TOKEN_LEN, worldId, true);
  return b;
}

export function encodeInput(seq: number, kind: number, payload: Uint8Array): Uint8Array {
  const b = new Uint8Array(6 + payload.length);
  b[0] = C_INPUT;
  view(b).setUint32(1, seq, true);
  b[5] = kind;
  b.set(payload, 6);
  return b;
}

export function encodePing(ts: number): Uint8Array {
  const b = new Uint8Array(5);
  b[0] = C_PING;
  view(b).setUint32(1, ts >>> 0, true);
  return b;
}

export function encodeWelcome(playerId: number, seed: bigint, worldKind: number, tickHz: number, tick: number): Uint8Array {
  const b = new Uint8Array(19);
  const v = view(b);
  b[0] = S_WELCOME;
  v.setUint32(1, playerId, true);
  v.setBigUint64(5, BigInt.asUintN(64, seed), true);
  b[13] = worldKind;
  b[14] = tickHz;
  v.setUint32(15, tick, true);
  return b;
}

export function encodeReject(reason: string): Uint8Array {
  let r = te.encode(reason);
  if (r.length > MAX_REASON_BYTES) r = r.subarray(0, MAX_REASON_BYTES);
  const b = new Uint8Array(1 + r.length);
  b[0] = S_REJECT;
  b.set(r, 1);
  return b;
}

export function encodePong(ts: number): Uint8Array {
  const b = new Uint8Array(5);
  b[0] = S_PONG;
  view(b).setUint32(1, ts >>> 0, true);
  return b;
}

/** TICK: tick u32, n u16, then n * (player u32, kind u8, len u16, payload). 7 bytes when empty. */
export function encodeTick(tick: number, inputs: readonly TickInput[]): Uint8Array {
  let len = 7;
  for (const i of inputs) len += 7 + i.payload.length;
  const b = new Uint8Array(len);
  const v = view(b);
  b[0] = S_TICK;
  v.setUint32(1, tick, true);
  v.setUint16(5, inputs.length, true);
  let o = 7;
  for (const i of inputs) {
    v.setUint32(o, i.player, true);
    b[o + 4] = i.kind;
    v.setUint16(o + 5, i.payload.length, true);
    b.set(i.payload, o + 7);
    o += 7 + i.payload.length;
  }
  return b;
}

export function decodeClient(b: Uint8Array): ClientMsg | null {
  if (b.length < 1) return null;
  const v = view(b);
  switch (b[0]) {
    case C_HELLO: {
      if (b.length !== 2 + HASH_LEN + TOKEN_LEN + 4) return null;
      return {
        t: "hello",
        version: b[1],
        buildHash: b.slice(2, 2 + HASH_LEN),
        token: b.slice(2 + HASH_LEN, 2 + HASH_LEN + TOKEN_LEN),
        worldId: v.getUint32(2 + HASH_LEN + TOKEN_LEN, true),
      };
    }
    case C_INPUT:
      if (b.length < 6) return null;
      return { t: "input", seq: v.getUint32(1, true), kind: b[5], payload: b.slice(6) };
    case C_PING:
      if (b.length !== 5) return null;
      return { t: "ping", ts: v.getUint32(1, true) };
    default:
      return null;
  }
}

export function decodeServer(b: Uint8Array): ServerMsg | null {
  if (b.length < 1) return null;
  const v = view(b);
  switch (b[0]) {
    case S_WELCOME:
      if (b.length !== 19) return null;
      return {
        t: "welcome",
        playerId: v.getUint32(1, true),
        seed: v.getBigUint64(5, true),
        worldKind: b[13],
        tickHz: b[14],
        tick: v.getUint32(15, true),
      };
    case S_REJECT:
      if (b.length - 1 > MAX_REASON_BYTES) return null;
      try {
        return { t: "reject", reason: td.decode(b.subarray(1)) };
      } catch {
        return null;
      }
    case S_TICK: {
      if (b.length < 7) return null;
      const n = v.getUint16(5, true);
      const inputs: TickInput[] = [];
      let o = 7;
      for (let k = 0; k < n; k++) {
        if (o + 7 > b.length) return null;
        const len = v.getUint16(o + 5, true);
        if (o + 7 + len > b.length) return null;
        inputs.push({ player: v.getUint32(o, true), kind: b[o + 4], payload: b.slice(o + 7, o + 7 + len) });
        o += 7 + len;
      }
      if (o !== b.length) return null;
      return { t: "tick", tick: v.getUint32(1, true), inputs };
    }
    case S_PONG:
      if (b.length !== 5) return null;
      return { t: "pong", ts: v.getUint32(1, true) };
    default:
      return null;
  }
}

/** The sim's canonical input bytes (shared/inputs.ts layout): kind u8, player u32, payload. */
export function simInputBytes(i: TickInput): Uint8Array {
  const b = new Uint8Array(5 + i.payload.length);
  b[0] = i.kind;
  view(b).setUint32(1, i.player, true);
  b.set(i.payload, 5);
  return b;
}

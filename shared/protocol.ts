// Binary WebSocket protocol (plan 7.2). Little-endian, u8 type tag first. Shared by client and server.
import { unzlibSync, zlibSync } from "fflate";
import { configForKind, CONFIG_BYTES, SIZE_DIMS, type RoomConfig } from "./room.ts";

const SANDBOX_CFG_BYTES = configForKind(0);
const GAME_CFG_BYTES = configForKind(1);

// Pure and environment-free. Decoders return null for a malformed or truncated frame; they never throw.

/**
 * v9 (R2b): WELCOME carries the room's 16-byte config (byte 13..28) instead of a bare world-kind byte, so a
 * joining client inits its sim from the same bytes every member of the room shares, not a kind number that
 * only meant something for the two fixed worlds. HELLO is unchanged: its `worldId` field now names a room id.
 */
export const PROTOCOL_VERSION = 9;
export const TICK_HZ = 60;

// Client -> server tags
export const C_HELLO = 0x01;
export const C_INPUT = 0x02;
export const C_PING = 0x03;
export const C_HASH = 0x04;
export const C_SNAPSHOT_UPLOAD = 0x05;
/** `tick u32, victim u32, killer u32, cause u8, bag u8`: one EV_DEATH the client's sim emitted. A report, never an input. */
export const C_CLAIM = 0x06;
export const CLAIM_LEN = 15;
/** `tick u32`: "I have finished replaying to my WELCOME or RESYNC tick" (D-122). Lets the server stop holding the clock for me. */
export const C_LIVE = 0x07;
export const LIVE_LEN = 5;
/**
 * `tick u32, count u16, hashes u64[count]`: this client's per-chunk hashes at a checkpoint tick the server asked
 * about (D-126). `count` 0 means "that tick is no longer in my ring buffer". Exactly `7 + 8 * count` bytes.
 * A diagnostic report, never an input (invariant 9).
 */
export const C_CHUNK_HASHES = 0x08;
export const CHUNK_HASHES_HEADER = 7;
// Server -> client tags
export const S_WELCOME = 0x81;
export const S_REJECT = 0x82;
export const S_TICK = 0x83;
export const S_PONG = 0x84;
export const S_SNAPSHOT = 0x85;
export const S_REQUEST_SNAPSHOT = 0x86;
export const S_RESYNC = 0x87;
/** `player u32, name utf8`: who a player id is. Render-only (labels); never state. */
export const S_PLAYER_NAME = 0x88;
export const MAX_NAME_CHARS = 24;
/** `id_len u8, id utf8, tick u32`: you earned this achievement (to the earner only). Ids are short ASCII slugs. */
export const S_ACHIEVEMENT = 0x89;
export const MAX_ACHIEVEMENT_ID_BYTES = 32;
/** `tick u32`: send me your chunk hashes for this checkpoint (D-126). */
export const S_REQUEST_CHUNK_HASHES = 0x8a;

/** Hash checkpoint spacing; snapshot ticks are multiples of it. */
export const HASH_EVERY = 60;
/** Uncompressed snapshot ceiling for the 512x512 sandbox (about 520 KB when every chunk is live). */
export const MAX_SNAPSHOT_RAW = 1 << 20;
/** A game world: 768 chunks x 8194 bytes = 6.3 MB, plus up to 1024 players and the pickups (about 70 KB). */
export const MAX_SNAPSHOT_RAW_GAME = 7 << 20;
/** Largest accepted SNAPSHOT_UPLOAD frame for a sandbox world. Every other frame is capped far lower by the server. */
export const MAX_UPLOAD_FRAME = 1 << 20;
/**
 * Compressed game-world snapshot frame ceiling. Cell bytes are 0..14 materials and small counters, so a worst-case
 * all-live world compresses at least 2:1 (about 3.3 MB); 4 MiB leaves headroom.
 */
export const MAX_UPLOAD_FRAME_GAME = 4 << 20;
export const WORLD_SANDBOX = 0;
export const WORLD_GAME = 1;
/** HELLO flag: watch only (no avatar, no Join, no inputs). Phones use this in the game world (D-011). */
export const HELLO_SPECTATE = 1;

/**
 * Ceilings that depend on the room, computed from its config (R0a): the size gives the chunk grid, the grid gives the
 * snapshot cap, and the cap bounds decompression (zip-bomb guard) before anything is read. A chunk is 8194 bytes in a
 * snapshot (2-byte index, mat and aux planes); 128 KiB covers the header, up to 1024 players and the pickups.
 * Reproduces the old per-kind numbers exactly: classic sandbox 1 MiB, caves 7 MiB.
 */
const MIB = 1 << 20;
export const SNAPSHOT_CHUNK_BYTES = 8194;
export const SNAPSHOT_OVERHEAD = 128 * 1024;
/** The chunk grid of a room: `cw x ch` chunks of CHUNK_CELLS. */
export const chunkGridFor = (cfg: RoomConfig): { cw: number; ch: number } => {
  const [w, h] = SIZE_DIMS[cfg.size];
  return { cw: w / CHUNK_CELLS, ch: h / CHUNK_CELLS };
};
export const chunkCountFor = (cfg: RoomConfig): number => {
  const g = chunkGridFor(cfg);
  return g.cw * g.ch;
};
/** Uncompressed snapshot ceiling for a room. */
export const maxSnapshotRawFor = (cfg: RoomConfig): number => Math.ceil((chunkCountFor(cfg) * SNAPSHOT_CHUNK_BYTES + SNAPSHOT_OVERHEAD) / MIB) * MIB;
/** Compressed SNAPSHOT_UPLOAD frame ceiling: a worst-case all-live world compresses at least 2:1 (see MAX_UPLOAD_FRAME_GAME). */
export const maxUploadFrameFor = (cfg: RoomConfig): number => Math.max(1, Math.ceil(maxSnapshotRawFor(cfg) / 2 / MIB)) * MIB;
/** The socket's one payload cap has to admit the largest upload of any world (ws checks it before the tag byte). */
export const MAX_SOCKET_PAYLOAD = Math.max(MAX_UPLOAD_FRAME, MAX_UPLOAD_FRAME_GAME);
/** Chunk side in cells (sim CHUNK). */
export const CHUNK_CELLS = 64;
/** The most chunks any world has (sim.ts MAX_CHUNKS): the decoder's own bound, whatever the world. */
export const MAX_CHUNK_COUNT = 4096;
/** The only length a CHUNK_HASHES frame for this room may have, at most (the server's per-world frame cap). */
export const maxChunkHashesFrameFor = (cfg: RoomConfig): number => CHUNK_HASHES_HEADER + 8 * chunkCountFor(cfg);
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
  | { t: "hello"; version: number; buildHash: Uint8Array; token: Uint8Array; worldId: number; flags: number }
  | { t: "input"; seq: number; kind: number; payload: Uint8Array }
  | { t: "ping"; ts: number }
  | { t: "hash"; tick: number; hash: bigint; stepP95: number; buffered: number }
  | { t: "snapshot-upload"; tick: number; hash: bigint; data: Uint8Array }
  | { t: "claim"; tick: number; victim: number; killer: number; cause: number; bag: number }
  | { t: "live"; tick: number }
  | { t: "chunk-hashes"; tick: number; hashes: BigUint64Array };

export type ServerMsg =
  | { t: "welcome"; playerId: number; seed: bigint; cfg: Uint8Array; worldKind: number; tickHz: number; tick: number; playersAtBase: number }
  | { t: "reject"; reason: string }
  | { t: "tick"; tick: number; inputs: TickInput[] }
  | { t: "pong"; ts: number }
  | { t: "snapshot"; tick: number; data: Uint8Array }
  | { t: "request-snapshot"; tick: number }
  /** Followed by an optional SNAPSHOT and then every closed tick after it; `tick` is the last closed tick (the replay target). */
  | { t: "resync"; tick: number; playersAtBase: number }
  | { t: "player-name"; player: number; name: string }
  | { t: "achievement"; id: string; tick: number }
  | { t: "request-chunk-hashes"; tick: number };

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export function encodeHello(
  buildHash: Uint8Array,
  worldId = 0,
  token: Uint8Array = new Uint8Array(TOKEN_LEN),
  flags = 0,
): Uint8Array {
  if (buildHash.length !== HASH_LEN || token.length !== TOKEN_LEN) throw new Error("bad hello field length");
  const b = new Uint8Array(1 + 1 + HASH_LEN + TOKEN_LEN + 4 + 1);
  b[0] = C_HELLO;
  b[1] = PROTOCOL_VERSION;
  b.set(buildHash, 2);
  b.set(token, 2 + HASH_LEN);
  view(b).setUint32(2 + HASH_LEN + TOKEN_LEN, worldId, true);
  b[2 + HASH_LEN + TOKEN_LEN + 4] = flags;
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

/**
 * v9 (R2b) layout, 36 bytes fixed:
 * `tag u8(0), playerId u32(1..5), seed u64(5..13), config 16 bytes(13..29), tickHz u8(29), tick u32(30..34),
 * playersAtBase u16(34..36)`. `cfg` replaces the old bare `worldKind: u8` at byte 13 so a joiner inits its sim
 * from the room's actual config, not a kind number that only ever meant something for the two fixed worlds.
 */
export function encodeWelcome(playerId: number, seed: bigint, cfg: Uint8Array, tickHz: number, tick: number, playersAtBase = 0): Uint8Array {
  if (cfg.length !== CONFIG_BYTES) throw new Error("bad welcome config length");
  const b = new Uint8Array(36);
  const v = view(b);
  b[0] = S_WELCOME;
  v.setUint32(1, playerId, true);
  v.setBigUint64(5, BigInt.asUintN(64, seed), true);
  b.set(cfg, 13);
  b[29] = tickHz;
  v.setUint32(30, tick, true);
  v.setUint16(34, Math.min(0xffff, playersAtBase), true);
  return b;
}

/**
 * Back-compat `worldKind` for WELCOME decode (R2b): the two fixed worlds' configs map back to their old kind
 * byte exactly, so `client/`'s existing call sites (still reading `m.worldKind`, unchanged in this slice —
 * R3 wires real room ids into the client) keep working unmodified. -1 for any other config: only a real joined
 * room (not `/sandbox` or the cave world) can produce one, and nothing in `client/` joins a real room yet.
 */
function kindOfWelcomeConfig(cfg: Uint8Array): number {
  if (bytesEqual(cfg, SANDBOX_CFG_BYTES)) return WORLD_SANDBOX;
  if (bytesEqual(cfg, GAME_CFG_BYTES)) return WORLD_GAME;
  return -1;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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

/**
 * HASH: tick u32, state hash u64, stepP95 u16 (hundredths of a ms, clamped), buffered u8 (playout buffer length,
 * clamped). The last two are timing figures for the server's dashboard; the sim never sees them.
 */
export function encodeHash(tick: number, hash: bigint, stepP95Ms = 0, buffered = 0): Uint8Array {
  const b = new Uint8Array(16);
  b[0] = C_HASH;
  view(b).setUint32(1, tick, true);
  view(b).setBigUint64(5, BigInt.asUintN(64, hash), true);
  const hund = Math.round(stepP95Ms * 100);
  view(b).setUint16(13, Number.isFinite(hund) ? Math.max(0, Math.min(65535, hund)) : 0, true);
  b[15] = Number.isFinite(buffered) ? Math.max(0, Math.min(255, Math.floor(buffered))) : 0;
  return b;
}

/** SNAPSHOT_UPLOAD: tick u32, state hash u64, then the fflate-compressed canonical snapshot. */
export function encodeSnapshotUpload(tick: number, hash: bigint, data: Uint8Array): Uint8Array {
  const b = new Uint8Array(13 + data.length);
  b[0] = C_SNAPSHOT_UPLOAD;
  view(b).setUint32(1, tick, true);
  view(b).setBigUint64(5, BigInt.asUintN(64, hash), true);
  b.set(data, 13);
  return b;
}

/** CLAIM: the fields of one EV_DEATH (plan 10). Fixed length. */
export function encodeClaim(tick: number, victim: number, killer: number, cause: number, bag: number): Uint8Array {
  const b = new Uint8Array(CLAIM_LEN);
  const v = view(b);
  b[0] = C_CLAIM;
  v.setUint32(1, tick >>> 0, true);
  v.setUint32(5, victim >>> 0, true);
  v.setUint32(9, killer >>> 0, true);
  b[13] = cause & 255;
  b[14] = bag & 255;
  return b;
}

/** LIVE: the tick the client's sim has reached after catching up. Informational: the server only needs the message. */
export function encodeLive(tick: number): Uint8Array {
  const b = new Uint8Array(LIVE_LEN);
  b[0] = C_LIVE;
  view(b).setUint32(1, tick >>> 0, true);
  return b;
}

/** CHUNK_HASHES: `hashes` empty means the tick is gone from the ring buffer. */
export function encodeChunkHashes(tick: number, hashes: BigUint64Array | readonly bigint[]): Uint8Array {
  if (hashes.length > MAX_CHUNK_COUNT) throw new RangeError("too many chunk hashes");
  const b = new Uint8Array(CHUNK_HASHES_HEADER + 8 * hashes.length);
  const v = view(b);
  b[0] = C_CHUNK_HASHES;
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, hashes.length, true);
  for (let i = 0; i < hashes.length; i++) v.setBigUint64(CHUNK_HASHES_HEADER + 8 * i, BigInt.asUintN(64, hashes[i]), true);
  return b;
}

export function encodeRequestChunkHashes(tick: number): Uint8Array {
  const b = new Uint8Array(5);
  b[0] = S_REQUEST_CHUNK_HASHES;
  view(b).setUint32(1, tick >>> 0, true);
  return b;
}

export function encodeSnapshot(tick: number, data: Uint8Array): Uint8Array {
  const b = new Uint8Array(5 + data.length);
  b[0] = S_SNAPSHOT;
  view(b).setUint32(1, tick, true);
  b.set(data, 5);
  return b;
}

export function encodeRequestSnapshot(tick: number): Uint8Array {
  const b = new Uint8Array(5);
  b[0] = S_REQUEST_SNAPSHOT;
  view(b).setUint32(1, tick, true);
  return b;
}

/** Display name as the server sends it: trimmed, control characters removed, capped to MAX_NAME_CHARS. Never HTML. */
export function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return Array.from(s).slice(0, MAX_NAME_CHARS).join("");
}

export function encodePlayerName(player: number, name: string): Uint8Array {
  const n = te.encode(cleanName(name));
  const b = new Uint8Array(5 + n.length);
  b[0] = S_PLAYER_NAME;
  view(b).setUint32(1, player, true);
  b.set(n, 5);
  return b;
}

export function encodeAchievement(id: string, tick: number): Uint8Array {
  const n = te.encode(id);
  if (n.length === 0 || n.length > MAX_ACHIEVEMENT_ID_BYTES) throw new Error("achievement id length");
  const b = new Uint8Array(1 + 1 + n.length + 4);
  b[0] = S_ACHIEVEMENT;
  b[1] = n.length;
  b.set(n, 2);
  view(b).setUint32(2 + n.length, tick >>> 0, true);
  return b;
}

export function encodeResync(tick: number, playersAtBase = 0): Uint8Array {
  const b = new Uint8Array(7);
  b[0] = S_RESYNC;
  view(b).setUint32(1, tick, true);
  view(b).setUint16(5, Math.min(0xffff, playersAtBase), true);
  return b;
}

/** Compression happens outside the sim; the hash is over the uncompressed canonical state. */
export function compressSnapshot(raw: Uint8Array): Uint8Array {
  return zlibSync(raw, { level: 6 });
}

/** Throws on corrupt data or output larger than `maxBytes` (a zip bomb cannot allocate past the cap). */
export function decompressSnapshot(data: Uint8Array, maxBytes = MAX_SNAPSHOT_RAW): Uint8Array {
  const out = new Uint8Array(maxBytes);
  const r = unzlibSync(data, { out });
  // fflate truncates silently when `out` fills up, so a full buffer means the stream was too big.
  if (r.length >= maxBytes) throw new Error("snapshot too large");
  return r.slice();
}

/** Split concatenated TICK frames (a tick_log batch). Returns null if the bytes are not whole frames. */
export function splitTickFrames(b: Uint8Array): Uint8Array[] | null {
  const v = view(b);
  const out: Uint8Array[] = [];
  let o = 0;
  while (o < b.length) {
    if (o + 7 > b.length || b[o] !== S_TICK) return null;
    const n = v.getUint16(o + 5, true);
    let e = o + 7;
    for (let k = 0; k < n; k++) {
      if (e + 7 > b.length) return null;
      e += 7 + v.getUint16(e + 5, true);
    }
    if (e > b.length) return null;
    out.push(b.subarray(o, e));
    o = e;
  }
  return out;
}

/** TICK: tick u32, n u16, then n * (player u32, kind u8, len u16, payload). 7 bytes when empty. */
export function encodeTick(tick: number, inputs: readonly TickInput[]): Uint8Array {
  // The count is a u16. A wrapped count would make every client misparse the frame, and it is persisted: refuse it
  // loudly rather than write it (the server caps client inputs per tick well below this; review catch-up N1).
  if (inputs.length > 0xffff) throw new RangeError(`a tick cannot carry ${inputs.length} inputs`);
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
      if (b.length !== 2 + HASH_LEN + TOKEN_LEN + 4 + 1) return null;
      return {
        t: "hello",
        version: b[1],
        buildHash: b.slice(2, 2 + HASH_LEN),
        token: b.slice(2 + HASH_LEN, 2 + HASH_LEN + TOKEN_LEN),
        worldId: v.getUint32(2 + HASH_LEN + TOKEN_LEN, true),
        flags: b[2 + HASH_LEN + TOKEN_LEN + 4],
      };
    }
    case C_INPUT:
      if (b.length < 6) return null;
      return { t: "input", seq: v.getUint32(1, true), kind: b[5], payload: b.slice(6) };
    case C_PING:
      if (b.length !== 5) return null;
      return { t: "ping", ts: v.getUint32(1, true) };
    case C_HASH:
      if (b.length !== 16) return null;
      return { t: "hash", tick: v.getUint32(1, true), hash: v.getBigUint64(5, true), stepP95: v.getUint16(13, true) / 100, buffered: b[15] };
    case C_SNAPSHOT_UPLOAD:
      if (b.length < 14) return null;
      return { t: "snapshot-upload", tick: v.getUint32(1, true), hash: v.getBigUint64(5, true), data: b.slice(13) };
    case C_CLAIM:
      if (b.length !== CLAIM_LEN) return null;
      return { t: "claim", tick: v.getUint32(1, true), victim: v.getUint32(5, true), killer: v.getUint32(9, true), cause: b[13], bag: b[14] };
    case C_LIVE:
      if (b.length !== LIVE_LEN) return null;
      return { t: "live", tick: v.getUint32(1, true) };
    case C_CHUNK_HASHES: {
      if (b.length < CHUNK_HASHES_HEADER) return null;
      const n = v.getUint16(5, true);
      if (n > MAX_CHUNK_COUNT || b.length !== CHUNK_HASHES_HEADER + 8 * n) return null;
      const hashes = new BigUint64Array(n);
      for (let i = 0; i < n; i++) hashes[i] = v.getBigUint64(CHUNK_HASHES_HEADER + 8 * i, true);
      return { t: "chunk-hashes", tick: v.getUint32(1, true), hashes };
    }
    default:
      return null;
  }
}

export function decodeServer(b: Uint8Array): ServerMsg | null {
  if (b.length < 1) return null;
  const v = view(b);
  switch (b[0]) {
    case S_WELCOME: {
      if (b.length !== 36) return null;
      const cfg = b.slice(13, 29);
      return {
        t: "welcome",
        playerId: v.getUint32(1, true),
        seed: v.getBigUint64(5, true),
        cfg,
        worldKind: kindOfWelcomeConfig(cfg),
        tickHz: b[29],
        tick: v.getUint32(30, true),
        playersAtBase: v.getUint16(34, true),
      };
    }
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
    case S_SNAPSHOT:
      if (b.length < 6) return null;
      return { t: "snapshot", tick: v.getUint32(1, true), data: b.slice(5) };
    case S_REQUEST_SNAPSHOT:
      if (b.length !== 5) return null;
      return { t: "request-snapshot", tick: v.getUint32(1, true) };
    case S_RESYNC:
      if (b.length !== 7) return null;
      return { t: "resync", tick: v.getUint32(1, true), playersAtBase: v.getUint16(5, true) };
    case S_PLAYER_NAME:
      if (b.length < 5 || b.length > 5 + MAX_NAME_CHARS * 4) return null;
      try {
        return { t: "player-name", player: v.getUint32(1, true), name: td.decode(b.subarray(5)) };
      } catch {
        return null;
      }
    case S_ACHIEVEMENT: {
      if (b.length < 2) return null;
      const n = b[1];
      if (n === 0 || n > MAX_ACHIEVEMENT_ID_BYTES || b.length !== 2 + n + 4) return null;
      try {
        return { t: "achievement", id: td.decode(b.subarray(2, 2 + n)), tick: v.getUint32(2 + n, true) };
      } catch {
        return null;
      }
    }
    case S_REQUEST_CHUNK_HASHES:
      if (b.length !== 5) return null;
      return { t: "request-chunk-hashes", tick: v.getUint32(1, true) };
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

// Typed loader around the sim.wasm C ABI (plan 6.11). No Node-only APIs: runs in browsers too.

export interface SimExports {
  memory: WebAssembly.Memory;
  init(seedLo: number, seedHi: number, worldKind: number): number;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  push_input(ptr: number, len: number): number;
  step(): number;
  tick(): number;
  state_hash(outPtr: number): void;
  chunk_hashes(outPtr: number): number;
  snapshot_size(): number;
  snapshot_write(outPtr: number): number;
  restore(ptr: number, len: number): number;
  set_sleep_enabled(on: number): void;
  mat_ptr(): number;
  aux_ptr(): number;
  width(): number;
  height(): number;
  ran_chunks(): number;
  events(outPtr: number, max: number): number;
  entities(outPtr: number, max: number): number;
  player_view(id: number, outPtr: number): number;
}

/** Event kinds from `events()` (plan 6.11). Render and UI only: nothing read here may become an input (invariant 9). */
export const EV_SPAWN = 1;
export const EV_PICKUP = 2;
export const EV_CAST = 3;
export const EV_CAST_REJECTED = 4;
export const EV_KNOCK = 5;
export const EV_IMPACT = 6;
export const EV_RESPAWN = 7;
export const EV_EXPLODE = 8;
export const EV_DEATH = 9;
export const EV_BAG_PICKUP = 10;
/** Cause of a death (`EV_DEATH.b`): a spell id 0..5 is that spell, then these. */
export const CAUSE_FIRE = 6;
export const CAUSE_LAVA = 7;
export const CAUSE_GUNPOWDER = 8;
/** Why a cast was refused (`CastRejected.b`). */
export const REJECT_SPELL = 1;
export const REJECT_CHARGES = 2;
export const REJECT_COOLDOWN = 3;
export const REJECT_FULL = 4;
export const REJECT_DEAD = 5;
export interface SimEvent {
  kind: number;
  player: number;
  /**
   * Spawn: x, y (1/16 cell), life. Pickup: pickup id, spell, charges. Cast: spell, angle, cast_seq.
   * CastRejected: spell, reason, cast_seq. Knock: vx, vy (1/16 cell per tick), attacker. Impact (`player` = owner):
   * cell x, y, spell. Respawn: x, y (1/16 cell), new life.
   * Explode (`player` = owner, 0 for gunpowder): centre cell x, y, radius. Death (`player` = victim): killer (0 if none), cause
   * (`CAUSE_*` or a spell id), 1 if a bag dropped else 0. BagPickup (`player` = taker): the bag's cell x, y, total charges taken.
   */
  a: number;
  b: number;
  c: number;
}

export const ENT_PLAYER = 1;
export const ENT_PICKUP = 2;
/** A bolt in flight: `id` is the owner, `sub` the spell, `a` the cast_seq, x and y in 1/16 cell. */
export const ENT_PROJECTILE = 3;
/** A dropped bag: `id` is its index in the list, `a` the total charges, x and y the cell centre in 1/16 cell. */
export const ENT_BAG = 4;
export const NUM_SPELLS = 6;
export interface EntityView {
  type: number;
  id: number;
  active: boolean;
  /** Player: facing. Pickup: spell. */
  sub: number;
  /** 1/16 cell. Player: feet centre. Pickup: the cell's bottom centre. */
  x: number;
  y: number;
  /** Player: life. Pickup: charges. Projectile: cast_seq. */
  a: number;
  health: number;
}

export const EVENT_BYTES = 17;
export const ENTITY_BYTES = 18;
/** Buffers for events() and entities(): a render view past these is truncated, which is harmless. */
export const MAX_EVENTS = 256;
export const MAX_ENTITIES = 1600;
/** One player's spells for the HUD: charges (65535 = infinite) and ticks of cooldown left. */
export interface PlayerView {
  charges: number[];
  cooldown: number[];
}

export interface Sim {
  init(seed: bigint, worldKind: number): void;
  /** Returns 0 on success, negative if the sim rejected the input. */
  pushInput(input: Uint8Array): number;
  step(): number;
  tick(): number;
  stateHash(): bigint;
  chunkHashes(): BigUint64Array;
  snapshot(): Uint8Array;
  restore(snap: Uint8Array): void;
  setSleepEnabled(on: boolean): void;
  /** Read-only views for rendering (invariant 9). Rebuild after every call: memory can grow. */
  matView(): Uint8Array;
  auxView(): Uint8Array;
  width(): number;
  height(): number;
  /** Telemetry: how many chunks the last step actually ran (sleeping and the active set skip the rest). */
  ranChunks(): number;
  /** Events from the last step (render-only). */
  events(): SimEvent[];
  /** Players then pickups, as the renderer should draw them (render-only). */
  entities(): EntityView[];
  /** Spell charges and cooldowns of a player, or null if it does not exist (render-only). */
  playerView(id: number): PlayerView | null;
}

// chunk_hashes writes 8 bytes per chunk: the 2048x1536 game world has 32 x 24 = 768 at CHUNK = 64.
const MAX_CHUNKS = 4096;

export function loadSim(bytes: Uint8Array, imports: WebAssembly.Imports = {}): Sim {
  const module = new WebAssembly.Module(bytes as BufferSource);
  const x = new WebAssembly.Instance(module, imports).exports as unknown as SimExports;
  // Memory may grow on any call, so never cache a view across calls.
  const mem = () => new Uint8Array(x.memory.buffer);

  function withBuf<T>(len: number, f: (ptr: number) => T): T {
    const ptr = x.alloc(len);
    try {
      return f(ptr);
    } finally {
      x.dealloc(ptr, len);
    }
  }

  const cells = () => x.width() * x.height();

  return {
    matView: () => new Uint8Array(x.memory.buffer, x.mat_ptr(), cells()),
    auxView: () => new Uint8Array(x.memory.buffer, x.aux_ptr(), cells()),
    width: () => x.width(),
    height: () => x.height(),
    ranChunks: () => x.ran_chunks(),
    events() {
      return withBuf(MAX_EVENTS * EVENT_BYTES, (p) => {
        const n = x.events(p, MAX_EVENTS);
        const dv = new DataView(x.memory.buffer);
        const out: SimEvent[] = [];
        for (let i = 0; i < n; i++) {
          const o = p + i * EVENT_BYTES;
          out.push({ kind: dv.getUint8(o), player: dv.getUint32(o + 1, true), a: dv.getInt32(o + 5, true), b: dv.getInt32(o + 9, true), c: dv.getInt32(o + 13, true) });
        }
        return out;
      });
    },
    entities() {
      return withBuf(MAX_ENTITIES * ENTITY_BYTES, (p) => {
        const n = x.entities(p, MAX_ENTITIES);
        const dv = new DataView(x.memory.buffer);
        const out: EntityView[] = [];
        for (let i = 0; i < n; i++) {
          const o = p + i * ENTITY_BYTES;
          out.push({
            type: dv.getUint8(o),
            id: dv.getUint32(o + 1, true),
            active: dv.getUint8(o + 5) === 1,
            sub: dv.getUint8(o + 6),
            x: dv.getInt32(o + 7, true),
            y: dv.getInt32(o + 11, true),
            a: dv.getUint16(o + 15, true),
            health: dv.getUint8(o + 17),
          });
        }
        return out;
      });
    },
    playerView(id) {
      return withBuf(4 * NUM_SPELLS, (p) => {
        if (x.player_view(id, p) === 0) return null;
        const dv = new DataView(x.memory.buffer);
        const charges: number[] = [];
        const cooldown: number[] = [];
        for (let k = 0; k < NUM_SPELLS; k++) {
          charges.push(dv.getUint16(p + 2 * k, true));
          cooldown.push(dv.getUint16(p + 2 * NUM_SPELLS + 2 * k, true));
        }
        return { charges, cooldown };
      });
    },
    init(seed, worldKind) {
      const s = BigInt.asUintN(64, seed);
      const rc = x.init(Number(s & 0xffffffffn), Number(s >> 32n), worldKind);
      if (rc !== 0) throw new Error(`sim init failed (${rc})`);
    },
    pushInput(input) {
      return withBuf(input.length, (p) => {
        mem().set(input, p);
        return x.push_input(p, input.length);
      });
    },
    step: () => x.step(),
    tick: () => x.tick(),
    stateHash() {
      return withBuf(8, (p) => {
        x.state_hash(p);
        return new DataView(x.memory.buffer).getBigUint64(p, true);
      });
    },
    chunkHashes() {
      return withBuf(MAX_CHUNKS * 8, (p) => {
        const n = x.chunk_hashes(p);
        const out = new BigUint64Array(n);
        const dv = new DataView(x.memory.buffer);
        for (let i = 0; i < n; i++) out[i] = dv.getBigUint64(p + i * 8, true);
        return out;
      });
    },
    snapshot() {
      const size = x.snapshot_size();
      return withBuf(size, (p) => {
        const n = x.snapshot_write(p);
        return mem().slice(p, p + n);
      });
    },
    restore(snap) {
      const rc = withBuf(snap.length, (p) => {
        mem().set(snap, p);
        return x.restore(p, snap.length);
      });
      if (rc !== 0) throw new Error(`sim restore failed (${rc})`);
    },
    setSleepEnabled: (on) => x.set_sleep_enabled(on ? 1 : 0),
  };
}

/** Hex sha256 of the wasm bytes (WebCrypto: Node and browsers). */
export async function simBuildHash(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

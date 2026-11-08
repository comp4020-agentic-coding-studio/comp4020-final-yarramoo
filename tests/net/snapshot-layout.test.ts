// Review M4: the server read stored snapshots at hand-copied offsets inside a silent try/catch, and the client chose
// its decompression ceiling from the world's area rather than the room. These pin the replacements: the layout comes
// from the sim build, an unreadable snapshot is logged, and the client's ceiling is the room's own.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Lockstep } from "../../client/lockstep.ts";
import { GameDb } from "../../server/db.ts";
import { EventLog } from "../../server/log.ts";
import { activePlayersIn, GAME_ID, World } from "../../server/world.ts";
import { encodeJoin, encodeLeave } from "../../shared/inputs.ts";
import { compressSnapshot, maxSnapshotRawFor } from "../../shared/protocol.ts";
import { CAVES_PVP, SIZE_DIMS } from "../../shared/room.ts";
import { loadSim, snapshotLayout, type Sim, type SnapshotLayout } from "../../shared/sim.ts";
import { buildHashHex, wasmBytes } from "./helpers.ts";

const layout = snapshotLayout(wasmBytes);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
});

describe("snapshot layout facts come from the sim build", () => {
  it("the wasm exports them as integers, and they agree with the Rust source and the database's format", () => {
    const rs = (f: string) => readFileSync(new URL(`../../sim/src/${f}`, import.meta.url), "utf8");
    expect(layout.formatVersion).toBe(Number(rs("snapshot.rs").match(/pub const FORMAT_VERSION: u16 = (\d+);/)![1]));
    const db = readFileSync(new URL("../../server/db.ts", import.meta.url), "utf8");
    expect(layout.formatVersion).toBe(Number(db.match(/SNAPSHOT_FORMAT_VERSION = (\d+)/)![1]));
    // Header: magic 4, version 2, build hash 32, seed 8, config 16, tick 4, w 2, h 2 (sim/src/snapshot.rs `write`).
    expect(layout.headerBytes).toBe(4 + 2 + 32 + 8 + 16 + 4 + 2 + 2);
    expect(Object.values(layout).every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(wasmBytes as BufferSource))).toEqual([]);
  });

  it("a build without the exports is refused, not guessed at", () => {
    const old = new Uint8Array(readFileSync(new URL("../fixtures/sim-v1-deployed.wasm", import.meta.url)));
    expect(() => snapshotLayout(old)).toThrow(/no snapshot layout exports/);
  });
});

describe("cold start reads the stored snapshot's players, and logs a snapshot it cannot read", () => {
  /** A game-world database whose latest snapshot has players 3 and 27 active and 9 left, under this build. */
  async function stored(data?: Uint8Array) {
    const dir = mkdtempSync(join(tmpdir(), "layouts-test-"));
    const db = new GameDb(dir);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanups.push(() => db.close());
    const build = await buildHashHex();
    if (!data) {
      const sim = loadSim(wasmBytes);
      sim.init(5n, 1);
      for (const id of [3, 9, 27]) sim.pushInput(encodeJoin(id));
      sim.step();
      sim.pushInput(encodeLeave(9));
      sim.step();
      data = compressSnapshot(sim.snapshot());
    }
    db.createWorld(GAME_ID, "game", 5n, build);
    db.saveSnapshot(GAME_ID, { tick: 2, hash: 0n, simBuild: build, data });
    return { db, build };
  }

  async function load(data: Uint8Array | undefined, given: SnapshotLayout | undefined) {
    const { db, build } = await stored(data);
    const log = new EventLog({ quiet: true });
    const w = new World({ id: GAME_ID, now: () => 0, db, simBuild: build, log, snapshotLayout: given });
    await w.load();
    return log.recent().filter((e) => e.ev === "snapshot.unreadable" || e.ev === "world.cold_start");
  }

  it("the active players get their orphan Leave, and nothing is logged as unreadable", async () => {
    const evs = await load(undefined, layout);
    expect(evs.map((e) => e.ev)).toEqual(["world.cold_start"]);
    expect(evs[0].orphan_leaves).toBe(2);
  });

  it("corrupt bytes are logged as snapshot.unreadable, and the room still loads", async () => {
    const evs = await load(Uint8Array.from([0x78, 0x9c, 1, 2, 3, 4, 5]), layout);
    expect(evs.map((e) => e.ev)).toEqual(["snapshot.unreadable"]);
    expect(evs[0]).toMatchObject({ lvl: "error", world: GAME_ID, tick: 2, bytes: 7 });
  });

  it("a snapshot of another format is logged, not read at this build's offsets", async () => {
    const evs = await load(undefined, { ...layout, formatVersion: layout.formatVersion + 1 });
    expect(evs.map((e) => e.ev)).toEqual(["snapshot.unreadable"]);
    expect(String(evs[0].error)).toMatch(/format/);
  });

  it("a World built without the layout logs it rather than reading nothing silently", async () => {
    const evs = await load(undefined, undefined);
    expect(evs.map((e) => e.ev)).toEqual(["snapshot.unreadable"]);
    expect(String(evs[0].error)).toMatch(/no snapshot layout/);
  });
});

describe("activePlayersIn throws on a section that runs past its bounds", () => {
  /** A real game snapshot's raw bytes, with `edit` applied, compressed again. */
  function edited(edit: (v: DataView) => void): Uint8Array {
    const sim = loadSim(wasmBytes);
    sim.init(5n, 1);
    sim.pushInput(encodeJoin(3));
    sim.step();
    const raw = sim.snapshot();
    edit(new DataView(raw.buffer, raw.byteOffset, raw.byteLength));
    return compressSnapshot(raw);
  }
  const cap = maxSnapshotRawFor(CAVES_PVP);

  it("an entity length past the end of the snapshot", () => {
    expect(() => activePlayersIn(edited((v) => v.setUint32(layout.headerBytes, 0x7fffffff, true)), layout, cap)).toThrow(/entity section runs past/);
  });
  it("a player count whose records run past the entity section", () => {
    expect(() => activePlayersIn(edited((v) => v.setUint32(layout.headerBytes + 4, 0xffffffff, true)), layout, cap)).toThrow(/player records run past/);
  });
  it("the unedited snapshot reads", () => {
    expect(activePlayersIn(edited(() => {}), layout, cap)).toEqual(new Set([3]));
  });
});

describe("the client decompresses a snapshot under its room's own ceiling", () => {
  /** A Lockstep over a stand-in sim of `w x h` cells that records how many bytes reached restore. */
  function lockstepAt(w: number, h: number) {
    const got = { bytes: -1 };
    const sim = { width: () => w, height: () => h, tick: () => 0, restore: (b: Uint8Array) => void (got.bytes = b.length) } as unknown as Sim;
    return { ls: new Lockstep(sim), got };
  }

  it.each([0, 1, 2])("size %i: a stream just under the cap restores, one at the cap is refused", (size) => {
    const [w, h] = SIZE_DIMS[size];
    const cap = maxSnapshotRawFor({ ...CAVES_PVP, size });
    const under = lockstepAt(w, h);
    under.ls.loadSnapshot(compressSnapshot(new Uint8Array(cap - 1)), 0);
    expect(under.got.bytes).toBe(cap - 1);
    const at = lockstepAt(w, h);
    expect(() => at.ls.loadSnapshot(compressSnapshot(new Uint8Array(cap)), 0)).toThrow(/too large/);
    expect(at.got.bytes).toBe(-1);
  });
});

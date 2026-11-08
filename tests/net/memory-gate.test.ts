// D-236: the memory gates read the source the machine has. They read only cgroup v2's `memory.current`, which Docker
// provides and the Fly VM (cgroup v1, root cgroup unlimited) does not, so both gates were off in production until a
// live load test OOM-killed the machine (9 Nov). The VM figures below are the ones read there that morning.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, ROOM_LOAD_MEMORY_RESERVE_BYTES, VERIFY_LANE_MEMORY_RESERVE_BYTES, type RunningServer } from "../../server/main.ts";
import { memoryReaders, pickMemorySource, type MemoryIo, type MemoryReaders } from "../../server/memory.ts";
import { laneBytes } from "../../server/verify.ts";
import { encodeConfig, SURVIVAL } from "../../shared/room.ts";
import { buildHashHex, connect, register, waitFor } from "./helpers.ts";

const MB = 1048576;
const FLY_TOTAL = 214868 * 1024; // MemTotal on the 256 MB machine
const fly: Record<string, string> = {
  "/sys/fs/cgroup/memory/memory.usage_in_bytes": "150769664\n", // counts ~80 MB of reclaimable page cache
  "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n", // the root cgroup: no limit
  "/proc/meminfo": "MemTotal:         214868 kB\nMemFree:           33552 kB\nMemAvailable:     111668 kB\n",
};
const io = (files: Record<string, string>, totalmem = FLY_TOTAL, rss = 100 * MB): MemoryIo => ({
  readFile: (p) => files[p],
  rss: () => rss,
  totalmem: () => totalmem,
});

describe("which memory figure the gates read", () => {
  it("on the Fly VM: no cgroup v2 file, an unlimited v1 root cgroup, so /proc/meminfo (MemTotal - MemAvailable)", () => {
    const p = pickMemorySource(memoryReaders(io(fly)));
    expect(p.source).toBe("meminfo");
    expect(p.limitBytes).toBe(FLY_TOTAL);
    expect(p.freeBytes()).toBe(111668 * 1024);
  });

  it("in Docker with --memory: cgroup v2's memory.current against memory.max", () => {
    const docker = { ...fly, "/sys/fs/cgroup/memory.current": "55000000\n", "/sys/fs/cgroup/memory.max": "268435456\n" };
    const p = pickMemorySource(memoryReaders(io(docker, 8 * 1024 * MB)));
    expect(p.source).toBe("cgroup2");
    expect(p.freeBytes()).toBe(268435456 - 55000000);
  });

  it("a cgroup v2 with no limit (\"max\") falls through", () => {
    const p = pickMemorySource(memoryReaders(io({ ...fly, "/sys/fs/cgroup/memory.current": "1\n", "/sys/fs/cgroup/memory.max": "max\n" })));
    expect(p.source).toBe("meminfo");
  });

  it("a cgroup v1 with a real limit is used", () => {
    const v1 = { ...fly, "/sys/fs/cgroup/memory/memory.limit_in_bytes": "268435456\n" };
    const p = pickMemorySource(memoryReaders(io(v1, 8 * 1024 * MB)));
    expect(p.source).toBe("cgroup1");
    expect(p.freeBytes()).toBe(268435456 - 150769664);
  });

  it("without any of those (macOS dev): the process RSS, which includes worker threads, against the machine", () => {
    const p = pickMemorySource(memoryReaders(io({}, 16 * 1024 * MB, 120 * MB)));
    expect(p.source).toBe("rss");
    expect(p.freeBytes()).toBe(16 * 1024 * MB - 120 * MB);
  });

  it("the reserves keep a fresh Fly VM to two M rooms and one warm lane, well short of the ~90 MB growth that was killed", () => {
    const idleFree = 111668 * 1024;
    // A room loads only with ROOM reserve free; each M room plus its lane cost ~30-45 MB on the VM (the crash: 3 + 3 in ~90 MB).
    expect(idleFree - ROOM_LOAD_MEMORY_RESERVE_BYTES).toBeLessThan(2 * 30 * MB);
    expect(idleFree - laneBytes(1) - VERIFY_LANE_MEMORY_RESERVE_BYTES).toBeGreaterThanOrEqual(0); // the first room's lane opens
    expect(idleFree - 15 * MB - laneBytes(1) - laneBytes(1) - VERIFY_LANE_MEMORY_RESERVE_BYTES).toBeLessThan(0); // the second's does not
  });
});

let hex: string;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
beforeAll(async () => {
  hex = await buildHashHex();
});

async function boot(readers: Partial<MemoryReaders>): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "sand-memory-gate-"));
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, memoryReaders: { ...memoryReaders(), ...readers } });
  cleanups.push(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
/** A Survival M room (cave terrain, so it would get a warm lane), as the live load test created. */
async function survivalRoom(port: number): Promise<number> {
  const config = Buffer.from(encodeConfig(SURVIVAL)).toString("base64");
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Mem", mode: "survival", config, visibility: "unlisted" }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}
// Everything but /proc/meminfo reads as on the Fly VM; the free figure is the test's.
const flyWith = (freeBytes: () => number): Partial<MemoryReaders> => ({
  cgroup2: () => undefined,
  cgroup1: () => undefined,
  meminfo: () => ({ usedBytes: FLY_TOTAL - freeBytes(), limitBytes: FLY_TOTAL }),
});

describe("the gates on a machine that reads like the Fly VM", () => {
  it("logs which source it uses at start", async () => {
    const s = await boot(flyWith(() => 100 * MB));
    const ev = s.log.recent().find((e) => e.ev === "memory.source");
    expect(ev).toMatchObject({ source: "meminfo", limit_mb: Math.round(FLY_TOTAL / MB), free_mb: 100 });
  });

  it("refuses a new room load with too little free, before the World is constructed", async () => {
    const s = await boot(flyWith(() => ROOM_LOAD_MEMORY_RESERVE_BYTES - MB));
    const id = await survivalRoom(s.port);
    const who = await register(s.port, "Busy");
    await expect(connect(s.port, hex, { world: id, token: who.token })).rejects.toThrow(/server busy/);
    expect(s.worlds.has(id)).toBe(false);
    expect(s.log.recent().some((e) => e.ev === "register.refused" && e.scope === "memory")).toBe(true);
  });

  it("loads the room but opens no warm lane when the lane would cross its reserve", async () => {
    // Enough for a room, not for a room plus its M lane: the room verifies cold, as before D-228.
    const s = await boot(flyWith(() => ROOM_LOAD_MEMORY_RESERVE_BYTES + 1 * MB));
    expect(ROOM_LOAD_MEMORY_RESERVE_BYTES + MB - laneBytes(1)).toBeLessThan(VERIFY_LANE_MEMORY_RESERVE_BYTES);
    const id = await survivalRoom(s.port);
    const who = await register(s.port, "Lane");
    const a = await connect(s.port, hex, { world: id, token: who.token });
    expect(s.worlds.has(id)).toBe(true);
    await waitFor(() => s.log.recent().some((e) => e.ev === "verify.lane_refused" || e.ev === "verify.lane_opened"));
    expect(s.log.recent().filter((e) => e.ev === "verify.lane_opened")).toEqual([]);
    expect(s.verifier?.laneIds()).toEqual([]);
    a.close();
  });

  it("with plenty free, the same room gets its lane (the refusals above are the gate, not the setup)", async () => {
    const s = await boot(flyWith(() => 150 * MB));
    const id = await survivalRoom(s.port);
    const who = await register(s.port, "Lane");
    const a = await connect(s.port, hex, { world: id, token: who.token });
    await waitFor(() => s.verifier?.laneIds().includes(id) ?? false);
    a.close();
  });
});

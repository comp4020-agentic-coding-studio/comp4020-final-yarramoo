// F6b (D-166) over the real server: two clients in one Survival room ready up and the round starts on the same
// tick for both; the server refuses Ready in other rooms and from spectators; a late spectator adds no player.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KIND_READY } from "../../shared/inputs.ts";
import { CAVES_PVP, SURVIVAL, encodeConfig } from "../../shared/room.ts";
import { ENT_PLAYER, ENT_READY, ENT_ROUND, EV_ROUND_START } from "../../shared/sim.ts";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, register, waitFor, type TestClient } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function boot(): Promise<RunningServer> {
  const d = mkdtempSync(join(tmpdir(), "sand-f6b-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  const s = await startServer({ port: 0, dataDir: d, snapshotEveryTicks: 120, quiet: true });
  cleanups.push(() => s.close());
  return s;
}
async function createRoom(port: number, mode: string, cfg: typeof SURVIVAL): Promise<number> {
  const config = Buffer.from(encodeConfig(cfg)).toString("base64");
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Lobby", mode, config, visibility: "public" }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}
/** Record the tick of each EV_ROUND_START this client's sim emits. */
function watchStart(c: TestClient): { ticks: number[] } {
  const out = { ticks: [] as number[] };
  const prev = c.ls.onStepped;
  c.ls.onStepped = (tick, inputs) => {
    prev?.(tick, inputs);
    if (c.ls.sim.events().some((e) => e.kind === EV_ROUND_START)) out.ticks.push(tick);
  };
  return out;
}
const round = (c: TestClient) => c.ls.sim.entities().find((e) => e.type === ENT_ROUND);

describe("the Survival lobby over the real server", () => {
  it("two clients ready up and the round starts on the same tick for both", async () => {
    const s = await boot();
    const room = await createRoom(s.port, "survival", { ...SURVIVAL, size: 0 });
    const [ra, rb] = [await register(s.port, "Ada"), await register(s.port, "Bo")];
    const a = await connect(s.port, hex, { world: room, token: ra.token });
    const b = await connect(s.port, hex, { world: room, token: rb.token });
    const wa = watchStart(a);
    const wb = watchStart(b);
    await waitFor(() => [a, b].every((c) => c.ls.sim.entities().filter((e) => e.type === ENT_PLAYER && e.active).length === 2), 8000, "both joined");
    expect(round(a)!.health & 1).toBe(0); // the lobby
    a.ready(1);
    await waitFor(() => b.ls.sim.entities().some((e) => e.type === ENT_READY && e.id === ra.id && e.active), 5000, "A's ready seen by B");
    expect(round(b)!.health & 1).toBe(0); // B not ready yet: no countdown, no start
    expect(round(b)!.x).toBe(-1);
    b.ready(1);
    await waitFor(() => round(a)!.health & 1 && round(b)!.health & 1 ? true : false, 10000, "round started on both");
    expect(wa.ticks).toHaveLength(1);
    expect(wb.ticks).toEqual(wa.ticks);
    // the hashes at a common tick agree
    await waitFor(() => [...a.hashes.keys()].some((k) => b.hashes.has(k) && k > wa.ticks[0]), 10000, "a hash past the start on both");
    const t = [...a.hashes.keys()].filter((k) => b.hashes.has(k) && k > wa.ticks[0]).pop()!;
    expect(a.hashes.get(t)).toBe(b.hashes.get(t));
  }, 30000);

  it("a spectator arriving after the start adds no player, and its Ready is refused", async () => {
    const s = await boot();
    const room = await createRoom(s.port, "survival", { ...SURVIVAL, size: 0 });
    const ra = await register(s.port, "Solo");
    const a = await connect(s.port, hex, { world: room, token: ra.token });
    await waitFor(() => a.ls.sim.entities().some((e) => e.type === ENT_PLAYER && e.active), 8000, "joined");
    a.ready(1);
    await waitFor(() => (round(a)?.health ?? 0) & 1 ? true : false, 10000, "started");
    const spec = await connect(s.port, hex, { world: room, spectate: true });
    await waitFor(() => spec.ls.simTick >= spec.ls.catchUpTarget && spec.ls.simTick > 0, 8000, "spectator caught up");
    const before = s.log.recent().filter((e) => e.ev === "input.rejected").length;
    spec.ready(1); // refused: a spectator has no player
    await waitFor(() => s.log.recent().filter((e) => e.ev === "input.rejected" && e.reason === "spectator_input").length > 0, 5000, "spectator Ready refused");
    expect(s.log.recent().filter((e) => e.ev === "input.rejected").length).toBeGreaterThan(before);
    expect(spec.ls.sim.entities().filter((e) => e.type === ENT_PLAYER).length).toBe(1);
  }, 30000);

  it("Ready is refused in a non-Survival room, and a bad Ready value is refused in Survival", async () => {
    const s = await boot();
    const dm = await createRoom(s.port, "deathmatch", { ...CAVES_PVP, size: 0 });
    const r = await register(s.port, "Dm");
    const a = await connect(s.port, hex, { world: dm, token: r.token });
    await waitFor(() => a.ls.sim.entities().some((e) => e.type === ENT_PLAYER && e.active), 8000, "joined");
    a.ready(1);
    await waitFor(() => s.log.recent().some((e) => e.ev === "input.rejected" && e.reason === "bad_kind_or_length" && e.kind === KIND_READY), 5000, "refused in deathmatch");
  }, 30000);

  it("a Ready value other than 0 or 1 is refused in Survival", async () => {
    const s = await boot();
    const sv = await createRoom(s.port, "survival", { ...SURVIVAL, size: 0 });
    const r2 = await register(s.port, "Sv");
    const b = await connect(s.port, hex, { world: sv, token: r2.token });
    await waitFor(() => b.ls.sim.entities().some((e) => e.type === ENT_PLAYER && e.active), 8000, "joined");
    b.raw(KIND_READY, Uint8Array.of(2));
    await waitFor(() => s.log.recent().some((e) => e.ev === "input.rejected" && e.kind === KIND_READY), 5000, "bad value refused");
    expect(round(b)!.health & 1).toBe(0);
  }, 30000);
});

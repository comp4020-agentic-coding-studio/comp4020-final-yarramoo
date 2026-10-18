// Slice 2: every connection has an identity (or is anonymous) in the logs, and players only ever see plain names.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, register, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-names-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string | null): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, quiet: true });
  cleanups.push(() => s.close());
  return s;
}
const GAME = 1;
const joins = (s: RunningServer) => s.log.recent().filter((e) => e.ev === "join");

describe("names for every visitor", () => {
  it("a sandbox client with a token logs Name#id; a zero-token one is accepted as anon#c<conn>", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Ada");
    const a = await connect(s.port, hex, { world: 0, token: me.token });
    const z = await connect(s.port, hex, { world: 0 });
    const js = joins(s);
    expect(js[0].who).toBe(`Ada#${me.id}`);
    expect(js[0].visitor).toBe(me.id);
    expect(js[0].name).toBe("Ada");
    expect(js[1].who).toMatch(/^anon#c\d+$/);
    expect(js[1].visitor).toBe(0);
    // Sim ids are still the sandbox counter, not the registered id.
    expect(a.playerId).toBe(1);
    expect(z.playerId).toBe(2);
    // An anonymous HELLO created nothing.
    expect(s.db!.playerCount()).toBe(1);
    a.close();
    z.close();
  });

  it("a sandbox client with an unknown token is accepted as anonymous", async () => {
    const s = await boot(tmp());
    const c = await connect(s.port, hex, { world: 0, token: new Uint8Array(32).fill(9) });
    expect(joins(s)[0].who).toMatch(/^anon#c/);
    expect(s.db!.playerCount()).toBe(0);
    c.close();
  });

  it("a game spectator with a token is named in the logs and gets no avatar", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Watcher");
    const c = await connect(s.port, hex, { world: GAME, token: me.token, spectate: true });
    expect(c.playerId).toBe(0);
    const j = joins(s)[0];
    expect(j.who).toBe(`Watcher#${me.id}`);
    expect(j.role).toBe("spectator");
    c.close();
  });

  it("two registrations with one name get distinct ids and log keys, and players see only the plain name", async () => {
    const s = await boot(tmp());
    const a = await register(s.port, "Sam");
    const b = await register(s.port, "Sam");
    expect(a.id).not.toBe(b.id);
    const ca = await connect(s.port, hex, { world: GAME, token: a.token });
    const cb = await connect(s.port, hex, { world: GAME, token: b.token });
    const watcher = await register(s.port, "Third");
    const cw = await connect(s.port, hex, { world: GAME, token: watcher.token });
    await waitFor(() => cw.names.size === 2, 5000, "names of the other two");
    expect([...cw.names.values()]).toEqual(["Sam", "Sam"]);
    const whos = joins(s).map((e) => e.who);
    expect(whos).toContain(`Sam#${a.id}`);
    expect(whos).toContain(`Sam#${b.id}`);
    ca.close();
    cb.close();
    cw.close();
  });

  it("a sandbox-only registration stays evictable, even with stats; a game player's does not", async () => {
    const s = await boot(tmp());
    const painter = await register(s.port, "Painter");
    const player = await register(s.port, "Player");
    const sb = await connect(s.port, hex, { world: 0, token: painter.token });
    sb.paint(4, 100, 50, 140, 50, 6);
    const g = await connect(s.port, hex, { world: GAME, token: player.token });
    await waitFor(() => (s.playerStats.get(painter.id).paints_sand ?? 0) === 1, 3000, "paint counted");
    sb.close();
    g.close();
    await waitFor(() => s.log.recent().filter((e) => e.ev === "leave").length === 2, 3000, "both left");
    s.playerStats.flush();
    expect(s.db!.loadStats(painter.id).paints_sand).toBe(1);
    // The painter never joined the game: evicted along with its stats row. The game player stays.
    expect(s.identity.evictUnjoined(Date.now() + 1000, 0)).toBe(1);
    expect(s.db!.loadStats(painter.id)).toEqual({});
    expect(s.db!.playerByTokenHash("x")).toBeNull();
    const again = await connect(s.port, hex, { world: GAME, token: player.token });
    expect(again.playerId).toBe(player.id);
    again.close();
  });
});

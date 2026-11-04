// Brief HB: the dev-teleport gate. A Pos jump far beyond maxPosJump is accepted only on a server started with the
// flag, never with it off, and never under a production environment (NODE_ENV=production or FLY_APP_NAME).
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { resolveDevTeleport } from "../../server/devteleport.ts";
import { World, SANDBOX_SEED } from "../../server/world.ts";
import { CLASSIC_SANDBOX } from "../../shared/room.ts";
import { POS_ONE } from "../../shared/avatar.ts";
import { EventLog } from "../../server/log.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

const payload = (x: number, y: number) => {
  const b = new Uint8Array(11);
  const v = new DataView(b.buffer);
  v.setInt32(2, x * POS_ONE, true);
  v.setInt32(6, y * POS_ONE, true);
  return b;
};
const peer = { send: () => {}, buffered: () => 0, close: () => {} };

/** The first Pos has no baseline; the second is 400 cells away at the same tick: a teleport. */
function jump(w: World): boolean {
  const j = w.join(peer, { playerId: 1 });
  expect(w.acceptPos(j.conn, payload(10, 10))).toBe(true);
  return w.acceptPos(j.conn, payload(410, 10));
}
const mk = (devTeleport?: boolean, log?: EventLog) =>
  new World({ id: 999100, cfg: { ...CLASSIC_SANDBOX, size: 2, avatars: 1 }, seed: SANDBOX_SEED, now: () => 0, devTeleport, log });

describe("dev teleport gate", () => {
  it("rejects a big Pos jump by default", () => {
    expect(jump(mk())).toBe(false);
    expect(jump(mk(false))).toBe(false);
  });

  it("accepts it when the flag is on, and logs dev.teleport once", () => {
    const log = new EventLog({ quiet: true });
    expect(jump(mk(true, log))).toBe(true);
    expect(log.recent().filter((e) => e.ev === "dev.teleport")).toHaveLength(1);
  });

  it("resolves the flag: off by default, on from the env, refused in production", () => {
    expect(resolveDevTeleport({})).toEqual({ on: false, refused: false });
    expect(resolveDevTeleport({ SIMULTA_DEV_TELEPORT: "1" })).toEqual({ on: true, refused: false });
    expect(resolveDevTeleport({ SIMULTA_DEV_TELEPORT: "1", NODE_ENV: "production" })).toEqual({ on: false, refused: true });
    expect(resolveDevTeleport({ SIMULTA_DEV_TELEPORT: "1", FLY_APP_NAME: "simulta" })).toEqual({ on: false, refused: true });
  });

  async function boot(opts: Parameters<typeof startServer>[0]): Promise<RunningServer> {
    const s = await startServer({ port: 0, dataDir: null, quiet: true, ...opts });
    cleanups.push(() => s.close());
    return s;
  }

  it("a server asked for the flag under NODE_ENV=production ignores it and logs a warning", async () => {
    const s = await boot({ devTeleport: true, env: { NODE_ENV: "production" } });
    expect(jump(s.game)).toBe(false);
    expect(s.log.recent().some((e) => e.ev === "dev.teleport_refused" && e.lvl === "warn")).toBe(true);
  });

  it("a server started with the flag in a clean environment accepts the jump", async () => {
    const s = await boot({ devTeleport: true, env: {} });
    expect(jump(s.game)).toBe(true);
  });
});

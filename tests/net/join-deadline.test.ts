// S2 (sec review): a socket that says HELLO and then nothing must not hold a member slot forever.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer, type RunningServer } from "../../server/main.ts";
import { encodeHello, encodePing } from "../../shared/protocol.ts";
import { buildHashHex, connect, paintFor, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function boot(joinDeadlineMs: number): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "sand-join-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, joinDeadlineMs });
  cleanups.push(() => s.close());
  return s;
}
const unhexB = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
/** A raw spectator socket: HELLO and then nothing (optionally a ping every `pingMs`, never LIVE). */
function rawSpectator(port: number, pingMs?: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const st = { closed: false, code: 0 };
  let timer: ReturnType<typeof setInterval> | undefined;
  ws.on("open", () => {
    ws.send(encodeHello(unhexB(hex), 0, undefined, 1));
    if (pingMs) timer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(encodePing(1)), pingMs);
  });
  ws.on("close", (code) => {
    st.closed = true;
    st.code = code;
    clearInterval(timer);
  });
  ws.on("error", () => {});
  cleanups.push(() => {
    clearInterval(timer);
    ws.terminate();
  });
  return st;
}

describe("join deadline", () => {
  it("a spectator that sends HELLO and nothing else is closed and leaves", async () => {
    const s = await boot(800);
    // The world needs a history, or the newcomer has nothing to replay, joins live at once, and is left to
    // reapSilent (LIVENESS_MS). The hole this closes is a world with a log: there a silent socket stays not-live forever.
    const painter = await connect(s.port, hex);
    await paintFor([painter], 600);
    const sp = rawSpectator(s.port);
    await waitFor(() => s.world.members.size === 2, 3000, "member joined");
    // world 0 is the sandbox, where the spectate flag is ignored, so the raw socket joins as a painter; what matters is
    // that it has a log to replay and so starts not-live (the reaper treats every world alike).
    const silent = [...s.world.members.values()].filter((m) => !m.live);
    expect(silent.length, "the silent socket must start not-live (it has a log to replay)").toBe(1);
    await waitFor(() => sp.closed, 5000, "never-live socket closed");
    await waitFor(() => s.world.members.size === 1, 3000, "member removed");
    expect(s.log.recent().some((e) => e.ev === "leave" && (e as any).reason === "never_live")).toBe(true);
  }, 20_000);

  it("a client still replaying and pinging is not closed by the deadline", async () => {
    const s = await boot(1000);
    const sp = rawSpectator(s.port, 200);
    await waitFor(() => s.world.members.size === 1, 3000, "member joined");
    await sleep(2500);
    expect(sp.closed).toBe(false);
    expect(s.world.members.size).toBe(1);
  }, 20_000);

  it("a live member is unaffected", async () => {
    const s = await boot(800);
    const c = await connect(s.port, hex);
    await sleep(2500); // helper pings every 2 s and went live at once
    expect(s.world.members.size).toBe(1);
    c.close();
  }, 20_000);
});

// The event logger: ring buffer, subscribers, rate limiting, ipTag, and the events a real server emits.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../server/main.ts";
import { EventLog } from "../../server/log.ts";
import { buildHashHex, connect, register, waitFor } from "./helpers.ts";

function fake() {
  let mono = 0;
  let wall = Date.UTC(2026, 9, 20, 3, 12, 9, 120);
  const log = new EventLog({ quiet: true, ringSize: 3, now: () => mono, wallClock: () => wall });
  return { log, advance: (ms: number) => ((mono += ms), (wall += ms)) };
}

describe("EventLog", () => {
  it("stamps t, lvl and ev, flattens fields, and converts bigint to hex", () => {
    const { log } = fake();
    const e = log.event("join", { world: 1, who: "p4", h: 255n, skipped: undefined }, "warn");
    expect(e).toEqual({ t: "2026-10-20T03:12:09.120Z", lvl: "warn", ev: "join", world: 1, who: "p4", h: "ff" });
  });

  it("keeps the newest ringSize events and recent(n) returns the tail, oldest first", () => {
    const { log } = fake();
    for (let i = 0; i < 5; i++) log.event("cast", { i });
    expect(log.recent().map((e) => e.i)).toEqual([2, 3, 4]);
    expect(log.recent(2).map((e) => e.i)).toEqual([3, 4]);
  });

  it("notifies subscribers, survives a throwing one, and unsubscribes", () => {
    const { log } = fake();
    const seen: string[] = [];
    log.subscribe(() => {
      throw new Error("boom");
    });
    const off = log.subscribe((e) => seen.push(e.ev));
    log.event("join");
    expect(seen).toEqual(["join"]);
    expect(log.recent()).toHaveLength(1);
    off();
    log.event("leave");
    expect(seen).toEqual(["join"]);
  });

  it("limited emits once per window per key and reports the suppressed count next time", () => {
    const { log, advance } = fake();
    const go = (key: string) => log.limited(key, 10_000, "input.rate_limited", { conn: key }, "warn");
    expect(go("a")).toBe(true);
    expect(go("a")).toBe(false);
    expect(go("a")).toBe(false);
    expect(go("b")).toBe(true); // another key has its own window
    advance(9_999);
    expect(go("a")).toBe(false);
    advance(1);
    expect(go("a")).toBe(true);
    const a = log.recent().filter((e) => e.conn === "a");
    expect(a[0].suppressed).toBeUndefined();
    expect(a[1].suppressed).toBe(3);
    advance(10_000);
    expect(go("a")).toBe(true);
    expect(log.recent().filter((e) => e.conn === "a").at(-1)!.suppressed).toBeUndefined();
  });

  it("ipTag is six hex chars, stable in a process, differs per ip and per process, and hides the ip", () => {
    const a = new EventLog({ quiet: true });
    const b = new EventLog({ quiet: true });
    const tag = a.ipTag("203.0.113.7");
    expect(tag).toMatch(/^[0-9a-f]{6}$/);
    expect(a.ipTag("203.0.113.7")).toBe(tag);
    expect(a.ipTag("203.0.113.8")).not.toBe(tag);
    expect(b.ipTag("203.0.113.7")).not.toBe(tag);
  });
});

describe("events from a real server", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const f of cleanups.splice(0).reverse()) await f();
  });

  it("logs join, leave and server.shutdown with the expected fields, and never a raw IP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = await startServer({ port: 0, dataDir: dir, quiet: true });
    cleanups.push(() => s.close());
    const hex = await buildHashHex();
    const a = await connect(s.port, hex);
    const b = await connect(s.port, hex);
    await waitFor(() => s.log.recent().filter((e) => e.ev === "join").length === 2);
    const joins = s.log.recent().filter((e) => e.ev === "join");
    expect(joins[0]).toMatchObject({ lvl: "info", world: 0, role: "painter", online: 1, who: expect.stringMatching(/^anon#c\d+$/), ua: "vitest-client" });
    expect(joins[1]).toMatchObject({ world: 0, role: "painter", online: 2, who: expect.stringMatching(/^anon#c\d+$/) });
    expect(joins[0].ip_tag).toMatch(/^[0-9a-f]{6}$/);
    expect(typeof joins[0].tick).toBe("number");
    expect(new Date(joins[0].t as string).toISOString()).toBe(joins[0].t);

    a.close();
    await waitFor(() => s.log.recent().some((e) => e.ev === "leave"));
    const leave = s.log.recent().find((e) => e.ev === "leave")!;
    expect(leave).toMatchObject({ world: 0, role: "painter", online: 1, who: expect.stringMatching(/^anon#c\d+$/) });
    expect(leave.duration_s).toBeGreaterThanOrEqual(0);

    b.close();
    await s.close();
    const shutdown = s.log.recent().find((e) => e.ev === "server.shutdown");
    expect(shutdown).toBeDefined();
    expect(shutdown!.lvl).toBe("info");

    const all = JSON.stringify(s.log.recent());
    expect(all).not.toContain("127.0.0.1");
    expect(all).not.toMatch(/::1|::ffff/);
  });

  it("logs one cast per accepted Cast, hello.rejected with a reason, and no raw token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = await startServer({ port: 0, dataDir: dir, quiet: true });
    cleanups.push(() => s.close());
    const hex = await buildHashHex();
    const me = await register(s.port, "Ada");
    const c = await connect(s.port, hex, { world: 1, token: me.token });
    await waitFor(() => s.log.recent().some((e) => e.ev === "join"));
    expect(s.log.recent().find((e) => e.ev === "join")).toMatchObject({ world: 1, role: "player", who: `Ada#${me.id}` });
    c.move(100, 100);
    c.cast(1, 16384, 1);
    await waitFor(() => s.log.recent().some((e) => e.ev === "cast"));
    expect(s.log.recent().find((e) => e.ev === "cast")).toMatchObject({ world: 1, who: `Ada#${me.id}`, spell: 1, angle: 16384 });
    c.close();
    await expect(connect(s.port, hex, { world: 1 })).rejects.toBeDefined();
    await waitFor(() => s.log.recent().some((e) => e.ev === "hello.rejected"));
    expect(s.log.recent().find((e) => e.ev === "hello.rejected")).toMatchObject({ lvl: "warn", reason: "unknown token", world: 1 });
    expect(JSON.stringify(s.log.recent())).not.toContain(Buffer.from(me.token).toString("hex"));
  });
});

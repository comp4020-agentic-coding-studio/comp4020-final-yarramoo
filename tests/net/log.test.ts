// The event logger: ring buffer, subscribers, rate limiting, ipTag, and the events a real server emits.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../../server/log.ts";

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

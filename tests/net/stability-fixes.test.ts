// Code-review fixes 1-3 (docs/research/code-review-2026-11-01.md): one event must not take down a server or room.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GameDb } from "../../server/db.ts";
import { startServer } from "../../server/main.ts";
import { CLASSIC_SANDBOX, encodeConfig } from "../../shared/room.ts";
import { buildHashHex, connect } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-stability-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe("fix 1: a room that cannot load rejects its client and leaves the server up", () => {
  it("rejects the HELLO, keeps serving other rooms, and leaves nothing half-registered", async () => {
    const dir = tmp();
    const s1 = await startServer({ port: 0, dataDir: dir, quiet: true });
    const config = Buffer.from(encodeConfig(CLASSIC_SANDBOX)).toString("base64");
    const res = await fetch(`http://127.0.0.1:${s1.port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Broken", mode: "sandbox", config, visibility: "public" }) });
    const { id } = (await res.json()) as { id: number };
    await s1.close();
    // A room stored under another build with a snapshot this server can only verify through a hung verifier.
    const db = new GameDb(dir);
    db.createWorld(id, "sandbox", 1n, "an-older-build");
    db.saveSnapshot(id, { tick: 60, hash: 1n, simBuild: "an-older-build", data: new Uint8Array(64) });
    db.close();
    const s = await startServer({ port: 0, dataDir: dir, quiet: true, verifyTimeoutMs: 300, verifierWorkerUrl: new URL("./hang-worker.ts", import.meta.url) });
    cleanups.push(() => s.close());
    await expect(connect(s.port, hex, { world: id })).rejects.toThrow(/room unavailable/);
    expect(s.worlds.has(id)).toBe(false);
    expect(s.log.recent().some((e) => e.ev === "hello.failed" && e.world === id)).toBe(true);
    const ok = await connect(s.port, hex); // the sandbox still serves
    ok.close();
  }, 20000);
});


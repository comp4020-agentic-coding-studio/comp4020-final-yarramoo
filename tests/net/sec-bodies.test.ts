// Security probe S1 (docs/research/sec-probe.md): a POST body that is valid JSON but not an object (`null`) must be
// refused with 400, never crash the server. `JSON.parse("null")` is null, so reading a field off it threw outside
// any try and took the whole process down: one anonymous request stopped the game for everyone.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

describe("POST bodies that are JSON but not objects", () => {
  it("are refused with 400 on every JSON route, and the server stays up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-secbody-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s: RunningServer = await startServer({ port: 0, dataDir: dir, quiet: true });
    cleanups.push(() => s.close());
    const base = `http://localhost:${s.port}`;
    for (const body of ["null", "true", "0", "[]", '"x"']) {
      // Room creation refuses anything that isn't an object.
      const r = await fetch(base + "/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) });
      expect(r.status, `/api/rooms ${body}`).toBe(400);
      // Registration reads one optional field; a non-object is a registration with no name (like `{}`), never a 5xx.
      const p = await fetch(base + "/api/players", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) });
      expect(p.status, `/api/players ${body}`).toBeLessThan(500);
    }
    // Still serving after all of it.
    expect((await fetch(base + "/api/rooms")).status).toBe(200);
  });
});

describe("anonymous room creation (security probe S2)", () => {
  it("is capped per IP per hour", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-seccap-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s: RunningServer = await startServer({ port: 0, dataDir: dir, quiet: true, roomCreatesPerIpHour: 3 });
    cleanups.push(() => s.close());
    const { CAVES_PVP, encodeConfig } = await import("../../shared/room.ts");
    const config = Buffer.from(encodeConfig({ ...CAVES_PVP, size: 0 })).toString("base64");
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://localhost:${s.port}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `R${i}`, mode: "deathmatch", config, visibility: "public" }), signal: AbortSignal.timeout(10_000) });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
  });
});

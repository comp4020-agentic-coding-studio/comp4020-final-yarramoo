// M6 slice a: the dashboard's achievement views. Admin sees name#id; the public view sees a bare count.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, register, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

/** Read an SSE stream for `ms` and return its raw text. */
async function readSse(port: number, query: string, ms: number): Promise<string> {
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${port}/dashboard/stream${query}`, { signal: ac.signal });
  const reader = r.body!.getReader();
  let raw = "";
  const end = Date.now() + ms;
  const timer = setTimeout(() => ac.abort(), ms + 200);
  try {
    while (Date.now() < end) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
    }
  } catch {
    /* aborted */
  }
  clearTimeout(timer);
  ac.abort();
  return raw;
}

describe("dashboard achievements", () => {
  it("admin gets Name#id awards and a per-connection count; public gets only a count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-achd-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s: RunningServer = await startServer({ port: 0, dataDir: dir, quiet: true, adminToken: "secret", inputSummaryMs: 100000 });
    cleanups.push(() => s.close());
    const me = await register(s.port, "Zorblax");
    const g = await connect(s.port, hex, { world: 1, token: me.token });
    cleanups.push(() => g.close());
    g.move(100, 100);
    g.cast(0, 100, 1);
    await waitFor(() => g.achievements.length === 1, 3000, "award");
    await sleep(100);

    const admin = await readSse(s.port, "?token=secret", 1500);
    expect(admin).toContain("event: achievements");
    const line = /event: achievements\ndata: (.*)\n/.exec(admin)![1];
    expect(JSON.parse(line)).toMatchObject([{ who: `Zorblax#${me.id}`, achievement: "first_spell", world: 1 }]);
    const conns = JSON.parse(/event: conns\ndata: (.*)\n/.exec(admin)![1]) as { who: string; achievements: number }[];
    expect(conns.find((c) => c.who === `Zorblax#${me.id}`)!.achievements).toBe(1);
    expect(JSON.parse(/event: summary\ndata: (.*)\n/.exec(admin)![1]).achievementsToday).toBe(1);

    const pub = await readSse(s.port, "", 1500);
    expect(pub).not.toContain("Zorblax");
    expect(pub).not.toContain("first_spell");
    expect(pub).not.toContain("event: achievements");
    expect(JSON.parse(/event: summary\ndata: (.*)\n/.exec(pub)![1]).achievementsToday).toBe(1);
    const api = await (await fetch(`http://127.0.0.1:${s.port}/api/summary`)).text();
    expect(api).not.toContain("Zorblax");
    expect(JSON.parse(api).achievementsToday).toBe(1);
    const page = await (await fetch(`http://127.0.0.1:${s.port}/dashboard`)).text();
    expect(page).not.toContain("Zorblax");
  }, 20000);
});

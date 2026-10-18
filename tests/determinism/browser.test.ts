import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import type { BrowserType } from "playwright";
import type { Server } from "node:http";
import { compare } from "./compare.ts";
import { canaryPath, castScript, gameScript, m5Script, readWasm, root, sharedScript, wasmPath } from "./helpers.ts";
import { m5Missing } from "./m5-coverage.ts";
import { run } from "./run.ts";
import type { RunResult } from "./run.ts";
import { serve } from "./server.ts";
import { relative } from "node:path";

interface PageOut { result: RunResult; buildHash: string; userAgent: string }

let server: Server;
let base: string;
const { script, path: scriptPath } = sharedScript();
const rel = (p: string) => "/" + relative(root, p);

beforeAll(async () => {
  ({ server, url: base } = await serve());
});
afterAll(() => {
  server.close();
});

async function inBrowser(type: BrowserType, wasm: string, canary: boolean, script = scriptPath, hashTick0 = false): Promise<PageOut> {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error("pageerror", e));
    await page.goto(`${base}/tests/determinism/runner.html`);
    await page.waitForFunction("window.runnerReady === true");
    return (await page.evaluate(
      ([w, s, c, t0]) => (window as any).runDeterminism(w, s, { canary: c, hashTick0: t0 }),
      [rel(wasm), rel(script), canary, hashTick0] as const,
    )) as PageOut;
  } finally {
    await browser.close();
  }
}

const engines: [string, BrowserType][] = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];

describe("cross-engine", () => {
  const normal = run(readWasm(wasmPath), script);
  // Same engine-dependent rule as runner.html, evaluated in Node (where userAgent is "Node.js/..").
  const canaryNode = run(readWasm(canaryPath), script, {
    env: { canary_value: () => (navigator.userAgent.startsWith("Mozilla") ? 1 : 0) },
  });

  for (const [name, type] of engines) {
    it(`D2: ${name} matches Node`, async () => {
      const out = await inBrowser(type, wasmPath, false);
      console.log(`${name}: ${out.userAgent}`);
      expect(compare(normal, out.result, ["node", name])).toBeNull();
    });
  }

  // D8: generation (and a few hundred ticks of the generated world) is identical in every engine.
  const game = gameScript();
  const gameNode = run(readWasm(wasmPath), game.script, {}, { hashTick0: true });
  for (const [name, type] of engines) {
    it(`D8: ${name} generates the same game world as Node`, async () => {
      const out = await inBrowser(type, wasmPath, false, game.path, true);
      expect(out.result.hashes[0][0]).toBe(0);
      expect(out.result.finalChunkHashes).toHaveLength(768);
      expect(compare(gameNode, out.result, ["node", name])).toBeNull();
    });
  }

  // D2 with players casting: bolts, knockback events and bursts are identical in every engine.
  const cast = castScript();
  const castNode = run(readWasm(wasmPath), cast.script);
  for (const [name, type] of engines) {
    it(`D2 with casts: ${name} matches Node`, async () => {
      const out = await inBrowser(type, wasmPath, false, cast.path);
      expect(compare(castNode, out.result, ["node", name])).toBeNull();
    });
  }

  // D2 on the M5 script: damage, death, bombs, gunpowder chains and bags are identical in every engine.
  const m5 = m5Script();
  const m5Node = run(readWasm(wasmPath), m5.script, {}, { collectEvents: true });
  it("M5 script covers pickups, bombs, deaths, respawn and bags (from the Node run)", () => {
    expect(m5Missing(m5Node.events!)).toEqual([]);
  });
  for (const [name, type] of engines) {
    it(`D2 with M5: ${name} matches Node`, async () => {
      const out = await inBrowser(type, wasmPath, false, m5.path);
      expect(compare(m5Node, out.result, ["node", name])).toBeNull();
    });
  }

  it("D10: the canary build diverges between Node and a browser, and the comparator says so", async () => {
    const out = await inBrowser(chromium, canaryPath, true);
    const d = compare(canaryNode, out.result, ["node", "chromium"]);
    expect(d, "canary went undetected: the harness cannot see engine-dependent behaviour").not.toBeNull();
    console.log(d?.message);
  });
});

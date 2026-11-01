// The built client must load from every route that serves index.html. `/r/<code>` once returned the page with
// relative asset paths (`./assets/x.js` resolved to `/r/assets/x.js`, a 404) and a blank room (found in F6b).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURVIVAL, encodeConfig } from "../../shared/room.ts";
import { startServer, type RunningServer } from "../../server/main.ts";

let dir = "";
let s: RunningServer;
let code = "";
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sand-assets-"));
  execFileSync("node_modules/.bin/vite", ["build", "--config", "client/vite.config.ts", "--outDir", join(dir, "client"), "--emptyOutDir"], { stdio: "pipe" });
  s = await startServer({ port: 0, dataDir: join(dir, "data"), quiet: true, clientDir: join(dir, "client") });
  const config = Buffer.from(encodeConfig({ ...SURVIVAL, size: 0 })).toString("base64");
  const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "A", mode: "survival", config, visibility: "public" }) });
  code = ((await res.json()) as { code: string }).code;
}, 120000);
afterAll(async () => {
  await s?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Every src/href in the HTML that is a local file, resolved against the page URL the way a browser would. */
function assets(html: string, page: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\s(?:src|href)="([^"#]+)"/g)) {
    if (/^(https?:|data:|mailto:|\/api\/|\/readme)/.test(m[1])) continue;
    const u = new URL(m[1], `http://x${page}`);
    if (u.host === "x") out.push(u.pathname);
  }
  return out;
}

describe("the built client loads from every page route", () => {
  for (const route of ["/", "/sandbox", "/game", "/r/CODE"]) {
    it(`${route}: every asset, and the wasm, returns 200`, async () => {
      const page = route.replace("CODE", code);
      const html = await (await fetch(`http://127.0.0.1:${s.port}${page}`)).text();
      const list = assets(html, page);
      expect(list.some((p) => p.endsWith(".js"))).toBe(true);
      // The wasm URL is built at runtime from document.baseURI; resolve it the same way.
      list.push(new URL("sim.wasm", new URL(html.match(/<base href="([^"]+)"/)?.[1] ?? "", `http://x${page}`)).pathname);
      for (const p of list) expect([p, (await fetch(`http://127.0.0.1:${s.port}${p}`)).status]).toEqual([p, 200]);
    });
  }
});

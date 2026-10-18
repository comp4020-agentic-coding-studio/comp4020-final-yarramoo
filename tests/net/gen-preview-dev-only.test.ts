// The generator preview is a dev page: vite builds from client/index.html alone, so nothing else under client/
// may reach dist/. This reads the build output (run `pnpm build:client` first; skipped if there is no dist).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dist = new URL("../../dist/client/", import.meta.url);

describe("generator preview is dev only", () => {
  it("is not in the vite build input", () => {
    const cfg = readFileSync(new URL("../../client/vite.config.ts", import.meta.url), "utf8");
    expect(cfg).not.toMatch(/gen-preview/);
    expect(cfg).not.toMatch(/rollupOptions/);
  });
  it.skipIf(!existsSync(dist))("is not in dist/client", () => {
    const walk = (d: URL): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(new URL(e.name + "/", d)) : [new URL(e.name, d).pathname],
      );
    const files = walk(dist);
    expect(files.filter((f) => /gen-preview/.test(f))).toEqual([]);
    for (const f of files.filter((f) => /\.(js|html|css)$/.test(f))) {
      expect(readFileSync(f, "utf8").includes("Generator preview"), f).toBe(false);
    }
  });
});

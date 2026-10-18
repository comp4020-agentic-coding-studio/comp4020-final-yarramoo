// The runtime image copies only server/ and shared/ (Dockerfile), so neither may import from client/.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

describe("import boundaries", () => {
  it("nothing under server/ or shared/ imports from client/", () => {
    const bad: string[] = [];
    for (const f of [...files("server"), ...files("shared")]) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) if (/(^|\/)client\//.test(m[1])) bad.push(`${f}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});

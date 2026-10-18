// The renderer's depth bands (cosmetic tint) mirror the generator's. Read gen.rs so a band change that forgets
// the client fails here rather than tinting the wrong rock.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEEP_TOP, depthBand, SHALLOW_TOP } from "../../shared/stats.ts";

const rs = readFileSync(new URL("../../sim/src/gen.rs", import.meta.url), "utf8");
const num = (name: string): number => {
  const m = rs.match(new RegExp(`pub const ${name}: i32 = (\\d+);`));
  if (!m) throw new Error(`${name} not found in gen.rs`);
  return Number(m[1]);
};

describe("client depth bands match gen.rs", () => {
  it("SHALLOW_TOP and DEEP_TOP", () => {
    expect(SHALLOW_TOP).toBe(num("SHALLOW_TOP"));
    expect(DEEP_TOP).toBe(num("DEEP_TOP"));
  });

  it("depthBand names the bands as the plan does (surface, shallow, deep) at the exact boundaries", () => {
    expect(depthBand(0)).toBe("surface");
    expect(depthBand(259)).toBe("surface");
    expect(depthBand(260)).toBe("shallow");
    expect(depthBand(799)).toBe("shallow");
    expect(depthBand(800)).toBe("deep");
  });
});

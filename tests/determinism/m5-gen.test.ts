// The M5 scenario generator is deterministic: same seed and sim build, same script.
import { describe, expect, it } from "vitest";
import { generateM5 } from "../../tools/inputgen-m5.ts";
import { readWasm, wasmPath } from "./helpers.ts";

describe("M5 scenario generator", () => {
  it("gives the same script twice, and a different seed gives a different one", () => {
    const wasm = readWasm(wasmPath);
    const a = generateM5(wasm);
    expect(JSON.stringify(generateM5(wasm))).toBe(JSON.stringify(a));
    expect(Object.keys(a.inputs).length).toBeGreaterThan(20);
    expect(JSON.stringify(generateM5(wasm, 20261015n))).not.toBe(JSON.stringify(a));
  });
});

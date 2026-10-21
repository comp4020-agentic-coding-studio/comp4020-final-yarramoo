// R0a: a determinism script names its room by preset ("config") or by the old world_kind alias, and both give the
// same run, so existing scripts keep working unchanged.
import { describe, expect, it } from "vitest";
import { run } from "./run.ts";
import { readWasm, wasmPath } from "./helpers.ts";

describe("script config", () => {
  const wasm = readWasm(wasmPath);
  const go = (extra: object) => run(wasm, { seed: "20261014", ticks: 120, inputs: {}, ...extra } as never, {}, { hashTick0: true }).hashes;

  it("config names and world_kind aliases run identically", () => {
    expect(go({ config: "classic_sandbox" })).toEqual(go({ world_kind: 0 }));
    expect(go({ config: "caves_pvp" })).toEqual(go({ world_kind: 1 }));
    expect(go({ world_kind: 0 })).not.toEqual(go({ world_kind: 1 }));
  });

  it("an unknown config name is an error, not a default", () => {
    expect(() => go({ config: "nope" })).toThrow(/unknown script config/);
  });
});

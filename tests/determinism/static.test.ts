import { describe, expect, it } from "vitest";
import { canaryPath, readWasm, sh, sharedScript, wasmPath } from "./helpers.ts";
import { compare } from "./compare.ts";
import { readWasm as _r } from "./helpers.ts";
import { run } from "./run.ts";

describe("native and static guards", () => {
  it("D3: native Rust hash log equals the WASM hash log", () => {
    const { script, path } = sharedScript();
    const out = sh("cargo", ["run", "--quiet", "--release", "--manifest-path", "sim/Cargo.toml", "--example", "run_script", "--", path]);
    const native = (JSON.parse(out) as [number, string][]).map(([t, h]): [number, string] => [t, h]);
    const wasm = run(readWasm(wasmPath), script);
    expect(native).toHaveLength(30);
    expect(compare({ hashes: native, finalChunkHashes: [] }, { hashes: wasm.hashes, finalChunkHashes: [] }, ["native", "wasm"])).toBeNull();
  });

  it("D11: normal wasm has no imports, canary exactly one", () => {
    expect(WebAssembly.Module.imports(new WebAssembly.Module(readWasm(wasmPath) as BufferSource))).toEqual([]);
    const c = WebAssembly.Module.imports(new WebAssembly.Module(readWasm(canaryPath) as BufferSource));
    expect(c).toHaveLength(1);
    expect(c[0].name).toBe("canary_value");
  });

  it("D11: clippy -D warnings on wasm32 is clean", () => {
    sh("cargo", ["clippy", "--manifest-path", "sim/Cargo.toml", "--target", "wasm32-unknown-unknown", "--release", "--", "-D", "warnings"]);
  });
});

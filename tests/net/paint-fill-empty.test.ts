// R4: `encodePaint`'s new fill-empty flag (bit 7 of the `mat` byte), byte-exact with sim/src/input.rs's
// `FILL_EMPTY_BIT` so the TS encoder and the Rust decoder never drift (same pattern as the shared config
// byte vectors, R0a).
import { describe, expect, it } from "vitest";
import { encodePaint, FILL_EMPTY_BIT } from "../../shared/inputs.ts";

describe("encodePaint fill-empty flag", () => {
  it("defaults to no flag, same bytes as before this feature existed", () => {
    const b = encodePaint(2, 4, -1, 2, 300, 4, 3);
    expect(b[5]).toBe(4);
  });

  it("sets bit 7 of the mat byte when fillEmpty is true, without disturbing the material id", () => {
    const b = encodePaint(2, 4, -1, 2, 300, 4, 3, true);
    expect(b[5]).toBe(4 | FILL_EMPTY_BIT);
    expect(b[5] & 0x0f).toBe(4);
  });

  it("round-trips through hex the same as a plain paint, with one byte different", () => {
    const plain = encodePaint(1, 7, 0, 0, 10, 10, 5, false);
    const filled = encodePaint(1, 7, 0, 0, 10, 10, 5, true);
    expect(filled.length).toBe(plain.length);
    for (let i = 0; i < plain.length; i++) {
      if (i === 5) continue;
      expect(filled[i]).toBe(plain[i]);
    }
    expect(filled[5]).toBe(plain[5] | FILL_EMPTY_BIT);
  });
});

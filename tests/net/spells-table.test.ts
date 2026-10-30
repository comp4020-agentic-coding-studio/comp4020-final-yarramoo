// The client's spell table (HUD cooldown bars, cast-preview ghost) mirrors sim/src/tuning.rs. Read the Rust
// source so a balance change that forgets the client fails here rather than looking subtly wrong.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOMB_RADIUS, DEATH_TICKS, DIG_RADIUS, DIG_REACH, HEALTH_MAX, SPELLS } from "../../client/spells.ts";
import { quantiseAngle } from "../../client/spells.ts";

const rs = readFileSync(new URL("../../sim/src/tuning.rs", import.meta.url), "utf8");
function arr(name: string): number[] {
  const m = rs.match(new RegExp(`pub const ${name}: \\[[^\\]]*\\] = \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found in tuning.rs`);
  return m[1].split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
}

describe("client spell table matches tuning.rs", () => {
  it("cooldown, speed and gravity", () => {
    const cd = arr("COOLDOWN");
    const sp = arr("SPEED");
    const gr = arr("GRAVITY_Q8");
    SPELLS.forEach((s, i) => {
      expect(s.cooldown, s.name).toBe(cd[i]);
      expect(s.speed * 256, s.name).toBeCloseTo(sp[i], 6);
      expect(s.gravity * 256, s.name).toBeCloseTo(gr[i], 6);
    });
    const en = rs.match(/SPELL_ENABLED: \[bool; NUM_SPELLS\] = \[([^\]]*)\]/)![1].split(",").map((x) => x.trim() === "true");
    SPELLS.forEach((s, i) => expect(s.enabled, s.name).toBe(en[i]));
  });
  it("mirrored death, health and bomb constants", () => {
    const num = (name: string): number => {
      const m = rs.match(new RegExp(`pub const ${name}: [a-z0-9]+ = (\\d+);`));
      if (!m) throw new Error(`${name} not found in tuning.rs`);
      return Number(m[1]);
    };
    expect(DEATH_TICKS).toBe(num("DEATH_TICKS"));
    expect(HEALTH_MAX).toBe(num("HEALTH_MAX"));
    expect(BOMB_RADIUS).toBe(num("BOMB_RADIUS"));
    expect(DIG_RADIUS).toBe(num("DIG_RADIUS"));
    expect(DIG_REACH).toBe(num("DIG_REACH"));
  });
  it("aim angles quantise to u16 with 0 along +x and growing downwards", () => {
    expect(quantiseAngle(1, 0)).toBe(0);
    expect(quantiseAngle(0, 1)).toBe(16384);
    expect(quantiseAngle(-1, 0)).toBe(32768);
    expect(quantiseAngle(0, -1)).toBe(49152);
    for (let i = 0; i < 200; i++) {
      const a = quantiseAngle(Math.cos(i), Math.sin(i));
      expect(Number.isInteger(a) && a >= 0 && a <= 65535).toBe(true);
    }
  });
});

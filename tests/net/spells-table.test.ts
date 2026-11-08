// The client's spell table (HUD cooldown bars, cast-preview ghost) mirrors sim/src/tuning.rs. Read the Rust
// source so a balance change that forgets the client fails here rather than looking subtly wrong.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOMB_RADIUS, DEATH_TICKS, DIG_RADIUS, DIG_REACH, HEALTH_MAX, SPELLS } from "../../client/spells.ts";
import { quantiseAngle } from "../../client/spells.ts";
import { ENEMY_MAX_HP, NUM_ENEMY_KINDS } from "../../shared/sim.ts";

const rs = readFileSync(new URL("../../sim/src/tuning.rs", import.meta.url), "utf8");
function arr(name: string): number[] {
  const m = rs.match(new RegExp(`pub const ${name}: \\[[^\\]]*\\] = \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found in tuning.rs`);
  return m[1].split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
}

describe("client mirrors of sim constants", () => {
  it("ENEMY_MAX_HP (shared/sim.ts) equals ENEMY_STATS hp, BOSS_HP and COLOSSUS_HP in tuning.rs, and is the only copy", () => {
    const stats = rs.match(/pub const ENEMY_STATS[^=]*= \[([\s\S]*?)\n\];/)![1];
    const hp = [...stats.matchAll(/EnemyStats \{ hp: (\d+)/g)].map((m) => Number(m[1]));
    expect(hp.length).toBe(NUM_ENEMY_KINDS);
    expect([...ENEMY_MAX_HP]).toEqual(hp);
    expect(ENEMY_MAX_HP[4]).toBe(Number(rs.match(/pub const BOSS_HP: u16 = (\d+);/)![1]));
    expect(ENEMY_MAX_HP[7]).toBe(Number(rs.match(/pub const COLOSSUS_HP: u16 = (\d+);/)![1]));
    // Review M4: the table was copied into worker.ts and hover.ts. No client file holds its own again.
    for (const f of readdirSync(new URL("../../client/", import.meta.url), { recursive: true }) as string[]) {
      if (!f.endsWith(".ts")) continue;
      expect(readFileSync(new URL(`../../client/${f}`, import.meta.url), "utf8"), f).not.toMatch(/ENEMY_MAX_HP\s*(:[^=]*)?=|\[\s*20,\s*30,\s*60,\s*90,\s*800\b/);
    }
  });
  it("worker.ts active-box overlay mirrors ACTIVE_W, ACTIVE_H (tuning.rs) and CHUNK (grid.rs)", () => {
    const worker = readFileSync(new URL("../../client/worker.ts", import.meta.url), "utf8");
    const grid = readFileSync(new URL("../../sim/src/grid.rs", import.meta.url), "utf8");
    const ts = (n: string) => Number(worker.match(new RegExp(`const ${n} = (\\d+);`))![1]);
    expect(ts("ACTIVE_W")).toBe(Number(rs.match(/pub const ACTIVE_W: i32 = (\d+);/)![1]));
    expect(ts("ACTIVE_H")).toBe(Number(rs.match(/pub const ACTIVE_H: i32 = (\d+);/)![1]));
    expect(ts("CHUNK")).toBe(Number(grid.match(/pub const CHUNK: usize = (\d+);/)![1]));
  });
  it("db.ts snapshot format equals FORMAT_VERSION in snapshot.rs", () => {
    const snap = readFileSync(new URL("../../sim/src/snapshot.rs", import.meta.url), "utf8");
    const db = readFileSync(new URL("../../server/db.ts", import.meta.url), "utf8");
    const rsv = Number(snap.match(/pub const FORMAT_VERSION: u16 = (\d+);/)![1]);
    expect(Number(db.match(/SNAPSHOT_FORMAT_VERSION = (\d+)/)![1])).toBe(rsv);
  });
});

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

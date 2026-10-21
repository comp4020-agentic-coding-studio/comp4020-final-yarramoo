// R0a: the room config table in shared/room.ts, checked against the same byte vectors as sim/tests/config.rs.
import { describe, expect, it } from "vitest";
import { CAVES_PVP, CLASSIC_SANDBOX, decodeConfig, encodeConfig } from "../../shared/room.ts";

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const CLASSIC = "01020000000001000000000800000000";
const CAVES = "01000201020000000301000800000000";
const SURVIVAL = "01000101020000010000010400000000";

// (why, byte index, new value) applied to the classic vector; same table as sim/tests/config.rs.
const MUTATIONS: [string, number, number][] = [
  ["wrong version", 0, 2],
  ["version 0", 0, 0],
  ["terrain 3", 1, 3],
  ["size 3", 2, 3],
  ["avatars 2", 3, 2],
  ["damage 3", 4, 3],
  ["spells 2", 5, 2],
  ["brushes 2", 6, 2],
  ["death 2", 7, 2],
  ["respawn 31", 8, 31],
  ["pickup_respawn 2", 9, 2],
  ["round 2", 10, 2],
  ["round 1 needs death 1", 10, 1],
  ["max_players 1", 11, 1],
  ["max_players 9", 11, 9],
  ["reserved byte 12", 12, 1],
  ["reserved byte 15", 15, 1],
];

describe("room config (shared/room.ts)", () => {
  it("presets encode to the shared vectors", () => {
    expect(toHex(encodeConfig(CLASSIC_SANDBOX))).toBe(CLASSIC);
    expect(toHex(encodeConfig(CAVES_PVP))).toBe(CAVES);
  });

  it("good vectors round-trip", () => {
    for (const h of [CLASSIC, CAVES, SURVIVAL]) {
      const c = decodeConfig(hex(h));
      expect(c, h).not.toBeNull();
      expect(toHex(encodeConfig(c!))).toBe(h);
    }
    expect(decodeConfig(hex(SURVIVAL))).toMatchObject({ death: 1, round: 1, maxPlayers: 4, size: 1 });
  });

  for (const [why, at, val] of MUTATIONS) {
    it(`refuses: ${why}`, () => {
      const b = hex(CLASSIC);
      b[at] = val;
      expect(decodeConfig(b)).toBeNull();
    });
  }

  it("refuses wrong lengths", () => {
    const good = hex(CLASSIC);
    expect(decodeConfig(good.slice(0, 15))).toBeNull();
    expect(decodeConfig(new Uint8Array([...good, 0]))).toBeNull();
    expect(decodeConfig(new Uint8Array(0))).toBeNull();
  });
});

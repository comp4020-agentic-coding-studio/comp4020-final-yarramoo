// Per-player stat names (plan 9.1, 10). Data and helpers only, no Node imports. Names come from shared/names.ts.
import { MATERIAL_NAMES, SPELL_NAMES } from "./names.ts";
import { POS_ONE } from "./avatar.ts";

export const STAT_MAX_DEPTH = "max_depth";
export const STAT_SESSIONS = "sessions";
export const STAT_PLAY_MS = "play_ms";
export const STAT_POS_REJECTED = "pos_rejected";
export const STAT_RESYNCS = "resyncs";
/** Credited kills and deaths, counted from majority CLAIMs about EV_DEATH (plan 10, D-120). */
export const STAT_KILLS = "kills";
export const STAT_DEATHS = "deaths";

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/** Short key for a spell id ("push"), or "spell<id>" for one the table does not know. */
export const spellKey = (id: number): string => (SPELL_NAMES[id] ? slug(SPELL_NAMES[id]) : `spell${id}`);
/** Short key for a material id ("sand"), or "mat<id>". */
export const materialKey = (id: number): string => {
  const n = MATERIAL_NAMES[id];
  return n ? slug(n) : `mat${id}`;
};

export const castStat = (spellId: number): string => `casts_${spellKey(spellId)}`;
export const paintStat = (matId: number): string => `paints_${materialKey(matId)}`;

/** A Pos y in 1/16 cells to whole cells, never negative. */
export const depthCells = (yFixed: number): number => Math.max(0, Math.floor(yFixed / POS_ONE));

/** Compact "push:12,water:3" for a counter map, keys sorted; "" when empty. */
export function compactCounts(m: ReadonlyMap<string, number>): string {
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}:${v}`).join(",");
}

/** The game world's depth bands, y in cells (plan 6.9). Mirrors SHALLOW_TOP and DEEP_TOP in sim/src/gen.rs, pinned by
 *  tests/net/depth-bands.test.ts. The one TypeScript copy: the client renderer and the server's player page read it. */
export const SHALLOW_TOP = 260;
export const DEEP_TOP = 800;

/** The band a depth (cells) is in, with the plan's names: above SHALLOW_TOP is the surface. */
export function depthBand(y: number): "surface" | "shallow" | "deep" {
  return y >= DEEP_TOP ? "deep" : y >= SHALLOW_TOP ? "shallow" : "surface";
}

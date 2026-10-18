// Per-player stat names (plan 9.1, 10). Data and helpers only, no Node imports. Spell and material names come
// from the client's display tables, the one place they are listed (spells-table.test.ts ties them to the sim).
import { MATERIALS } from "../client/materials.ts";
import { SPELLS } from "../client/spells.ts";
import { POS_ONE } from "./avatar.ts";

export const STAT_MAX_DEPTH = "max_depth";
export const STAT_SESSIONS = "sessions";
export const STAT_PLAY_MS = "play_ms";
export const STAT_POS_REJECTED = "pos_rejected";
export const STAT_RESYNCS = "resyncs";

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/** Short key for a spell id ("push"), or "spell<id>" for one the table does not know. */
export const spellKey = (id: number): string => (SPELLS[id] ? slug(SPELLS[id].name) : `spell${id}`);
/** Short key for a material id ("sand"), or "mat<id>". */
export const materialKey = (id: number): string => {
  const m = MATERIALS.find((x) => x.id === id);
  return m ? slug(m.name) : `mat${id}`;
};

export const castStat = (spellId: number): string => `casts_${spellKey(spellId)}`;
export const paintStat = (matId: number): string => `paints_${materialKey(matId)}`;

/** A Pos y in 1/16 cells to whole cells, never negative. */
export const depthCells = (yFixed: number): number => Math.max(0, Math.floor(yFixed / POS_ONE));

/** Compact "push:12,water:3" for a counter map, keys sorted; "" when empty. */
export function compactCounts(m: ReadonlyMap<string, number>): string {
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}:${v}`).join(",");
}

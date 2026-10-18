// Achievement table (plan 10). Data only, no Node imports: the server evaluates it, the client looks up names
// and descriptions by id (text from the wire is never trusted).
import { STAT_MAX_DEPTH, castStat } from "./stats.ts";

export type StatMap = Readonly<Record<string, number>>;

interface Base {
  id: string;
  name: string;
  description: string;
}
/** Counted by the server from inputs it accepts. `on` is a stat-name prefix: only a change to a matching stat re-checks it. */
export interface ServerAchievement extends Base {
  source: "server";
  on: string;
  check(stats: StatMap): boolean;
}
/** Awarded from a majority claim about a simulation outcome (slice b); never evaluated by `check`. */
export interface ClaimAchievement extends Base {
  source: "claim";
}
export type Achievement = ServerAchievement | ClaimAchievement;

/** Spell ids as in shared/names.ts SPELL_NAMES. */
const WATER = 2;
const ROSE = 3;
const FIRE_BOLT = 4;
const BOMB = 5;

/** Spelunker: a Pos with y at or below this many cells (the deep band). */
export const SPELUNKER_DEPTH = 800;

const casts = (spell: number, n: number) => (s: StatMap) => (s[castStat(spell)] ?? 0) >= n;

export const ACHIEVEMENTS: readonly Achievement[] = [
  {
    id: "first_spell",
    name: "First spell",
    description: "Cast any spell",
    source: "server",
    on: "casts_",
    check: (s) => Object.entries(s).some(([k, v]) => k.startsWith("casts_") && v >= 1),
  },
  { id: "gardener", name: "Gardener", description: "100 Rose casts", source: "server", on: castStat(ROSE), check: casts(ROSE, 100) },
  { id: "waterworks", name: "Waterworks", description: "100 Water casts", source: "server", on: castStat(WATER), check: casts(WATER, 100) },
  { id: "pyromaniac", name: "Pyromaniac", description: "50 Fire bolt casts", source: "server", on: castStat(FIRE_BOLT), check: casts(FIRE_BOLT, 50) },
  { id: "demolitionist", name: "Demolitionist", description: "25 Bomb casts", source: "server", on: castStat(BOMB), check: casts(BOMB, 25) },
  {
    id: "spelunker",
    name: "Spelunker",
    description: `Reach ${SPELUNKER_DEPTH} cells deep`,
    source: "server",
    on: STAT_MAX_DEPTH,
    check: (s) => (s[STAT_MAX_DEPTH] ?? 0) >= SPELUNKER_DEPTH,
  },
  { id: "first_blood", name: "First blood", description: "Get a credited kill", source: "claim" },
  { id: "shoved_to_doom", name: "Shoved to their doom", description: "Kill with a Push or Blast", source: "claim" },
  { id: "five_kills", name: "Five kills", description: "Get 5 credited kills", source: "claim" },
  { id: "back_from_the_dead", name: "Back from the dead", description: "Die 10 times", source: "claim" },
];

export const achievementById = (id: string): Achievement | undefined => ACHIEVEMENTS.find((a) => a.id === id);
export const SERVER_ACHIEVEMENTS = ACHIEVEMENTS.filter((a): a is ServerAchievement => a.source === "server");

// Death-feed text. Pure: the worker passes in a plain-name lookup (never `name#id`), render-only (invariant 9).
import { achievementById } from "../shared/achievements.ts";
import { SPELL_NAMES } from "../shared/names.ts";
import { CAUSE_ACID, CAUSE_FIRE, CAUSE_GUNPOWDER, CAUSE_LAVA } from "../shared/sim.ts";

export interface DeathInfo {
  victim: number;
  /** 0 when nobody is credited. */
  killer: number;
  /** A spell id 0..NUM_SPELLS or a CAUSE_* constant. */
  cause: number;
  bagDropped: boolean;
}

const SPELL_LABEL = ["Push", "Blast", "Water", "Rose", "Fire bolt", "Bomb"];
/** Verb when someone else did it, and the reflexive when the victim did it to themselves. */
const SPELL_VERB: [string, string][] = [
  ["shoved", "shoved themselves"],
  ["blasted", "blasted themselves"],
  ["drowned", "drowned themselves"],
  ["pricked", "pricked themselves"],
  ["torched", "torched themselves"],
  ["blew up", "blew themselves up"],
];

export const UNKNOWN_NAME = "someone";

/** `nameOf` returns a plain display name or undefined; an unknown id reads as "someone". */
export function formatDeath(d: DeathInfo, nameOf: (id: number) => string | undefined): string {
  const v = nameOf(d.victim) || UNKNOWN_NAME;
  const k = d.killer !== 0 && d.killer !== d.victim ? nameOf(d.killer) || UNKNOWN_NAME : null;
  const self = d.killer === d.victim && d.killer !== 0;
  let text: string;
  if (d.cause >= 0 && d.cause < SPELL_VERB.length) {
    const label = SPELL_LABEL[d.cause];
    if (k) text = `${k} ${SPELL_VERB[d.cause][0]} ${v} (${label})`;
    else if (self) text = `${v} ${SPELL_VERB[d.cause][1]}`;
    else text = `${v} was killed (${label})`;
  } else if (d.cause === CAUSE_FIRE) {
    text = k ? `${k} burned ${v} (Fire)` : `${v} burned (Fire)`;
  } else if (d.cause === CAUSE_LAVA) {
    text = k ? `${k} sent ${v} into lava` : `${v} fell in lava`;
  } else if (d.cause === CAUSE_GUNPOWDER) {
    text = k ? `${k} blew up ${v} (gunpowder)` : `${v} was blasted by gunpowder`;
  } else if (d.cause === CAUSE_ACID) {
    text = k ? `${k} dissolved ${v} in acid` : `${v} dissolved in acid`;
  } else if (d.cause >= 40 && d.cause < 48) {
    // 40 + enemy kind: 0 slime, 1 imp, 2 acid slime, 3 worm, 4 the Deep Mage, 5 lava wisp, 6 frost sprite, 7 the Sand Colossus.
    const how = ["was slain by a slime", "was burned by an imp", "was dissolved by an acid slime", "was eaten by a worm", "was struck down by the Deep Mage", "was scorched by a lava wisp", "was frozen by a frost sprite", "was buried by the Sand Colossus"][d.cause - 40];
    text = `${v} ${how ?? "was slain by a monster"}`;
  } else {
    text = `${v} died`;
  }
  return d.bagDropped ? `${text} and dropped their bag` : text;
}

/** Toast for an earned achievement. Name and description come from the shared table by id; wire text is never used. */
export function formatAchievement(id: string): string | null {
  const a = achievementById(id);
  return a ? `Achievement: ${a.name} \u00b7 ${a.description}` : null;
}

/** Enemy kinds by index (sim ENEMY_STATS order), singular display names. */
export const ENEMY_NAMES = ["Slime", "Fire imp", "Acid slime", "Worm", "Deep Mage", "Lava wisp", "Frost sprite", "Sand Colossus"];
const CAUSE_ENEMY_BASE = 40;

/**
 * The player's own death line: "Killed by a Fire imp", "Your own Bomb", "Burned in lava". `cause` is EV_DEATH.b, `killer` EV_DEATH.a
 * (0 when nobody is credited). Plain names only. Never returns "undefined".
 */
export function youDiedText(cause: number, killer: number, me: number, nameOf: (id: number) => string | undefined): string {
  const other = killer !== 0 && killer !== me ? nameOf(killer) || UNKNOWN_NAME : null;
  if (cause >= CAUSE_ENEMY_BASE && cause < CAUSE_ENEMY_BASE + ENEMY_NAMES.length) {
    const n = ENEMY_NAMES[cause - CAUSE_ENEMY_BASE];
    return n === "Deep Mage" || n === "Sand Colossus" ? `Killed by the ${n}` : `Killed by ${/^[AEIOU]/.test(n) ? "an" : "a"} ${n}`;
  }
  if (cause >= 0 && cause < SPELL_NAMES.length) {
    if (other) return `Killed by ${other}'s ${SPELL_NAMES[cause]}`;
    return killer === me && killer !== 0 ? `Your own ${SPELL_NAMES[cause]}` : `Killed by a ${SPELL_NAMES[cause]}`;
  }
  const by = other ? ` (${other})` : "";
  if (cause === CAUSE_FIRE) return `Burned to death${by}`;
  if (cause === CAUSE_LAVA) return `Burned in lava${by}`;
  if (cause === CAUSE_GUNPOWDER) return `Blown up by gunpowder${by}`;
  if (cause === CAUSE_ACID) return `Dissolved in acid${by}`;
  return other ? `Killed by ${other}` : "You died";
}

// Death-feed text. Pure: the worker passes in a plain-name lookup (never `name#id`), render-only (invariant 9).
import { achievementById } from "../shared/achievements.ts";
import { CAUSE_FIRE, CAUSE_GUNPOWDER, CAUSE_LAVA } from "../shared/sim.ts";

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

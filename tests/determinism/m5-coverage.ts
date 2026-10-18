// What the M5 script must actually do, so that four engines agreeing is not agreement about nothing.
import { EV_BAG_PICKUP, EV_DEATH, EV_EXPLODE, EV_PICKUP, EV_RESPAWN } from "../../shared/sim.ts";
import type { SimEvent } from "../../shared/sim.ts";

/** Returns the list of things the event stream lacks (empty when the script covers M5). */
export function m5Missing(events: SimEvent[]): string[] {
  const has = (f: (e: SimEvent) => boolean) => events.some(f);
  const need: [string, (e: SimEvent) => boolean][] = [
    ["EV_PICKUP of Fire bolt (4)", (e) => e.kind === EV_PICKUP && e.b === 4],
    ["EV_PICKUP of Bomb (5)", (e) => e.kind === EV_PICKUP && e.b === 5],
    ["EV_EXPLODE c=18 (bomb)", (e) => e.kind === EV_EXPLODE && e.c === 18],
    ["EV_EXPLODE c=4 (gunpowder)", (e) => e.kind === EV_EXPLODE && e.c === 4],
    ["EV_DEATH with a bag (c=1)", (e) => e.kind === EV_DEATH && e.c === 1],
    ["EV_DEATH with a killer (a!=0)", (e) => e.kind === EV_DEATH && e.a !== 0],
    ["EV_DEATH by self or none (a==0 or a==victim)", (e) => e.kind === EV_DEATH && (e.a === 0 || e.a === e.player)],
    ["EV_RESPAWN", (e) => e.kind === EV_RESPAWN],
    ["EV_BAG_PICKUP", (e) => e.kind === EV_BAG_PICKUP],
  ];
  return need.filter(([, f]) => !has(f)).map(([n]) => n);
}

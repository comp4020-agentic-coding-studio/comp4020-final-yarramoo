import { apply, init, tick } from "../engine/engine.ts";
import type { Action, Sequence, State } from "../engine/types.ts";

// Pure: no database, no clock. A mission is init(seed) plus its accepted
// actions at the nowMs each was applied at, then a tick to wherever the live
// state had got to. Rejected actions are never logged, and need not be: what
// they changed (ticking up to their nowMs) is the same as ticking later, since
// the engine is granularity independent.
export interface LoggedAction {
  nowMs: number;
  action: Action;
}

export function rebuild(seq: Sequence, seed: number, actions: LoggedAction[], finalNowMs: number): State {
  let state = init(seq, seed);
  for (const { nowMs, action } of actions) state = apply(seq, state, action, nowMs).state;
  return tick(seq, state, finalNowMs).state;
}

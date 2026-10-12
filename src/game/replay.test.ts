import { describe, expect, it } from "vitest";
import { apply, init, tick } from "../engine/engine.ts";
import { BASE, loadMvp, findSeed } from "../engine/testutil.ts";
import type { Action, State } from "../engine/types.ts";
import { rebuild, type LoggedAction } from "./replay.ts";

// A tiny stand-in for the server: apply, log only what was accepted.
function live(seed: number, script: { at: number; action: Action }[], finalNow: number) {
  const seq = loadMvp();
  let state: State = init(seq, seed);
  const log: LoggedAction[] = [];
  const rejected: Action[] = [];
  for (const { at, action } of script) {
    const r = apply(seq, state, action, at);
    state = r.state;
    if (r.ok) log.push({ nowMs: at, action });
    else rejected.push(action);
  }
  state = tick(seq, state, finalNow).state;
  return { seq, state, log, rejected };
}

describe("rebuild", () => {
  const seed = findSeed(loadMvp(), (s) => s.faults["vent_stuck"]!.scheduledT !== null);
  const s = (n: number) => BASE + n * 1000;
  const script: { at: number; action: Action }[] = [
    { at: s(0), action: { role: "flight", type: "start" } },
    // rejected: wrong role, locked step, unknown step, bad report, not yet a poll
    { at: s(1), action: { role: "propulsion", type: "step", stepId: "arm_retract" } },
    { at: s(2), action: { role: "propulsion", type: "step", stepId: "tank_pressurise" } },
    { at: s(3), action: { role: "ground", type: "step", stepId: "nope" } },
    { at: s(4), action: { role: "ground", type: "step", stepId: "arm_retract" } },
    { at: s(7), action: { role: "ground", type: "step", stepId: "pad_clear" } },
    { at: s(9), action: { role: "propulsion", type: "step", stepId: "tank_pressurise" } },
    { at: s(11), action: { role: "flight", type: "poll_open", pollId: "poll_1" } },
    { at: s(15), action: { role: "propulsion", type: "step", stepId: "feed_prime" } },
    { at: s(40), action: { role: "flight", type: "hold" } },
    { at: s(55), action: { role: "flight", type: "resume" } },
  ];

  it("equals the live state, and rejected actions are not logged", () => {
    const finalNow = s(120);
    const { seq, state, log, rejected } = live(seed, script, finalNow);
    expect(rejected.length).toBeGreaterThanOrEqual(4);
    expect(log.length + rejected.length).toBe(script.length);
    expect(log.some((l) => l.action.role === "propulsion" && l.action.type === "step" && l.action.stepId === "arm_retract")).toBe(false);
    expect(state.phase === "count" || state.phase === "hold").toBe(true);
    expect(rebuild(seq, seed, log, finalNow)).toEqual(state);
  });

  it("is sensitive to the log: dropping an accepted action changes the state", () => {
    const finalNow = s(120);
    const { seq, state, log } = live(seed, script, finalNow);
    expect(rebuild(seq, seed, log.slice(0, -1), finalNow)).not.toEqual(state);
  });

  it("replays through to a finished mission", () => {
    const finalNow = s(300);
    const withScrub = [...script, { at: s(250), action: { role: "flight", type: "scrub" } as Action }];
    const { seq, state, log } = live(seed, withScrub, finalNow);
    expect(state.phase).toBe("done");
    expect(state.outcome).not.toBeNull();
    expect(rebuild(seq, seed, log, finalNow)).toEqual(state);
  });

  it("serialises: a JSON round trip of the state replays to the same thing", () => {
    const finalNow = s(120);
    const { seq, state, log } = live(seed, script, finalNow);
    const rt = JSON.parse(JSON.stringify(log)) as LoggedAction[];
    expect(rebuild(seq, seed, rt, finalNow)).toEqual(JSON.parse(JSON.stringify(state)));
  });
});

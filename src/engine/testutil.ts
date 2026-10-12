import { readFileSync } from "node:fs";
import { apply, init, tick } from "./engine.ts";
import { parseSequence } from "./sequence.ts";
import { view } from "./view.ts";
import type { Action, EngineEvent, Report, Role, Sequence, State } from "./types.ts";

// Test helpers only: loads mvp.json and drives a crew with a simple bot.

export function loadSequence(id: string): Sequence {
  const raw = JSON.parse(readFileSync(new URL(`../../data/sequences/${id}.json`, import.meta.url), "utf8"));
  return parseSequence(raw);
}

export const loadMvp = (): Sequence => loadSequence("mvp");
export const loadKestrel2 = (): Sequence => loadSequence("kestrel2");

/** True when any weather readout is outside its nominal band right now. */
export function weatherAmber(state: State, seq: Sequence): boolean {
  return Object.entries(seq.values).some(
    ([id, d]) => d.role === "weather" && (state.values[id]! < d.nominal[0] || state.values[id]! > d.nominal[1]),
  );
}

export function findSeed(seq: Sequence, pred: (s: State) => boolean): number {
  for (let seed = 1; seed < 2000; seed++) if (pred(init(seq, seed))) return seed;
  throw new Error("no seed matches");
}

export const BASE = 10_000; // nowMs at which the crew presses start

export interface Run {
  seq: Sequence;
  state: State;
  now: number;
  events: EngineEvent[];
}

export function begin(seq: Sequence, seed: number): Run {
  const run: Run = { seq, state: init(seq, seed), now: BASE, events: [] };
  const r = act(run, { role: "flight", type: "start" });
  if (!r.ok) throw new Error(r.error);
  return run;
}

export function act(run: Run, action: Action) {
  const res = apply(run.seq, run.state, action, run.now);
  run.state = res.state;
  run.events.push(...res.events);
  return res;
}

export function advance(run: Run, ms: number): void {
  run.now += ms;
  const r = tick(run.seq, run.state, run.now);
  run.state = r.state;
  run.events.push(...r.events);
}

/** Advance until the mission clock reaches tSec (T-minus seconds, negative). */
export function advanceToT(run: Run, tSec: number): void {
  advance(run, tSec * 1000 - run.state.tMs);
}

const isDone = (run: Run): boolean => run.state.phase === "done";

export interface BotOptions {
  fix?: boolean; // do fix steps when they unlock (default true)
  report?: (role: Role, pollId: string) => Report; // default "go"
  untilTMs?: number; // stop when the clock reaches this
  stepMs?: number;
  skip?: string[]; // step ids the crew never does
  resume?: boolean; // resume holds at once (default true)
  canResume?: (run: Run) => boolean; // when set, flight resumes only while this is true
  repoll?: (run: Run, pollId: string) => boolean; // when set, a no-go poll is re-opened only while this is true
  holdWhen?: (run: Run) => boolean; // when set, flight calls a hold while counting whenever this is true
}

/** A prompt crew: every ready step is done at once, polls opened and answered. */
export function runBot(run: Run, opts: BotOptions = {}): Run {
  const { seq } = run;
  const fix = opts.fix ?? true;
  const fixIds = new Set(seq.faults.map((f) => f.fixStep));
  const reportOf = opts.report ?? (() => "go" as Report);
  for (let i = 0; i < 2000 && !isDone(run); i++) {
    if (opts.untilTMs !== undefined && run.state.tMs >= opts.untilTMs) break;
    advance(run, opts.stepMs ?? 1000);
    if (isDone(run)) break;
    let progress = true;
    while (progress && !isDone(run)) {
      progress = false;
      for (const step of seq.steps) {
        const st = run.state.steps[step.id]!.status;
        if ((st === "ready" || st === "missed") && (fix || !fixIds.has(step.id)) && !opts.skip?.includes(step.id)) {
          if (act(run, { role: step.role, type: "step", stepId: step.id }).ok) progress = true;
        }
      }
      for (const poll of seq.polls) {
        const p = run.state.polls[poll.id]!;
        const reopen =
          p.status === "closed" && !seq.roles.filter((r) => r !== "flight").every((r) => p.reports[r]?.report === "go");
        if (p.status === "ready" || p.status === "missed" || (reopen && (opts.repoll?.(run, poll.id) ?? true))) {
          if (act(run, { role: "flight", type: "poll_open", pollId: poll.id }).ok) progress = true;
        }
        if (run.state.polls[poll.id]!.status === "open") {
          for (const role of seq.roles.filter((r) => r !== "flight")) {
            if (!run.state.polls[poll.id]!.reports[role]) {
              const r = act(run, { role, type: "poll_report", pollId: poll.id, report: reportOf(role, poll.id) });
              if (r.ok) progress = true;
            }
          }
        }
      }
      if (run.state.phase === "count" && opts.holdWhen?.(run)) {
        if (act(run, { role: "flight", type: "hold" }).ok) progress = true;
      }
      if (run.state.phase === "hold" && (opts.resume ?? true) && (opts.canResume?.(run) ?? true)) {
        if (act(run, { role: "flight", type: "resume" }).ok) progress = true;
      }
    }
  }
  return run;
}

export { view };

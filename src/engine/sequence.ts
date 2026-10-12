import { ROLES } from "./types.ts";
import type { FaultDef, PollDef, Role, Sequence, StepDef, ValueDef } from "./types.ts";

// Hand-written validator for data/sequences/*.json. The caller reads the file;
// this only checks the parsed value. Throws SequenceError whose message starts
// with the JSON path of the problem, e.g. `steps[3].after[0]: unknown id "x"`.

export class SequenceError extends Error {
  path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SequenceError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new SequenceError(path, message);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!isObj(v)) fail(path, "expected an object");
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim() === "") fail(path, "expected a non-empty string");
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "expected a finite number");
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "expected true or false");
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "expected an array");
  return v;
}

function pair(v: unknown, path: string): [number, number] {
  const a = arr(v, path);
  if (a.length !== 2) fail(path, "expected [low, high]");
  return [num(a[0], `${path}[0]`), num(a[1], `${path}[1]`)];
}

function role(v: unknown, path: string, allowed: Role[]): Role {
  if (typeof v !== "string" || !(ROLES as readonly string[]).includes(v)) {
    fail(path, `expected one of ${ROLES.join(", ")}`);
  }
  if (!allowed.includes(v as Role)) fail(path, `role "${v}" is not in the sequence's roles`);
  return v as Role;
}

function window(v: unknown, path: string, countdownSec: number): [number, number] {
  const [open, close] = pair(v, path);
  if (open >= close) fail(path, "window must open before it closes (open < close)");
  if (open < -countdownSec) fail(`${path}[0]`, `opens before the countdown starts (T-${countdownSec})`);
  if (close >= 0) fail(`${path}[1]`, "must close before T-0 (be negative)");
  return [open, close];
}

function unique(path: string, ids: string[], id: string): void {
  if (ids.includes(id)) fail(path, `duplicate id "${id}"`);
}

export function parseSequence(raw: unknown): Sequence {
  const o = obj(raw, "$");
  const id = str(o.id, "id");
  const name = str(o.name, "name");
  const countdownSec = num(o.countdownSec, "countdownSec");
  if (!Number.isInteger(countdownSec) || countdownSec <= 0) {
    fail("countdownSec", "expected a positive whole number of seconds");
  }

  const holdBudgetSec = num(o.holdBudgetSec, "holdBudgetSec");
  if (holdBudgetSec <= 0) fail("holdBudgetSec", "expected a positive number of seconds");

  const rolesRaw = arr(o.roles, "roles");
  const roles: Role[] = [];
  rolesRaw.forEach((r, i) => {
    if (typeof r !== "string" || !(ROLES as readonly string[]).includes(r)) {
      fail(`roles[${i}]`, `expected one of ${ROLES.join(", ")}`);
    }
    if (roles.includes(r as Role)) fail(`roles[${i}]`, `duplicate role "${r}"`);
    roles.push(r as Role);
  });
  if (!roles.includes("flight")) fail("roles", 'must include "flight"');
  if (roles.length < 2) fail("roles", "needs at least one console besides flight");

  const valuesRaw = obj(o.values, "values");
  const values: Record<string, ValueDef> = {};
  for (const [vid, vr] of Object.entries(valuesRaw)) {
    const p = `values.${vid}`;
    const v = obj(vr, p);
    const def: ValueDef = {
      role: role(v.role, `${p}.role`, roles),
      label: str(v.label, `${p}.label`),
      unit: str(v.unit, `${p}.unit`),
      start: num(v.start, `${p}.start`),
      driftPerSec: num(v.driftPerSec, `${p}.driftPerSec`),
      nominal: pair(v.nominal, `${p}.nominal`),
      limit: pair(v.limit, `${p}.limit`),
    };
    if (def.role === "flight") fail(`${p}.role`, "flight has no values");
    if (def.nominal[0] > def.nominal[1]) fail(`${p}.nominal`, "low is above high");
    if (def.limit[0] > def.nominal[0] || def.limit[1] < def.nominal[1]) {
      fail(`${p}.limit`, "limit must contain the nominal range");
    }
    if (def.start < def.limit[0] || def.start > def.limit[1]) {
      fail(`${p}.start`, "start must be inside the limit range");
    }
    values[vid] = def;
  }

  const ids: string[] = []; // steps and polls share one namespace
  const stepsRaw = arr(o.steps, "steps");
  const steps: StepDef[] = stepsRaw.map((sr, i) => {
    const p = `steps[${i}]`;
    const s = obj(sr, p);
    const sid = str(s.id, `${p}.id`);
    unique(`${p}.id`, ids, sid);
    ids.push(sid);
    const def: StepDef = {
      id: sid,
      role: role(s.role, `${p}.role`, roles),
      label: str(s.label, `${p}.label`),
      after: arr(s.after, `${p}.after`).map((a, j) => str(a, `${p}.after[${j}]`)),
      required: bool(s.required, `${p}.required`),
    };
    if (s.window !== undefined) def.window = window(s.window, `${p}.window`, countdownSec);
    if (s.effects !== undefined) {
      def.effects = arr(s.effects, `${p}.effects`).map((er, j) => {
        const ep = `${p}.effects[${j}]`;
        const e = obj(er, ep);
        const value = str(e.value, `${ep}.value`);
        if (!values[value]) fail(`${ep}.value`, `unknown value "${value}"`);
        const eff: { value: string; set?: number; driftPerSec?: number } = { value };
        if (e.set !== undefined) eff.set = num(e.set, `${ep}.set`);
        if (e.driftPerSec !== undefined) eff.driftPerSec = num(e.driftPerSec, `${ep}.driftPerSec`);
        if (eff.set === undefined && eff.driftPerSec === undefined) {
          fail(ep, "an effect needs set and/or driftPerSec");
        }
        return eff;
      });
    }
    return def;
  });

  const pollsRaw = arr(o.polls, "polls");
  const polls: PollDef[] = pollsRaw.map((pr, i) => {
    const p = `polls[${i}]`;
    const q = obj(pr, p);
    const pid = str(q.id, `${p}.id`);
    unique(`${p}.id`, ids, pid);
    ids.push(pid);
    return {
      id: pid,
      label: str(q.label, `${p}.label`),
      after: arr(q.after, `${p}.after`).map((a, j) => str(a, `${p}.after[${j}]`)),
      window: window(q.window, `${p}.window`, countdownSec),
    };
  });

  // references and cycles over the shared step/poll graph
  const graph: Record<string, { after: string[]; path: string }> = {};
  steps.forEach((s, i) => (graph[s.id] = { after: s.after, path: `steps[${i}]` }));
  polls.forEach((q, i) => (graph[q.id] = { after: q.after, path: `polls[${i}]` }));
  for (const [gid, node] of Object.entries(graph)) {
    node.after.forEach((a, j) => {
      if (graph[a] === undefined) fail(`${node.path}.after[${j}]`, `unknown id "${a}"`);
      if (a === gid) fail(`${node.path}.after[${j}]`, "depends on itself");
    });
  }
  const state: Record<string, 1 | 2> = {};
  const visit = (gid: string, trail: string[]): void => {
    if (state[gid] === 2) return;
    if (state[gid] === 1) {
      const cycle = [...trail.slice(trail.indexOf(gid)), gid].join(" -> ");
      fail(`${graph[gid]!.path}.after`, `dependency cycle: ${cycle}`);
    }
    state[gid] = 1;
    for (const a of graph[gid]!.after) visit(a, [...trail, gid]);
    state[gid] = 2;
  };
  for (const gid of Object.keys(graph)) visit(gid, []);

  const faultsRaw = arr(o.faults, "faults");
  const faultIds: string[] = [];
  const faults: FaultDef[] = faultsRaw.map((fr, i) => {
    const p = `faults[${i}]`;
    const f = obj(fr, p);
    const fid = str(f.id, `${p}.id`);
    unique(`${p}.id`, faultIds, fid);
    faultIds.push(fid);
    const def: FaultDef = {
      id: fid,
      role: role(f.role, `${p}.role`, roles),
      label: str(f.label, `${p}.label`),
      window: pair(f.window, `${p}.window`),
      chance: num(f.chance, `${p}.chance`),
      realChance: num(f.realChance, `${p}.realChance`),
      severity: f.severity as FaultDef["severity"],
    };
    if (f.severity !== "abort" && f.severity !== "explode") fail(`${p}.severity`, 'expected "abort" or "explode"');
    if (def.role === "flight") fail(`${p}.role`, "flight has no console faults");
    if (def.window[0] > def.window[1]) fail(`${p}.window`, "t1 must not be after t2");
    if (def.window[0] < -countdownSec) fail(`${p}.window[0]`, "before the countdown starts");
    if (def.window[1] >= 0) fail(`${p}.window[1]`, "must be before T-0 (negative)");
    for (const k of ["chance", "realChance"] as const) {
      if (def[k] < 0 || def[k] > 1) fail(`${p}.${k}`, "expected a probability from 0 to 1");
    }
    if (f.effect !== undefined) {
      const e = obj(f.effect, `${p}.effect`);
      const value = str(e.value, `${p}.effect.value`);
      if (!values[value]) fail(`${p}.effect.value`, `unknown value "${value}"`);
      def.effect = { value, driftPerSec: num(e.driftPerSec, `${p}.effect.driftPerSec`) };
    }
    if (f.crossCheck !== undefined) {
      const c = obj(f.crossCheck, `${p}.crossCheck`);
      def.crossCheck = {
        role: role(c.role, `${p}.crossCheck.role`, roles),
        label: str(c.label, `${p}.crossCheck.label`),
      };
      if (def.crossCheck.role === def.role) {
        fail(`${p}.crossCheck.role`, "a cross-check must be on a different console than the fault");
      }
    }
    if (f.fixStep !== undefined) {
      const fix = str(f.fixStep, `${p}.fixStep`);
      const step = steps.find((s) => s.id === fix);
      if (!step) fail(`${p}.fixStep`, `unknown step "${fix}"`);
      if (step.role !== def.role) fail(`${p}.fixStep`, `step "${fix}" is on another console`);
      if (step.required) fail(`${p}.fixStep`, `step "${fix}" must be required: false (the fault may not occur)`);
      def.fixStep = fix;
    }
    return def;
  });

  return { id, name, countdownSec, holdBudgetSec, roles, values, steps, polls, faults };
}

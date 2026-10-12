import type {
  ChecklistItem,
  ConsoleCrossCheck,
  ConsolePoll,
  ConsoleStep,
  ConsoleValue,
  ConsoleView,
  Debrief,
  Report,
  Role,
  Sequence,
  State,
} from "./types.ts";

// What one console may see. Everything here is built field by field from the
// sequence and state; nothing is copied wholesale, so a new State field cannot
// leak into a view by accident. The flight view adds the master checklist
// (labels, roles, statuses) and nothing about other consoles' values, faults
// or cross-checks.

function isComplete(seq: Sequence, s: State, id: string): boolean {
  const step = s.steps[id];
  if (step) return step.status === "done";
  const p = s.polls[id]!;
  return (
    p.status === "closed" &&
    seq.roles.filter((r) => r !== "flight").every((r) => p.reports[r]?.report === "go")
  );
}

export function view(seq: Sequence, state: State, role: Role): ConsoleView {
  const reporters = seq.roles.filter((r) => r !== "flight");

  const steps: ConsoleStep[] = seq.steps
    .filter((st) => st.role === role)
    .map((st) => ({
      id: st.id,
      label: st.label,
      status: state.steps[st.id]!.status,
      required: st.required,
      window: st.window ? [st.window[0], st.window[1]] : null,
      waitingOn: st.after
        .filter((a) => !isComplete(seq, state, a))
        .map((a) => {
          const other = seq.steps.find((x) => x.id === a);
          if (!other) return { role: "flight" as Role, label: seq.polls.find((x) => x.id === a)!.label };
          return { role: other.role, label: other.role === role ? other.label : null };
        }),
    }));

  const values: ConsoleValue[] = Object.entries(seq.values)
    .filter(([, d]) => d.role === role)
    .map(([id, d]) => {
      const value = state.values[id]!;
      return {
        id,
        label: d.label,
        unit: d.unit,
        value,
        nominal: [d.nominal[0], d.nominal[1]],
        limit: [d.limit[0], d.limit[1]],
        caution: value < d.nominal[0] || value > d.nominal[1],
      };
    });

  const cautions = seq.faults
    .filter((f) => f.role === role && state.faults[f.id]!.active && !state.faults[f.id]!.resolved)
    .map((f) => f.label);

  const crossChecks: ConsoleCrossCheck[] = seq.faults
    .filter((f) => f.crossCheck && f.crossCheck.role === role)
    .map((f) => {
      const fs = state.faults[f.id]!;
      const abnormal = fs.active && fs.real && !fs.resolved;
      return { label: f.crossCheck!.label, reading: abnormal ? "abnormal" : "normal" };
    });

  const polls: ConsolePoll[] = seq.polls.map((q) => {
    const p = state.polls[q.id]!;
    const reports: Partial<Record<Role, Report>> = {};
    for (const r of reporters) {
      const rep = p.reports[r];
      if (rep) reports[r] = rep.report;
    }
    return {
      id: q.id,
      label: q.label,
      status: p.status,
      window: [q.window[0], q.window[1]],
      reports,
      pending: p.status === "open" ? reporters.filter((r) => !p.reports[r]) : [],
      myReport: p.reports[role]?.report ?? null,
    };
  });

  const v: ConsoleView = {
    role,
    phase: state.phase,
    tMs: state.tMs,
    holds: state.holds,
    holdLeftMs: Math.max(0, seq.holdBudgetSec * 1000 - (state.holdMs ?? 0)),
    outcome: state.outcome ? { ...state.outcome, reasons: [...state.outcome.reasons] } : null,
    steps,
    values,
    cautions,
    crossChecks,
    polls,
  };

  if (role === "flight") {
    const checklist: ChecklistItem[] = seq.steps.map((st) => ({
      id: st.id,
      label: st.label,
      role: st.role,
      status: state.steps[st.id]!.status,
      required: st.required,
    }));
    v.checklist = checklist;
  }

  if (state.phase === "done") v.debrief = debrief(seq, state);
  return v;
}

function debrief(seq: Sequence, state: State): Debrief {
  return {
    steps: seq.steps.map((st) => ({
      id: st.id,
      label: st.label,
      role: st.role,
      status: state.steps[st.id]!.status,
      atT: state.steps[st.id]!.atT ?? null,
    })),
    polls: seq.polls.map((q) => {
      const p = state.polls[q.id]!;
      return {
        id: q.id,
        label: q.label,
        status: p.status,
        reports: structuredClone(p.reports),
        history: structuredClone(p.history),
      };
    }),
    faults: seq.faults.map((f) => {
      const fs = state.faults[f.id]!;
      return {
        id: f.id,
        label: f.label,
        role: f.role,
        scheduledT: fs.scheduledT,
        real: fs.real,
        active: fs.active,
        resolved: fs.resolved,
      };
    }),
    values: Object.entries(seq.values).map(([id, d]) => ({
      id,
      label: d.label,
      role: d.role,
      unit: d.unit,
      value: state.values[id]!,
      limit: [d.limit[0], d.limit[1]],
    })),
  };
}

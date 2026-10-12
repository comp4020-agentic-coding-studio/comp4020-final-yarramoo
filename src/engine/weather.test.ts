import { describe, expect, it } from "vitest";
import { nextRandom } from "./rng.ts";
import { apply, init, tick } from "./engine.ts";
import { parseSequence, SequenceError } from "./sequence.ts";
import { act, advance, advanceToT, begin, findSeed, loadKestrel2, loadMvp, loadSequence, runBot, view, weatherAmber } from "./testutil.ts";
import { ROLES, ROLE_LABELS } from "./types.ts";
import type { Sequence, State } from "./types.ts";
import { readFileSync } from "node:fs";

const mvp = loadMvp();
const k2 = loadKestrel2();
const rawK2 = (): any => JSON.parse(readFileSync(new URL("../../data/sequences/kestrel2.json", import.meta.url), "utf8"));
const rawMvp = (): any => JSON.parse(readFileSync(new URL("../../data/sequences/mvp.json", import.meta.url), "utf8"));
const WEATHER = ["ceiling", "shear", "lightning"];

/** kestrel2 with fixed weather: a constant reading, no fronts, no faults. */
function steadyWeather(ceiling: number): Sequence {
  const r = rawK2();
  for (const id of WEATHER) r.values[id].fronts.driftPerSec = [0, 0];
  r.values.ceiling.start = ceiling;
  for (const f of r.faults) f.chance = 0;
  return parseSequence(r);
}

describe("roles", () => {
  it("weather is a role with a label, and only kestrel2 seats it", () => {
    expect(ROLES).toContain("weather");
    expect(ROLE_LABELS.weather).toBe("Weather");
    expect(k2.roles).toEqual(["flight", "propulsion", "ground", "weather"]);
    expect(mvp.roles).toEqual(["flight", "propulsion", "ground"]);
  });

  it("the weather view holds weather readouts only, and no other console sees them", () => {
    const run = begin(k2, 3);
    advance(run, 5000);
    const w = view(k2, run.state, "weather");
    expect(w.values.map((v) => v.id).sort()).toEqual([...WEATHER].sort());
    expect(w.steps.map((s) => s.id).sort()).toEqual(["balloon_release", "lcc_brief"]);
    for (const role of ["flight", "propulsion", "ground"] as const) {
      const text = JSON.stringify(view(k2, run.state, role));
      for (const id of WEATHER) expect(text, `${role} sees ${id}`).not.toContain(`"${id}"`);
      for (const label of ["Cloud base", "Upper-level wind shear", "Nearest lightning"]) {
        expect(text, `${role} sees ${label}`).not.toContain(label);
      }
    }
    // the front schedule is state, never a view
    expect(JSON.stringify(w)).not.toContain("frontIdx");
    expect(JSON.stringify(w)).not.toContain('"rate"');
  });

  it("the poll's reporters are the sequence's roles minus flight: weather is pending in kestrel2, absent from mvp", () => {
    const run = begin(k2, 3);
    runBot(run, { untilTMs: -130_000 }); // every poll_1 prerequisite is done well before its window
    advanceToT(run, -124);
    expect(run.state.polls.poll_1!.status).toBe("ready");
    expect(act(run, { role: "flight", type: "poll_open", pollId: "poll_1" }).ok).toBe(true);
    expect(view(k2, run.state, "flight").polls[0]!.pending.sort()).toEqual(["ground", "propulsion", "weather"]);
    const m = begin(mvp, 3);
    runBot(m, { untilTMs: -100_000 });
    for (const pl of view(mvp, m.state, "flight").polls) expect(pl.pending).not.toContain("weather");
  });
});

describe("weather fronts: the pre-rolled schedule", () => {
  it("is seed-determined plain JSON on elapsed-time boundaries, with rates inside the range", () => {
    const a = init(k2, 11);
    expect(init(k2, 11)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(init(k2, 12).fronts).not.toEqual(a.fronts);
    expect(Object.keys(a.fronts).sort()).toEqual([...WEATHER].sort());
    for (const id of WEATHER) {
      const d = k2.values[id]!.fronts!;
      const sched = a.fronts[id]!;
      // covers countdown + hold budget (450 s) and then some
      expect(sched.length).toBeGreaterThanOrEqual(Math.ceil((300 + 150) / d.everySec));
      expect(sched.at(-1)!.at).toBeGreaterThan((300 + 150) * 1000);
      sched.forEach((f, i) => {
        expect(f.at).toBe((i + 1) * d.everySec * 1000);
        expect(f.rate).toBeGreaterThanOrEqual(d.driftPerSec[0]);
        expect(f.rate).toBeLessThanOrEqual(d.driftPerSec[1]);
      });
      expect(a.frontIdx[id]).toBe(0);
    }
    // the rates really vary
    expect(new Set(a.fronts.ceiling!.map((f) => f.rate)).size).toBeGreaterThan(5);
  });

  it("is rolled after the faults: a sequence without fronts is exactly what it was", () => {
    const m = init(mvp, 7);
    expect(m.fronts).toEqual({});
    expect(m.frontIdx).toEqual({});
    // k2 shares mvp's fault dice: same seed, same fault schedule for the shared faults
    const k = init(k2, 7);
    expect(k.faults).toEqual(m.faults);
  });
});

describe("weather fronts: drift", () => {
  it("changes the rate at each front (the value is piecewise linear in elapsed time)", () => {
    const run = begin(k2, 5);
    const sched = run.state.fronts.ceiling!;
    // a bot would do steps; plain ticks are enough to watch the weather alone
    const at = (sec: number) => {
      run.now = 10_000 + sec * 1000;
      const r = tick(k2, run.state, run.now);
      run.state = r.state;
      return run.state.values.ceiling!;
    };
    const v0 = at(0);
    expect(v0).toBe(3600);
    expect(at(30)).toBe(3600); // rate 0 before the first front at 40 s
    const v40 = at(40);
    const v80 = at(80);
    expect(v40).toBe(3600);
    expect(v80).toBeCloseTo(3600 + sched[0]!.rate * 40, 6);
    expect(at(120)).toBeCloseTo(3600 + sched[0]!.rate * 40 + sched[1]!.rate * 40, 6);
    expect(run.state.frontIdx.ceiling).toBe(3);
  });

  it("chunked ticks equal one tick across front boundaries (count phase)", () => {
    const s0 = begin(k2, 21).state;
    const t1 = 10_000 + 250_000;
    const direct = tick(k2, s0, t1);
    expect(direct.state.frontIdx.ceiling).toBe(6);
    let rng = 5;
    const rnd = () => {
      const r = nextRandom(rng);
      rng = r.state;
      return r.value;
    };
    for (const chunk of [333, 1000, 7777, 39_999, 40_000, 40_001]) {
      let s = s0;
      const events: unknown[] = [];
      for (let t = 10_000 + chunk; ; t += chunk) {
        const r = tick(k2, s, Math.min(t, t1));
        s = r.state;
        events.push(...r.events);
        if (t >= t1) break;
      }
      expect(s, `chunk ${chunk}`).toEqual(direct.state);
      expect(events).toEqual(direct.events);
    }
    for (let trial = 0; trial < 10; trial++) {
      let s = s0;
      for (let t = 10_000; t < t1; ) {
        t = Math.min(t1, t + 1 + Math.floor(rnd() * 30_000));
        s = tick(k2, s, t).state;
      }
      expect(s).toEqual(direct.state);
    }
  }, 60_000);

  it("chunked ticks equal one tick through a hold, a resume and T-0", () => {
    // idle crew: the count is held by a missed step, then the window runs out
    const base = begin(k2, 21);
    advanceToT(base, -280);
    expect(act(base, { role: "flight", type: "hold" }).ok).toBe(true);
    const s0 = base.state;
    const end = base.now + 400_000;
    const direct = tick(k2, s0, end);
    expect(direct.state.phase).toBe("done");
    expect(direct.state.outcome!.reasons[0]).toContain("Launch window closed");
    // weather ran for the whole 150 s of hold, plus the 20 s before it
    expect(direct.state.elapsedMs).toBe(20_000 + 150_000);
    let rng = 77;
    const rnd = () => {
      const r = nextRandom(rng);
      rng = r.state;
      return r.value;
    };
    for (let trial = 0; trial < 12; trial++) {
      let s = s0;
      let t = base.now;
      const events: unknown[] = [];
      while (t < end) {
        t = Math.min(end, t + 1 + Math.floor(rnd() * 20_000));
        const r = tick(k2, s, t);
        s = r.state;
        events.push(...r.events);
      }
      expect(s).toEqual(direct.state);
      expect(events).toEqual(direct.events);
    }
  });

  it("weather keeps drifting during a hold while the clock is frozen, exactly as it would counting", () => {
    const counting = begin(k2, 21);
    advance(counting, 130_000);
    const held = begin(k2, 21);
    expect(act(held, { role: "flight", type: "hold" }).ok).toBe(true);
    advance(held, 130_000);
    expect(held.state.phase).toBe("hold");
    expect(held.state.tMs).toBe(-300_000);
    expect(held.state.elapsedMs).toBe(130_000);
    expect(held.state.frontIdx).toEqual({ ceiling: 3, shear: 3, lightning: 3 });
    for (const id of WEATHER) expect(held.state.values[id]).toBe(counting.state.values[id]);
    expect(WEATHER.some((id) => held.state.values[id] !== k2.values[id]!.start)).toBe(true);
    // and it keeps going after the resume: the schedule is on elapsed time, not the mission clock
    expect(act(held, { role: "flight", type: "resume" }).ok).toBe(true);
    advance(held, 60_000);
    expect(held.state.elapsedMs).toBe(190_000);
    expect(held.state.frontIdx.ceiling).toBe(4);
  });

  it("past the last front the final rate persists", () => {
    const s = init(k2, 4);
    const sched = s.fronts.ceiling!;
    const big = { ...k2, holdBudgetSec: 1e6 };
    const started = apply(big, s, { role: "flight", type: "hold" }, 0);
    expect(started.ok).toBe(false); // not started: only start works
    const r0 = apply(big, s, { role: "flight", type: "start" }, 0);
    expect(r0.ok).toBe(true);
    const held = apply(big, r0.state, { role: "flight", type: "hold" }, 0);
    expect(held.ok).toBe(true);
    const after = tick(big, held.state, 100_000_000).state;
    expect(after.frontIdx.ceiling).toBe(sched.length);
    const later = tick(big, after, 100_001_000).state;
    expect(later.values.ceiling! - after.values.ceiling!).toBeCloseTo(sched.at(-1)!.rate, 6);
  });

  it("mvp is untouched: no fronts, and a full state round trip plays on identically", () => {
    const run = begin(mvp, 9);
    runBot(run, { untilTMs: -100_000 });
    expect(run.state.fronts).toEqual({});
    const copy: State = JSON.parse(JSON.stringify(run.state));
    expect(tick(mvp, copy, run.now + 90_000)).toEqual(tick(mvp, run.state, run.now + 90_000));
  });

  it("a snapshot saved before fronts existed still ticks", () => {
    const run = begin(mvp, 9);
    const old: any = JSON.parse(JSON.stringify(run.state));
    delete old.fronts;
    delete old.frontIdx;
    expect(tick(mvp, old, run.now + 30_000).state.tMs).toBe(run.state.tMs + 30_000);
  });
});

describe("atT0: what an out-of-nominal value does at T-0", () => {
  // tank pressure set into the caution band (nominal 230-270, limit 50-335)
  function tank(atT0: string | undefined, set = 285, extra?: (r: any) => void): Sequence {
    const r = rawMvp();
    r.faults.forEach((f: any) => delete f.effect);
    r.steps.find((s: any) => s.id === "tank_pressurise").effects[0].set = set;
    if (atT0) r.values.tank_pressure.atT0 = atT0;
    extra?.(r);
    return parseSequence(r);
  }
  const NO_FAULTS = findSeed(mvp, (s) => Object.values(s.faults).every((f) => f.scheduledT === null));
  const flyTank = (q: Sequence) => runBot(begin(q, NO_FAULTS));

  it("default (and explicit abort) is a pad abort", () => {
    expect(flyTank(tank(undefined)).state.outcome!.kind).toBe("pad_abort");
    expect(flyTank(tank("abort")).state.outcome!.kind).toBe("pad_abort");
  });

  it("explode turns the caution band into an explosion", () => {
    const run = flyTank(tank("explode"));
    expect(run.state.outcome!.kind).toBe("explosion");
    expect(run.state.outcome!.reasons.join(" ")).toContain("outside nominal");
  });

  it("scrub ends the mission as a scrub with a readable reason, a scrub event, then the outcome", () => {
    const run = flyTank(tank("scrub"));
    expect(run.state.outcome).toMatchObject({ kind: "scrub", atT: 0 });
    expect(run.state.outcome!.reasons[0]).toBe("Propulsion outside launch criteria at T-0");
    expect(run.state.outcome!.reasons.join(" ")).toContain("Propellant tank pressure read 285.0 kPa");
    expect(run.state.holds).toBe(0);
    const tail = run.events.slice(-2);
    expect(tail[0]).toMatchObject({ kind: "scrub", data: { reason: "Propulsion outside launch criteria at T-0" } });
    expect(tail[0]!.role).toBeUndefined();
    expect(tail[1]).toMatchObject({ kind: "outcome", data: { kind: "scrub" } });
  });

  it("a value inside nominal never triggers any override", () => {
    for (const m of ["explode", "scrub", "abort"]) expect(flyTank(tank(m, 250)).state.outcome!.kind).toBe("success");
  });

  it("outside the limit is an explosion whatever atT0 says, phrased as launching into it for scrub values", () => {
    for (const m of ["abort", "explode", "scrub"]) {
      const run = flyTank(tank(m, 340));
      expect(run.state.outcome!.kind, m).toBe("explosion");
      if (m === "scrub") expect(run.state.outcome!.reasons[0]).toMatch(/^Launched into Propellant tank pressure 340\.0 kPa, outside the limit/);
    }
  });

  it("precedence: explosion > pad_abort > requirements hold > scrub > success", () => {
    // scrub value + a value in another caution band that aborts -> pad abort beats the scrub
    const abortToo = tank("scrub", 285, (r) => (r.steps.find((s: any) => s.id === "bus_transfer").effects[0].set = 25.5));
    expect(flyTank(abortToo).state.outcome!.kind).toBe("pad_abort");
    // scrub value + a value past its limit -> explosion beats both
    const blastToo = tank("scrub", 285, (r) => (r.steps.find((s: any) => s.id === "bus_transfer").effects[0].set = 20));
    expect(flyTank(blastToo).state.outcome!.kind).toBe("explosion");
    // scrub value + an unmet requirement -> the T-1 hold comes first, no scrub yet
    const late = tank("scrub", 285, (r) => r.steps.push({ id: "late_check", role: "ground", label: "Final safing check", after: [], required: true }));
    const run = runBot(begin(late, NO_FAULTS), { untilTMs: -2000, skip: ["late_check"] });
    advance(run, 5000);
    expect(run.state.phase).toBe("hold");
    expect(run.state.tMs).toBe(-1000);
    expect(run.state.holds).toBe(1);
    // the crew catches up, resumes, and now the launch decision meets the weather: scrub
    expect(act(run, { role: "ground", type: "step", stepId: "late_check" }).ok).toBe(true);
    expect(act(run, { role: "flight", type: "resume" }).ok).toBe(true);
    advance(run, 2000);
    expect(run.state.outcome).toMatchObject({ kind: "scrub" });
    expect(run.state.outcome!.reasons[0]).toBe("Propulsion outside launch criteria at T-0");
    // and a clean in-nominal run still succeeds
    expect(flyTank(tank("scrub", 250)).state.outcome!.kind).toBe("success");
  });

  it("the validator knows atT0 and fronts", () => {
    const bad = (mut: (r: any) => void): string => {
      const r = rawK2();
      mut(r);
      try {
        parseSequence(r);
      } catch (e) {
        expect(e).toBeInstanceOf(SequenceError);
        return (e as SequenceError).path;
      }
      throw new Error("expected rejection");
    };
    expect(bad((r) => (r.values.ceiling.atT0 = "boom"))).toBe("values.ceiling.atT0");
    expect(bad((r) => (r.values.ceiling.fronts.everySec = 0))).toBe("values.ceiling.fronts.everySec");
    expect(bad((r) => (r.values.ceiling.fronts.driftPerSec = [1, -1]))).toBe("values.ceiling.fronts.driftPerSec");
    expect(bad((r) => (r.values.ceiling.fronts.driftPerSec = [1]))).toBe("values.ceiling.fronts.driftPerSec");
    expect(bad((r) => r.steps[2].effects = [{ value: "ceiling", driftPerSec: 1 }])).toBe("steps[2].effects[0].driftPerSec");
    expect(bad((r) => (r.roles = ["flight", "propulsion", "ground"]))).toBe("values.ceiling.role");
    // set on a front value is allowed
    const ok = rawK2();
    ok.steps[2].effects = [{ value: "ceiling", set: 5000 }];
    expect(() => parseSequence(ok)).not.toThrow();
  });
});

describe("a weather seat that reports GO over an amber readout", () => {
  const q = steadyWeather(3000); // cloud base below the 4000 ft floor all count long
  const NO_FAULTS = findSeed(q, (s) => Object.values(s.faults).every((f) => f.scheduledT === null));

  it("is recorded as go-on-caution (showing caution), and the launch is scrubbed at T-0", () => {
    const run = runBot(begin(q, NO_FAULTS)); // default bot: everybody says GO
    const reports = run.events.filter((e) => e.kind === "poll_report" && e.role === "weather");
    expect(reports).toHaveLength(2);
    for (const e of reports) expect(e.data).toMatchObject({ report: "go", showing: "caution" });
    expect(run.state.polls.poll_1!.reports.weather).toMatchObject({ report: "go", showing: "caution" });
    // the others were nominal
    expect(run.state.polls.poll_1!.reports.propulsion).toMatchObject({ report: "go", showing: "nominal" });
    // launch authority was given, so the crew launched into weather outside criteria
    expect(run.state.steps.launch_authority!.status).toBe("done");
    expect(run.state.outcome).toMatchObject({ kind: "scrub", atT: 0 });
    expect(run.state.outcome!.reasons[0]).toBe("Weather outside launch criteria at T-0");
    expect(run.state.outcome!.reasons.join(" ")).toContain("Cloud base read 3000.0 ft");
    expect(run.events.at(-2)).toMatchObject({ kind: "scrub", data: { reason: "Weather outside launch criteria at T-0" } });
  });

  it("NO-GO from the weather seat holds the count and counts as speaking up (showing caution, report nogo)", () => {
    const run = begin(q, NO_FAULTS);
    // the weather never clears, so the crew holds until the launch window closes
    runBot(run, { report: (role) => (role === "weather" ? "nogo" : "go"), repoll: () => false, resume: false });
    const hold = run.events.find((e) => e.kind === "hold")!;
    expect(String(hold.data!.reason)).toBe('Weather reported no-go on "Go/no-go: propellant, pad and weather readiness"');
    expect(run.state.polls.poll_1!.reports.weather).toMatchObject({ report: "nogo", showing: "caution" });
    expect(run.state.outcome).toMatchObject({ kind: "scrub", reasons: ["Launch window closed after 1 hold"] });
  });

  it("the debrief carries the weather readouts and the final reading", () => {
    const run = runBot(begin(q, NO_FAULTS));
    const d = view(q, run.state, "flight").debrief!;
    expect(d.values.filter((v) => v.role === "weather").map((v) => v.id).sort()).toEqual([...WEATHER].sort());
  });
});

describe("kestrel2 is winnable", () => {
  const N = 150;
  const play = (seed: number, attentive: boolean) => {
    const run = begin(k2, seed);
    const amber = () => weatherAmber(run.state, k2);
    let amberAtPoll = false;
    runBot(run, {
      // the Weather seat reports what its console shows
      report: (role, pollId) => {
        const a = role === "weather" && amber();
        if (a) amberAtPoll = true;
        void pollId;
        return a ? "nogo" : "go";
      },
      repoll: () => !amber(),
      canResume: () => !amber(),
      // an attentive Weather seat speaks up after the final poll too and Flight holds
      holdWhen: attentive ? () => amber() && run.state.polls.poll_2!.status === "closed" && run.state.tMs > -60_000 : undefined,
    });
    return { run, amberAtPoll };
  };

  it("a crew that holds for amber weather and resumes when it clears wins at least 80% of seeds", () => {
    let wins = 0;
    let heldAndWon = 0;
    let amberSeeds = 0;
    const lost = new Set<string>();
    for (let seed = 1; seed <= N; seed++) {
      const { run, amberAtPoll } = play(seed, true);
      if (amberAtPoll) amberSeeds++;
      if (run.state.outcome!.kind === "success") {
        wins++;
        if (run.state.holds > 0) heldAndWon++;
      } else {
        lost.add(run.state.outcome!.reasons[0]!.replace(/\d+ holds?/, "N holds"));
      }
    }
    // some of the weather is bad, a hold rescues some of it, and the rest is lost to the window or the weather
    expect(amberSeeds / N).toBeGreaterThan(0.2);
    expect(amberSeeds / N).toBeLessThan(0.6);
    expect(heldAndWon).toBeGreaterThan(5);
    expect(wins / N, `lost: ${[...lost].join("; ")}`).toBeGreaterThanOrEqual(0.8);
    expect([...lost].every((r) => /Launch window closed|Weather outside/.test(r)), [...lost].join("; ")).toBe(true);
  }, 120_000);

  it("a crew that launches regardless of the weather loses some seeds to a scrub, never to an explosion", () => {
    let scrubs = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const run = runBot(begin(k2, seed));
      const o = run.state.outcome!;
      expect(["success", "scrub"]).toContain(o.kind);
      if (o.kind === "scrub") {
        scrubs++;
        expect(o.reasons[0]).toBe("Weather outside launch criteria at T-0");
      }
    }
    expect(scrubs).toBeGreaterThan(2);
  }, 60_000);

  it("a scripted hold: weather amber at the final poll, hold, wait it out, re-poll, resume, success", () => {
    // find a seed where the attentive bot succeeded after holding at poll 2
    let found: number | null = null;
    for (let seed = 1; seed <= 200 && found === null; seed++) {
      const { run } = play(seed, false);
      const p2 = run.events.filter((e) => e.kind === "poll_report" && e.data?.pollId === "poll_2" && e.role === "weather");
      if (run.state.outcome!.kind === "success" && p2.length >= 2 && p2[0]!.data!.report === "nogo") found = seed;
    }
    expect(found, "a seed that needs a hold at the final poll").not.toBeNull();
    const { run } = play(found!, false);
    const holdEvents = run.events.filter((e) => e.kind === "hold");
    expect(holdEvents.length).toBeGreaterThan(0);
    expect(String(holdEvents[0]!.data!.reason)).toContain("Weather reported no-go");
    expect(run.state.polls.poll_2!.history.length).toBeGreaterThan(0);
    expect(run.state.holdMs).toBeLessThan(150_000);
    expect(run.state.outcome!.kind).toBe("success");
  }, 60_000);
});

describe("loadSequence", () => {
  it("loads both shipped sequences", () => {
    expect(loadSequence("mvp").id).toBe("mvp");
    expect(loadSequence("kestrel2").name).toBe("Kestrel-2 orbital");
    expect(k2.countdownSec).toBe(300);
    expect(k2.holdBudgetSec).toBe(150);
  });
});

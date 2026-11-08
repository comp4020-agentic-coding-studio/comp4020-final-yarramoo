import { describe, expect, it } from "vitest";
import { DEEP_TOP, SHALLOW_TOP } from "../../shared/stats.ts";
import { DEPTH_HOLD_MS, FIGHT_HOLD_MS, MAX_MUSIC_VOICES, MOODS, degreeToMidi, moodToSwitch, initialMoodState, makeRng, maxOverlap, planBar, stepMood, type Mood, type MoodInput, type MoodState } from "../../client/music.ts";

const moods = Object.keys(MOODS) as Mood[];
const base: MoodInput = { y: 100, bossAlive: false, sandbox: false, round: null };

describe("tables", () => {
  it("every scale and chord stays in a sane MIDI range", () => {
    for (const k of moods) {
      const m = MOODS[k];
      expect(m.bpm).toBeGreaterThan(30);
      for (const c of m.chords) for (let off = 0; off < 14; off++) {
        const n = degreeToMidi(m, c + off + 5);
        expect(n).toBeGreaterThanOrEqual(24);
        expect(n).toBeLessThanOrEqual(108);
      }
    }
  });
});

describe("planBar", () => {
  it("notes are in time order, in the bar, and within the voice cap", () => {
    for (const k of moods) for (let bar = 0; bar < 8; bar++) {
      const notes = planBar(k, bar, makeRng(bar + 1));
      expect(notes.length).toBeGreaterThan(0);
      for (let i = 1; i < notes.length; i++) expect(notes[i].t).toBeGreaterThanOrEqual(notes[i - 1].t);
      for (const n of notes) {
        expect(n.t).toBeGreaterThanOrEqual(0);
        expect(n.t).toBeLessThan(MOODS[k].beatsPerBar);
        expect(n.vel).toBeGreaterThan(0);
        expect(n.vel).toBeLessThanOrEqual(1);
      }
      expect(maxOverlap(notes)).toBeLessThanOrEqual(MAX_MUSIC_VOICES);
    }
  });
  it("is deterministic for a seed", () => {
    expect(planBar("surface", 3, makeRng(7))).toEqual(planBar("surface", 3, makeRng(7)));
  });
});

describe("stepMood", () => {
  const run = (s: MoodState, inp: MoodInput, t: number) => stepMood(s, inp, t);
  it("depth changes need DEPTH_HOLD_MS in the new band", () => {
    let s = initialMoodState();
    s = run(s, { ...base, y: SHALLOW_TOP + 10 }, 0);
    expect(s.mood).toBe("surface");
    s = run(s, { ...base, y: SHALLOW_TOP + 10 }, DEPTH_HOLD_MS - 1);
    expect(s.mood).toBe("surface");
    s = run(s, { ...base, y: SHALLOW_TOP + 10 }, DEPTH_HOLD_MS);
    expect(s.mood).toBe("caves");
    s = run(s, { ...base, y: DEEP_TOP + 5 }, DEPTH_HOLD_MS + 10);
    s = run(s, { ...base, y: DEEP_TOP + 5 }, 2 * DEPTH_HOLD_MS + 10);
    expect(s.mood).toBe("deep");
  });
  it("hopping across a boundary resets the timer", () => {
    let s = initialMoodState();
    s = run(s, { ...base, y: SHALLOW_TOP + 1 }, 0);
    s = run(s, { ...base, y: SHALLOW_TOP - 1 }, 2000);
    s = run(s, { ...base, y: SHALLOW_TOP + 1 }, 2500);
    s = run(s, { ...base, y: SHALLOW_TOP + 1 }, 4000);
    expect(s.mood).toBe("surface");
    s = run(s, { ...base, y: SHALLOW_TOP + 1 }, 2500 + DEPTH_HOLD_MS);
    expect(s.mood).toBe("caves");
  });
  it("boss is immediate and ends back at depth mood after a hold", () => {
    let s = initialMoodState();
    s = run(s, { ...base, bossAlive: true }, 0);
    expect(s.mood).toBe("boss");
    s = run(s, base, 100);
    expect(s.mood).toBe("boss");
    s = run(s, base, 100 + DEPTH_HOLD_MS);
    expect(s.mood).toBe("surface");
  });
  it("round stings are immediate and final; sandbox stays on surface", () => {
    let s = run(initialMoodState(), { ...base, round: "win" }, 0);
    expect(s.mood).toBe("victory");
    s = run(s, { ...base, y: DEEP_TOP + 50 }, 99999);
    expect(s.mood).toBe("victory");
    expect(run(initialMoodState(), { ...base, round: "lose" }, 0).mood).toBe("defeat");
    let sb = initialMoodState();
    sb = run(sb, { ...base, sandbox: true, y: DEEP_TOP + 50 }, 0);
    sb = run(sb, { ...base, sandbox: true, y: DEEP_TOP + 50 }, 99999);
    expect(sb.mood).toBe("surface");
  });
});

describe("fight mood", () => {
  const run = (s: MoodState, inp: MoodInput, t: number) => stepMood(s, inp, t);
  it("a combat signal switches to fight at once and holds, then returns to the depth mood at once", () => {
    let s = run(initialMoodState(), { ...base, combatAt: 1000 }, 1000);
    expect(s.mood).toBe("fight");
    s = run(s, { ...base, combatAt: 1000 }, 1000 + FIGHT_HOLD_MS - 1);
    expect(s.mood).toBe("fight");
    s = run(s, { ...base, combatAt: 1000 }, 1000 + FIGHT_HOLD_MS);
    expect(s.mood).toBe("surface");
  });
  it("a fresh signal extends the hold", () => {
    let s = run(initialMoodState(), { ...base, combatAt: 0 }, 0);
    s = run(s, { ...base, combatAt: 5000 }, 5000);
    s = run(s, { ...base, combatAt: 5000 }, FIGHT_HOLD_MS + 1000);
    expect(s.mood).toBe("fight");
  });
  it("boss and round stings outrank fight; no signal means no fight", () => {
    expect(run(initialMoodState(), { ...base, bossAlive: true, combatAt: 0 }, 0).mood).toBe("boss");
    expect(run(initialMoodState(), { ...base, round: "win", combatAt: 0 }, 0).mood).toBe("victory");
    expect(run(initialMoodState(), { ...base, combatAt: null }, 0).mood).toBe("surface");
    expect(run(initialMoodState(), base, 0).mood).toBe("surface");
  });
  it("fight is faster, minor and has percussion on every beat", () => {
    expect(MOODS.fight.bpm).toBeGreaterThan(MOODS.deep.bpm * 1.8);
    expect(MOODS.fight.scale).toEqual([0, 2, 3, 5, 7, 8, 10]);
    const perc = planBar("fight", 0, makeRng(1)).filter((n) => n.voice === "perc");
    expect(perc.map((n) => n.t)).toEqual([0, 1, 2, 3]);
  });
  it("sandbox ignores combat", () => {
    expect(run(initialMoodState(), { ...base, sandbox: true, combatAt: 0 }, 0).mood).toBe("surface");
  });
});

describe("moodToSwitch (hardening review client F1)", () => {
  it("a finished sting is not restarted by the room asking for it again", () => {
    // The sting played its bar and the engine fell back to "menu"; the room still asks for "victory" every message.
    expect(moodToSwitch("victory", "menu", "victory")).toBeNull();
    expect(moodToSwitch("defeat", "menu", "defeat")).toBeNull();
  });
  it("a sting that has not played yet starts, and ordinary moods still switch", () => {
    expect(moodToSwitch("victory", "deep", null)).toBe("victory");
    expect(moodToSwitch("deep", "surface", null)).toBe("deep");
    expect(moodToSwitch("deep", "deep", null)).toBeNull();
  });
});

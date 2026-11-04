// Synthesised music (WebAudio, no files). Render-only: nothing here reads or writes sim state (invariants 1 and 9).
// The pure parts (mood tables, mood selection, bar planning) have no WebAudio and are unit-tested; the engine below
// them is a look-ahead scheduler on the same AudioContext as sfx.ts. Music has its own gain and its own mute key,
// and connects straight to the context's destination so muting sound effects does not mute it, nor the reverse.
import { getAudio } from "./sfx.ts";
import { store } from "./storage.ts";
import { DEEP_TOP, SHALLOW_TOP } from "../shared/stats.ts";

export const MUSIC_KEY = "sand.music";

export type Mood = "menu" | "surface" | "caves" | "deep" | "boss" | "victory" | "defeat";
export type VoiceKind = "pad" | "mel" | "bass" | "pluck" | "drone" | "perc";

export interface Note {
  voice: VoiceKind;
  /** MIDI note number (ignored for perc). */
  midi: number;
  /** Start within the bar, in beats. */
  t: number;
  /** Length in beats. */
  dur: number;
  /** Loudness 0..1. */
  vel: number;
}

interface VoiceDef {
  type: OscillatorType;
  /** Low-pass cutoff in Hz. */
  cutoff: number;
  attack: number;
  release: number;
  gain: number;
}

interface MoodDef {
  root: number; // MIDI of the tonic
  scale: number[]; // semitone offsets from the root
  bpm: number;
  beatsPerBar: number;
  /** Chord loop: scale-degree roots (indices into the scale); each chord stacks degrees +0, +2, +4. */
  chords: number[];
  /** Chance per half-beat of a melody note (0 for none). */
  melDensity: number;
  /** Chance per beat of a pluck. */
  pluckDensity: number;
  pad: boolean;
  drone: boolean;
  bassOstinato: boolean;
  perc: boolean;
  voices: Partial<Record<VoiceKind, VoiceDef>>;
  /** A sting plays one bar, then the engine falls back to the calm menu mood. */
  once?: boolean;
}

const PENT_MAJOR = [0, 2, 4, 7, 9];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];

export const MOODS: Record<Mood, MoodDef> = {
  // Warm and unhurried: C major pentatonic, slow pads, sparse bell-like melody.
  menu: {
    root: 48, scale: PENT_MAJOR, bpm: 66, beatsPerBar: 4, chords: [0, 3, 1, 4],
    melDensity: 0.14, pluckDensity: 0, pad: true, drone: false, bassOstinato: false, perc: false,
    voices: {
      pad: { type: "triangle", cutoff: 900, attack: 1.2, release: 1.6, gain: 0.5 },
      mel: { type: "sine", cutoff: 3000, attack: 0.02, release: 1.4, gain: 0.55 },
      bass: { type: "sine", cutoff: 400, attack: 0.1, release: 0.8, gain: 0.5 },
    },
  },
  // Light and curious: D lydian, a little quicker, plucky melody.
  surface: {
    root: 50, scale: LYDIAN, bpm: 84, beatsPerBar: 4, chords: [0, 4, 3, 1],
    melDensity: 0.22, pluckDensity: 0.2, pad: true, drone: false, bassOstinato: false, perc: false,
    voices: {
      pad: { type: "triangle", cutoff: 1100, attack: 0.9, release: 1.2, gain: 0.4 },
      mel: { type: "triangle", cutoff: 3200, attack: 0.01, release: 0.9, gain: 0.5 },
      pluck: { type: "triangle", cutoff: 2600, attack: 0.005, release: 0.5, gain: 0.45 },
      bass: { type: "sine", cutoff: 400, attack: 0.05, release: 0.6, gain: 0.5 },
    },
  },
  // Darker and sparse: E dorian, low drone, occasional plucks, no pad.
  caves: {
    root: 40, scale: DORIAN, bpm: 56, beatsPerBar: 4, chords: [0, 0, 5, 3],
    melDensity: 0, pluckDensity: 0.18, pad: false, drone: true, bassOstinato: false, perc: false,
    voices: {
      drone: { type: "sawtooth", cutoff: 260, attack: 2.0, release: 2.4, gain: 0.35 },
      pluck: { type: "sine", cutoff: 1800, attack: 0.005, release: 1.6, gain: 0.55 },
      bass: { type: "sine", cutoff: 300, attack: 0.3, release: 1.2, gain: 0.45 },
    },
  },
  // Tense: A minor, a slow heartbeat pulse in the bass, thin pad.
  deep: {
    root: 33, scale: MINOR, bpm: 62, beatsPerBar: 4, chords: [0, 5, 0, 6],
    melDensity: 0.05, pluckDensity: 0.08, pad: true, drone: true, bassOstinato: false, perc: true,
    voices: {
      pad: { type: "sawtooth", cutoff: 500, attack: 1.5, release: 2.0, gain: 0.22 },
      drone: { type: "sawtooth", cutoff: 200, attack: 2.0, release: 2.4, gain: 0.3 },
      pluck: { type: "square", cutoff: 1200, attack: 0.005, release: 1.0, gain: 0.25 },
      mel: { type: "triangle", cutoff: 1800, attack: 0.05, release: 1.4, gain: 0.35 },
      bass: { type: "sine", cutoff: 200, attack: 0.01, release: 0.5, gain: 0.7 },
    },
  },
  // Driving: D minor, fast, eighth-note bass ostinato and a noise hit on the beat.
  boss: {
    root: 38, scale: MINOR, bpm: 138, beatsPerBar: 4, chords: [0, 0, 5, 6],
    melDensity: 0.25, pluckDensity: 0, pad: false, drone: false, bassOstinato: true, perc: true,
    voices: {
      mel: { type: "sawtooth", cutoff: 1800, attack: 0.01, release: 0.25, gain: 0.3 },
      bass: { type: "sawtooth", cutoff: 500, attack: 0.005, release: 0.12, gain: 0.5 },
      pad: { type: "square", cutoff: 700, attack: 0.1, release: 0.4, gain: 0.18 },
    },
  },
  // Stings: one bar, then a fall back to calm.
  victory: {
    root: 60, scale: PENT_MAJOR, bpm: 96, beatsPerBar: 4, chords: [0],
    melDensity: 0, pluckDensity: 0, pad: true, drone: false, bassOstinato: false, perc: false, once: true,
    voices: {
      pad: { type: "triangle", cutoff: 2200, attack: 0.05, release: 1.8, gain: 0.5 },
      mel: { type: "triangle", cutoff: 3500, attack: 0.01, release: 1.2, gain: 0.55 },
    },
  },
  defeat: {
    root: 45, scale: MINOR, bpm: 50, beatsPerBar: 4, chords: [0],
    melDensity: 0, pluckDensity: 0, pad: true, drone: false, bassOstinato: false, perc: false, once: true,
    voices: {
      pad: { type: "sawtooth", cutoff: 500, attack: 0.3, release: 2.5, gain: 0.3 },
      mel: { type: "sine", cutoff: 1500, attack: 0.02, release: 2.0, gain: 0.5 },
    },
  },
};

export const MAX_MUSIC_VOICES = 8;

/** Pitch of scale degree `deg` (may exceed the scale length: wraps up an octave each time). */
export function degreeToMidi(m: MoodDef, deg: number): number {
  const n = m.scale.length;
  const oct = Math.floor(deg / n);
  return m.root + oct * 12 + m.scale[((deg % n) + n) % n];
}

/** Tiny seeded xorshift32 for cosmetic randomness; never the sim's RNG. Returns a 0..1 generator. */
export function makeRng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Number of notes overlapping at the busiest moment (for the voice cap). */
export function maxOverlap(notes: Note[]): number {
  let best = 0;
  for (const a of notes) {
    let n = 0;
    for (const b of notes) if (b.t <= a.t && b.t + b.dur > a.t) n++;
    best = Math.max(best, n);
  }
  return best;
}

/** Plan one bar: notes sorted by start time, at most MAX_MUSIC_VOICES sounding at once. Pure given the rng. */
export function planBar(mood: Mood, barIndex: number, rng: () => number): Note[] {
  const m = MOODS[mood];
  const chord = m.chords[barIndex % m.chords.length];
  const bars = m.beatsPerBar;
  const out: Note[] = [];
  const add = (voice: VoiceKind, midi: number, t: number, dur: number, vel: number) => {
    if (m.voices[voice] || voice === "perc") out.push({ voice, midi, t, dur: Math.min(dur, bars - t + 2), vel });
  };
  if (m.pad) for (const off of [0, 2, 4]) add("pad", degreeToMidi(m, chord + off + 5), 0, bars + 0.5, 0.7);
  if (m.drone) add("drone", degreeToMidi(m, chord), 0, bars + 1, 0.8);
  if (mood === "victory") {
    [0, 2, 4, 5, 7].forEach((d, i) => add("mel", degreeToMidi(m, d + 5), i * 0.5, 2, 0.8));
  } else if (mood === "defeat") {
    [4, 3, 1, 0].forEach((d, i) => add("mel", degreeToMidi(m, d + 5), i * 1, 2.5, 0.7));
  }
  if (m.bassOstinato) {
    for (let i = 0; i < bars * 2; i++) add("bass", degreeToMidi(m, chord + (i % 4 === 3 ? 2 : 0)) , i * 0.5, 0.45, i % 2 ? 0.55 : 0.85);
  } else if (m.perc) {
    // A slow pulse: bass thump on beats 1 and 3 (deep) or every beat (boss, with noise).
    for (let b = 0; b < bars; b += mood === "boss" ? 1 : 2) add("bass", degreeToMidi(m, chord), b, 0.6, 0.9);
  } else {
    add("bass", degreeToMidi(m, chord), 0, bars, 0.7);
  }
  if (m.perc) for (let b = 0; b < bars; b += 1) if (mood === "boss" || b % 2 === 0) add("perc", 0, b, 0.12, b === 0 ? 1 : 0.6);
  if (m.melDensity > 0 && mood !== "victory" && mood !== "defeat") {
    for (let h = 0; h < bars * 2; h++) {
      if (rng() < m.melDensity) {
        const d = chord + [0, 1, 2, 4, 5][Math.floor(rng() * 5)] + 5;
        add("mel", degreeToMidi(m, d), h * 0.5, mood === "boss" ? 0.5 : 1.5, 0.5 + rng() * 0.4);
      }
    }
  }
  if (m.pluckDensity > 0) {
    for (let b = 0; b < bars; b++) {
      if (rng() < m.pluckDensity) add("pluck", degreeToMidi(m, chord + [0, 2, 4, 7][Math.floor(rng() * 4)] + 5), b + (rng() < 0.5 ? 0 : 0.5), 1, 0.5 + rng() * 0.4);
    }
  }
  out.sort((a, b) => a.t - b.t);
  // Enforce the cap: drop the latest-starting non-pad notes that would exceed it.
  while (maxOverlap(out) > MAX_MUSIC_VOICES) {
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].voice === "mel" || out[i].voice === "pluck") { idx = i; break; }
    if (idx < 0) break;
    out.splice(idx, 1);
  }
  return out;
}

// ---- Mood selection (pure) ----

export interface MoodInput {
  /** Camera centre y in cells. */
  y: number;
  bossAlive: boolean;
  /** Sandbox world: always the gentle surface mood. */
  sandbox: boolean;
  /** Round outcome once known (a one-shot sting); null while playing. */
  round: "win" | "lose" | null;
}

export interface MoodState {
  mood: Mood;
  candidate: Mood;
  /** When the candidate depth mood was first wanted (ms), or null. */
  since: number | null;
  sting: boolean;
}

export const DEPTH_HOLD_MS = 3000;
export const initialMoodState = (): MoodState => ({ mood: "surface", candidate: "surface", since: null, sting: false });

function depthMood(y: number): Mood {
  return y >= DEEP_TOP ? "deep" : y >= SHALLOW_TOP ? "caves" : "surface";
}

/** One step of mood selection. Boss and round stings are immediate; a depth change needs DEPTH_HOLD_MS in the new band. */
export function stepMood(s: MoodState, inp: MoodInput, nowMs: number): MoodState {
  if (s.sting) return s; // the round is over; stay with the sting's calm afterwards
  if (inp.round) return { mood: inp.round === "win" ? "victory" : "defeat", candidate: s.candidate, since: null, sting: true };
  if (inp.bossAlive) return { ...s, mood: "boss", candidate: "boss", since: null };
  const want = inp.sandbox ? "surface" : depthMood(inp.y);
  if (want === s.mood) return { ...s, candidate: want, since: null };
  if (want !== s.candidate || s.since === null) return { ...s, candidate: want, since: nowMs };
  if (nowMs - s.since >= DEPTH_HOLD_MS) return { ...s, mood: want, since: null };
  return s;
}

// ---- Engine ----

const MUSIC_GAIN = 0.2;
const FADE = 2;
const LOOKAHEAD = 0.1;
const TICK_MS = 25;

let muted = store.get(MUSIC_KEY) === "off";
let wanted: Mood | null = null;
let running = false;
let master: GainNode | null = null;
let bus: GainNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let queue: { time: number; note: Note; mood: Mood; bus: GainNode; sec: number }[] = [];
let nextBarTime = 0;
let barIndex = 0;
let engineMood: Mood | null = null;
let stingPlanned = false;
/** The sting that has played its bar (the room keeps asking for it every players message). */
let stingDone: Mood | null = null;
let live = 0;
let scheduled = 0;
let rng = makeRng(0x9e3779b1);

export const isMusicMuted = () => muted;
export function setMusicMuted(m: boolean) {
  muted = m;
  store.set(MUSIC_KEY, m ? "off" : "on");
  if (master) master.gain.setTargetAtTime(m ? 0 : MUSIC_GAIN, master.context.currentTime, 0.15);
}

const debug = () => {
  (window as unknown as { __music: unknown }).__music = { mood: engineMood, live, scheduled, muted, queued: queue.length, running };
};

/** Start the engine (call after a user gesture). Safe to call repeatedly. */
export function startMusic() {
  if (running) return;
  const a = getAudio();
  if (!a) return;
  running = true;
  master = a.ctx.createGain();
  master.gain.value = muted ? 0 : MUSIC_GAIN;
  master.connect(a.destination);
  timer = setInterval(tick, TICK_MS);
  if (wanted) switchMood(wanted);
  debug();
}

export function stopMusic() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  queue = [];
  bus?.disconnect();
  master?.disconnect();
  bus = master = null;
  engineMood = null;
  debug();
}

/** Which mood a request should switch the engine to, or null to keep playing what it plays. */
export function moodToSwitch(mood: Mood, engine: Mood | null, stingDone: Mood | null): Mood | null {
  // A sting plays once: after its bar the engine falls back to "menu", and the room's repeated request must not restart it.
  if (mood === stingDone) return null;
  return mood !== engine ? mood : null;
}

/** Ask for a mood; takes effect now if the engine runs, else when it starts. */
export function setMood(mood: Mood) {
  if (mood === stingDone) return; // keep the calm fallback, also across a music off/on (startMusic plays `wanted`)
  wanted = mood;
  const next = moodToSwitch(mood, engineMood, stingDone);
  if (running && next) switchMood(next);
}

function switchMood(mood: Mood) {
  const a = getAudio();
  if (!a || !master) return;
  const now = a.ctx.currentTime;
  if (bus) {
    const old = bus;
    old.gain.cancelScheduledValues(now);
    old.gain.setValueAtTime(old.gain.value, now);
    old.gain.linearRampToValueAtTime(0, now + FADE);
    setTimeout(() => old.disconnect(), (FADE + 0.3) * 1000);
  }
  bus = a.ctx.createGain();
  bus.gain.setValueAtTime(0, now);
  bus.gain.linearRampToValueAtTime(1, now + FADE);
  bus.connect(master);
  queue = [];
  engineMood = mood;
  barIndex = 0;
  stingPlanned = false;
  nextBarTime = now + 0.05;
  debug();
}

function tick() {
  const a = getAudio();
  if (!a || !running || a.ctx.state !== "running" || !engineMood || !bus) return;
  const horizon = a.ctx.currentTime + LOOKAHEAD;
  while (!stingPlanned && nextBarTime < horizon + 0.5 && queue.length < 64) {
    const def = MOODS[engineMood];
    const sec = 60 / def.bpm;
    for (const note of planBar(engineMood, barIndex, rng)) queue.push({ time: nextBarTime + note.t * sec, note, mood: engineMood, bus, sec });
    nextBarTime += def.beatsPerBar * sec;
    barIndex++;
    if (def.once) {
      // After the sting's bar, fall back to calm; its notes still ring out on their own bus.
      stingPlanned = true;
      const me = engineMood;
      setTimeout(() => { if (engineMood === me) { wanted = "menu"; stingDone = me; switchMood("menu"); } }, Math.max(0, (nextBarTime - a.ctx.currentTime) * 1000));
      break;
    }
  }
  while (queue.length && queue[0].time < horizon) {
    const q = queue.shift()!;
    if (q.time >= a.ctx.currentTime - 0.05 && live < MAX_MUSIC_VOICES) playNote(a.ctx, q.note, Math.max(q.time, a.ctx.currentTime), q.mood, q.bus, q.sec, a.noise);
  }
  queue.sort((x, y) => x.time - y.time);
  debug();
}

function playNote(c: AudioContext, n: Note, t: number, mood: Mood, dest: AudioNode, sec: number, noiseBuf: AudioBuffer | null) {
  const nodes: AudioNode[] = [];
  const end = (stopAt: number) => {
    live++;
    scheduled++;
    setTimeout(() => {
      live--;
      for (const x of nodes) x.disconnect();
    }, Math.max(0, (stopAt - c.currentTime) * 1000) + 100);
  };
  if (n.voice === "perc") {
    if (!noiseBuf) return;
    const src = c.createBufferSource();
    const f = c.createBiquadFilter();
    const g = c.createGain();
    src.buffer = noiseBuf;
    f.type = "lowpass";
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 0.14);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * n.vel, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    src.connect(f).connect(g).connect(dest);
    src.start(t, 0);
    src.stop(t + 0.17);
    nodes.push(src, f, g);
    end(t + 0.17);
    return;
  }
  const v = MOODS[mood].voices[n.voice];
  if (!v) return;
  const len = Math.max(0.05, n.dur * sec);
  const peak = Math.max(0.0002, v.gain * n.vel);
  const g = c.createGain();
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = v.cutoff;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + Math.min(v.attack, len));
  g.gain.setValueAtTime(peak, t + Math.max(v.attack, len));
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(v.attack, len) + v.release);
  const stop = t + Math.max(v.attack, len) + v.release + 0.05;
  const freq = 440 * Math.pow(2, (n.midi - 69) / 12);
  // Pads and drones get a second, slightly detuned oscillator for warmth; it counts as one voice.
  const detunes = n.voice === "pad" || n.voice === "drone" ? [-6, 6] : [0];
  for (const d of detunes) {
    const osc = c.createOscillator();
    osc.type = v.type;
    osc.frequency.value = freq;
    osc.detune.value = d;
    osc.connect(f);
    osc.start(t);
    osc.stop(stop);
    nodes.push(osc);
  }
  f.connect(g).connect(dest);
  nodes.push(f, g);
  end(stop);
}

/** A "Music on/off" button. `cls` is the existing button class to reuse; it is returned for the caller to insert. */
export function makeMusicButton(cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = "musicBtn";
  b.className = cls;
  const show = () => {
    const label = muted ? "Music off, click to turn on" : "Music on, click to turn off";
    // A note, with a slash through it when off. Inline SVG, no image files.
    b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 12V3l7-1.5V10"/><circle cx="4.5" cy="12" r="1.7"/><circle cx="11.5" cy="10" r="1.7"/>${muted ? '<path d="M2 2l12 12"/>' : ""}</svg>Music`;
    b.setAttribute("aria-pressed", String(muted));
    b.setAttribute("aria-label", label);
    b.title = label;
  };
  show();
  b.onclick = () => {
    startMusic();
    setMusicMuted(!muted);
    show();
  };
  return b;
}

/** Start music from the first pointer or key gesture (after sfx.ts has unlocked the context). */
export function startMusicOnGesture(unlock: () => void) {
  const go = () => {
    unlock();
    startMusic();
    if (running) for (const ev of ["pointerdown", "keydown"] as const) removeEventListener(ev, go, true);
  };
  for (const ev of ["pointerdown", "keydown"] as const) addEventListener(ev, go, { capture: true });
}

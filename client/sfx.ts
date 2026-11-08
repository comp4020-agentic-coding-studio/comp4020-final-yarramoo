// Synthesized sound effects (WebAudio, no files). Main thread only: an AudioContext does not exist in a Worker,
// so the worker posts `{type:"sfx"}` messages and room.ts hands them to `play`. Render-only: nothing here reads
// or writes sim state (invariants 1 and 9). Volume and pan arrive already worked out from the camera distance.
import { store } from "./storage.ts";

export const MUTE_KEY = "sand.muted";

/** Sound names the worker may ask for. */
export type SfxName =
  | "push" | "blast" | "water" | "rose" | "fire" | "bomb" | "dig" | "flask" | "wall" | "hole"
  | "reject" | "impact" | "explode" | "knock" | "death" | "respawn" | "pickup" | "bag" | "heal" | "squelch" | "splat"
  | "crackle" | "screech" | "hiss" | "rumble" | "crunch" | "roar" | "bossdeath" | "descend" | "sizzle"
  | "burn" | "corrode" | "powderhit" | "blasthit" | "bolthit" | "hurt"
  | "slimehit" | "imphit" | "acidhit" | "wormbite" | "magehit" | "wisphit" | "frosthit" | "colossushit"
  | "acidflask" | "lavaflask" | "freeze" | "quake" | "mudslide";

/** At most this many voices sound at once; extra ones are dropped (16 explosions in a frame must not clip). */
const MAX_VOICES = 10;
const MASTER_GAIN = 0.5;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let voices = 0;
/** Dev instrumentation (read-only): requests per sound name, and the last and peak ambient water level. */
const counts: Record<string, number> = {};
let waterLast = 0;
let waterPeak = 0;
export const sfxCounts = () => ({ counts: { ...counts }, water: waterLast, waterPeak });

let muted = store.get(MUTE_KEY) === "1";

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  store.set(MUTE_KEY, m ? "1" : "0");
  if (master) master.gain.value = m ? 0 : MASTER_GAIN;
}

/** Create the context (lazily) and resume it; call from a user gesture. Safe to call repeatedly. */
export function unlock() {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_GAIN;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let s = 1; // cosmetic xorshift, never the sim's RNG
      for (let i = 0; i < d.length; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
      }
    }
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    // no audio on this device
  }
}

/** The shared context for music.ts: null until the first gesture. Music connects to `destination` directly, so
 * the sound-effects mute (which acts on `master`) does not silence it. */
export const getAudio = () => (ctx ? { ctx, destination: ctx.destination, noise: noiseBuf } : null);

/** Test hook: the context state, or null before the first gesture. */
export const audioState = (): string | null => ctx?.state ?? null;

interface Out {
  c: AudioContext;
  dest: AudioNode;
  t: number;
  vol: number;
}

function tone(o: Out, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0) {
  const osc = o.c.createOscillator();
  const g = o.c.createGain();
  const t = o.t + delay;
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain * o.vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(o.dest);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(o: Out, dur: number, gain: number, f0: number, f1: number, q = 1, kind: BiquadFilterType = "bandpass", delay = 0) {
  if (!noiseBuf) return;
  const src = o.c.createBufferSource();
  src.buffer = noiseBuf;
  const fl = o.c.createBiquadFilter();
  const g = o.c.createGain();
  const t = o.t + delay;
  fl.type = kind;
  fl.Q.value = q;
  fl.frequency.setValueAtTime(f0, t);
  fl.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain * o.vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(fl).connect(g).connect(o.dest);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

// Ambient water: ONE looping noise voice (not counted in MAX_VOICES), created on demand and stopped after a few s of silence.
let wSrc: AudioBufferSourceNode | null = null;
let wGain: GainNode | null = null;
let wPan: StereoPannerNode | null = null;
let wFilter: BiquadFilterNode | null = null;
let wLfo: OscillatorNode | null = null;
let wStopTimer: ReturnType<typeof setTimeout> | null = null;
const WATER_MAX_GAIN = 0.6;

function stopWater() {
  wStopTimer = null;
  try { wSrc?.stop(); wLfo?.stop(); } catch { /* already stopped */ }
  wSrc?.disconnect(); wLfo?.disconnect(); wFilter?.disconnect(); wGain?.disconnect(); wPan?.disconnect();
  wSrc = wGain = wPan = wFilter = wLfo = null;
}

/** Ease the ambient water voice to `level` 0..1, panned. Does nothing before the first gesture. */
export function setWater(level: number, pan: number) {
  waterLast = level;
  if (level > waterPeak) waterPeak = level;
  if (!ctx || !master || !noiseBuf) return;
  if (level <= 0) {
    if (wGain && ctx) {
      wGain.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
      if (!wStopTimer) wStopTimer = setTimeout(stopWater, 4000);
    }
    return;
  }
  if (wStopTimer) { clearTimeout(wStopTimer); wStopTimer = null; }
  if (!wSrc) {
    wSrc = ctx.createBufferSource();
    wSrc.buffer = noiseBuf;
    wSrc.loop = true;
    wFilter = ctx.createBiquadFilter();
    wFilter.type = "bandpass";
    wFilter.frequency.value = 900;
    wFilter.Q.value = 0.6;
    wLfo = ctx.createOscillator();
    wLfo.frequency.value = 0.35;
    const lg = ctx.createGain();
    lg.gain.value = 250; // slow wobble of the cutoff, +-250 Hz
    wLfo.connect(lg).connect(wFilter.frequency);
    wGain = ctx.createGain();
    wGain.gain.value = 0;
    wPan = ctx.createStereoPanner();
    wSrc.connect(wFilter).connect(wGain).connect(wPan).connect(master);
    wSrc.start(0, Math.random() * 0.5);
    wLfo.start();
  }
  const t = ctx.currentTime;
  wGain!.gain.setTargetAtTime(level * WATER_MAX_GAIN, t, 0.15);
  wPan!.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.15);
}

/** Play one sound. `vol` 0..1 and `pan` -1..1 come from the camera distance; `mag` 0..1 scales explosions. */
export function play(name: SfxName, vol: number, pan: number, mag = 0.5) {
  counts[name] = (counts[name] ?? 0) + 1; // dev instrumentation: every request, before mute and context checks
  if (muted || !ctx || !master || ctx.state !== "running" || vol < 0.02 || voices >= MAX_VOICES) return;
  const c = ctx;
  const p = c.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(master);
  const o: Out = { c, dest: p, t: c.currentTime + 0.005, vol };
  let dur = 0.4;
  switch (name) {
    case "push": noise(o, 0.25, 0.5, 400, 2200, 1.2); dur = 0.3; break;
    case "blast": tone(o, "sine", 150, 40, 0.3, 0.9); noise(o, 0.22, 0.6, 1800, 300, 0.8); dur = 0.35; break;
    case "dig": noise(o, 0.2, 0.7, 700, 250, 1.5, "lowpass"); noise(o, 0.12, 0.5, 2500, 900, 3, "bandpass", 0.03); tone(o, "square", 90, 55, 0.12, 0.25); dur = 0.3; break;
    case "flask": noise(o, 0.1, 0.6, 5000, 3000, 2, "highpass"); noise(o, 0.35, 0.35, 3500, 1500, 1.5, "bandpass", 0.08); tone(o, "sine", 700, 1100, 0.12, 0.2, 0.05); dur = 0.5; break;
    case "wall": tone(o, "square", 80, 45, 0.18, 0.35); noise(o, 0.15, 0.6, 600, 200, 1.5, "lowpass"); dur = 0.3; break;
    case "hole": tone(o, "sine", 70, 45, 0.5, 0.45); noise(o, 0.5, 0.25, 300, 120, 1, "lowpass"); dur = 0.6; break;
    case "water": noise(o, 0.3, 0.5, 900, 3000, 2, "bandpass"); tone(o, "sine", 500, 900, 0.12, 0.25); dur = 0.35; break;
    case "rose": tone(o, "sine", 880, 880, 0.35, 0.35); tone(o, "sine", 1320, 1320, 0.35, 0.25, 0.06); tone(o, "sine", 1760, 1760, 0.4, 0.15, 0.12); dur = 0.55; break;
    case "fire": noise(o, 0.35, 0.45, 3000, 800, 0.7, "highpass"); for (let i = 0; i < 4; i++) noise(o, 0.03, 0.5, 4000, 3000, 1, "bandpass", i * 0.07 + Math.random() * 0.03); dur = 0.45; break;
    case "bomb": noise(o, 0.5, 0.35, 5000, 6500, 3, "bandpass"); tone(o, "triangle", 260, 180, 0.2, 0.2); dur = 0.55; break;
    case "reject": tone(o, "square", 300, 220, 0.04, 0.12); dur = 0.08; break;
    case "impact": noise(o, 0.12, 0.5, 1200, 400, 1); tone(o, "sine", 220, 90, 0.1, 0.4); dur = 0.15; break;
    case "explode": {
      const m = Math.max(0, Math.min(1, mag));
      const len = 0.35 + 0.6 * m;
      tone(o, "sine", 90 - 40 * m, 28, len, 0.9);
      noise(o, len, 0.7, 1500 - 800 * m, 120, 0.6, "lowpass");
      dur = len + 0.05;
      break;
    }
    case "knock": tone(o, "sawtooth", 200, 70, 0.15, 0.4); noise(o, 0.1, 0.4, 900, 300, 1); dur = 0.2; break;
    case "death": tone(o, "sawtooth", 330, 55, 0.7, 0.4); noise(o, 0.5, 0.3, 800, 100, 0.8, "lowpass"); dur = 0.75; break;
    case "respawn": tone(o, "sine", 330, 330, 0.18, 0.3); tone(o, "sine", 495, 495, 0.18, 0.3, 0.1); tone(o, "sine", 660, 660, 0.3, 0.3, 0.2); dur = 0.55; break;
    case "squelch": tone(o, "sine", 260, 120, 0.12, 0.4); noise(o, 0.08, 0.25, 700, 250, 1); dur = 0.18; break;
    case "splat": tone(o, "sine", 200, 50, 0.3, 0.45); noise(o, 0.25, 0.4, 1200, 200, 0.9, "lowpass"); dur = 0.35; break;
    case "crackle": noise(o, 0.16, 0.35, 3200, 900, 1.2, "highpass"); tone(o, "sawtooth", 520, 780, 0.1, 0.25); dur = 0.22; break;
    case "roar": tone(o, "sawtooth", 110, 55, 0.9, 0.5); tone(o, "square", 82, 41, 0.9, 0.35); noise(o, 0.8, 0.4, 900, 150, 1, "lowpass"); dur = 1; break;
    case "bossdeath": tone(o, "sawtooth", 220, 30, 1.8, 0.55); tone(o, "sine", 60, 25, 1.8, 0.6); noise(o, 1.6, 0.5, 2500, 100, 0.8, "lowpass"); noise(o, 0.5, 0.5, 4000, 1000, 2, "bandpass", 0.2); dur = 2; break;
    case "descend": tone(o, "sine", 110, 55, 0.9, 0.5); tone(o, "triangle", 330, 110, 0.7, 0.3); noise(o, 0.5, 0.25, 600, 120, 1, "lowpass"); dur = 1; break;
    case "screech": tone(o, "sawtooth", 1500, 500, 0.35, 0.35); tone(o, "square", 1100, 380, 0.3, 0.2); dur = 0.4; break;
    case "sizzle": noise(o, 0.28, 0.45, 6500, 3000, 1.2, "highpass"); noise(o, 0.2, 0.3, 1800, 700, 2, "bandpass", 0.02); tone(o, "sawtooth", 180, 90, 0.12, 0.15); dur = 0.32; break;
    case "hiss": noise(o, 0.3, 0.3, 5000, 2500, 1.5, "highpass"); dur = 0.34; break;
    case "rumble": tone(o, "sine", 55, 38, 0.4, 0.5); noise(o, 0.35, 0.35, 220, 90, 0.7, "lowpass"); dur = 0.45; break;
    case "crunch": noise(o, 0.12, 0.5, 1800, 400, 1.2, "lowpass"); noise(o, 0.2, 0.4, 900, 150, 0.9, "lowpass"); tone(o, "square", 130, 50, 0.18, 0.35); dur = 0.3; break;
    case "pickup": tone(o, "triangle", 660, 1320, 0.14, 0.35); dur = 0.2; break;
    case "heal": tone(o, "sine", 440, 440, 0.12, 0.3); tone(o, "sine", 660, 880, 0.22, 0.3, 0.09); dur = 0.35; break;
    case "burn": noise(o, 0.3, 0.4, 2500, 1200, 0.8, "highpass"); for (let i = 0; i < 5; i++) noise(o, 0.03, 0.45, 3500, 2500, 1, "bandpass", i * 0.05 + Math.random() * 0.03); tone(o, "sawtooth", 140, 100, 0.2, 0.15); dur = 0.35; break;
    case "corrode": noise(o, 0.35, 0.35, 7000, 4500, 1.5, "highpass"); for (let i = 0; i < 6; i++) tone(o, "sine", 1500 + Math.random() * 1500, 600, 0.04, 0.12, i * 0.05); dur = 0.4; break;
    case "powderhit": noise(o, 0.2, 0.7, 2500, 300, 0.8, "lowpass"); tone(o, "sawtooth", 180, 60, 0.15, 0.4); noise(o, 0.06, 0.5, 5000, 3000, 1, "highpass"); dur = 0.25; break;
    case "blasthit": tone(o, "sine", 110, 35, 0.45, 0.8); noise(o, 0.4, 0.6, 1400, 150, 0.7, "lowpass"); tone(o, "square", 200, 80, 0.1, 0.3); dur = 0.5; break;
    case "bolthit": tone(o, "sawtooth", 600, 150, 0.14, 0.4); noise(o, 0.16, 0.5, 4000, 1200, 1, "highpass"); dur = 0.2; break;
    case "hurt": tone(o, "triangle", 260, 130, 0.14, 0.45); noise(o, 0.08, 0.3, 1000, 400, 1); dur = 0.18; break;
    case "slimehit": tone(o, "sine", 160, 70, 0.2, 0.5); noise(o, 0.12, 0.3, 600, 200, 1.5, "lowpass"); tone(o, "sine", 300, 120, 0.08, 0.2, 0.05); dur = 0.25; break;
    case "imphit": tone(o, "square", 900, 500, 0.1, 0.25); tone(o, "sawtooth", 1300, 700, 0.12, 0.2, 0.05); noise(o, 0.08, 0.3, 3500, 1500, 1.5); dur = 0.2; break;
    case "acidhit": noise(o, 0.2, 0.4, 5500, 2500, 1.5, "highpass"); tone(o, "sine", 220, 90, 0.15, 0.4); noise(o, 0.12, 0.3, 900, 300, 2, "bandpass", 0.04); dur = 0.25; break;
    case "wormbite": noise(o, 0.1, 0.6, 1600, 500, 1.5, "bandpass"); tone(o, "square", 120, 60, 0.1, 0.35); noise(o, 0.1, 0.5, 2200, 800, 2, "bandpass", 0.09); tone(o, "square", 110, 55, 0.1, 0.3, 0.09); dur = 0.25; break;
    case "magehit": tone(o, "sine", 700, 300, 0.3, 0.3); tone(o, "sine", 705, 305, 0.3, 0.25); tone(o, "triangle", 350, 150, 0.25, 0.3); dur = 0.35; break;
    case "wisphit": noise(o, 0.25, 0.35, 5000, 1500, 1, "highpass"); tone(o, "sawtooth", 300, 200, 0.2, 0.25); tone(o, "sine", 90, 60, 0.2, 0.3); dur = 0.3; break;
    case "frosthit": tone(o, "sine", 2400, 1800, 0.2, 0.25); tone(o, "sine", 3100, 2200, 0.16, 0.2, 0.03); noise(o, 0.1, 0.35, 6500, 4500, 2, "highpass"); dur = 0.25; break;
    case "colossushit": tone(o, "sine", 65, 28, 0.5, 0.9); noise(o, 0.35, 0.7, 500, 90, 0.8, "lowpass"); noise(o, 0.1, 0.5, 1500, 600, 1.2, "bandpass"); dur = 0.55; break;
    case "acidflask": noise(o, 0.1, 0.6, 5000, 3000, 2, "highpass"); tone(o, "sine", 700, 1100, 0.1, 0.2, 0.04); noise(o, 0.45, 0.35, 7000, 4000, 1.5, "highpass", 0.1); for (let i = 0; i < 4; i++) tone(o, "sine", 1800 + i * 300, 700, 0.04, 0.1, 0.12 + i * 0.06); dur = 0.6; break;
    case "lavaflask": noise(o, 0.1, 0.6, 5000, 3000, 2, "highpass"); tone(o, "sine", 600, 900, 0.1, 0.2, 0.04); tone(o, "sine", 70, 45, 0.5, 0.5, 0.08); for (let i = 0; i < 4; i++) tone(o, "sine", 120 + i * 30, 70, 0.1, 0.3, 0.12 + i * 0.08); noise(o, 0.5, 0.25, 350, 120, 1, "lowpass", 0.1); dur = 0.65; break;
    case "freeze": tone(o, "sine", 1200, 3200, 0.5, 0.25); tone(o, "sine", 1800, 4200, 0.45, 0.18, 0.05); tone(o, "triangle", 2400, 5000, 0.35, 0.12, 0.1); noise(o, 0.5, 0.2, 5000, 8000, 3, "bandpass"); dur = 0.6; break;
    case "quake": tone(o, "sine", 48, 30, 1, 0.8); tone(o, "sine", 62, 34, 0.9, 0.5, 0.05); noise(o, 1, 0.5, 260, 60, 0.7, "lowpass"); noise(o, 0.2, 0.4, 700, 200, 1, "lowpass", 0.35); noise(o, 0.2, 0.4, 600, 150, 1, "lowpass", 0.65); dur = 1.1; break;
    case "mudslide": tone(o, "sine", 180, 70, 0.18, 0.5); tone(o, "sine", 120, 220, 0.15, 0.4, 0.15); tone(o, "sine", 250, 80, 0.2, 0.4, 0.3); noise(o, 0.5, 0.35, 500, 150, 2, "lowpass"); dur = 0.55; break;
    case "bag": tone(o, "triangle", 520, 520, 0.09, 0.35); tone(o, "triangle", 780, 780, 0.09, 0.35, 0.07); tone(o, "triangle", 1040, 1040, 0.16, 0.35, 0.14); dur = 0.35; break;
  }
  voices++;
  setTimeout(() => {
    voices--;
    p.disconnect();
  }, (dur + 0.1) * 1000);
}

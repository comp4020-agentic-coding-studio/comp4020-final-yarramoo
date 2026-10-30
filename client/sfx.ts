// Synthesized sound effects (WebAudio, no files). Main thread only: an AudioContext does not exist in a Worker,
// so the worker posts `{type:"sfx"}` messages and room.ts hands them to `play`. Render-only: nothing here reads
// or writes sim state (invariants 1 and 9). Volume and pan arrive already worked out from the camera distance.
import { store } from "./storage.ts";

export const MUTE_KEY = "sand.muted";

/** Sound names the worker may ask for. */
export type SfxName =
  | "push" | "blast" | "water" | "rose" | "fire" | "bomb" | "dig"
  | "reject" | "impact" | "explode" | "knock" | "death" | "respawn" | "pickup" | "bag";

/** At most this many voices sound at once; extra ones are dropped (16 explosions in a frame must not clip). */
const MAX_VOICES = 10;
const MASTER_GAIN = 0.5;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let voices = 0;
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

/** Play one sound. `vol` 0..1 and `pan` -1..1 come from the camera distance; `mag` 0..1 scales explosions. */
export function play(name: SfxName, vol: number, pan: number, mag = 0.5) {
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
    case "pickup": tone(o, "triangle", 660, 1320, 0.14, 0.35); dur = 0.2; break;
    case "bag": tone(o, "triangle", 520, 520, 0.09, 0.35); tone(o, "triangle", 780, 780, 0.09, 0.35, 0.07); tone(o, "triangle", 1040, 1040, 0.16, 0.35, 0.14); dur = 0.35; break;
  }
  voices++;
  setTimeout(() => {
    voices--;
    p.disconnect();
  }, (dur + 0.1) * 1000);
}

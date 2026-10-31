// Canonical input encoders (plan 6.11 "Byte layout", D-017). Little-endian, no padding.
// Pure and environment-free: runs in Node and in browsers.

export const KIND_JOIN = 1;
export const KIND_LEAVE = 2;
export const KIND_POS = 3;
export const KIND_CAST = 4;
export const KIND_PAINT = 5;

function make(len: number, kind: number, player: number): { b: Uint8Array; v: DataView } {
  const b = new Uint8Array(len);
  const v = new DataView(b.buffer);
  v.setUint8(0, kind);
  v.setUint32(1, player, true);
  return { b, v };
}

export function encodeJoin(player: number): Uint8Array {
  return make(5, KIND_JOIN, player).b;
}

export function encodeLeave(player: number): Uint8Array {
  return make(5, KIND_LEAVE, player).b;
}

/** x, y in 1/16-cell fixed point. */
export function encodePos(player: number, life: number, x: number, y: number, facing: number): Uint8Array {
  const { b, v } = make(16, KIND_POS, player);
  v.setUint16(5, life, true);
  v.setInt32(7, x, true);
  v.setInt32(11, y, true);
  v.setUint8(15, facing);
  return b;
}

export function encodeCast(player: number, spell: number, angle: number, castSeq: number): Uint8Array {
  const { b, v } = make(10, KIND_CAST, player);
  v.setUint8(5, spell);
  v.setUint16(6, angle, true);
  v.setUint16(8, castSeq, true);
  return b;
}

/** Bit 7 of the Paint input's `mat` byte: "fill empty only" (ids 0-20 sit below it, in the low 7 bits). Matches
 * `sim/src/input.rs`'s `FILL_EMPTY_BIT`. */
export const FILL_EMPTY_BIT = 0x80;

export function encodePaint(
  player: number,
  mat: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  fillEmpty = false,
): Uint8Array {
  const { b, v } = make(15, KIND_PAINT, player);
  v.setUint8(5, mat | (fillEmpty ? FILL_EMPTY_BIT : 0));
  v.setInt16(6, x0, true);
  v.setInt16(8, y0, true);
  v.setInt16(10, x1, true);
  v.setInt16(12, y1, true);
  v.setUint8(14, radius);
  return b;
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

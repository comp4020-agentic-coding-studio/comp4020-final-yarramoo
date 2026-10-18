// Pure helpers for the social overlays: who's online, the minimap strip and name-tag fade.
// Render-only and client-only: nothing here becomes a sim input (invariant 9, D-055).

export interface Who {
  id: number;
  name: string;
  me: boolean;
  dead: boolean;
}

/** You first, then the living, then the dead; each group by name (case-insensitive), ties by id. */
export function sortPlayers<T extends Who>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.me !== b.me) return a.me ? -1 : 1;
    if (a.dead !== b.dead) return a.dead ? 1 : -1;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id - b.id;
  });
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A world coordinate as a pixel offset along a strip `size` px long; clamped to the strip. */
export function worldToStrip(v: number, worldSize: number, size: number): number {
  if (worldSize <= 0) return 0;
  return clamp((v / worldSize) * size, 0, size);
}

/** The camera's view as a bracket on the strip: left offset and width in px (at least `minW`, kept inside). */
export function viewBracket(camX: number, viewW: number, worldW: number, size: number, minW = 6): { left: number; width: number } {
  const width = Math.min(size, Math.max(minW, (viewW / worldW) * size));
  const left = clamp((camX / worldW) * size, 0, size - width);
  return { left, width };
}

/** A click on the strip as the camera's top-left cell, centring the view there, clamped to the world. */
export function stripToCamera(px: number, size: number, worldSize: number, viewSize: number): number {
  const c = (clamp(px, 0, size) / size) * worldSize;
  return clamp(c - viewSize / 2, 0, Math.max(0, worldSize - viewSize));
}

/** Label opacity by distance from the view centre: 1 within `near`, `min` beyond `far`, linear between. */
export function fadeAlpha(dist: number, near: number, far: number, min = 0.15): number {
  if (dist <= near) return 1;
  if (dist >= far) return min;
  return 1 - ((dist - near) / (far - near)) * (1 - min);
}

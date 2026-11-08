// Skies: every room's sky is picked from its seed, so everyone in a room sees the same one and rooms differ.
// Render-only (invariants 1 and 9): nothing here touches the sim, and the sim never reads it back.
export const SKY_KINDS = ["night", "day", "dawn", "rain", "aurora"] as const;
export type SkyName = (typeof SKY_KINDS)[number];

/** Pure: the same seed always gives the same sky index (into SKY_KINDS). A 64-bit mix so that consecutive seeds differ. */
export function skyForSeed(seed: bigint): number {
  let x = BigInt.asUintN(64, seed) ^ 0x9e3779b97f4a7c15n;
  x = BigInt.asUintN(64, (x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n);
  x = BigInt.asUintN(64, (x ^ (x >> 27n)) * 0x94d049bb133111ebn);
  x ^= x >> 31n;
  return Number(x % BigInt(SKY_KINDS.length));
}

/** Dev override (`?sky=rain`), or the seed's sky. Anything unrecognised falls back to the seed. */
export function resolveSky(seed: bigint, override?: string | null): number {
  const i = override ? SKY_KINDS.indexOf(override as SkyName) : -1;
  return i >= 0 ? i : skyForSeed(seed);
}

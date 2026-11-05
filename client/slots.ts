// Hotbar slot order (display only; a cast still sends the real spell id). A spell gets a slot the first time the
// local player holds a charge of it (infinite starters at once), in the order first held, for the rest of the session.

/** Append every spell in `bar` order that has charges and no slot yet. Returns the same array if nothing changed. */
export function addPickedUp(order: number[], charges: readonly number[], bar: readonly number[]): number[] {
  let out = order;
  for (const s of bar) {
    if ((charges[s] ?? 0) > 0 && !out.includes(s)) out = [...out, s];
  }
  return out;
}

/** Swap two slots; out-of-range or equal indexes leave the order alone. */
export function swapSlots(order: number[], i: number, j: number): number[] {
  if (i === j || i < 0 || j < 0 || i >= order.length || j >= order.length) return order;
  const out = [...order];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

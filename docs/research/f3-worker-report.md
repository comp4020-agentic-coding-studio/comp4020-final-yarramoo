# F3 worker report: new spells

Six spells landed except Teleport (skipped). Nothing pushed. Tool budget ran out before the browser look.

## Commits
1. `0a5b5a6` scaffolding: NUM_SPELLS 12, arrays, `BAG_SPELL_IDS`, snapshot v6, names/table/BAR, inputgen. Red first: the bag round-trip test failed with a duplicated id table.
2. `7530f28` Acid/Oil/Lava flasks (shared `burst`, lava fills downwards first) and Wall. Red first: lava burst removed, Wall's player check removed, Wall's material filter widened; each failed its test.
3. `6e69d6a` Black Hole, D7 test (`d7_black_hole_boring_through_a_sleeping_region_is_invisible`), snapshot round trip, cap test. Red first: dig removed, pull removed, cap raised, lifetime raised; each failed a test.
4. `dde8920` pickup tables by band; tests; determinism expectations updated (see below).
5. Client commit (hash in the run summary): Q/E cycling, wrapping bar, fx, sfx, no Wall ghost.

Gates: cargo test, clippy wasm, typecheck, `pnpm test:determinism` (41) green on commits 1-4. `pnpm test:net` ran at the client commit: 308 passed, 1 failed (`claims-live`, fixed, rerun 3x green, see below). The full net suite was not rerun after that test edit.

## Bounded-work numbers
Wall at most 36 cells. Flasks at most 50/70/60 cells (clamped to 70 inside `burst`). Black Hole dig at most 7x7 = 49 cells per hole per tick, 2 holes per player; the pull is one loop over players. Test `every_spell_cast_at_its_caps...` bounds total cells changed (counts cells, not time).

## Determinism and test expectations that moved (not weakened)
- The new table changes which spots hold Fire/Bomb, so the M5 script plays out differently (bot 3 dies at tick 10, bot 1 at 70). `m5-state.test.ts` cuts and the death/bag assertion were re-pointed at the new timeline (the check is now "some tick has a dead player and a bag", and bombs in flight at tick 72). `entities.test.ts` accepts every spell in the tables.
- `claims-live.test.ts`: the first Bomb spot moved; Ana now dies a moment later in fire (cause 32). The "counted once" assertion now filters to Bo's death.

## Not done / unverified
- Teleport (id 12) skipped: no budget to do the Pos analysis. `maxPosJump` allows only about (3+6)*(dt+10)/16-cell-scale steps; a bolt teleport longer than that would need either a server-visible hint or a loosened limit. `NUM_SPELLS` is 12, so adding it later means one more slot and a v7 snapshot.
- Browser look and screenshots (`docs/art/shots/f3-*.png`) NOT done. The dev route's `__devGoto(spell)` already walks to pickups of any spell, so no grant hook was added (it would need a sim ABI change). Fx, sounds, the Black Hole swirl and the bar wrap are unseen in a real browser.
- No second-browser check.
- Black Hole is not confirmed to stay inside the active region: it digs wherever it flies, and `Grid::set` wakes the chunks it changes; D7 test passes with a sleeping region, but a hole outside every player's active rect is only as safe as ordinary projectiles (they also step everywhere). Reviewer should check.

## Architectural decisions for review
- Bag: `BAG_SPELL_IDS` table (9 finite spells), BAG_BYTES 26. Alternative: carry all 12 slots. Cost: adding a finite spell edits the table; a test pins it to `START_CHARGES`.
- Bar selection: keys 1-9 for the first nine, Q/E cycle the whole bar. Not `-`/`=` (zoom) and not the wheel (zoom). Cost: Q/E are unavailable for future bindings; slots 10-12 show no key hint.
- Pickup weights: shallow all 2; deep Fire/Bomb/Lava 2, Black Hole 1. Table is `PICKUP_TABLE` in `tuning.rs`, rolled with `SALT_PICKUP_SPELL`. Costs: it reshuffled spot spells for every seed and moved determinism script timelines.
- Black Hole pull: emits `EV_KNOCK` with c=0 (no hitter credit) of `BH_PULL` 12 (1/16 cell per tick), the same path Push/Blast use. Alternative: credit the caster. Chose no credit so a pulled player's death is not a kill.
- Black Hole as a projectile: `step_black_hole` runs before the DDA, so it ignores terrain; `Grid::dig` with a zero-length segment is the disc dig. Does not use bomb cap. Per-owner cap 2 via the REJECT_FULL path.
- Wall: instant like Dig (no projectile), skips every alive hitbox, writes only Empty/gas/liquid. New `is_liquid` in `materials.rs`.
- Teleport: see above; skipped.
- Flask `burst` is shared with water; lava passes `down=true`.

## FUTURE.md ideas (suggested)
- A dev-only grant-charges ABI call for screenshots and tests.
- Show a key hint for slots 10-12 and a Q/E label on the bar.

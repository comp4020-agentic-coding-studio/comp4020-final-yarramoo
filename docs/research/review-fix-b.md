# Review of 807ca0f..f83c21e (island_anchor, set_unseeded, Pebbles, Seed sprinkle)

Read cold, no builds or tests run. Verdict: no must-fix.

## should-fix
1. tuning.rs (~line 286-291): the new `PAINT_SEED_ONE_IN` doc block was inserted between the existing doc comment
   ("Removed solid cells recorded per tick ... total flood cell visits per tick") and `MAX_ISLAND_REMOVED`/`ISLAND_MAX`/
   `ISLAND_WORK_MAX`. The old text now attaches to the Seed constant and the three island constants lose their doc.
   Move the new block above or below. Confidence: high. Cosmetic, no behaviour change.

## notes
2. grid.rs crumble_islands, island_anchor logic: correct as far as I can trace.
   - Every cell given an anchor stamp was first given a flood stamp, so the seed-skip test (`island_stamp==stamp`)
     never skips a cell that is neither anchored nor already crumbled. A stamped free island is fully popped, so all its
     cells crumble. An anchored flood's popped cells and still-stacked cells are all marked. Cells not yet stamped
     when it ended are simply re-flooded and hit the anchor check. No misjudgement of a free island as anchored
     from stamp order.
   - The inner `break` on Bedrock or on an anchor join only leaves the neighbour loop, not the `while`, so the flood
     keeps running to its limit. All stamped cells therefore end up in `island_cells`, which is why marking works.
     Cost: the anchor join gives no work saving. Cheap optimisation: `break` the while once anchored (then the stack
     marking loop becomes essential, and it is already there). Not needed for correctness. Confidence: high.
   - Budget and cap: a flood ended by `limit` (ISLAND_MAX or the remaining ISLAND_WORK_MAX) is called anchored and its
     cells marked anchored. That is conservative only (a free island of >= limit cells, or one met after the budget is
     nearly spent, stays as floating rock, and later seeds joining it are also called anchored). It can never crumble
     an anchored region. `break 'seeds` drops later seeds, so rock they would have freed floats until a later cut
     re-seeds it. Same as before the fix; deterministic. Confidence: high.
   - Wrap: on `island_tick` wrap both arrays are zeroed and the tick restarts at 1; correct. After snapshot restore or
     a fresh Grid both arrays and the tick are 0, so the first pass uses 1. Confidence: high.
   - Memory: one more u32 per cell (1 MiB at 512x512, more on caves worlds). Acceptable; mention in decisions.
3. Pebbles coverage (materials.rs, grid.rs, names.ts, client): handled everywhere I could find.
   - `material_class` defaults to solid (matches names.ts "solid", avatar can stand on it, as on Sand).
   - `is_structural` excludes it (so a pebble pile is never a flood island); `powder_ok` falls through the same way as Sand.
   - Dissolvable, explosion-clearable and spawn-ground lists include it.
   - Deliberately not glazed by lava: `SAND`-only at grid.rs ~712 and ~723. Lava beside pebbles also does not keep its
     chunk awake. Consistent, and wake-up is invisible by invariant 8 anyway. Confirm that "no glass from pebbles" is
     intended (it is a visible rule difference from Sand).
   - gen.rs lines ~437, 448, 625, 856, 1645 list SAND for generation-time checks; Pebbles never exist at gen time, so fine.
   - client palette t[21] is set; PALETTE_SIZE 32 is fine.
4. Test changes: falling_rock.rs, enemy_ai.rs (21 -> 22 classes) and avatar.test.ts only follow the id/Sand-to-Pebbles
   change. The paintable unit test drops STEM and FLOWER from the "paintable" loop on purpose and now also asserts
   `PEBBLES` and `PEBBLES+1` are not paintable, which is stricter than the old `COAL+1`. Nothing weakened beyond the brief.
   Side effect: old recordings that painted Stem or Flower now no-op (`paintable` check in sim.rs ~496); fine while not live.
5. Seed sprinkle determinism (sim.rs disc): `rng(self.seed, self.tick, x as u32, y as u32, SALT_PAINT_SEED)` uses
   non-negative i32 coordinates cast to u32 (clamped to the grid, so no sign issue), a fixed-width salt (256, unique),
   no usize and no state. `is_multiple_of` on u32 is integer only; needs Rust >= 1.89 (stable). It built, so fine.
   Draw depends on cell+tick, so overlapping stamps agree. Bounded work unchanged (skip inside the existing disc loop).
   The sprinkle also applies with `fill_empty`; check order is fine because the fill_empty skip runs first.
6. `set_unseeded` is only reached from paint when `is_structural(mat)`; painting structural over structural needs no
   seed. Painting a non-structural over rock still goes through `set` and seeds. Painted-wall islands can later be
   judged as islands when a neighbour is cut, which is the intended behaviour.

## Session model's resolution (3 Nov)

- Should-fix (misplaced doc comment in `tuning.rs`): **fixed**; the falling-rock comment is back on `MAX_ISLAND_REMOVED`.
- Lava not glazing Pebbles: **accepted as intended** (D-175).
- The optional work saving on an anchor join: not taken.
- Seen in a browser (dev Survival world, merged build): a painted rock disc floats; a small rock ring cut by a Sand stroke crumbles to grey Pebbles that fall and heap (`docs/art/shots/fix-b-pebbles-heap.png`). A large ring (about 1000 cells) stays, being over `ISLAND_MAX` = 400 (D-165's design).

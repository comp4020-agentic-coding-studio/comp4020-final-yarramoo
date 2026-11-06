# INT-3 report: x-spells onto multa

## Step 1-2: port (ids 25-28 materials, spells 12-14, format 16)
Cherry-picked acdc9cb, 6060b9c, ae5cdb6 (the last was empty after the second, skipped). Conflicts in client/materials.ts, client/worker.ts, shared/names.ts, sim/src/materials.rs, snapshot.rs, tuning.rs resolved by hand: Mud 25, Salt 26, Snow 27, Thermite 28; `isPaintable`/`paintable` extended (22-24 and 25-28); FORMAT_VERSION and `server/db.ts` SNAPSHOT_FORMAT_VERSION 16.
`sim/tests/e3_spells.rs` asserted ids 22-25 and `!paintable(26)`: updated (`!paintable(29)`).

## Step 3: the sleep divergence
**Cause: the test, not a material.** `new_spells_are_deterministic_and_sleep_invisible` writes cells straight into `grid.mat` and
only calls `mark_chunk` in `arena()`, before the write. With sleeping on, the chunks are quiet after the first step, so the
hand-written snow/water block is never run; sleeping off runs everything. Bisect (one material at a time over the same arena,
hash compared per tick): snow, mud, salt, thermite AND plain Sand all diverged at tick 0; with `mark_chunk` on every chunk after
the write, all six scenarios agreed for 600 ticks. Red then green for that one cause: the test was red as shipped and green after
marking after the write (11/11 e3 tests pass).
Because that proves nothing about the rules, I added `each_new_material_alone_sleeps_invisibly`: each material alone, painted by
Paint input (so writes go through `Grid::set`), across chunk boundaries, with its trigger (Fire, Lava, Water, Ice) arriving at
tick 300, sleep on vs off. It passes. Mutation check: removing Mud's "waiting for its turn" `vol_seen` makes it fail
("mud: sleeping changed the result"), so Mud's flag is load-bearing and tested. Removing Snow's `powder_can_move` flag or
Thermite's lit `vol_seen` did NOT fail this test: those flags are redundant in the scenarios I can build (a moving cell already
keeps its chunk awake the next tick); I left them in (harmless, conservative) and do not claim they are tested.

## Step 4: Thermite per-tick bound
`THERMITE_EAT_PER_TICK = 16` (tuning.rs), a scratch `thermite_budget` on `Grid` reset in `step_cells`; lit Thermite stops converting once it is spent (the cell stays lit, so its chunk stays awake and the rest wait). Test `lit_thermite_is_bounded_per_tick` (60x60 thermite mass in rock, all lit at once): without the cap it converted **84 cells in one tick (red)**, with it at most 16 (green), and the lava count per tick is identical with sleep on and off.

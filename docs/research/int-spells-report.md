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

## Step 5: pins
Full cargo run (/tmp/int3-cargo0.log, 16:06-16:19) was red in 8 binaries, all mechanical: format 15 to 16 (bags, heals, config_state, golden fixture renamed golden-v16.bin), BAG_BYTES 26 to 32 (12 spells), material count 25 to 29 (enemy_ai), "first unpaintable id" now THERMITE+1 (grid unit test, biome_materials). Pins that moved on purpose: golden `SCRIPTED_HASH` 14440853585275264011 to 7782343954484590231; `perf-trace.txt` regenerated (all scenario snapshots moved, as expected: the world snapshot format and header changed; the per-tick sleep-on/off equality assertion inside that test still held). No M5 cut was touched. After the fixes /tmp/int3-cargo1.log was red only in `bag_is_thirty_two_bytes...` (a literal byte layout, fixed). Generation does not use the new materials (generator untouched).

## Steps 6-7: client and look (vite :5193, `/game?world=game&avatar=1`, screenshots in `docs/research/int-spells-shots/`)
- `materials.png` (3x zoom): Mud (dark brown mound), Salt and Snow (white / pale cyan), Thermite (orange) painted by `__devPaint` 25-28, palette and names OK.
- `hotbar-1280.png`: six slots after picking up Freeze, Quake and Mudslide via `__devGoto(12/13/14)`; Mudslide shows as "Mud" (new `SHORT_NAMES` entry). Nothing overflows at 1280x800 with 6 slots; the bar can hold all 15 spells only by wrapping or clipping, not checked with 15 held (the game gives a few at a time).
- `hotbar-390.png` (390x844): **the bar overflows**: Mud is clipped at the right edge. This is not a new problem for 3 slots (Push, Blast, Dig, Freeze, Quake, Mud = 6 already clips at 390); mobile bar layout is a pre-existing limit made worse by more spells. Not fixed in this slice (see decisions).
- `cast-quake.png`: Quake cast at the rock ledge beside the avatar: a patch of the ledge turned to light pebbles (visible crumbled area left of the avatar's feet). Charges 4 to 3.
- `cast-mudslide.png`: Mudslide cast: two brown Mud blobs landing in the air, charges 6 to 4 (two casts, the second from an earlier aim test).
- **Freeze not seen working in the browser**: I cast it at a painted Water pool, but the bolt flew level and did not reach the pool (charges ran out: 8 to 0 over three casts) so no screenshot shows ice. Its effect is covered only by the sim test `freeze_turns_a_bounded_amount_of_water_to_ice` (passes). Honest gap.

## Gate
Run 1 (16:33-16:47, /tmp/int3-g-*.log): cargo, clippy, tsc green; determinism red on one test, `tests/determinism/entities.test.ts` pinning the pickup spell list to ids 2-11 (the new Freeze, Quake and Mudslide are now in the pickup table, so it correctly saw 12-14). Updated the list; that test alone then passed. Gate rerun from scratch below.

Run 2 (16:48-17:14, /tmp/int3-g-{cargo,clippy,tsc,det,net}.log): cargo, clippy, tsc, determinism (53/53) green; `test:net` red, 4 tests (log /tmp/int3-g-net.log): `avatar.test.ts` (class table 0-24), `entity-layout.test.ts` (hard-coded player record 102 and bag 26 bytes), `slots.test.ts` (`charges()` helper length 12), `stats.test.ts` (it used **25 as "an unknown id"**: the exact lesson from the last slices, 25 is now Mud; moved to 60). All four were tests pinning old sizes or ids, none a sim fault. Fixed, then those four files green (29 tests) and the whole `pnpm test:net` rerun green: **417 passed, 1 skipped** (/tmp/int3-g-net2.log, 17:17-17:23). The sim, clippy and determinism steps were not rerun after those test-only edits (no sim/ or shared/ file changed after the green run 2 steps); `pnpm typecheck` was rerun green (/tmp/int3-g-tsc2.log). Strictly the chain was not one unbroken run: the last full chain stopped at net.

## Architectural decisions for review
1. **Ids and format:** Mud 25, Salt 26, Snow 27, Thermite 28, spells 12-14, format 16. Alternative: reuse gaps (none). Cost: bag record is 32 bytes, three hard-coded mirrors in tests (entity-layout now derives them from NUM_SPELLS).
2. **Sleep fix is a test fix, not a sim fix.** No sim rule changed for invariant 8. Cost: the Snow `powder_can_move` flag and Thermite's lit `vol_seen` are untested by mutation (redundant in what I could build); if someone later removes them nothing fails. Alternative was deleting them; I kept the conservative flags.
3. **Thermite cap is a per-tick budget of 16** (a shared scratch counter on `Grid`, like the trails), first-come in scan order. Alternative: per-cell limit only (existing). Cost: scan order decides which lit cell eats first; deterministic, but a big mass burns slower. 16 is untuned.
4. **Mobile hotbar left as is** (overflows at 390 px; pre-existing). Alternative: wrap or scroll the bar; client-only, deferred.
5. **`SPELL_ENABLED` written out as 15 `true`s** because `tests/net/spells-table.test.ts` parses the literal list with a regex; `[true; NUM_SPELLS]` broke it. Alternative: teach the test to read the repeat form.
6. Freeze untested in the browser (see above).

## FUTURE.md ideas
- Mud, Salt, Snow, Thermite could appear in generation (mud pits, salt flats, snow at the top biome) once they are known to be sleep-safe.
- A hotbar that scrolls or wraps below ~480 px.
- A sim test helper `write_cells(grid, ...)` that always marks the chunks, so hand-written arenas cannot repeat this setup fault.

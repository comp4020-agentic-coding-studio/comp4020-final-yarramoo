# Review: row-major band scan (D-191)

Read-only review of the uncommitted `Grid::step_cells` change (`sim/src/grid.rs`), `sim/tests/wake.rs`, plan 6.2/6.5 and D-191. Nothing was built or run; all conclusions are from reading the code.

## Findings

1. **risk (pre-existing, made worse by the test edit), `sim/tests/wake.rs:~66-90` `a_seed_reached_by_water_across_the_edge_grows` does not test what its doc comment says.**
   - `world()` calls `set_active_around` and only then does the test `set` the dirt floor, water, pedestal and seed. Every `set` on a frozen chunk calls `touch` -> `wake` -> `woken = true`, so the seed's chunk (chunk 8, x 512..575) is woken from tick 0. `step_cells` never clears `woken` while some chunk is active.
   - A Seed is volatile (`vol_seen`), so the chunk keeps `awake` and therefore stays woken for the whole run. Water reaching it is never needed. The seed would grow with no water at all.
   - New with the edit: the seed (x = 530, y = 121) sits on a pedestal covering x 528..532, y 122..125. `update_seed`'s wet check is the 5x5 box x 528..532, y 119..123, and every cell of it that could hold water is dirt (y 122, 123) or air. Water at x = 527 or 533 is 3 columns away, so the seed is never "wet". The comment "water reaches it and wets it" is false. The seed germinates at the dry 1-in-6 rate.
   - Failure scenario: a regression where water crossing the active edge no longer wakes a frozen chunk would still pass. The test only checks that a woken frozen chunk with a seed runs.
   - Fix: build the world, call `set_active_around` last and `g.woken.fill(false)` (as `a_frozen_chunk_nothing_reaches_stays_frozen` does), then assert chunk 8 is not woken before the water arrives and is afterwards. Make the seed wet (water in the 5x5 box) or drop the wetness claim. The seed must also be inside the frozen region: chunk 8 starts at x = 512 and the active box covers x < 488, so chunks 0..7 are active and 8.. are frozen. The seed is frozen at its position, so that part is fine.

2. **nit, `sim/src/grid.rs` test `poured_water_spreads_without_walls_on_chunk_edges`: weak measurement.**
   - It could pass vacuously: `worst` stays 0 if no column more than 10 from x = 470 is measured, and there is no assertion that any column was measured or that water crossed a chunk edge (x = 448, 384). In practice 1000 ticks of pouring does spread across several edges, so the risk is low. A counter `measured > 100` and a check that the water spans x = 448 would remove the doubt.
   - Add `aux` and `woken` to the on/off equality, because invariant 8 covers hashed state, not just `mat`.
   - `surface_of` takes the topmost water cell, so an airborne splash droplet above a column gives a spurious large step (a false failure, not a false pass).
   - The all-active setup means frozen/woken late-join paths are only exercised by the existing wake/flow tests, not by this one.
   - D-191 says "54-row step before" while the test comment says "22 rows at x = 448". These are probably different metrics (the 22 is from the screenshot); consider saying so.

3. **nit, `sim/src/grid.rs` step_cells late-joiner `ran_chunks` / doc.** `ran_chunks` counts each chunk at most once per tick (a chunk belongs to one band and `running[ci]` latches), so the telemetry is right. `running` has length `cw` and `running[..cw]` is the whole vector; nothing else reads it. The existing assertion `ran_chunks == 0` still holds because a frozen not-woken chunk is not counted.

No correctness bug found in the scan itself.

## Checked and fine

**1. Sleep invisibility.**
- Premise: a chunk asleep at band start has `awake = false`, i.e. last tick nothing changed in it or within 1 cell, and nothing volatile is in it. Any change to it or its 8 neighbours this tick before band start (lower band, inputs, earlier ticks) sets `awake` through `touch`, so it is "running" at start.
- A change made mid-band wakes it at that moment, and the chunk joins at the next row-segment check. The rows it skipped were processed before the change in the sleep-off run too, so they saw the same neighbourhood as at tick start and did nothing.
- Same-row ordering is right on both parities. If the touching chunk runs earlier in the row, the woken chunk joins that same row. If it runs later (e.g. odd ticks, or a right neighbour on even ticks), the chunk's row segment had already passed in the sleep-off run too.
- Writes that land on an already-processed row of the sleeping chunk are seen next tick, because `awake` stays set.
- Reach beyond 1 cell: `slide` (reach 6) is gated by the 3x3 `liquid_free` and `open` checks, and when the gate passes the cell moves regardless of the far cells, so a resting cell cannot be affected by a change 2 to 6 cells away. This is pre-existing and still correct.
- `update_seed`'s 5x5 wet check, stems, fire, smoke, steam, gas, acid, lava and ice are volatile (`vol_seen`) or read only the 4-neighbourhood, so they never sleep on a change that `touch` would miss. Explosions queue in `pending` and resolve after the pass; `carve`, `dig` and `crumble_islands` write through `set`/`touch`, so the wake is by touch. Nothing found that reads or writes beyond the touch radius without being volatile. All pre-existing and unchanged by the new order.

**2. `awake`/`woken` end-of-tick equality, case by case.**
- Asleep and untouched: not running, `awake` false, unchanged. Sleep-off: runs, `awake` cleared, quiet, false. Equal. `woken` is the same via `update_woken`.
- Asleep and touched mid-band: sleep-on joins with `awake` true (set by the touch, not cleared). Sleep-off: cleared at the band pre-pass, set again by the same touch. Equal. Nothing clears `awake` after the pre-pass, so no ordering issue.
- Touched by the band below, before its band starts: running at start in both modes; cleared and re-set identically.
- Touched by its own band after its rows ran: `awake` set after the clear in both modes. The new pre-pass clears all chunks of the band up front, which also fixes the old hazard of a later neighbour's touch landing before an earlier chunk's clear.
- Frozen-and-woken: runs from start regardless of the switch, `awake` cleared. Same as before.
- Frozen-not-woken, touched mid-band: `wake` sets `woken` (and `awake`), the chunk joins via the `woken` check and `awake` stays true, so it remains woken one more tick. Frozen behaviour does not depend on `sleep_enabled`, so this is deterministic and identical on/off.

**3. Band-skip `continue`.** Only cells of band `cy` run during its pass, and `pending` is resolved after all bands. `crumble_islands` runs in `sim.rs` after `step_cells`. A touch from band `cy` onto `cy-1` is seen by that band's pre-pass, which runs later. A band with no running chunk therefore cannot wake anything, and under sleep-off those cells would have done nothing.

**4. `vol_seen`.** It is only ever ORed into `awake[c]`, never cleared except by the per-segment reset. Each segment is exactly one chunk, so the per-segment scope is equivalent to the old per-chunk scope. The `moved[i] != 0` early-return path still sets it. Nothing relied on the per-chunk lifetime.

**5. `running`/`cw`.** `running` is scratch, allocated in `new`, overwritten for every column at each band pre-pass, and not hashed or snapshotted. There is no other `Grid {` constructor, so there is no restore path with a different `cw`.

**8. Parity and perf.** Odd ticks scan chunks right to left and cells within a chunk right to left, so the whole row is right to left (a true alternating raster); even ticks are the mirror. The `y` range is bottom to top as before. The extra cost is one `cw`-sized pre-pass and a `contains` per band and a branch per 64-cell segment, which is negligible next to `update_cell`. Row segments are contiguous in `mat`, which is if anything friendlier to the cache.

## Architectural decisions for review

- **Row-major per band, late join by a touch check at each row segment** (chosen) versus a full-grid raster. A full raster would drop the band structure and make skipping asleep chunks per row. Cost of the chosen design: correctness of sleep invisibility rests on the argument that skipped rows would have done nothing, which holds only while every non-volatile rule reads at most the 3x3 neighbourhood (or is gated by it). Any new material with a non-volatile rule reading 2 or more cells away breaks invariant 8, and the D7-style on/off tests will only catch it if that case is exercised. Worth a one-line warning next to `touch` in `grid.rs` and a row in plan 6.4.
- **A late joiner keeps `awake`/`woken` rather than clearing at join.** This is the more conservative choice (one extra full run next tick) and it is what makes on/off equal. Do not "optimise" it by clearing at join.
- **Result-changing change:** the golden and `perf_equiv` fixtures were re-recorded. Fine while the game is not live. After launch, a scan-order change like this is a protocol break and needs the sim-build hash rejection (invariant 10) to cover old clients.
- **Wake test:** the `woken` state is polluted by the test setup order (finding 1). Fix the test setup rather than relying on a volatile seed to hold the chunk awake.

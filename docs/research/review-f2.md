# Review F2: Oil, Acid, Gas, Ice, Glass, Coal (f1615e5..f3adac2)

Cold read of `sim/src/grid.rs`, `gen.rs`, `materials.rs`, `rng.rs`, `sim/tests/sleep.rs`, `client/*`, `shared/names.ts`. Read only: nothing was built or run. Findings are from reading the code, not from running it. The working-tree edit to `tests/net/game.test.ts` is outside the diff range but is mentioned under finding 6.

## Findings

### 1. should-fix: the avatar controller treats Oil, Acid and Gas as solid
`client/avatar.ts:44-46`. `isGas` is `m >= 10 && m <= 12` and `isLiquid` is Water or Lava. `isSolid` is "not Empty, not gas, not liquid".
- Oil (15), Acid (16) and marsh Gas (17) are therefore solid walls to the local predictor.
- Pos is client-authoritative, so this is what players actually experience.
- Scenario: a player walks into a generated marsh-gas pocket and stops at an invisible haze. A pool of Acid is a safe floor that does not hurt, and an Oil pool cannot be waded or swum.
- Gas drifts into tunnel tops at runtime, so it can also block a corridor that `repair_traversal` kept clear at generation.
- `gen.rs` assumes the opposite. `place_gas_pockets` says a pocket "never blocks a walkable passage". The traversal test's `open` set (gen.rs:1304) counts OIL, ACID and GAS as passable.
- Fix: decide the rule (gas passes, oil passes and slows like water, acid passes and ideally damages). Update `isGas`/`isLiquid` in `client/avatar.ts`. Keep the stale "Water, Lava" comment in step.

### 2. should-fix: acid keep-off-path only tests the pool's seed cell
`gen.rs:590-600` (`place_acid`) calls `near_path(path, x, yf, 40)` on the start cell only. `try_pool` accepts a region up to 70 cells wide (`hi - lo > 70`), spanning up to 8 rows deep.
- Scenario: a seed point 41 cells from a path point, in a basin that stretches toward it. The pool touches or covers the path, so the effective margin is about 0 to 40 rather than 40.
- `repair_traversal` would then dig through it with `clear_all`. The guaranteed route is intact but runs through a pit that was meant to stay off it.
- The test `acid_stays_off_the_path_and_gen_materials_are_paintable` does not catch this. Its seed-world half only asserts `acid > 0` and that every cell is paintable. The "red without the path check" half calls the same `place_acid` and `near_path` the generator uses, with a hand-made path, so it is not independent.
- Fix: reject the pool if any `sc.region` cell is within the margin, which needs a hook between `level_flood` and the write in `try_pool`. In the test, independently compute the Chebyshev distance from every generated Acid cell to the `path` returned by the worm stage and assert at least `ACID_PATH_MARGIN` (or the relaxed value).

### 3. should-fix: the timing "bounded work" test is a weak bound
`sim/tests/sleep.rs` (`new_materials_keep_a_tick_within_bounds`).
- The cap is `max(6 x water, 30_000 us)`, so the floor is 30 ms. Measured values were 5.7 and 5.4 ms against 3.2 ms for water, so the real bound is roughly 5x slack.
- It averages 60 ticks. The gas case flashes the whole pocket in the first tick or two and then sits mostly burnt-out and asleep, so the average hides the worst tick, which is the one that matters.
- It is wall-clock and noisy. In debug, or on a loaded CI box, it either flakes or passes anything below 30 ms.
- It would still catch a quadratic rule at 141k cells, so it is not meaningless, but it would pass a 4x regression.
- It also writes `/tmp/f2-bounds.txt` from inside a test.
- Fix: assert a count, not time. Count `set`/`touch` calls or `ran_chunks` per tick, or assert that no rule loop exceeds `reach`. Take the max over ticks, and include the ignition tick for Gas.

### 4. should-fix: a flash fire can cascade through a whole pocket in one tick
`grid.rs:578-588`. Fire ignites an adjacent Gas cell at 1 in 1 with `set(..., FIRE, 6)`, and `set` does not set `moved`.
- The new Fire cell is still updated later in the same `step_cells` pass if the iteration order reaches it.
- The pass runs rows bottom to top and x left to right on even ticks, right to left on odd ticks. So fire runs up a gas column and along a row in the iteration direction all in one tick.
- Work is still bounded by the number of cells, because each cell is updated once per tick, so this is not a blow-up.
- It is an update-order artefact: the front moves unboundedly far per tick upward and in the x sweep direction, but only 1 cell per tick downward or against the sweep.
- It is deterministic and sleeping-invisible. A woken later chunk runs this tick and an earlier one next tick, exactly as with sleeping off.
- The same thing already exists for Wood and Oil, but 1-in-1 makes it deterministic and total.
- Fix (optional): set `self.moved[n] = 1` for the new flash Fire so the front moves one cell per tick. Otherwise document it and make `gas_flash_burns_the_whole_pocket` assert the asymmetry is intended.

### 5. should-fix: gas pockets can sit within reach of Lava
`gen.rs:~640`. The lava exclusion is `near_material(g, px, cy, 14, 14, LAVA)`, checked at one point, but the pocket spans `px +/- r` with `r` up to 29.
- Lava ignites any `is_flammable` neighbour at 1 in 8 per tick (`update_lava`, and Gas is now in `is_flammable`).
- Scenario: a pocket edge 20 cells from the check point touches lava, so it is ignited on the first ticks of a world and flashes before any player arrives.
- Note that lava-ignited Gas becomes ordinary Fire with life 30 to 90, not a 6-tick flash (`update_lava` passes `FIRE, 0`).
- Fix: check Lava with `rx = r + 2` and `ry` covering the pocket rows. Optionally make lava ignition of Gas use `FLASH_LIFE` too.

### 6. nit/unverified: M4b test edit and the claimed cause
`tests/net/game.test.ts` is modified in the working tree, outside the diff range. The new comment says "failed 4 runs in 6 after F2", which means F2 changed the outcome. The worker report says the failure was intermittent and the cause not found.
- Aiming B along a "clear" angle may be sound, but it is a test edit made to turn a red test green. By CLAUDE.md, an intermittent test is a race until shown otherwise.
- Check that this is not F2-induced: new materials near spawn or bolts, `is_gas(GAS)` makes bolts pass through Gas (`spells.rs:224`), changed hash and tick timing of join.
- Show the original test red against a pre-F2 commit before accepting the explanation.

### 7. nit: first-tick `aux` initialisation makes every generated Ice and Acid chunk non-pristine
`gen.rs` writes `mat` only. Ice (`aux 0`) and Acid (`aux 0`) both do `set(i, X, init)` on their first update, which calls `touch`.
- That sets `pristine[c] = false`, so every chunk containing generated Ice or Acid is serialised in snapshots, and the first tick is not a no-op.
- It is deterministic and correct, because inactive chunks stay pristine and regenerate identically. It only costs snapshot size.
- Fix: have gen write the initial `aux` (`ICE_COLD + 1`, `ACID_STRENGTH`) so those chunks stay pristine until something happens.

### 8. nit: acid chunks never sleep
`update_cell` flags Acid volatile unconditionally. A resting acid pool (up to 1602 cells at L) keeps its chunks awake forever.
- It is correct for sleeping invisibility.
- It could be narrowed to "acid with a Water or dissolvable neighbour", as Ice is, if sleeping savings matter.

### 9. nit: Ice freeze bias and shared salts
- `update_ice` draws one roll per tick and uses it for every Water neighbour, so when it succeeds it always freezes the first neighbour in up, down, left, right order. A vertical bias.
- `SALT_COAL_IGNITE` is used by Fire (%8), Lava (%16) and Coal (%24) at the same `(nx, ny, tick)`, and `SALT_ICE_MELT` by Fire (%3) and Lava (%2). The rolls are correlated: a %24 hit implies a %8 hit. This is harmless for determinism but not independent. A per-site salt would fix it.

### 10. nit: documentation and test gaps
- The `update_acid` doc says dilution makes "both become Water". The code turns only the acid cell into Water (the Water cell is unchanged). The test expects 2 Water, so the comment is wrong.
- The comments at `sim/src/input.rs:9,15` and `shared/inputs.ts:44` still say "ids 0-14 use only the low 4 bits". Ids are now up to 20. The code is fine because the fill bit is bit 7 and `mat` is masked, but the `& 0x0f` in `tests/net/paint-fill-empty.test.ts:16` only works for the id 4 it uses.
- `tools/inputgen.ts:32` `MATS` stops at 14, so the fuzzed determinism scripts (D1/D2/D3, four browsers) never paint ids 15 to 20. They are only covered through generated Caves worlds and `sleep.rs`.
- `place_gas_pockets` counts a pocket as placed only if `put >= 60`, but it keeps the cells it wrote even when it falls short, so there are leftover partial pockets.
- `Acid` is not dissolving Ice, Coal or Glass, and `sand`/`seed` do not sink through Oil or Acid (`powder_ok`). Sand therefore floats on oil. This is consistent but unphysical, and it is not mentioned in the density comments.

## Checked and found fine

1. **Bounded work.**
   - Every new rule reads four neighbours (Gas five) and makes at most one move or conversion.
   - The only loop is `slide`, capped by `reach` (Acid 4, Oil 5, Water 6, Lava 3).
   - Acid dissolves one neighbour per tick. Ice freezes one neighbour and spends budget, and ice made by freezing is spent, so a lake cannot chain-freeze.
   - Oil and Gas ignition goes through Fire cells. The generator's flood fills are bounded by `cap`.
   - The flash cascade (finding 4) is bounded by cell count, because each cell updates once per tick.
2. **Sleep invisibility.**
   - Every change goes through `set`, `swap` or `touch`, which wake the neighbouring chunks including corners. Cross-chunk reads are all at distance 1 (Gas diagonal-up included), and a change in a border cell wakes the other side.
   - Fire, Lava and lit Coal are volatile. They are the cells that melt, ignite or light other things, so Ice next to Fire or Lava is handled by the fire or lava cell's own awake chunk.
   - Acid is volatile. Unlit Coal and spent Ice are passive: they change only when a neighbour changes, which wakes them.
   - Ice sets `vol_seen` whenever it has budget and a Water neighbour is seen, which is exactly its chance-dependent case. A fresh Ice cell initialises itself on the first tick through `set`.
   - Gas has no chance except choosing a side, and that is drawn only when it moves. A gas cell under a roof does nothing, so it can sleep. A Fire neighbour wakes it by `set`.
   - Water and Oil next to a different liquid always have a move available, so they are not resting.
   - `d7_ice_by_water_keeps_its_chunk_awake` targets the one non-obvious case and was shown red, per the worker report.
3. **Determinism.** There are no floats, `HashMap`, `usize` hashing or threads in the diff. `x as u32` casts feed rng only. All 13 new sim salts (200-212) and 15 gen salts (220-234) are unique and do not collide with the existing ones (checked by listing and `uniq -d`). The only shared salts are the deliberate ones in finding 9. rng is counter-based everywhere, and per-neighbour scans use fixed order arrays.
4. **Reactions.** Every id produced (Fire, Smoke, Steam, Water, Rock, Glass, Empty, Ice, Coal) is below 21 and is covered by `paintable`, `MATERIAL_NAMES`, the 32-entry palette, `MATERIALS` and the `dig` and `carve` lists. The ordering Oil < Acid < Water is a strict total order through `ok` fns (Oil displaces none of the liquids, Acid displaces Oil, Water displaces Oil and Acid), so there is no swap-back oscillation. Sideways slides through a lighter liquid converge. Lava keeps its own rules.
5. **Gen.**
   - No gas or ice step can hang. `find_water_surface`, `find_floor` and the ceiling loop are bounded and in range, and the ice and coal index math stays inside `1..w-2` and `1..h-2`.
   - Liquid regions are closed below by `level_flood`'s construction, and `repair_traversal` now drains hanging Oil and Acid too.
   - Ice and Coal only replace solids (Rock, Dirt or Rock) so box reachability is unchanged. Gas needs at least 24 cells of open height below its 6 rows, and `repair_traversal` digs through anything (clear_all) if a pocket does block. The traversal test's `open` set was widened by OIL, ACID and GAS only, and the stricter `deepest_box_reach` still counts everything non-Empty as blocking.
6. **Client.** `uPal` is `[32]`, the Float32Array is 96, and `PALETTE_SIZE` is 32. The shader reads `uPal[m]` with an integer index and no other 16-based arithmetic. The Gas shimmer branch (m == 17) is render-only: it reads `uTime`, `c`, `h`, `bg` and `col`, all defined above it. `paletteTable` is filled for ids up to 20 and the rest are magenta.
7. **Weakening.** The only expectation changes are `new_materials_are_paintable_but_not_bedrock` (range widened to COAL and `COAL + 1` as the first unpaintable id, a legitimate update) and the traversal `open` set, which is noted in finding 1. No assertion was loosened elsewhere in the range.

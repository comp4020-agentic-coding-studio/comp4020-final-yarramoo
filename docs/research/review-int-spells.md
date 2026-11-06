# Review: int-spells (diff multa..int-spells)

Read cold, read-only. Nothing was run. "Checked" means I traced it in the code. "Suspect" means I reasoned but did not run it.

## Summary
One real invariant-8 hole (Snow packing). Everything else holds or is a nit. Bounds, decode and the mirrors look right.

## 1. Sleep invisibility

### S1 [should-fix, blocker for invariant 8] Snow packing reads 3 cells up, but `touch` wakes only distance 1. Checked in code.
`sim/src/grid.rs` `update_snow`, the `(1..=3).all(|k| self.at(x, y - k) == SNOW)` condition, and `Grid::touch` (the wake radius is 1 cell).
- Scenario. A flake rests at row `B1` (local row 1 of a chunk). Snow sits at `B0` and `A63` of the chunk above. Chunk B is asleep, because nothing in it can move and `vol_seen` is only set when all three cells above are already Snow.
- A snow cell then lands at `A62`. `touch(A62)` wakes chunk A only. A62 is not on A's edge, so no neighbour is woken. B stays asleep.
- Sleep off: the B1 flake now has 3 Snow above and rolls 1 in 16 each tick, so it becomes Ice. Sleep on: it never rolls until something else wakes B. This is a divergence.
- It needs the stack to straddle a chunk boundary with the third-above cell at least 2 rows from the edge. That happens naturally in snow piles on chunk lines (every 64 rows).
- This is the case the `touch` doc comment warns about ("a cell that can act on a change 2 or more cells away must mark its chunk volatile"). The new `each_new_material_alone_sleeps_invisibly` test says it uses 63/64 boundaries. A last-flake-arrives-at-distance-2/3 case needs a stack of 3 or more across the line, so it likely isn't covered.
- Fix: set `vol_seen` for a resting Snow flake whenever `at(x, y-1) == SNOW`, so it never sleeps under a flake. Alternatively drop the 3-cell reach and use only the 3x3 neighbourhood. Add a test with a 4-deep stack across a chunk line where the top flake is added late.

### S2 [verdict] `vol_seen` on Snow's `powder_can_move` branch is needed. A test gap, not dead code. Checked by reasoning.
- Snow falls only on even ticks. Say a hole opens under a resting flake during tick t. `touch` wakes the chunk, which runs at t+1.
- If t+1 is odd, the flake cannot move. Without `vol_seen`, `awake` is cleared after that run and the chunk sleeps through t+2 (even), when the sleep-off world would fall.
- So a divergence is reachable without the flag. The tests pass without it only because they never open the hole on a tick that makes the next tick odd, or the test chunk stays awake for another reason. Add a case where the support is removed on both tick parities.
- The same argument applies to Mud's `else if self.powder_can_move` branch (moves only when `tick % 3 == 0`). That branch is also needed, and has the same gap: vary the removal tick mod 3.

### S3 [nit] `vol_seen` on lit Thermite is redundant, though harmless. Checked.
Every lit tick does `aux[i] -= 1; touch(i)`, and `touch` sets `awake[c]`. The burn timer therefore keeps its chunk awake anyway, which is why removing the flag fails no test. The final tick (`set(i, FIRE)`) is also a touch. The lighting transition (unlit to lit) does `touch` too. Keep it for clarity, or drop it. Correctness does not depend on it.

### Other rules, checked and fine
- Mud's heat check, Salt's Ice/Water rolls, Snow's heat check and Thermite's lighting read the 4-neighbourhood only, so a distance-1 `touch` wake is enough.
- Salt and Snow set `vol_seen` beside their chance triggers (compare the Ice rule). Thermite writes go through `Grid::set` or `touch`, so neighbours in other chunks are woken.
- Salt's two rolls share one salt (`SALT_SALT_MELT`) in disjoint branches. That is fine.

## 2. Thermite budget
- Checked: reset at the top of `step_cells` and initialised in `new()`. `update_cell` is called only from `step_cells`, so it is never read before reset. It is not state: not snapshotted and not hashed. That is correct, because it is dead at tick end.
- Order equivalence. A lit cell touches itself every tick, so its chunk is always awake and running in both sleep modes, and the raster order among lit cells is identical. A frozen chunk (inactive and not woken) skips in both modes. A restored world therefore consumes it the same as a live one, provided `active` and `woken` are the same (`woken` is snapshotted).
- One edge: a lit cell with `moved != 0` returns early without consuming budget. The same happens in both modes.
- Bounded at 16 conversions per tick regardless of lit count. Rock-to-Lava goes through `set`, which seeds island floods, and those are bounded by `ISLAND_WORK_MAX` / `MAX_ISLAND_REMOVED`.

## 3. Bounds
- Quake (checked): a disc of radius 5 gives at most 81 writes, with bounds checks. It goes through `Grid::set`, so islands crumble under the normal budgets (4000 visits per tick, `ISLAND_MAX` 400, `FALL_MAX_ISLANDS`). One cast cannot cost unbounded work. Exempting Quake from `MAX_PROJECTILES` / `REJECT_FULL` is correct because it spawns no projectile. It is limited by charges and its 90-tick cooldown, the same as Wall and Dig.
- Freeze (checked): a 15x15 scan, capped at 80 cells, writing spent Ice (aux 1). It adds structure without a seed, so there is no flood. It does count against the projectile caps.
- Mudslide (checked): `burst` is capped by `cap.min(OIL_BURST_CELLS)` at 70 cells.
- Paint of new materials is clamped by the existing `MAX_PAINT_*`. `paintable` includes MUD..=THERMITE (25-28) and excludes 29 (the grid unit test pins it).
- [nit] Lit Thermite turns every Water neighbour to Steam with no roll, up to 16 per tick. That is bounded, and Steam is volatile, so a Thermite cell sunk in a lake makes a lot of awake chunks. It is a perf cost, not a correctness one.

## 4. Snapshot and decode, format 16
- Checked: the player record and bag record sizes derive from `NUM_SPELLS` and `BAG_SPELLS` (`PLAYER_BYTES`, `BAG_BYTES`), so the TypeScript and Rust layouts move together. The bag decode reads exactly `BAG_SPELLS` u16s, bounds x and y, and rejects all-zero bags.
- Projectile decode rejects `spell >= NUM_SPELLS`, so unknown ids 15 and above are refused and 12-14 are accepted.
- Pickups are matched against the generated list, so the spell id there is validated by equality.
- [nit, pre-existing] Charges are not capped on decode, for players or bags. Pickup applies `min(INFINITE - 1)` and saturating add, so there is no overflow. Not introduced here.
- [nit, pre-existing] The grid decode copies `mat` bytes raw with no id check, so ids above 28 (and above 24 before this change) are accepted. `update_cell` ignores unknown ids and `material_class` treats them as solid. I found no crash path, but the question asked for "nothing above 28", and that is not enforced. A one-line `mat <= THERMITE` check in `restore_with` would enforce it.
- [nit] A restored lit Thermite carries arbitrary `aux` (up to 255 ticks of burn). That is bounded and harmless.
- Spell ids 12-14 in enemy-owned projectiles from a hostile snapshot would run `impact` for Freeze/Mudslide. Bounded, harmless.

## 5. Mirrors
- Checked: `MATERIAL_CLASS` has 29 entries (counted with awk). `SPELL_NAMES` has 15, and `NUM_SPELLS` in `shared/sim.ts` and `BAR` in `client/spells.ts` are 15. `isPaintable` is 22..=28 and matches the Rust. `SNAPSHOT_FORMAT_VERSION` is 16 in `server/db.ts` and `shared/sim.ts`. `castStat` and `paintStat` derive keys from the names tables, so they pick up the new ids.
- I did not count the entries of `MATERIAL_NAMES`, and I did not check the render colour table or LUT. The diff adds 4 `MATERIALS` entries and 4 names, so it is likely right.
- [nit] `client/toasts.ts` `SPELL_LABEL` / `SPELL_VERB` have 6 entries, and spells 6-14 already fall through to the generic text. The new spells do no player damage, so there is no regression, but it is a table that does not follow the id range.
- [nit] `client/worker.ts` hard-codes `SPELL_WALL` and `SPELL_QUAKE` as "no projectile". It matches `spells.rs`, but it is a second place to keep in sync.
- [nit] Snow packed to Ice, and Ice from Freeze, are structural with no island seed. A flake packed mid-pile can sit as a floating Ice cell until something seeds it. This is visual only, not a determinism issue.

## Not found
- No float, HashMap or usize hashing. All new rng calls are counter-based with distinct salts (260-267 collide numerically with `SALT_GEN_*` 260-267, but those are gen-time salts used at a different tick, so it is a nit; if gen uses tick 0 then at tick 0 an identical (x, y) draw could correlate, which is harmless).

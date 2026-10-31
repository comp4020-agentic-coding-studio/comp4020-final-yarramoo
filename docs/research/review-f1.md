# Review F1 (6e87433..725a30b): Dig, cause renumbering, snapshot 5, roomy caves

Read-only review of the diff; nothing was built or run. No blockers found.

## Findings

### 1. nit: `activePlayersIn` lost its doc comment (server/world.ts ~1287-1289)
The new `/** One player record ... */ const PLAYER_RECORD` was inserted between the existing doc comment ("Active player ids in a compressed game snapshot...") and `activePlayersIn`. The old comment now sits above the const and the function has none. No behavioural effect. Fix: move the const above the original comment.

### 2. nit: `server/db.ts:9` `SNAPSHOT_FORMAT_VERSION = 3` is a stale label
It is written into the snapshot row but nothing reads it for gating; the sim's own `FORMAT_VERSION` (5) decides. Harmless, but misleading to a reader. Fix: set it to 5 or delete it.

### 3. nit: death toast for cause 6 (Dig) would read "someone died" (client/toasts.ts:33)
`SPELL_LABEL`/`SPELL_VERB` have 6 entries. Dig does no damage, so no EV_DEATH can carry cause 6 and this is unreachable today. If Dig ever gains damage, the fallback text is generic rather than wrong. Fix: none needed; optionally add a Dig row.

### 4. nit: dig preview is rotated with non-uniform scale (client/room.ts ~603-607)
Width uses `sx`, height uses `sy`, then `rotate(angle)`. If the canvas scale is anisotropic the capsule skews; with square cells (the normal case) it is exact. Render-only (invariants 1 and 9 hold). Fix: only matters if sx != sy.

### 5. nit: `borders_surface_and_open_fraction` limit 60 -> 120 is calibrated on one seed (sim/src/gen.rs:1070-1083)
The reason is real: shaft radii went from 5-9 to 10-16, so up to 5 shafts open about 2x the columns. It is a legitimate update, not a silent weakening. But a worst case of 5 x ~33 columns could exceed 120 on another seed. The test only runs seed 3 and the world is deterministic, so it cannot flake. Scenario: someone changes `WORM_R_MAX` and the bound needs retuning again. Fix: derive the bound from `5 * (2 * WORM_R_MAX + 1)` rather than a magic number.

### 6. nit: M5 script needed 3 more self-bomb ticks (tools/inputgen-m5.ts:84)
The wider caves removed bot 2's self-death in the original script, so ticks 630/695/760 were added. The coverage assertion (a credited-nobody self-kill) is kept, and the script ends at tick 900, so the extra ticks fit. This is a real fix, not weakening. Fragility remains: any later gen change can silently remove the death again. The worker's FUTURE idea (a reactive self-bomb loop) covers this. `m5-state` has no diff in this range and no `m5-state.test.ts` exists in `tests/net`, so nothing was weakened there.

### 7. nit: the client ghost for Dig is a 3x3 marker pinned at the avatar (client/worker.ts ~679, 728)
Speed 0 means it sits on the avatar until `EV_CAST` (same seq) or `EV_CAST_REJECTED` removes it, or it ages out. It is harmless and cosmetic. It does not mislead beyond a brief marker.

## Checked and found fine

1. **Bounded work.** `Grid::dig` (sim/src/grid.rs ~645-676) clamps `r` to 0..=7 and each segment component to +-14 before any use. Box is at most (14 + 2*7 + 1)^2 = 841 cells, further clamped to the world, and the cooldown is 18 ticks. Overflow: `dx*dx + dy*dy` <= 392 in i32. `px, py` are i64 and at most about 30 in magnitude near the segment, since the box is bounded. `px*l2` is at most about 12k and its square about 1.5e8, so there is huge i64 headroom. `ax + dx` is a player cell coordinate plus 14, so no i32 risk. The `l2 == 0` branch avoids the division-free degenerate case. Near world edges, negative `x0/y0` are clamped by `.max(0)` and `.min(w-1)`. Arithmetic shift (`>>`) in `dig_cast` floors identically on all targets. The `dig_work_is_bounded...` test passes extreme values (r = 10_000, endpoint +10_000), exercising both clamps.
2. **Determinism.** No floats, no HashMap, no `usize` hashed in the new sim code. `PLAYER_BYTES` is derived from `NUM_SPELLS`, and the new per-spell fields are fixed-width. `carve_chambers`: counter-based rng with distinct (band, band+2) args, so no stream collision. It iterates `path` (a Vec in worm order, deterministic) twice with the same filter, so `n` and `nth(pick)` agree. The 2/3 ellipse test is i64 integer maths. The new salt 136 is unique (130-135, 140-145 used). `unwrap_or(&(0,0))` is unreachable.
3. **Cause codes.** Sim `CAUSE_*` (tuning.rs), `shared/sim.ts`, `SHOVE_CAUSES` (achievements.ts) and the toasts all agree on 32/33/34. `server/achievements.ts` uses `SHOVE_CAUSES.includes`. The server claim path (`world.ts` ~1120, `shared/protocol.ts` ~265) only passes the u8 through, and 34 fits. `apply_damage` uses `cause < NUM_SPELLS` for the player-caused test, which still separates 0..6 from 32+. `claims.test.ts` was updated and extended to check that causes 6-8 grant nothing. No stray 6/7/8 cause literals found (the other `6`/`7` hits in tests are unrelated paint-radius and ids).
4. **Layouts.** Rust `PLAYER_BYTES` = 21 + 6*7 + 8 = 71. Server `PLAYER_RECORD` = 21 + 6*NUM_SPELLS + 8 = 71. `entity-layout.test.ts` asserts 71. `PLAYER_VIEW_BYTES` = 4*NUM_SPELLS agrees with the `shared/sim.ts` `playerView` (`withBuf(4*NUM_SPELLS)`, cooldown offset `2*NUM_SPELLS`). Client `SPELLS.length` is checked against `NUM_SPELLS` at load, and `spells-table.test.ts` pins the table against `tuning.rs`. Snapshot `FORMAT_VERSION` 5 covers the changed player record and `restore` refuses any other version (tests updated to refuse 4 and 6). **Old format-4 snapshot at boot:** the sim wasm hash changes, so `row.simBuild !== this.simBuild`. `loadFromDb` then calls `verifier.check`. A format-4 snapshot gets `refused` (worker answers `ok: false`), not `unavailable`, so `ok` is false and the world is reset with `world.build_changed outcome=reset`. The server does not crash. Only a verifier timeout or crash stops boot, which is the existing intended behaviour. The tick log is dropped with the reset. Bags use `BAG_SPELLS` = 4 over `charges[2+k]`, so Dig (id 6) is correctly outside them, and a death keeps Dig unlimited (bags.rs test).
5. **Gen.** `carve_chambers` runs after worms and before `connect_and_prune`, `line_entrances_with_dirt` and all material placement. So pools, sand and gunpowder are placed into the opened space, and cannot hang over a void. It only clears ROCK and DIRT, so Bedrock and walls are untouched, and the centre filter keeps it 60 rows under the surface and 12 clear of the walls and floor. `repair_traversal` runs last and can only add tunnels (and drains hanging liquid), so its guarantee is not weakened. Pickup spots are chosen last from the final grid. The worker's measured pickup counts are unchanged. Chambers sit on path points, so they are connected by construction, and `connect_and_prune` handles any leftover. Nothing is order-dependent beyond the deterministic Vec order.
6. **Client.** Dig is render-only in the client. It sends the same Cast input as other spells, and the preview, dust fx and sfx read the sim's events only. The preview geometry (segment midpoint, width `reach + 2r`, height `2r`, chest origin `y-5` = `CHEST`) matches the sim. `BAR = [0,1,6,2,3,4,5]` maps key 3 to Dig and `BAR.length` bounds the keys. The preview condition uses id 6. Stats keys are derived from `SPELL_NAMES` ("casts_dig"), and the "any casts_" achievement still works.
7. **Silent weakening.** See findings 5 and 6: updates are justified. Test expectation changes for bags, `config_state`, terrain and `spells.rs` follow the new array size or id, and add Dig-specific tests (bounded work, capsule extent, unlimited and cooldown, Blast no longer digs).

## Not verified (read-only)
- Nothing was executed. The worker admits the Dig preview and a live dig click were not seen in a browser. A two-tab check of Dig is still owed (CLAUDE.md "Open it and look").
- Gen guarantees across many seeds were not run.

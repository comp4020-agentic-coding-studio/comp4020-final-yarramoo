# Review: M5 slice 1 (damage core)

Scope: `git diff 8f4c105..f3a2236`. Method: read the diff and surrounding code, ran `cargo test --release` (all green), wrote a throwaway probe (deleted; tree clean apart from the pre-existing `.gitignore`/`README.md` edits).

## S (must fix before pushing)

None found.

## N (should fix)

### N1. Kill credit survives death and respawn
`sim/src/spells.rs:258-273` (`apply_damage`), `:349-360` (`respawn_player`). Neither clears `last_hit_by` / `last_hit_tick`.
Scenario: B hits A at tick 2, A dies at tick 4 (credit B), respawns at 184. A then dies to lava at tick 183+ (181 ticks after the original hit, inside the 300-tick window). B is credited again for a hit from a previous life.
Evidence (probe): after the first death, `last_hit_by 2, last_hit_tick 2` persisted at tick 183 and the second death emitted `EV_DEATH a=2`.
Fix: in `apply_damage` at death, or in `respawn_player`, set `last_hit_by = 0; last_hit_tick = 0`. Add a test.

### N2. The dead-bolt test cannot fail
`sim/tests/damage.rs:~233-241` ("A bolt passes through the corpse"). Player 2 stands at x=518 and fires angle 0 (right), so the bolt flies away from player 1 (x=510) whatever the rule is. Also `s.events` is cleared every step, so `all(!(EV_KNOCK && player==1))` after the loop only inspects the last step. `projectiles.len() <= 1` is near-vacuous. The "no bolt hitbox while dead" rule (`update_projectiles` filter on `alive`) is effectively untested.
Fix: place the shooter on the left (or fire toward the corpse), collect KNOCK events across all steps, and add a live-player control that does get knocked.

### N3. Gunpowder falloff test mirrors the implementation
`sim/tests/damage.rs:~128-140`. The expected damage is computed with the same `isqrt`/shift formula as the code, so a wrong formula passes. Assert the literal (dx=-2 cells, dy=-0.5, d=2, damage 30), as the comment already states.

## M (minor)

- M1. `spells.rs:266`: `dead_until = tick.wrapping_add(180)`. A death within 180 ticks of the u32 wrap gives a small `dead_until`, so the respawn check `tick >= dead_until` is true next tick (early respawn). Needs about 2 years of ticks at 60 Hz. Compare with a wrapping difference or note it.
- M2. `grid.rs` `Grid::carve` is `pub` and indexes `cy*w+cx` before any bounds check (`ci`). An out-of-world centre panics (a trap in wasm). Current callers pass in-world centres. Clamp or make it `pub(crate)`/debug-assert.
- M3. `explode_at` is `pub` with unbounded `r`. `kr = r*3/2` and `KNOCK_EXPLOSION*(kr-d)` stay in i32 only for small r. Only internal callers exist (r=4), but slice 2 callers need the same clamp as the paint rule (`MAX_PAINT_RADIUS`-style).
- M4. `damage.rs` fire test has dead code (`hits`, `let _ = &mut hits`).
- M5. A hit that only knocks (distance in [r, 1.5r)) still sets `last_hit_by`. Probably intended; mention in the D-102..105 text if so.
- M6. Respawn does not reset charges or cooldowns. Check this is a design decision rather than an omission.

## Checked and found fine

- `isqrt`: Newton from `n` (n>=2) with `div_ceil(2)` start, no overflow (`x + n/x` where x is about n/2 or less), correct at 0, 1, perfect squares, `u64::MAX` (test covers 0..5000, `u64::MAX`, `1<<62`). Cast to u32 safe.
- Signed division in knockback (`mag*dx/dist`) truncates toward zero identically on wasm32 and native. All distance maths are i64. `i32` coordinate arithmetic is far from overflow (max about 33k).
- Iteration order: all loops go over `players` in vector order (sorted by id), `explosions` in queue order. No HashMap, no floats, no `usize` in hashed state (`dead_until`, `last_hit_*` are u32 and are serialised).
- Sleeping: hazard scan reads the player's own hitbox cells, which lie within the active rectangle (576x320) around the player's position; positions are unchanged between `refresh_active` and the scan. Respawn runs before `refresh_active`. Reading the grid is state-only, so the scan is independent of chunk sleep. World-edge hitboxes are clamped (`max(0)`, `min(w-1)`). `explode_at` reads no cells.
- Dead state: `alive()` gates cast (REJECT_DEAD), pickups, bolt boxes, explosion, hazard and `apply_damage`. Pos is rejected when `health==0`. `Join` of a dead player only sets `active`; it does not revive. A player who left while dead respawns (respawn loop does not require `active`). A same-tick explosion death skips the hazard scan (alive() false). Snapshot mid-death restores `dead_until` (test D-style).
- Step order matches the doc comment; explosion damage precedes hazards, so no double death event (apply_damage is a no-op on a corpse).
- Kill credit: self never credited; missing killer fine (ids persist, players are never removed, so no id reuse in game worlds); gunpowder passes owner 0 and takes no credit.
- Sandbox byte-identity: `carve` body is the same arithmetic, same rng call and salt, same iteration order; `resolve_explosions` only adds a push to the scratch vec, which is not hashed. All new behaviour in `step` is gated on `world_kind != 0`; the new Pos condition and respawn loop only touch players, which the sandbox never creates. The p1_bench-hash/D1/compat proof is sound for this. Bounded work: the explosion queue is capped per tick (D-022) and events per tick are bounded by explosions x MAX_PLAYERS.
- Tests that do bite: lava and fire cadence and phase, credit window boundary (300 ok, 301 not), self-kill credit, respawn exactly at `dead_until`, left-while-dead respawn, pickup while dead (own control not in file, but the probe shows a live player does collect it), determinism plus snapshot restore.

## Resolution (fixed by the orchestrating session)

- **N1 fixed:** `respawn_player` clears `last_hit_by` and `last_hit_tick`. The new test `a_hit_from_a_previous_life_does_not_credit_the_next_death` failed without the fix (player 2 credited for a death in the next life) and passes with it.
- **N2 fixed:** the corpse check now fires Push left (angle 32768), toward the corpse, and collects knocks over every step through the new helper `push_hits`. A control test, `the_corpse_test_shot_does_hit_a_live_player`, shows the same shot lands on a live player. Shown to fail when dead players keep a bolt hitbox (`.filter(|p| p.active)`): "a bolt hit the corpse".
- **N3 fixed:** the falloff test asserts the literal 70 HP (30 damage), not the formula recomputed with `isqrt`.
- **M1–M6** left as they are: `dead_until` wrap needs ~2.3 years of continuous ticks; `explode_at` has two fixed-radius callers (4 and, in slice 2, 18), so a radius clamp waits for a caller that needs one; M5 (a knock-only hit sets last-hit) matches the plan's credit rule for Push and Blast; M6 (charges and cooldowns kept on respawn) is superseded by slice 3, which moves finite charges into a dropped bag at death.

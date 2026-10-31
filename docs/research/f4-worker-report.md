# F4 worker report: enemies slice 1 (Slime) plus one-life co-op Survival

## Commits

### 1. Config byte 12 `enemies` and the SURVIVAL preset
- Changed: `sim/src/config.rs` (`enemies`, `survival()`, `has_enemies()`, reserved now bytes 13..16),
  `shared/room.ts` (`CONFIG_FIELDS`, `SURVIVAL`), `client/menu.ts` (Survival card uses `SURVIVAL`, co-op text,
  `pvp: false`), `sim/src/script.rs` and `tests/determinism/run.ts` (script preset name `survival`), vectors in
  `sim/tests/config.rs` and `tests/net/room.test.ts`, `sim/tests/config_state.rs` (enemies is in the hash).
- Red first: with the Rust/TS sources stashed, the test files failed to compile (Rust) and 2 vitest cases failed
  (`presets encode to the shared vectors`, `good vectors round-trip`). Green after.
- Gate: cargo test, clippy, typecheck, test:determinism all green.

### 2+3. Enemy state, snapshot format 7, entities view, and generator placement (one commit; flagged)
- Items 2 and 3 landed as ONE commit: `sim.rs` builds the enemy list from `gen::enemy_spots`, so splitting after
  the fact would have meant a red intermediate state. Flagged as a deviation from the checklist.
- State: `Enemy` in `entities.rs` (35 bytes), `Sim.enemies`, `Sim.round_over`, `Base.enemies`; entity bytes append
  `n_enemies u32, enemies, round_over u8`; `FORMAT_VERSION` 7; `ENT_ENEMY` view record; `EV_ENEMY_HURT/DEATH`,
  `EV_ROUND_END` ids 11-13 (sim and `shared/sim.ts`). Enemies come from `Sim::new` and the cached base.
- Gen: `gen::enemy_spots` (shallow band floors, off the surface spawn zone, off pickups, whole 5x4 body Empty).
- Re-pointed expectations (all about the version/section bump, none weakened): `bags.rs` format 6 -> 7 (and the
  refused-version list now holds 6 instead of 7), `config_state.rs` same, `bags.rs`/`spells.rs` hostile-section
  offsets move by the 5-byte empty enemy section.
- Slime counts (seeds 1-3, from `/tmp/f4-slime-counts.txt`): S 7/8/5 (target 8), M 8/8/8 (target 8), L 25/25/25.
  S falls short of its floor on some seeds because the shallow band is small; the test allows 50%..100% of target.
- New tests (`sim/tests/enemies.rs`): byte layout and snapshot round trip, hostile bytes, view record, empty
  section, enemies-only-when-on, floor/liquid/spawn/pickup placement, counts per size, cached base.

### 4. Stepping rule, slime AI, contact damage, embedded rescue
- `sim/src/enemy.rs` (new), `materials.rs` (`material_class`, `blocks_enemy`, pinned to `shared/names.ts` by a test that parses it),
  slime tuning in `tuning.rs`, salts 240-243 in `rng.rs`. Enemies step in `update_entities` right after `update_projectiles`.
- Red first: with `update_enemies` stubbed to return immediately, 6 of the 10 new tests failed (stepping, cap, targeting
  tie, hop, contact damage, embedded rescue). `a_dead_or_absent_player_wakes_nothing`, the D7 test and the work test
  pass with the stub by nature (nothing moves), so D7 is a regression guard, not a red-first test; it does
  exercise a near, an outside and an on-the-edge slime plus a paint that disturbs a settled region.
- Work count (`Sim.enemy_work`, cells examined by collision tests): 48 slimes, 24 stepped: worst 3600 cells/tick, mean 2966 cells/tick
- Gate: cargo test, clippy, typecheck, test:determinism green.

### 5. Enemies take damage
- `enemy.rs`: `damage_enemy` (marks hp, emits `EV_ENEMY_HURT`), `knock_enemy` (impulse / 4, lifted by at least 8),
  `reap_enemies` (removal in id order, `EV_ENEMY_DEATH` with credit inside `KILL_CREDIT_TICKS`), `enemy_hazard_scan`
  (lava/fire/acid at the player cadence, per-kind immunity mask, only for the stepping set). `spells.rs`: enemy boxes
  join `step_projectile`'s box list with ids tagged `ENEMY_BOX` (high bit), `impact` handles Push and Fire bolt hits
  on them, `blast` and `explode_at` get an enemy loop. Players are matched first in the box list.
- Red first: with spells.rs reverted and the hazard scan call removed, 5 of the 6 new tests failed; the far frozen
  slime test passes by nature (nothing happens either way).
- Gate green.

### 6. The co-op knock gate (D-158)
- `spells.rs`: `hit_player` returns early for another player's victim when `!damage_from_players()` (covers Push and
  Blast, the two callers); `explode_at` skips another player's explosion entirely in such rooms (no credit, damage
  or `EV_KNOCK`, so Bomb is covered; the caster's own knock is unchanged); the Black Hole pull skips non-owners.
  Enemies are still hurt and moved by all of them.
- Red first: with the three gates neutralised, 2 of the 4 new tests fail (Push/Blast/Bomb on another player; Black
  Hole pull). The other two (own bomb knock, Push on a slime) are non-regression tests and pass either way.
- Gate green (the stash-style revert was restored before the gate; `grep` confirms the gate text is present).

### 7. One life and `EV_ROUND_END` loss (sim only; server `round.end` NOT built)
- `spells.rs`: with `death == 1`, `dead_until = u32::MAX` on death (every reader goes through `alive()` or
  `health == 0 && tick >= dead_until`, so nothing else changed; `apply_damage` is now `pub` for tests).
  `sim.rs`: `check_round_end` after the hazard scans, `round_over` in hashed state, `round_won()` hook returning
  false (boss slice), enemies stop stepping once `round_over != 0`. Loss means at least one player is active and no
  active player is alive; a lone Leave does not end the round. Solo works.
- Red first: with `check_round_end` removed and `u32::MAX` disabled, all 5 new tests failed.
- **Server `round.end` and the room-ended flag were left out.** The claim path is built around `ResolvedDeath` and
  a fixed-length CLAIM frame (`shared/protocol.ts`, `onClaim`, `tryResolveClaim`); a round-end claim needs a new
  wire message, a client sender, a tally and a rooms-table flag. That is the brief's "too big, stop at sim plus
  client banner" case, so I did not half-build it. The client banner is item 8.
- Gate green.


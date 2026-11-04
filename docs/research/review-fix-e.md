# Review: Brief E heal drops (567c6ea..a27eb78), read cold

No must-fix found. Code read only; no tests or builds run.

## Should-fix

1. should-fix, sim/src/spells.rs:~700 (`update_heals` fall rule) and enemy.rs:~595 (drop site). A heal whose cell is solid (enemy killed with its hitbox cell inside rock, sand, dirt, or a wall painted in) only falls when the cell BELOW is EMPTY or gas. It never moves out of a solid cell, and a player's hitbox cannot overlap solid cells, so nobody can take it. It sits for 3600 ticks, then expires. While it sits it counts toward MAX_HEALS=16, so a few of them evict real heals (oldest first). A heal sitting on water or lava also never sinks, which is fine. Scenario: a boss or slime killed by Dig/bomb or a collapsing wall in a cave. Deterministic, so it is not a desync, only a wasted drop. Fix: at drop time, or in the fall step, if the heal's cell is solid, search upward (bounded, e.g. 8 cells) for the first non-solid cell. Confidence: medium-high (I did not run it).

2. should-fix, sim/src/entities.rs decode (heal loop). `expires_at` is not validated. A hostile snapshot can carry `expires_at = u32::MAX`, a heal that lives about 2.2 years of ticks. The server writes snapshots itself, so the risk is low. It is only a state-bound gap. Also x/y are validated in-world but not "not solid". Fix: refuse `expires_at > tick + HEAL_LIFETIME` (the tick is available in restore after the header, if the decode is given it). Confidence: medium. Could be a note.

## Notes

3. note, no test for the new decode rule "heals in a room without enemies is refused" (snapshot.rs ~91). `hostile_heal_bytes_fail_cleanly` covers out-of-world x/y, amount 0, amount over HEALTH_MAX and over-cap count, but only on `arena()`, which has enemies. The sandbox/no-enemy room case, a truncated tail, and a count that disagrees with the length are not covered. The logic reads correctly: the count is bounded by MAX_HEALS before any allocation, and the exact length is checked before parsing (heal_at + 4 + nh*9 + ROUND_TAIL == len). I found no bug, only a gap in coverage.

4. note, determinism checks that came out clean.
   - The rng call is `rng(seed, tick, cx as u32, cy as u32, SALT_HEAL_DROP)`. Salt 257 is unique, and all inputs are fixed-width. Nothing hashed is usize: `len() as u32`, u16 and u8 fields, and u32 expires_at. HEAL_BYTES = 9 matches write().
   - Drops are collected during `retain` (iterated in id order) and applied afterwards. `reap_enemies` runs at a fixed tick position, so the eviction order is deterministic. Eviction removes index 0, the oldest, with `Vec::remove`.
   - Multiple heals reaching one player are taken in index order. Two players on one heal resolve by `players` order, assumed sorted by id as with pickups. A full-health player does not consume it (`while p.health < HEALTH_MAX`).
   - Order within the tick: respawns, then bags, then heals, then pickups. A just-respawned player is alive at full health, so it takes no heal. A dead player is excluded by `alive(tick)`.
   - Sleep: the only grid read is `mat[(y+1)*w+x]`. It never writes the grid, the same argument as bags. There is a sleep test (`sleeping_is_invisible_to_falling_heals`). I found no divergence.
   - Heal drop position is `(cx, cy-1)`. cy is the feet cell (solid ground), and cy-1 is the last hitbox cell. It is clamped to the world, so the top edge (cy=0) gives y=0 and no u16 underflow. `y+1<h` guards the bottom edge.
   - The drop is gated on `cfg.has_enemies()`, consistent with the decode rule.

5. note, the offset-arithmetic test changes (bags.rs, enemies.rs, spells.rs, entity-layout.test.ts) only account for the added 4-byte heal count. The TS test still asserts `o === elen`, so a layout slip would show. The hostile enemy-count test and the projectile-count test still hit the intended fields. Format pins moved 10 to 11, the refused-version lists now include 10, and config_state uses 12 as the "too new" case. Nothing weakened. `activePlayersIn` reads the player section at the front, unaffected.

6. note, the layout change cannot make an old snapshot decode wrongly. A v10 snapshot is refused by version before decode, and v11's exact-length check ties the heal count to the total. Hostile v11 with a shifted layout fails the length equality or the `r.u32() != nh` check.

7. note, client (invariant 9): `pushHeal`, the EV_HEAL handler (burst, sfx, toast message to the main thread) and the ENT_HEAL draw only read the entity view and events. Nothing is sent as a sim input. The toast is a UI message. `Math.sin(now)` is cosmetic only. Clean. Minor cosmetic: the burst uses `e.c - 1` while the sound uses `e.c + 0.5`.

## Session model's resolution (4 Nov)

- **Should-fix 1 (heal stuck in solid): fixed.** `drop_heal` raises a heal dropped inside solid ground to the first
  open cell within `HEAL_RISE_MAX` = 12, and drops nothing if there is none. Test
  `a_heal_dropped_in_rock_rises_to_open_air_or_is_not_dropped`, red with the fix reverted.
- **Should-fix 2 (immortal heal in a snapshot): fixed.** Restore refuses a heal whose `expires_at` is more than
  `HEAL_LIFETIME` past the snapshot's tick (wrapping). Two existing round-trip tests used `expires_at: 99_999`, a value
  no real drop can have; they now use the longest real lifetime. Test
  `decode_refuses_heals_without_enemies_and_immortal_heals`, red with the fix reverted.
- **Note (no-enemies decode untested):** covered by the same new test, which also refuses heals in a `caves_pvp`
  room.
- **Not seen in a browser:** the heal sprite (a pulsing red cross, `pushHeal`) and the heal sound and toast. The dev
  route's teleport to an enemy lands beside the boss's arena, and the avatar died before it could kill anything. The
  sim side is covered by 14 tests; check the drawing in the next playtest.
- **Full gate on E with these fixes:** cargo (39 binaries), clippy, typecheck, determinism 53/53, net 363/363.

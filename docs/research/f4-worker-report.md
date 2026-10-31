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

### 8. Client, plus the D2 Survival script (one commit; browser look NOT done)
- Client: `pushSlime` sprite (idle, squash, stretch, white hit flash, hp bar) in `fx.ts`; `squelch` and `splat` sounds;
  `EV_ENEMY_HURT/DEATH/ROUND_END` handling and an `ENT_ENEMY` draw pass in `worker.ts`; a dead player in a `death: 1`
  room follows a living teammate and sees "You died. Spectating"; a "The party fell" / "Victory" banner with a
  **New room** button (`POST /api/rooms` with the `SURVIVAL` preset, then navigate); dev-only `?cfg=survival` on
  `/game?world=game&avatar=1` and `__devGotoEnemy()`.
- D2: `survivalScript()` (two players next to real slimes casting Push and Blast, from `config: "survival"`);
  Node D1/D6 test asserts at least 3 `EV_ENEMY_HURT`; browser D2 on Chromium, Firefox and WebKit matches Node.
  Red first: the first two versions of the script produced 0 hurt events (bolt one row high, then casts refused by
  cooldown) and the assertion failed; fixed in the script, not by loosening the assertion beyond `>= 3` (the script
  yields exactly 3).
- Gate green (cargo, clippy, typecheck, determinism including browsers).

## Not done / unverified
- **Not built:** server `round.end` event and room-ended flag (needs a new claim wire message); the net test
  (Survival room via `POST /api/rooms`, two clients agreeing on the hash); `pnpm test:net` was NOT run.
- **Not looked at:** no agent-browser session, no screenshots (checklist item 9 is only this report). The client
  rendering, spectate follow, banner and New-room button have only been typechecked.
- The client changes are untested beyond `tsc`.

## Architectural decisions for review
- **Enemy fields:** `id u16, kind u8, x/y i32, vx/vy i16, hp u16, facing u8, state u8, cooldown_until u32, hop_until u32,
  last_hit_by u32, last_hit_tick u32` (35 bytes). Differences from the design: `id` is u16 (generator ids), `nest`,
  `timer`, `target` are dropped (no nests, target recomputed each step), `hop_until` added. Cost later: the boss
  will want `timer`/`phase`; add fields with a format bump (the game is not live).
- **No id counter:** ids come from the generator and no enemy spawns after init (D-157). Cost: the boss's summoned
  imps would need a counter (`next_enemy_id`) in hashed state, as the design's section 12 warned.
- **Config byte 12 `enemies` 0|1:** backward compatible; reserved bytes are now 13..16. The validator does not
  reject `enemies 1` on non-Caves terrain: it simply places none (placement is in the Caves generator).
- **Stepping rectangle:** computed from `players` (alive, active) in `stepping_set`; nothing reads `grid.awake`. Cap 24
  stepped (lowest ids) and 48 total. Cost: a frozen boss pauses when nobody is near; no leash healing yet.
- **Enemy boxes in `step_projectile`:** appended after player boxes in the same `Box5` list, id tagged with the high bit
  (`ENEMY_BOX`); `impact` branches on the bit. Reversible and small. Cost: an enemy-owned projectile (imp bolts) will
  need `q.owner` tagging and a skip rule; `hit_player` still takes a plain player id.
- **Cause-code range:** `CAUSE_ENEMY_BASE = 40`, `+ kind`. Contact damage uses `apply_damage`, which treats any
  cause >= `NUM_SPELLS` as environmental, so it is gated by `damage_from_env()` (damage >= 1), not by player damage.
  A `damage: 0` room (Creative) would make enemies harmless; there are none there.
- **`dead_until = u32::MAX` for one life:** every reader goes through `alive()` or the respawn test, so nothing else
  changed. Cost: a snapshot carries the sentinel; a future "revive" feature must reset it explicitly.
- **`round_over` and the round-end rule:** hashed u8; loss = at least one active player and none alive; a Leave while
  others live does not end it; a room whose only player leaves (inactive, so `any_active` false) does not end.
  `round_won()` is the boss hook. Enemy stepping and the hazard scan stop once `round_over != 0`.
- **Server room-ended handling:** deferred, see above. Reversible: nothing was half-built.
- **Co-op gate placement:** inside `hit_player`, `explode_at` and the Black Hole pull, keyed on `damage_from_players()`.
  `explode_at` with `owner != 0` from another player now skips that player entirely (no credit, damage or knock).
  Gunpowder (owner 0) still damages and knocks everyone, as environment.
- **Per-tick enemy cost:** 48 slimes all in range, 24 stepped: worst 3600 cells examined per tick, mean about 2970
  (measured by `Sim.enemy_work`, `/tmp/f4-enemy-work.txt` from `enemy_work_is_bounded_and_measured`).

## Slime counts per size (seeds 1-3)
S 7/8/5 (target 8, floor), M 8/8/8 (target 8, the scale gives 12 but the 8 floor and the shallow band bind), L 25/25/25.
The brief's "about 25 at L" holds; M and S are small. Flag: M may want a higher floor.

## FUTURE.md ideas (suggested only)
- Slime idle hop and hop cooldown tuning by playtest; a "bounce off walls" step-up so slimes climb one-cell ledges.
- A round-end claim message (and `round.end` log) once the boss slice defines the win condition.
- Spectator camera cycling (click to follow a chosen teammate) for one-life rooms.

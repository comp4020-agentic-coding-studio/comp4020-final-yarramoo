# Review: F4 (enemies, Slime, co-op gate, one life, round end), `a8e2f3f..70bc25e`

Read-only cold review. No builds or tests were run (another process owns them). Every claim below comes from reading the code.

## Findings

### S1 (should-fix): the co-op gate still records a teammate's Fire bolt as the "last hitter", so a later slime or lava death is credited to the teammate

`sim/src/spells.rs` `fire_bolt_hit` (about line 434) sets `last_hit_by` and `last_hit_tick` on the victim before `apply_damage` refuses the damage. Unlike `hit_player` and `explode_at`, it was not given the D-158 gate.
- Scenario: in a Survival room, A fires a bolt at B. B takes no damage, but `B.last_hit_by = A`. Within 300 ticks B dies to a slime (cause 40) or to lava. `apply_damage` credits the kill to A, so the death toast reads "A sent B into lava" and the server bumps A's kill stat. The server then grants `first_blood` and `five_kills`. Two cooperating players can farm those achievements without PvP.
- The bolt is also consumed by the teammate's body, as Push is.
- Fix: in `fire_bolt_hit`, return early when `victim != owner && !self.cfg.damage_from_players()`. Better, gate it at the `impact` call site so the bolt can pass through teammates. Add a test: co-op, A bolts B, B dies to lava, assert `EV_DEATH.a == 0`.

### S2 (should-fix): a player can get a new life in a `death: 1` room by getting a new identity

`sim/src/sim.rs:275-301` `join`: an existing dead id stays dead. Join sets only `active = true` and leaves `health` at 0 and `dead_until` at `u32::MAX`. So same-id rejoin and reconnect are NOT a bypass.
- Gap: a brand-new visitor id (cleared localStorage or token, or a second name) takes the `Err(at)` path and gets `Player::new`, which is full health and alive. The same holds for any id that joins after `round_over == 1`.
- Scenario: in a two-player Survival room, A dies. A clears storage, registers a new name and joins as id 9, alive. The round is not lost because 9 is alive.
- Scenario: after `EV_ROUND_END`, a late joiner is alive in a room whose enemies are frozen forever (`update_enemies` returns when `round_over != 0`), and nothing tells them the round is over.
- The sim cannot link ids to people. The honest fix is a rule: with `round == 1`, `join` of a NEW id after the first tick of play, or after `round_over`, spawns it dead (or refuses it). Alternatively the server refuses new ids in an ended room.
- Whichever is chosen, record it. If this is accepted as out of scope, put it in `docs/DECISIONS.md` as a known limitation.

### S3 (should-fix): the round-end rule ends the round when the last LIVING player leaves, which contradicts the doc comment and the worker's claim

`sim/src/sim.rs` `check_round_end`: `lost = any_active && !any_alive`.
- Scenario: A is dead (still `active`, spectating) and B is alive. B's connection drops or B closes the tab. The server stamps `Leave(B)`. Now `any_active` is true (A, dead) and `any_alive` is false, so `EV_ROUND_END` fires and `round_over` is hashed.
- B reconnects to a lost round and cannot continue. The comment says "a player who leaves does not by itself end the round (a reconnect must find it running)". That holds only when no dead-but-active player remains.
- Fix: count only players who are alive or who left alive. Simplest: a loss needs every player in `players` with `health == 0` (ignoring `active`) and at least one such player. Tie it to "everyone who has ever joined is dead", which is also the D-160 wording ("every player who has joined is dead"). A leaver who was alive then blocks the loss.
- Side effect: a room whose last alive player left and never returned stays open, which is harmless. Test it: dead A, alive B, Leave(B), assert `round_over == 0`.
- Related: a dead player who leaves (`active` false) is not counted by the current rule, so "A dead and gone, B alive, B dies" does end the round. That case is correct.

### S4 (should-fix): the round banner is lost for anyone who isn't watching live

`client/worker.ts` EV_ROUND_END handler: `if (!quiet) send(...)`. `round_over` is hashed state, but the client never reads it.
- A client that is catching up, fast-forwarding or reconnecting never sees the one-shot event, so it gets no banner and no "New room" button. It also sees no reason why the slimes are frozen.
- Fix: expose `round_over` in the entities view or the player view (for example as a flag on an existing record), and show the banner from state, not from the event. At minimum, show the banner from state on join.

### S5 (should-fix, minor): the server never marks an ended room, so it stays in the public list and joinable

The `round.end` server handling is deferred (commit message `de42066`). A lost Survival room stays public and joinable. Combined with S2, a stranger can walk into a dead world. Log the gap in `FUTURE.md`, or hide ended rooms from `GET /api/rooms`.

### N1 (nit): a projectile can be consumed by an enemy that already died this tick

`spells.rs` `update_projectiles` builds `boxes` once. A slime reduced to hp 0 by an earlier bolt in the same loop stays in `boxes` until `reap_enemies` runs at the end. A second bolt then stops on the corpse: `damage_enemy` returns early at hp 0, but `knock_enemy` and the bolt's consumption still happen. Fix: skip enemy boxes whose `hp == 0` in `step_projectile`, or refresh the boxes after a kill. Low impact.

### N2 (nit): the embedded-rescue work is not covered by the work-count test

`enemy.rs` `step_enemy`: a buried slime runs up to `ENEMY_RESCUE_CELLS` (64) calls of `enemy_blocked` at up to 20 cells each, so about 1300 cell reads per enemy per tick, repeated every tick while it stays buried. At 24 stepped enemies that is about 31k cell reads per tick worst case. This is bounded, and cheap in absolute terms, but `enemy_work_is_bounded_and_measured` only runs 48 free-standing slimes and asserts under 9600. Add a buried-slimes case (24 buried, assert the worst tick) so the bound that matters is the one measured. Optionally freeze a slime after a failed rescue instead of retrying every tick.

### N3 (nit): decode accepts enemies in rooms with `enemies == 0`

`entities::decode` does not check `cfg.has_enemies()`, and `update_enemies` steps any non-empty list. Snapshots are verified by consensus so this is not exploitable, but a hostile snapshot of a Deathmatch room could carry slimes that then hurt players via cause 40 (`damage >= 1`). Reject `ne > 0 && !cfg.has_enemies()` in `restore`.

### N4 (nit): kill-toast and cause text for slime deaths

`client/toasts.ts` `formatDeath` falls to `${v} died` for cause 40+. There is no crash: the spell-index, `CAUSE_*` and else branches are all safe, and `SHOVE_CAUSES` does not include 40 so no achievement is granted. A line such as "slain by a slime" would be better. `server/achievements.ts` `onDeath` is also safe with 40. `claim` carries cause as u8, and 40 fits.

### N5 (nit): other small items
- `client/worker.ts` hard-codes `e.a / 20` for the hp fraction. Take it from the kind's max hp, or put `max_hp` in the view.
- `client/room.ts` banner: the New room POST always uses `visibility: "public"`, even from an unlisted room. The API shape (`name, mode, config` base64, `visibility`) matches `server/main.ts` and `client/menu.ts`. The server accepts a base64 config of any length other than 32 hex characters, so the 16-byte base64 string is parsed correctly. A 429 maps to the rate-limit message, as in the server.
- `sim/tests/bags.rs` and `config_state.rs` loops no longer try version 8 (previously 7 was the "future" version). Add `8` to the refused list so a future-version refusal stays covered.
- Entity-view order puts enemies last. `MAX_ENTITIES` is 1600, so truncation would drop enemies first. Fine at today's counts.

## Answers to the specific questions

1. **D7. Fine.**
   - No enemy code reads `grid.awake`. `stepping_set` and `alive_targets` read only `players` (alive and active) and `enemies`, both hashed.
   - Enemy cell reads (`enemy_blocked`, `enemy_hazard_scan`) read `grid.mat`.
   - Maximum motion per tick is `ENEMY_MAX_SPEED` = 128 units = 8 cells per axis. The step-rect to active-rect margin is 64 cells horizontally and 32 vertically, before chunk rounding. A slime that starts inside the rect therefore cannot reach a frozen chunk within a tick.
   - Even if it did, reading a frozen chunk is harmless: frozen chunks are determined by player positions, not by sleep flags, so they are identical with sleep on and off. Sleeping chunks inside the active rect hold the same contents either way (invariant 8), so reads there are fine.
   - The iteration order is deterministic: enemies in id order, targets in player-id order, nearest-player ties go to the lowest id (strict `<`).
2. **Bounded work. Fine.**
   - `MAX_ENEMIES` 48 and `MAX_ENEMIES_STEPPED` 24 are enforced (decode refuses more than 48, `stepping_set` stops at 24).
   - The per-enemy loops are bounded: the move loop does at most 8 one-cell steps per axis plus the wall-hug loop, and the rescue is at most 64 tries (N2).
   - The projectile loops cost at most 8 substeps x (players + 48 boxes) per bolt, with at most 256 bolts. The `explode_at` and `blast` enemy loops are at most 48 iterations each.
   - Contact is at most 24 enemies x players.
3. **Snapshot. Fine.**
   - Format 7 appends the enemy count, the enemies and `round_over` to the entity bytes, after the bags. The hash covers the same bytes, because `state_hash` uses `entity_bytes`.
   - `snapshot::size` is `write().len()`, so it cannot drift.
   - `server/world.ts` `activePlayersIn` reads only the player section at the fixed offset after the 70-byte header. Players come first, so it is unaffected.
   - Hostile-bytes tests (`enemies.rs`) cover an over-cap count, `u32::MAX`, count/length mismatch, truncation, a trailing byte, an unknown kind, x out of the world, hp 0 and `round_over == 2`. `bags.rs` and `spells.rs` offsets were updated correctly (`-5`).
   - `Base` caching includes enemies. Config bytes include `enemies`, so a base cannot cross-match.
4. **Co-op gate.** Push (`hit_player`), the Blast cone (`hit_player`), the Bomb explosion (`explode_at` skip), the Black Hole pull and flask bursts (terrain only) are all covered, except for the Fire-bolt credit (S1). Gunpowder (owner 0) hitting everyone, and an owner's own bomb still knocking the owner, are consistent.
   - Side effect: in `damage: 1` rooms a caster takes no damage from their own Bomb or Fire bolt, because `apply_damage` treats spell causes as player-caused.
   - Indirect harm via fire or oil under a teammate, or lava and acid flasks, is environmental damage and is allowed by design. Push and Fire bolt still stop on a teammate's body, which is mildly griefable but harmless.
5. **One life.** Same-id rejoin and reconnect cannot bypass it (`join` keeps health 0 and `dead_until = u32::MAX`; `Pos` is ignored while `health == 0`; D-078 life baselines never move because `life` never increments). A new identity can (S2).
6. **Round end.** It fires exactly once, because `round_over` is hashed and checked first. Solo death and two players both dying end it. The "one dies, other leaves" case does end it, contrary to the worker's claim (S3). Enemies stop after `round_over` (both `update_enemies` and `enemy_hazard_scan` return). Players, projectiles and the grid keep stepping, which is fine. A room with everyone gone never ends, which is acceptable.
7. **Contact cause 40.** `apply_damage` takes the `else` branch (`damage_from_env`, `damage >= 1`), so a Creative (`damage: 0`) room takes none. Toasts and achievements are safe (N4).
8. **Determinism.** No floats in `sim/src/enemy.rs`, `entities.rs`, `gen.rs` or the `spells.rs` additions. No `HashMap`. All hashed integers are fixed-width (`as u32` on lengths; `i16` velocities written through `to_le_bytes`). New salts 240, 241, 242 and 243 are unique among `SALT_*` constants (checked by scanning `rng.rs`; the `COAL_BURN` 240 in `grid.rs` is an aux value, not a salt). The idle draw uses `(tick, id, 1)` and the hop draw `(tick, id, 0)`, so even a shared salt would not collide.
9. **Test weakening.**
   - The re-pointed expectations in `bags.rs`, `spells.rs` and `config_state.rs` are faithful: they move offsets by the new 5 bytes, bump the format constant, and keep the old versions refused. The only loss is the future-version check (N5).
   - Tests that pass when the code is stubbed (the D7 slime test, the work count, the frozen tests) need a mutation to bite:
     - D7: the repo has a `canary` feature. Add a canary that makes `stepping_set` skip enemies in chunks where `!grid.awake`. Show `d7_sleeping_is_invisible_with_slimes...` red under it. Also assert in the test that some chunk in the arena is actually asleep with sleep on while a slime stands in it. The arena marks every chunk awake at the start, and 900 ticks may not be enough for them to settle, so the test may compare two identical runs.
     - Work count: add the buried case (N2) and assert a tighter bound (such as the measured worst plus slack) so a regression doubling the work fails.
     - Frozen tests: assert, in the same test, that the same slime DOES move when the rect is widened or the player is moved closer (a control), so a stub that never steps anything can't pass.
10. **Client.** The slime sprite, hp bar, squelch/splat fx, spectate camera and banner read only the render views, `EV_*` events and `cfg`, and send nothing to the sim, so it is render-only (invariants 1 and 9). `enemySeen` is render state only. The New room button uses the real create API shape (see N5 for the visibility caveat). See S4 for the banner-from-event problem.

## Checked and found fine
- `cfg.encode`/`decode` for byte 12; `round == 1` requires `death == 1`; reserved bytes 13..15 enforced; TS and Rust vectors agree (`SURVIVAL_HEX`).
- `update_projectiles` order: enemy boxes come after player boxes, so players are hit first.
- `reap_enemies` after each source; ids are looked up by binary search, never by stale index, and loops iterate by index over a fixed length.
- Enemy generation: integer-only, bounded by 6000 tries, bodies must be all Empty, kept away from pickups and from the spawn zone.
- Embedded rescue never writes the grid, so it cannot cause a wake-state change.
- `check_round_end` runs only when `cfg.round == 1`, so Deathmatch and Creative are unaffected.
- Hazard scan reads only the enemy's own hitbox cells; frozen enemies take no hazard damage.

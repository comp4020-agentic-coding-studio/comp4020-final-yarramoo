# Review of F6b (Survival ready-up lobby), 98856d0..2125d71

Read-only review: git, grep and reading only. Nothing was run. "Confirmed" means read in the code; "suspected" means inferred.

## Verdict
No blockers. Four should-fixes and several nits. The countdown is pure hashed state with a single start tick. The boss-win bit and the snapshot v9 follow-through are intact.

## Confirmed correct
- Countdown is hashed state: `Player.ready` is in `Player::encode` (entities.rs) and `lobby_since` is in `round_tail()`, so `entity_bytes` and the hash cover both. `update_lobby` runs after the tick's inputs and reads only sim state.
- Start tick: `lobby_since = tick` on the first all-ready update, and the round starts when `tick - lobby_since >= 180`. This is the same tick on every client. `LOBBY_IDLE = u32::MAX` is safe with `wrapping_sub`, because it is only compared after being reset.
- Reset paths: un-ready (`update_lobby` sees `!all` and sets idle), Join (new or rejoin, sim.rs `join`), Leave (sim.rs apply). A disconnect mid-countdown goes through the server-stamped Leave, so it is covered. Zero active players gives `active == 0`, which sets idle, so a room never starts empty.
- Ready cannot be forced for another player. The server stamps `joined.playerId` (main.ts, `stampClient`). The sim also ignores Ready from an unknown or inactive player, and outside the lobby. Spectators hit `spectator_input` before reaching the Ready branch.
- Casts are dropped in the lobby (`apply`). `apply_damage` is gated. `update_enemies` and `enemy_hazard_scan` return early. Pickups are skipped. The loss rule is inert in `check_round_end`. The only direct `p.health` writers are `apply_damage` and `respawn_player` (grep).
- The boss win bit survives. `reap_enemies` sets `ROUND_BOSS_KILLED` (bit 1), and `round_won` reads it. `lobby.rs` pins `RUNNING | BOSS_KILLED`. The hostile-decode limit `round[1] > 3` still allows bit 1.
- Late arrival: `join` uses `!in_lobby()`, so a new id after the start or the end joins dead. A rejoin keeps its state (pinned by a test).
- Snapshot v9: `FORMAT_VERSION` is 9 in snapshot.rs and `SNAPSHOT_FORMAT_VERSION` is 9 in db.ts. `PLAYER_RECORD` is +9 (the ready byte), and `activePlayersIn` reads only the `active` byte at o+4, so the layout is intact. `encode`/`decode` use `ROUND_TAIL_BYTES` consistently. `decode` rejects `ready > 1` and "running with a live countdown".
- Server `KIND_READY`: accepted only when `cfg.round === 1`, with length 1 and value <= 1. It is counted via `counts.ready()` into `input.summary.readies`, with no per-input log line. The rate limit applies first.
- Determinism `LOBBY_SHIFT`: Ready at tick 2 starts the countdown at tick 2 and the round at tick 182. Every input at t>=2 moves to t+190, which leaves 8 ticks of slack. Hashes are compared per tick across engines, so the comparison stays valid.

## Findings

### S1 should-fix: the lobby is a free depth and cast-achievement farm (confirmed in code)
`server/main.ts:~1146-1160`. The server does not know the phase. Pos in the lobby is accepted and feeds `playerStats.max(STAT_MAX_DEPTH)` and Spelunker. Enemies are inert, and nothing hurts in the lobby.
- Failure: a player walks to the bottom of the cave at no risk, as long as the lobby lasts. The speed baseline in `PosBaselines` bounds the walk rate but not the total, because the lobby has no time limit.
- Casts are counted into `castStat` and `achievements.onStat` even though the sim now drops them. Cast-count achievements can be farmed by spamming Cast in the lobby. The server already counted casts the sim rejected, but the lobby makes it free and guaranteed.
- Fix: either clamp or ignore Pos in the lobby in the sim (see S2), or stop crediting depth and cast stats until the round runs. The server could track "running" from the `EV_ROUND_START` it sees, or from the last snapshot's round bytes.

### S2 should-fix: Pos is unrestricted in the lobby, so a player can pre-position (confirmed; the worker flagged it as reversible)
`sim.rs` `Input::Pos`. A player can wait in the lobby and walk right to the pickup piles or the boss arena before the start. The worker is correct that nothing can be taken or hurt there. But on the start tick everyone is where they chose, and pickups unlock at once. A player at the supply pile takes first pick.
- Fix (cheap, deterministic): in the lobby, ignore Pos or clamp it to a spawn radius in `apply`. Or reset all alive players to their spawn point on the start tick.

### S3 should-fix: one AFK or unready player blocks the room forever (confirmed by design)
`update_lobby` requires every *active* player to be ready. There is no timeout and no kick. An idle tab, or a player who toggles Ready off, holds everyone.
- Fix options: the host or any player can force-start after N seconds, or an unready player with no input for T seconds is dropped. At minimum the client should show who is not ready (`ENT_READY` already exists).

### S4 should-fix: the re-pointed tests bypass the lobby entirely (confirmed). Acceptable, but a gap remains
About 60 tests set `round_started |= ROUND_RUNNING` straight after Join. I sampled the diffs for boss.rs, boss_phases.rs, boss_win.rs, enemy_ai.rs (7 sites), enemy_acid.rs, enemy_bolts.rs, enemy_damage.rs, enemy_imp.rs, enemy_worm.rs, one_life.rs, bags.rs, spells.rs, enemies.rs and players.rs. Every change is one added line, a `[0; 3]` to `ROUND_TAIL_BYTES` swap, or an offset fix (`b.len() - 7` becomes `4 + ROUND_TAIL_BYTES`). I found none weakened.
- `enemies.rs`: the old `r[l-1] = 2` poked the `round_result` byte, and the new `r[l - ROUND_TAIL_BYTES + 2]` pokes the same byte. The test label says "round_over 2" but writes the result byte, which is a pre-existing mislabel.
- `boss_win.rs`: `s.round_started = ROUND_RUNNING` replaces `= 0`, with the comment "no boss-win bit yet". Same intent.
- `one_life.rs` late-joiner rewrite: the old "joiner after a first death or first kill spectates" cases are gone, because that mechanic was deliberately replaced. The new test still covers "a joiner in the lobby is alive" and "a joiner once running is dead". It also sets `round_started = 0` after `room()` to get back to the lobby, which is a state hack, but the countdown path itself is covered by `lobby.rs` (`after_the_start_a_new_id_joins_dead...`). The "after round_over: dead" part is unchanged.
- Gap: `the_round_state_is_in_the_view_the_snapshot_and_the_hash` forces RUNNING, so it no longer shows that a death does not start the round. `lobby.rs::a_first_kill_or_death_no_longer_starts_a_round...` covers that, so this is a nit.
- The forced state is internally consistent (`lobby_since` idle, `ready` 0), so no real path is hidden. I did not check whether any one test accidentally relied on the old flag-0 behaviour, such as a late joiner spectating.
- Determinism: the "same fight" wording is loose. The 190 lobby ticks still run `step_cells`, so sand, water and lava move for 190 ticks before the fight, and tick-keyed rng differs. Enemies and pickups are frozen, so scripted positions read at tick 0 stay valid. The claim "the same fight" is approximate, but cross-engine equality is still tested (suspected-correct; I did not run it). The wording in `helpers.ts` should say "equivalent", not "same".

### N1 nit: hostile decode does not reject a countdown that lies in the future (confirmed)
`entities.rs` decode. It only rejects "running with `since != IDLE`". A lobby snapshot with `lobby_since` far ahead of the tick gives `wrapping_sub` a huge value, so the round starts on the next step. `lobby.rs` claims in a comment to cover "in the future of the snapshot tick" but only tests IDLE. Snapshots are majority-hash verified, so the risk is low. Fix: decode does not know the tick, so check it in `snapshot::restore` (`since <= tick` or IDLE), and add the test the comment promises.

### N2 nit: a non-lobby or inconsistent tail is accepted (confirmed)
- `round_started == 2` (boss bit, not running) decodes, but in the lobby `check_round_end` is skipped, so a win would be deferred.
- A non-`round == 1` room can carry a non-idle `lobby_since` or `ready == 1`. These are hashed, so a mismatch is caught, but it is not rejected cleanly.
- Fix: reject `BOSS_KILLED` without `RUNNING`, and reject `ready` and `lobby_since` when `cfg.round != 1`.

### N3 nit: world explosions are not gated in the lobby (suspected, not traced)
`damage_enemy` has callers at spells.rs:198, 425, 445 and 732 and enemy.rs:638. Only enemy.rs:638 is behind `in_lobby`. Gunpowder or a lava reaction in the lobby could kill an enemy, or the boss, via spells.rs:732 (`explode_at`). `reap_enemies` would then set the boss bit in the lobby. The win would fire the instant the round starts. Extremely unlikely, but cheap to gate: `if self.in_lobby() { return; }` at the top of `damage_enemy`.

### N4 nit: a spurious Leave restarts the countdown (confirmed)
`sim.rs` Leave. `lobby_since` is reset even when the player was already inactive. Only the server stamps Leave, so it is unlikely. Fix: reset only on an active to inactive change.

### N5 nit: the Join that ignores the player count
`join` clears `ready` and the countdown even for a rejoin in a running round. This is harmless because `lobby_since` is already idle.

## Not checked
No tests were run, and the client (commit 4) is not in this diff. `tests/net/lobby.test.ts` was not read line by line.

# F6b worker report: the Survival ready-up lobby (D-166)

Status: commits 1-3 done and gated; commits 4 (client) and 5 (screenshots) NOT started (tool budget). Until commit 4 lands the client has no Ready control, so a Survival room (including the dev route) stays in the lobby.

## Commit 1: sim
- `Input::Ready` (kind 6, 6 bytes, ready 0/1), `Player.ready` (hashed, snapshotted), `Sim.lobby_since` (hashed, in the round tail), `ROUND_RUNNING` = bit 0 of `round_started`, `EV_ROUND_START` (15), `ENT_READY` (7) view records, `ENT_ROUND.x` = countdown ticks left (-1 idle).
- Lobby rules: `in_lobby()` gates Cast, damage (`apply_damage`), enemy stepping and hazard scan, pickups, the loss rule.
- Snapshot FORMAT_VERSION 8 -> 9; `server/db.ts` label and `PLAYER_RECORD` (activePlayersIn) follow.
- Tests: `sim/tests/lobby.rs` (21 tests, real seed 1 terrain), input decode tests, boss tests re-pointed to set `ROUND_RUNNING` after joining (they test the fight).
- Red-first: the new tests could not compile/run before the feature (new API); the `countdown_179` test was red on first run for an off-by-one in the test (fixed in the test, expectation tied to the exact tick: round starts on the step run at tick begun+180).

## Architectural decisions for review
- Phase representation: no new phase byte. Lobby = `cfg.round==1 && round_started bit0 == 0 && round_over == 0`; Running = bit 0; Over = `round_over`. `lobby_since` u32 (idle = u32::MAX) hashed. Alternative: phase byte. Cost for F7: achievements can key on `ROUND_RUNNING`; a phase byte would be clearer for Deathmatch.
- `round_started` bit 0 now means "countdown completed" (D-161's first-kill flag is gone; kills/deaths no longer set it). Bit 1 boss win unchanged and pinned by a test.
- Lobby movement: players move freely (Pos still accepted); reversible vs freezing. They cannot cast or be hurt, so nothing is gained by moving.
- Countdown resets on: un-ready, any Join (new or rejoin; rejoin clears ready), Leave. Active-count changes reset through those.
- Snapshot bump 8 -> 9 (game not live).

## Commit 2: determinism
- `tests/determinism/helpers.ts`: `lobbyAt` sends Ready (tick 2) from every player, and shifts every later input by `LOBBY_SHIFT` = 190 (round starts at tick 182). Scripts run `+190` ticks. Hashes are compared per tick, so equal hashes still mean the same fight, shifted by exactly 190 ticks. No check weakened.
- Gate: 53 determinism tests pass (Node + Chromium, Firefox, WebKit).

## Commit 3: server and shared
- `KIND_READY` accepted in `server/main.ts` only when `cfg.round == 1`, payload length 1, value 0 or 1, from a joined non-spectator (spectators hit the existing `spectator_input` reject). Counted in `input.summary` as `readies`. The player id is stamped from the connection.
- `tests/net/lobby.test.ts` (4 tests): two clients start on the same tick, same hash; a late spectator adds no player and its Ready is refused; Ready refused in deathmatch; bad value refused in Survival.
- No new event name, no room-list badge, no server stepping (optional items skipped).
- Gate: cargo all green, clippy, typecheck, determinism 53, net 318 (run at the commit).

## Not done
- Client lobby overlay, R key, countdown, toast/sound, late-arrival panel, dev-route auto-ready (commit 4); two-browser screenshots (commit 5). The sim/view are ready for them: `ENT_ROUND` (`x` = countdown ticks left or -1, `health` bit 0 = running), `ENT_READY` records while in the lobby, `EV_ROUND_START`.
- Late arrival: the sim joins a late new id dead (D-161 mechanic, keyed on the phase). The pure-spectator choice for the panel is a client change, still to do (prefer `opts.spectate`).
- Hostile snapshot: also rejects "running with a live countdown".

## FUTURE.md ideas (suggested)
- Show "lobby" / "in progress" in the room list from the last snapshot's round bytes.
- Server log event for round start, derived from stamped Ready inputs.

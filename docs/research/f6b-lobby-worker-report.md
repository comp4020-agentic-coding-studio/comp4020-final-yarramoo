# F6b worker report: the Survival ready-up lobby (D-166)

Status: all five commits done. Commits 1-4 gated (cargo, clippy, typecheck, determinism 53, net 318).

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

## Commit 4: client
- Worker: reads `ENT_ROUND` (`x` countdown ticks left, `health` bit 0 running) and `ENT_READY` records into a `lobby` field of the `players` message; `Ready` toggle message sends `KIND_READY` (server) or pushes `Ready` (local); `EV_ROUND_START` posts a "Descend!" toast and a new `descend` sound.
- Dev route: the dev avatar pushes `Ready` right after its Join when `cfg=survival`, so the round starts 3 s after load. Checked in the browser: overlay shows "2", `Descending...`; after the start `__devGotoEnemy(4)` placed the avatar beside the boss, `__devBossHp(300)` showed the boss bar at 300/800, `__devGoto(4)` ran. (The avatar then died to the boss: "The party fell" banner, unchanged.)
- Overlay: plain names, a tick per player, "Waiting for N" or a 3-2-1 count, a one-line description, a Ready button and the R key.
- Late-arrival panel: when my first appearance in the sim is dead while the round is Running, Spectate / Find another room / Start a new room.

## Commit 5: two-browser look (screenshots in docs/art/shots/f6b-*.png, each viewed before citing)
- Real server (8123) behind a throwaway proxy in /tmp (see "Found"), Vite-built client. Ada and Bo in one Survival room: Ada readied, Bo readied; both screenshots show the overlay with both ticks ticked and the countdown ("2" for Ada, "1" for Bo, one frame apart: the shots were taken about 0.3 s apart). Bo's later shot shows the "Descend!" toast and no overlay. Third session Cy after the start: the late-arrival panel. Clicking Spectate reloads with `?spectate=1`: panel gone, no avatar.
- Not checked in the browser: R key release on a held key, the Find/Start buttons (code only), sound audibility (headless).

## Found
- The production server serves `/r/<code>` with relative asset paths (`./assets/...` resolves to `/r/assets/...`, 404), so a room page is blank when served by `server/main.ts` directly. I did not change it (out of the brief's file list) and used a proxy that strips `/r/`. Worth checking whether this is already known or the Docker build differs.
- `Who (3)` after Cy chose Spectate: Cy's first connection already joined and the sim made a dead player. Spectate as `?spectate=1` is a pure spectator for the next connection, but the dead record from the first remains. Harmless to the loss rule (everyone-dead test) but visible in the list.

## Architectural decisions (client, added)
- Spectate = reload with `?spectate=1` (pure spectator connection) rather than staying as the dead player. Alternative: stay dead (no reload, no flash, but the dead player counts as a player). Cost: the dead record from the first join stays until the server's own cleanup; a cleaner fix needs the choice before the join (a pre-join check from the room list/snapshot round byte), which pairs with S5 and the room-list badge.
- The late check runs once per connection, when my player first appears (`mine.health == 0` while Running). It cannot fire for a rejoin that keeps its state.

## FUTURE.md ideas (suggested)
- Show "lobby" / "in progress" in the room list from the last snapshot's round bytes.
- Server log event for round start, derived from stamped Ready inputs.

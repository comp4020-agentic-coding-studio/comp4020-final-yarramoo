# Owned sandbox: a player's own persistent world (Opus lead report, 8 Nov)

Brief: `docs/briefs/owned-sandbox.md`. Branch `owned-sandbox` (worktree `/tmp/wt-owned`), not pushed. Written as the
work went.

## Budget
- B0 (start): $315.13 week spend. Stop dispatching at $347.13, finish by $355.13.
- After the server slice and its red-first runs: $322.24.

## Design (decided by the lead)
- **Data model**: migration 9 (`user_version` 9) adds `rooms.owner_player_id integer references players(id)` and a **partial unique
  index** `rooms_owner on rooms(owner_player_id) where owner_player_id is not null`. One owned room per player is a
  database fact, not only a lookup. `creator_player_id` is set too (it was always null before: `POST /api/rooms` is
  anonymous). Every other room has a null owner and is unchanged.
- **Config**: always `CLASSIC_SANDBOX` (512 x 512 empty box, brushes), the same as `/sandbox`. Not configurable: the
  smallest world costs the least memory per loaded slot, and the brief's user decision is "a sandbox".
- **Visibility**: always `unlisted` (link-only) and excluded from `listPublicRooms` even if that ever changed. The
  simpler choice: no "make public" toggle, no moderation question for a world that lives forever.
- **Name**: "<owner's plain name>'s world" (cleaned name, at most 24 characters, plus 8, fits the 32-character room
  name). Plain name only; `name#id` goes to the log (`room.created` `owner` field).
- **Sweep**: `staleRooms` skips `owner_player_id is not null`, so neither the minute sweep nor the boot sweep can
  delete one. `deleteRoom` also refuses an owned room unless the reason is `"owner"` (second layer).
- **Unload**: an empty owned room's unload timer only unloads it (shutdown flushes, `worlds.delete`, `room.unloaded`),
  keeping every row; the next HELLO lazy-loads it through the existing `getOrLoadRoom` (snapshot + tick log).
- **Delete**: `DELETE /api/sandbox/:code`, owner only. Members are closed with a new close code **4003** ("world
  deleted"), then the existing one-transaction `RoomsStore.deleteRoom` removes snapshots, tick log, incidents, the
  world row and the room row. The link then 404s; a fresh create afterwards gets a new code and a new seed.
- **Non-owner**: can join and paint (the room is an ordinary sandbox room), cannot delete (403), cannot rename
  (there is no rename).
- **Owner kept from eviction**: creating an owned room stamps the owner's `players.joined_at`. Without it,
  `evictUnjoined` (registrations that never joined a game world) would try to delete a player a room row references,
  the foreign key would throw, and registration at the cap would fail. A sandbox-only owner never "joins" in the D-069
  sense, so this matters.
- **Log growth**: a sandbox world is snapshotted every `SNAPSHOT_EVERY_TICKS` (1800, a minute at 30 Hz) while
  someone is in it, and `prune` keeps 5 snapshots and drops the tick log before the oldest. An empty world adds no
  ticks (the clock pauses on the last leave), so an owned world idle for days does not grow at all; in use it holds
  at most about 5 snapshots and 5 minutes of log, the same as any room.

## API
| Verb | Path | Auth | Result |
|---|---|---|---|
| GET | `/api/sandbox` | Bearer token | 200 the caller's world, 404 none, 401 unknown token |
| POST | `/api/sandbox` | Bearer token, same origin | 201 created / 200 existing (idempotent); 429 per-IP hourly limit (shared with `POST /api/rooms`) |
| DELETE | `/api/sandbox/:code` | Bearer token, same origin | 200 deleted; 403 not the owner (or an unowned room); 404 unknown; 409 a load in flight |
| GET | `/api/rooms/:code` | none | now also `owned: boolean` |

Events: `room.created` (with `owner`), `room.deleted` (`reason: "owner"`), `room.unloaded`, and a new
`room.delete_refused` (rate limited per IP tag), `room.create_rejected` with `owned: true` for refusals.

## Tests (`tests/net/owned-sandbox.test.ts`, six) and red-first evidence
All six fail with the server change stashed (`/tmp/owned-red.log`: 6 failed), but that only shows the route is new.
Each guard was then broken alone, with the rest of the change in place:

| Guard broken | Test that went red | Log |
|---|---|---|
| empty owned room deleted instead of unloaded (`scheduleUnload`) | unloads when empty ... reloads | `/tmp/owned-red-unload.log` |
| no owner check on DELETE | a non-owner ... not delete it (403) | `/tmp/owned-red-owner.log` |
| sweep exemption **and** `deleteRoom`'s owned refusal removed | survives the sweep ... | `/tmp/owned-red-sweep2.log` |
| same, with the restart booting a day later | survives the sweep; survives a restart | `/tmp/owned-red-restart.log` |
| all three one-per-player layers removed (route lookup, `ensureOwned` lookup, unique index) | one per player | `/tmp/owned-red-idem3.log` |

Removing only one layer of the sweep (`/tmp/owned-red-sweep.log`) or of one-per-player (`/tmp/owned-red-idem2.log`)
stays green: the other layer holds. That is by design, and the table above shows the tests themselves can fail.

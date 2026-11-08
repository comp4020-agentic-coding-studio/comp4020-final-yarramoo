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
- **Owner kept from eviction**: `evictUnjoined` skips any player who owns a room. Without it, eviction (registrations
  that never joined a game world, D-069) would try to delete a player a room row references, and the foreign key throws
  (shown: `FOREIGN KEY constraint failed`). *Correction:* the first version stamped the owner's `joined_at` at create
  instead; the cold review (N1) pointed out that this hid the coupling and pinned registrations with no bound. Replaced
  by the explicit exclusion plus a total cap, `MAX_OWNED_ROOMS = 200` (503 `owned_cap`).
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

## Tests (`tests/net/owned-sandbox.test.ts`, eight) and red-first evidence
All six fail with the server change stashed (`/tmp/owned-red.log`: 6 failed), but that only shows the route is new.
Each guard was then broken alone, with the rest of the change in place:

| Guard broken | Test that went red | Log |
|---|---|---|
| empty owned room deleted instead of unloaded (`scheduleUnload`) | unloads when empty ... reloads | `/tmp/owned-red-unload.log` |
| no owner check on DELETE | a non-owner ... not delete it (403) | `/tmp/owned-red-owner.log` |
| sweep exemption **and** `deleteRoom`'s owned refusal removed | survives the sweep ... | `/tmp/owned-red-sweep2.log` |
| same, with the restart booting a day later | survives the sweep; survives a restart | `/tmp/owned-red-restart.log` |
| all three one-per-player layers removed (route lookup, `ensureOwned` lookup, unique index) | one per player | `/tmp/owned-red-idem3.log` |
| `evictUnjoined` without the owner exclusion | owner not evicted (FOREIGN KEY constraint failed) | `/tmp/owned-red-evict.log` |
| no `MAX_OWNED_ROOMS` check | total is capped | `/tmp/owned-red-cap.log` |

Removing only one layer of the sweep (`/tmp/owned-red-sweep.log`) or of one-per-player (`/tmp/owned-red-idem2.log`)
stays green: the other layer holds. That is by design, and the table above shows the tests themselves can fail.

The migration tests in `stats.test.ts` and `achievements.test.ts` pinned `schemaVersion` 8; they now pin 9 (a pin
moving on purpose, caught by the first gate's net step: `/tmp/owned-g-net.log`).
Menu router: the worker showed `#mine` red (2 failed) then green (14 passed); see `owned-menu-worker-report.md`.

## Gates
1. Server slice, full tier (`shared/events.ts`): cargo, clippy, typecheck, determinism 53/53 green
   (`/tmp/owned-g-{cargo,clippy,tsc,det}.log`); net red on the two schema-version pins (`/tmp/owned-g-net.log`), so the
   chain did not commit; pins moved, net rerun 504 passed / 1 skipped (`/tmp/owned-g-net2.log`), committed `8662a55`.
2. Menu + review fixes, full tier (`client/worker.ts`): cargo, clippy, typecheck green, determinism 53/53, net 508/508
   (`/tmp/owned-g2-*.log`), committed `b7cd4b9`. It ran while the slow-net lead's throttled browsers had the load at
   ~150-280; nothing went red, so no quiet rerun was needed.
3. `APP_URL=http://localhost:8077 pnpm check` against the final build: exit 0 (`/tmp/owned-check.log`). API smoke on
   the final build: create 201, again 200, a non-owner's DELETE of Mitch's world 403 (`room.delete_refused not_owner
   who Smoke#7`), owner DELETE 200 (`room.deleted reason owner who Smoke#7`); Mitch's world still 200 after two
   restarts.

## Two browsers and a restart (my own server, `PORT=8077 DATA_DIR=/tmp/owned-data`)
Port 8076 from the brief was taken: the slow-net lead's `tests/soak/slow-net.ts` listened on `127.0.0.1:8076`, so
requests to localhost would have reached it, not this server. Moved to 8077. Screenshots read:
- `/tmp/owned-shot-2-world.png`: "My world" after Create: "MITCH'S WORLD", code, link, Copy, Enter, Delete world.
- `/tmp/owned-shot-4-owner.png` and `-3-guest.png`: the owner (sand) and a second visitor "Ann" (water) in the same
  world, both strokes on both screens; "Delete world" in the owner's header only.
- Server killed and restarted on the same data dir; `GET /api/rooms/FVJ9SN` still `owned: true`, 42 tick-log rows.
  `/tmp/owned-shot-5-after-restart.png`: a fresh visitor opens the link, `room.loaded` logged, the sand pile and the
  settled water are there.
- Delete: a second owner created `EYTTK3`, a guest joined, the owner confirmed Delete in the menu
  (`-6-confirm.png`). The guest's tab: "This world was deleted", red dot, no reconnect (`-8-guest-kicked.png`).
  The link afterwards: 404, "No room has that code." (`-9-link-gone.png`). `room.deleted reason: owner` logged.
- Noticed, not fixed (pre-existing for every unknown code): the dead-link page's header reads "Game world" with an
  empty pill. FUTURE.md-worthy polish.

## Cold review (`docs/research/review-owned-sandbox.md`, Sonnet) and what was done
Each claim checked in the code first.
- **N1** owned rooms unbounded, `joined_at` stamp pins registrations: real. Fixed as above (exclusion + cap), two
  tests red first.
- **N2** an exception in the route escapes the handler: real (`deleteRoom` and `ensureOwned` can throw on a DB error).
  Wrapped: 500 + `db.write_failed`. Ordering kept (memory torn down, then rows): if the DB delete fails the world is
  unloaded with rows intact, which is a valid state the next join reloads and the owner can retry; reordering would
  need to close members after the rows are gone, the same end state, so not worth the churn.
- **N3** `finish()` arms an unload timer for a deleted world: real, harmless; `scheduleUnload` now ignores a closing
  or replaced world.
- **M1** one `log.limited` key for create and delete refusals: fixed (separate keys). **M2** no `who` on an owner
  delete: added. **M3** non-atomic `joined_at` update: gone with N1's fix.

## Spend
| Who | Model | Cost |
|---|---|---|
| Lead | Opus | about $14.5 (total below) |
| Menu worker (`owned-menu.md`) | Sonnet | about $0.7 |
| Cold reviewer (`owned-review.md`) | Sonnet | about $0.7 |

## Architectural decisions for review
1. **`owner_player_id` column + partial unique index**, not a flag on `creator_player_id`. Alternatives: an `owned`
   flag (one-per-player then only an app-level check), or a separate `owned_worlds` table (a join on every room read).
   Cost later: every room read selects one more column; rooms with an owner have a FK to `players`, so any future
   player-deletion path must handle owners (eviction does now).
2. **Fixed config and visibility** (classic 512 x 512 sandbox, unlisted, never listed). Reversible: a later version
   can take a config at create and add a "public" toggle; no stored data assumes otherwise.
3. **Delete by code in the path with the token as Bearer**, so a non-owner gets a meaningful 403. Same-origin only.
4. **Owner delete closes members with 4003** rather than waiting for the room to empty. A new close code the client
   treats as final (worker.ts onclose only).
5. **Unload keeps rows; the sweep never sees owned rooms.** An owned world nobody visits costs disk only: ~5 snapshots
   (each a compressed 512 x 512 world) plus at most ~5 minutes of log. 200 worlds is a few tens of MB at worst.
6. **`MAX_OWNED_ROOMS = 200`**, a global cap with no eviction of abandoned owned worlds. Alternative: sweep owned worlds
   nobody opened for N days. Not done: "lasts until the owner deletes it" was the user's decision.
7. **Room page owner check is a second fetch** (`GET /api/sandbox`) rather than a `mine` flag on `GET /api/rooms/:code`
   (worker's choice; keeps the public route token-free).

## D-row draft
| D-225 | 2026-11-08 | **A player's own persistent sandbox** (`rooms.owner_player_id`, partial unique index, migration 9): one per player, `CLASSIC_SANDBOX`, unlisted; `GET/POST /api/sandbox`, `DELETE /api/sandbox/:code` owner-only (Bearer token, 403 otherwise, members closed 4003). The sweep and the public list skip owned rooms; an empty one unloads and lazy-reloads from its snapshot and log; owners are never evicted; at most 200 in total. Survival/Deathmatch unchanged. | The marking criteria's "persists"; the user's decisions (one per player, link paints, owner deletes, lasts until deleted). Cold review N1 replaced a `joined_at` stamp with an explicit eviction exclusion and a cap. | `docs/briefs/owned-sandbox.md`, `docs/research/owned-sandbox-report.md`, `docs/research/review-owned-sandbox.md`, `8662a55` |

## Engineering-decisions entry draft
**47. A world that is yours, and what "persists" had to mean.** Every world already survived a restart (snapshots +
tick log, entry N), but every room died two minutes after its last player left, so nothing a player made lasted.
The owned sandbox reuses all of that machinery and changes only who may end a room: the sweep skips rooms with an
owner, an empty one unloads (memory) without being deleted (disk), and only the owner's token can delete it. The
cold review found the first version kept owners from eviction by pretending they had joined, which hid a foreign-key
crash and let a script pin registrations forever; the fix made the exclusion explicit and capped the total. **How a
marker sees it:** Menu -> My world -> Create, paint, copy the link into a second browser and paint there too; restart
the server (or wait past two minutes empty); open the link: the world is as you left it. Delete it from My world and
the link says the room is gone.

## FUTURE.md ideas
- Show "Open my world" on the title screen once you have one (worker).
- Let the owner rename the world (worker).
- The dead-link page's header ("Game world", an empty pill) should say the room is gone.
- A "last visited" note on My world, and an optional reset-to-empty that keeps the code.

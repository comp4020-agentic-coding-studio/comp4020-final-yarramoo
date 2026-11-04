# N1 report: rooms die when empty

Built per `docs/briefs/n1-room-lifecycle.md`. Server only; no sim change, so the cargo and determinism steps were not run.

## What changed
- `server/db.ts`: migration 8 adds `rooms.first_joined_at`, backfilled for rooms that already hold play.
- `server/rooms.ts`: `touch`, `markJoined`, `staleRooms` (stored-time rule) and `deleteRoom` (one transaction).
- `server/main.ts`: `deleteRoom` (skips a room with members or a load in flight), `sweepRooms` (boot plus every minute, touches occupied rooms first), the empty timer now deletes, `last_active` stamped on join and leave, options `roomNeverJoinedMs`, `roomSweepMs`, `now`, and `RunningServer.sweepRooms()` for tests.
- `shared/events.ts`: `room.deleted`.
- Tests: `tests/net/room-lifecycle.test.ts` (new, 7 tests, shown red against the old server code first); `room-join.test.ts` one test changed (an emptied room used to reload fresh, now it is unknown).

## Architectural decisions for review
1. **"Ever joined" is a column (`first_joined_at`), not derived.** Alternative: infer from tick log or snapshots. Those are written lazily (a flush, a snapshot every N ticks), so a short visit could look never-joined and be deleted at 10 minutes. Cost: one more migration; the backfill treats any room with stored play as joined at its `last_active`.
2. **`last_active` is stamped on join, on leave and by the minute sweep**, rather than by a timer per room. Cost: up to a minute stale while occupied, which only matters if the server dies mid-session; then the grace period starts from at most a minute earlier.
3. **The empty timer deletes in-process; the sweep covers everything else** (never loaded, or loaded-and-empty after a restart). Both go through one `deleteRoom`, which refuses while a load is in flight or any member exists. A join that wins the race keeps the room; a HELLO after deletion finds no row and is refused as "unknown room", so nothing is resurrected. A join landing in the same synchronous turn as the delete cannot happen (single thread).
4. **Memory-only servers (no database) keep the old unload behaviour**, since there are no rows to delete.
5. **The reserved rows 0 and 1 are excluded by `id > 1`** in the sweep and refused in `deleteRoom`. The worlds table rows for ids 0 and 1 are never touched.
6. **`ended_at` rooms (finished Survival rounds) are treated like any other**: they die on the same rules.
7. Tests use `now` injection plus `sweepRooms()`; the empty-timer path uses a 200 ms `roomUnloadMs`.

## Not done / watch
- D-188 was the next free number when written; another worker may have taken it, renumber on merge.
- A snapshot verify still in flight when a room is deleted is stopped by `closing` (it checks it before saving); not separately tested.

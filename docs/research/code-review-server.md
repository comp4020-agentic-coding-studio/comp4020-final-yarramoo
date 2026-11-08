# Code review: server/ and shared/ protocol (branch multa)

Scope: `server/*.ts`, `shared/*.ts`, `tests/net/`. Read-only review; nothing was run. "Confirmed" means I traced it in the code. "Suspected" means the code path is real but I did not prove the trigger.

## Findings

### 1. A failed room load or a throwing join crashes the whole server (high, stability, confirmed)
`server/main.ts:1005` (`void getOrLoadRoom(...).then(...)`, no `.catch`), `server/main.ts:407-443`, `server/world.ts:404-408`, `server/main.ts:1336-1339`.

- **What is wrong:** `getOrLoadRoom` awaits `World.load()`. `load()` deliberately throws when a stored snapshot cannot be verified after a sim-build change (`verify_unavailable`). It also touches SQLite. The `.then` body calls `identity.resolve`, `w.join` and `playerStats.bump`, which can throw on a DB error. None of this is caught. In production the `unhandledRejection` handler logs and then rethrows, so the process dies.
- **Scenario:** the sim build changes on deploy. Someone opens `/r/ABC12` while the verifier worker is cold and times out (10 s on a 256 MB machine). That one HELLO throws, the process exits, and every room drops. The throw is right for the two fixed worlds at boot ("let the platform restart us"). For a lazily loaded room triggered by any client it is wrong, and it can repeat on every retry. The `handshaking` flag is also never reset on this path.
- **Fix:** wrap the HELLO continuation in try/catch. On error, log `hello.rejected` or `room.load_failed`, reply `rej("server error")`, and reset `handshaking`. Keep the "refuse to start" behaviour only for boot-time loads.

### 2. DB writes in hash handling are unguarded, so a DB error kills the process (medium, stability, confirmed)
`server/world.ts:907` (`db.recordIncident`), `:924` and `:1046` (`updateIncident`), `server/main.ts:1207-1209` (the 4 ms timer), `:976` (the `message` handler).

- **What is wrong:** `flush()` carefully catches DB errors (`world.ts:550-557`). `diverged()` does not. It is reached from `onHash` (the ws message handler) and from `tick()` via `resolveDue`. The timer loop `for (const w of worlds.values()) w.tick()` has no try/catch and there is no `uncaughtException` handler.
- **Scenario:** the volume is full (SQLITE_FULL) or locked. A divergence is detected and `recordIncident` throws. This is an uncaught exception in either a socket event or a timer, which takes down every world. One world's exception also stops the other worlds' `tick()` for that pass.
- **Fix:** wrap `recordIncident` and `updateIncident` in a small `safeDb()` helper. Give the timer loop a per-world try/catch that logs `world.tick_failed` and closes just that world.

### 3. A persistent divergence loops resync with no limit, and floods the DB and log (medium, consistency and stability, confirmed)
`server/world.ts:891-916`, `:1068-1081`, `server/db.ts:384`.

- **What is wrong:** every divergent checkpoint (every 60 ticks, about 1 s) does the following:
  1. inserts a `desync_incidents` row, which is never pruned;
  2. emits `desync` and `resync` via `elog.event`, not `limited`, which breaks the CLAUDE.md rule;
  3. sends the member the full snapshot plus the entire log through `sendCatchUp`.
  Only the chunk diagnosis is rate limited.
- **Scenario:** a client with a bad build or browser quirk, or a hostile client that sends random HASH values, diverges every second. It costs the server a snapshot of up to several MB plus up to 200k log frames each second. It adds about 86k incident rows a day and fills the 500-entry log ring, which pushes real events out.
- **Hostile case:** in a 2-member room the tie goes to the longest-connected member. A hostile first joiner can therefore keep the honest second member in a permanent resync loop. That is one client desyncing a room.
- **Fix:**
  - Add a per-member resync budget (for example 3 per minute). Past it, close the socket with a "desync, reload" code.
  - Rate limit `desync`, `resync` and `recordIncident` per world.
  - Prune incidents to the last N rows.

### 4. Joins and resyncs cost O(log length) synchronous `ws.send` calls on the tick thread (medium, stability, confirmed)
`server/world.ts:649-656`, `:52`, `:48`, `:361-364`.

- **What is wrong:** `sendCatchUp` sends the snapshot and then every log tick as its own `trySend`. With no verified snapshot the log is allowed to reach 200k ticks and beyond, because joins are no longer refused. That is more than 200k separate frames written synchronously on the shared event loop. Every world's clock stalls while it runs.
- **Scenario:** a long-lived room whose snapshots keep getting rejected or never requested has a large log. Each join or resync freezes all worlds for tens to hundreds of ms and queues megabytes. The 8 MB `MAX_BUFFERED_BYTES` check only fires per frame.
- **Fix:** coalesce the log into one concatenated frame, or a few chunks of 64 KB or more. Cache the concatenation until the log changes. A TICK-batch message would also work if the client parses it.

### 5. No liveness timeout, so half-open sockets stay as members forever (medium, stability, confirmed absence, suspected effect)
`server/main.ts:903-914`, `:1204`.

- **What is wrong:** the server pings every 2 s and records RTT on pong. It never terminates a connection that stops answering. The only drops are the 8 MB send queue, a `close` event, or an `error` event. A client that disappears without a FIN (NAT drop, sleeping laptop) needs hours to reach 8 MB at about 0.5 KB/s, or relies on TCP keepalive.
- **Scenario:** the ghost member:
  - keeps its room loaded, so `scheduleUnload` never fires and the room slot cap fills;
  - adds a 2 s `HASH_WAIT_MS` delay to every checkpoint (`world.ts:862-863`);
  - counts as an eligible voter in `eligibleAt`, which inflates the death-claim quorum (`world.ts:1136-1140`).
- **Fix:** if no pong arrives within about 3 ping periods (about 10 s), call `ws.terminate()`.

### 6. Death claims and achievements are wired only for the fixed game world (medium, maintainability and consistency, confirmed)
`server/main.ts:465-472`, `:461-464`.

- **What is wrong:** `onDeathResolved` is set only on `game` (world id 1). R2b rooms are `World` instances created by `mk(id, cfg, seed)`, and none of them gets the hook. `nameOfVisitor` also only searches `game.members`.
- **Scenario:** deaths in any user-created Survival or Caves room never reach stats, kills/deaths or achievements, even though clients send CLAIM frames that are voted on. Nothing logs this.
- **Fix:** set the hook inside `mk()` (a `worldHooks(w)` function), and make `nameOfVisitor` take the world.

### 7. Loaded-room caps ignore loads in flight (medium, stability, confirmed)
`server/main.ts:368-381`, `:418-437`.

- **What is wrong:** `loadedRoomSlots()` counts only `worlds`. `worlds.set(id, w)` happens after `await w.load()`, so concurrent HELLOs for different unloaded rooms all pass the slot, L-room and memory checks. The check-then-insert is atomic only per room id.
- **Scenario:** a burst of HELLOs to 30 different (publicly listed) room ids loads 30 worlds against a cap of 16. L rooms are 4x the weight, so the memory cap is also bypassed.
- **Fix:** count `loadingRooms` in the slot totals, or reserve the slot before the `await`.

### 8. Anonymous room creation has no rate limit, and rooms and their data are never deleted (medium, stability, confirmed)
`server/rooms.ts:115`, `server/main.ts:659`, `server/db.ts:239-248`.

- **What is wrong:** the limit applies only when `creatorPlayerId !== null`. The route always passes `null`, so the limit is dead code. Room rows are never deleted. Each room that has been played keeps up to 5 snapshots (MBs each) plus tick-log rows.
- **Scenario:** a script POSTs `/api/rooms` in a loop. The `rooms` table and the public list grow without bound. Each joined room then adds MBs of snapshots to the volume.
- **Latent issue:** `rooms.id` is `integer primary key` without `AUTOINCREMENT`. If a room row is ever deleted, SQLite can reuse the highest id. The new room would then adopt the old room's `worlds`, `snapshots` and `tick_log` rows, which hold a different config and seed.
- **Fix:** add a per-IP room-creation limit. Add a room GC (for example, unlisted rooms inactive for 7 days, together with their world rows). Use `AUTOINCREMENT`.

### 9. Only the "input" frame type is rate limited (medium, stability, suspected)
`server/main.ts:976-1199`, in particular `:978`, `:1115`, `:1119`.

- **What is wrong:** `Buffer.from(data)` copies every frame. `ping` (answered with a pong), `hash`, `live`, `claim` (limited later in the world), and `snapshot-upload` (an unrequested one is only ignored in `onUpload` after the full frame, up to about 3 MB, has been received and copied) have no per-connection budget. The tag and tick are checked before decoding only for CHUNK_HASHES.
- **Scenario:** one client streams 3 MB uploads or tiny pings as fast as it can. The server spends CPU and bandwidth on each, and the tick thread is shared.
- **Fix:** add one per-connection token bucket over all frames, with a byte budget. Move the `expectsUpload` check ahead of the copy, as is done for CHUNK_HASHES.

### 10. Replacing a connection skips `leave()` cleanup (low, consistency, confirmed)
`server/world.ts:582-592`.

- **What is wrong:** the old member is deleted from `members` directly. `request` and `waitingUpload` are not cleared if they belonged to it, and `evaluateHold` and `checkpoints` are not touched. The snapshot request then sits idle until `SNAPSHOT_GIVE_UP_TICKS` (10 s). `online` is incremented for the new Join with no Leave, so `onlineAt` and `playersAtBase` drift upward by one per replaced tab. That is a UI presence count only.
- **Fix:** factor the removal logic of `leave()` into `removeMember(conn, stampLeave: boolean)`, and use it in both places.

### 11. `tickSamples` is never pruned when a room unloads (low, stability, confirmed)
`server/main.ts:916-927`, `:339-343`.

- **What is wrong:** `tickSamples.set(w.id, ...)` runs for every world, but it is deleted only in `adminReset`. An unloaded room keeps its entry (about 11 samples) forever, and a reloaded room starts with stale samples whose tick numbers do not match.
- **Fix:** delete the entry in the unload path (`scheduleUnload` and `discardIfFreshlyLoaded`). A single `unloadRoom(w)` function would also remove the duplicated shutdown code in those two places.

### 12. `server/main.ts` is one 1,100-line closure (medium, maintainability, confirmed)
`server/main.ts:248-1330`.

- **What is wrong:** `startServer` holds the HTTP routes, room lifecycle (load, unload, caps), the admin dashboard data, the entire WebSocket protocol handler, timers and shutdown. The closure shares about 20 mutable locals (`worlds`, `live`, `loadingRooms`, `stats` and others).
- **Duplication and coupling:**
  - The request body reader is copied three times (`/api/players`, `adminReset`, `createRoomRoute`), and `/api/players` re-implements `originOk` inline (`:714`).
  - Per-kind input validation, stats updates and achievements are interleaved in one 60-line `case "input"` (`:1122-1178`). Mode rules are split between `main.ts` (`cfg.round`, `cfg.brushes`, in the input handler) and `world.ts` (`kind`).
  - Adding a new input kind means touching `shared/inputs.ts`, this handler, `InputCounts`, `PlayerStats` and the sim, with nothing enforcing the set.
  - Code comments cite review documents and findings (`:278-315`, `:347-352`), which will rot.
- **Fix:** extract `rooms-manager.ts` (the lazy-load, cap and unload lifecycle), `http-routes.ts` (with a shared `readJsonBody`), and `connection.ts` (the per-socket handler). Make input validation a table keyed by kind and room config.

### 13. `World` carries five concerns in one class (medium, maintainability, confirmed)
`server/world.ts:204-1285`.

- **What is wrong:** one class holds the tick log and clock, join/leave, hash checking, chunk diagnosis, death claims, snapshot request and verification, and cold-start parsing. It has about 40 private fields. The claims and diagnosis code (about 250 lines) touches only `members` and `now`.
- **Hazard:** `World.stats` is a hand-written `Object.assign` literal that is duplicated in the constructor and in `reset()` (`:222`, `:813`). A new counter has to be added in both places.
- **Fix:** extract `ClaimTally`, `ChunkDiagnosis` and `SnapshotCoordinator` as classes that take narrow interfaces, and create `WorldStats` from a single `newStats()` factory.

### 14. Protocol and layout knowledge is hand-duplicated (low to medium, maintainability, confirmed)
`server/world.ts:1289-1322`, `server/main.ts:1150`, `server/world.ts:437`.

- **What is wrong:**
  - `activePlayersIn` hard-codes the snapshot header size (70), the player record size and the offset of the `active` byte. These mirror `sim/src/entities.rs`.
  - `activeAfter` and `presenceDelta` re-parse TICK frames by hand (offsets 5, 7, `7 + len`) instead of using `decodeServer`.
  - The Pos payload offset (`getInt32(6)`) is a magic number.
- **Mitigation that already exists:** `tests/net/entity-layout.test.ts` pins the snapshot parser against the real sim. This is good practice. The test repeats `HEADER = 70`, so a header change needs two edits. There is no equivalent pin for the other two.
- **Fix:** export `SNAPSHOT_HEADER_BYTES` and `PLAYER_RECORD_BYTES` from `shared/sim.ts`, with a test that fails when the Rust constants change. Add a `forEachTickInput(frame, fn)` helper in `protocol.ts` and use it in all three places.

### 15. Cold start restores only the snapshot, and orphan leaves are for game-kind worlds only (low, consistency, suspected)
`server/world.ts:451-453`, `:473-479`.

- **What is wrong:** for sandbox-kind worlds `stillActive` is always an empty set. A crash leaves a Join with no Leave in the log for sandbox-kind rooms (ids from `nextPlayer`), and no orphan Leave is stamped. Whether the sim cares about a stale player there depends on the sim, which I did not read.
- **Fix:** if the sim treats sandbox players as presence, compute orphans for every kind. Otherwise add a comment that says it is intentionally harmless.

### 16. Test quality: real clocks, sleeps, and timing windows (low to medium, maintainability, suspected)
`tests/net/catchup-hold.test.ts:178-179`, `tests/net/snapshot-timing.test.ts:72-75`, and the `sleep` calls across `tests/net/*.ts` (many files).

- **What is wrong:** most tests boot a real server on real clocks and wait. Examples:
  - `expect(waited).toBeLessThan(2000)` against a 500 ms valve;
  - `sleep(300); expect(...)` before waiting on a state change;
  - "wait for the retry" with a 20 s timeout.
  Upper-bound timing assertions under CI load are the usual source of "intermittent means a race" failures, which CLAUDE.md says to treat as defects.
- **Mitigation that already exists:** `World` and `TickClock` take an injected `now`, and `clock.test.ts` exercises the clock purely. The world logic (hold, claims, diagnosis, snapshot flow) could be unit-tested on a fake clock with fake peers, as the injection allows.
- **Fix:** move timing-sensitive cases (valve, retry, claim timeouts, hold deadlines) to fake-clock `World` tests. Keep a small number of real-socket tests for integration only.

### 17. Small items (low)
- `server/main.ts:294-304`: the reserved room rows 0 and 1 are inserted with raw SQL in `main.ts`, bypassing `GameDb`/`RoomsStore`. `seedForRoom(id) = id` makes every room's cave predictable and gives rooms in different DB generations the same layout (`:315`).
- `server/world.ts:1223`: `requestSnapshot` uses a bare `ref.peer.send` while every other send goes through `trySend`. In ws 8 this does not throw for a closing socket, but it bypasses the queue cap.
- `server/world.ts:551-557`: if the DB keeps failing, `pending` grows without bound (each failure keeps the frames). Cap it and close the world on a long failure.
- `server/main.ts:1005-1008`, `:1038-1039`: two HELLOs awaiting the same room load where the first is rejected can cause the second to see `closing` and be rejected with "server is shutting down". The message is misleading, but it is not unsafe.

## Strengths
- **Consistent input path:** inputs are stamped into a single ordered `TickClock` open tick, and join/resync catch-up is sent synchronously. A joiner therefore cannot miss or double a tick. The clock is pure (injectable `now`), re-entrancy-safe (`closed++` before `onClose`), and pauses and rebases cleanly when a room is empty or held.
- **Snapshot acceptance is defensive:** a snapshot is accepted only when it is requested from a specific member for a specific tick, the claimed hash matches the majority hash, and a worker restore reproduces both the tick and the hash. The reset generation counter (`resetGen`) stops a stale verify from saving after an admin reset. The sim runs in a worker with a timeout, so a game-world restore does not stall the clock.
- **Hash policy:** majority with a longest-connected tie-break, a bounded `truth` map, a `minHashTick` guard against stale hashes, and chunk diagnosis that is rate-limited and never delays the resync.
- **Persistence on restart:** the log is validated for contiguity on cold start (with a repair path), orphan Joins get stamped Leaves, a sim-build change does not reset on a mere verify timeout, and DB writes in `flush` are batched and retried.
- **Resource bounds in most places:** per-IP and per-world member caps, frame size caps, the unload timer, bounded claim and diagnosis maps, and `log.forget` to release limiter keys on disconnect.
- **Test coverage:** `entity-layout.test.ts` pins the hand-written snapshot parser to the real sim. Test coverage is broad (about 40 files in `tests/net/`).

## Top 5
1. **HELLO continuation has no catch (finding 1):** a room-load failure or DB error during join is an unhandled rejection that the production handler rethrows, so one client can crash every room.
2. **Unguarded DB writes in `diverged()` and no per-world isolation in the tick timer (finding 2):** a disk-full or locked DB turns a divergence into a process crash.
3. **Unbounded resync loop plus unpruned incident rows (finding 3):** a persistently diverging or hostile client costs a full snapshot and log every second, grows the DB, and can trap an honest member in a 2-member room.
4. **Joins and resyncs send the whole log one frame at a time (finding 4):** with up to 200k+ ticks this stalls all worlds, and there is no liveness timeout (finding 5), so dead sockets pin rooms and slow checkpoints.
5. **Rooms are not first-class (findings 6, 7, 8):** rooms get no death or achievement hook, the loaded-room cap ignores in-flight loads, and anonymous room creation is unlimited and never garbage collected.

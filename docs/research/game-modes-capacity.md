# Game modes: how many worlds fit on the Fly machine

Labels: **[code]** read in code, **[measured]** run here, **[doc]** from an existing doc, **[infer]** inference.

## Summary

- The server holds no simulation per world. A `World` is a tick log, a member map and a snapshot blob. The only sim instance on the server is in the verify worker, and that worker is shared by all worlds **[code: `server/main.ts:239`, `server/verify.ts`, `server/verify-worker.ts`]**. Adding a world therefore costs a few MB of RAM and almost no CPU.
- The binding constraint is connections and sockets, then the single thread's tick timer. It is not world count. The hard memory risk is the verify worker restoring a large snapshot on a 256 MB box.
- Recommendation: one process, 4 fixed world kinds (sandbox, cave, arena, creative), arena as at most 2 instances. Cap total members, not worlds.

## 1. Per-world cost

**Memory.**
- Idle server with both worlds loaded, empty DB: **82 MB RSS** `[measured]` (`ps` and `/api/summary` agree: `rssMb` 82). D-003 budgeted Node at 60-80 MB `[doc]`.
- Snapshot held in memory per world: raw ceiling is 1 MiB for a 512x512 sandbox and 7 MiB for the 2048x1536 cave (`MAX_SNAPSHOT_RAW`, `MAX_SNAPSHOT_RAW_GAME`, `shared/protocol.ts:48-50`) `[code]`. A full cave world is about 6.3 MB raw, the stored blob is compressed (upload frame cap 4 MiB) `[code, D-003]`. An arena can be sized freely: a 512x512 arena is at most 1 MiB raw, so the cave is the expensive kind.
- Tick log: about 10 bytes per empty tick while no snapshot exists; 200k ticks is about 2 MB (`MAX_LOG_TICKS`, `world.ts:42-46`) `[code]`. With a snapshot every 1800 ticks (`SNAPSHOT_EVERY_TICKS`) the log in memory is bounded by that plus inputs `[code]`. Inputs raise it: 40 inputs/s per player cap (`INPUT_RATE_LIMIT`).
- Per connection: a socket send queue is dropped past 8 MiB (`MAX_BUFFERED_BYTES`) `[code]`, so a slow client can pin up to 8 MiB. 64 members per world (`MAX_MEMBERS_PER_WORLD`), 12 per IP `[code, main.ts:58-60]`. A hostile upload can make the server buffer 4 MiB per message (D-066) `[doc]`.
- Verify worker: one per process, started on demand, `unref`'d when idle `[code, verify.ts:61]`. It holds one sim instance (about the size of one world, D-003 says about 6.3 MB for the cave) plus the wasm. It restores a cave snapshot in about 380 ms `[doc, D-066]`. Its memory is sized by the largest world kind, not by the number of worlds.
- Soak: 3 headless clients on both worlds for 30 min reported **host RSS 217 MB** `[doc, n1-30min.md:27]`. I could not tell whether "host" is the server alone or the machine running the Chromium bots; treat 217 MB as an upper bound until checked. It is close to the 256 MB limit either way, and `D-003` warns at 200 MB.

**CPU per tick.** `main.ts:835` runs one 4 ms `setInterval` that calls `w.tick()` for every world `[code]`. A world with no members does not advance (clock pauses when empty; the log only grows with connected time) `[doc, snapshot-timing.md]`, so an empty world costs one cheap function call per 4 ms. Cost with players is relaying inputs and fan-out, which scales with members times 60 ticks/s. No stepping happens on the server (invariant 11). Hash voting and claim sweeps (250 ms) are per world.

**Disk.** `tick_log` is pruned once a snapshot lands: only 5 snapshots are kept (`SNAPSHOTS_KEPT = 5`, `db.ts:8`) and log rows at or before the oldest kept snapshot are deleted (`prune`, `db.ts:220-228`) `[code]`. So per world: at most 5 compressed snapshots plus the log since the oldest one. The fresh DB was 232 KB with both worlds `[measured]`. Upper bound for the cave: 5 x about 2-4 MB compressed = 10-20 MB `[infer from frame cap]`. 4 worlds is well under 100 MB of the 1 GB volume. `keep_for_timelapse` rows are the one thing that would grow without bound, if anything sets them `[code]`.

## 2. How many worlds fit

| Resource | Limit | Cost per extra world | Verdict |
|---|---|---|---|
| RAM 256 MB | about 82 MB base, warn at 200 MB | 1-8 MB state, plus connections | Not binding for world count |
| Connections | 8 MiB worst-case send buffer each, 64 per world | per player, not per world | Binding: cap total members |
| CPU (one shared vCPU) | one tick timer for all worlds | grows with players | Binding under load |
| Disk 1 GB | about 20 MB cave, less for small | small | Not binding |

Estimate **[infer]**: with a 217 MB soak ceiling and about 82 MB idle, there is roughly 100 MB headroom before the 200 MB warning. At about 1 MB per active socket, plus roughly 8 MB per world with a snapshot, 4 worlds and about 40-60 total players fit; the soak did not push past 3 clients, so this is unmeasured. Measure before promising more.

An idle world costs one DB row and the hot snapshot blob. Lazy loading is possible but not built: `main.ts:239-242` loads every world at start and holds `this.snapshot` for its lifetime. Unloading an empty world means freeing the snapshot and tick log and calling `load()` again on first join. A cold cave load needs the verify worker (400 ms restore), so it must not run on the tick thread. A 4-world fixed set does not need this; many arena instances would.

## 3. One process or several

- **One process (current):** simplest, one DB writer, one verify worker, and `worlds` is a `Map`. Shared fate: the tick timer, a slow DB write, or a long GC delays every world `[infer]`. The earlier stall (a main-thread snapshot restore blocking about 260 ms, D-061/D-066) was fixed by moving verification to the worker `[doc]`.
- **`worker_threads` per mode:** isolates event-loop stalls, but each worker costs a V8 isolate (about 10-20 MB `[infer]`), node:sqlite cannot be shared across threads without a second connection, and the admin dashboard, identity and stats all read one `Db`. On 1 shared vCPU, threads do not add compute, they only add scheduling fairness. Not worth it.
- **Child processes:** about 60-80 MB each for Node, so 2 would reach about 160 MB idle `[infer from the 82 MB base]`. Rejected.
- **More Fly machines:** not allowed by the course.

Conclusion: one process. The thing to guard is stall risk, and the way to do it is to keep heavy work (snapshot restore, compression) in the worker and to keep per-world `tick()` O(members).

## 4. What adding a world needs

All **[code]**:
- `shared/protocol.ts:58-70`: add world kind constants and extend `maxSnapshotRawFor`, `maxUploadFrameFor`, `chunkGridFor` (they are ternaries on `WORLD_GAME`, so a new kind silently gets sandbox values).
- `server/world.ts:37-40`: `SANDBOX_ID`, `GAME_ID`, `worldKindOf`, and `this.seed = this.id === GAME_ID ? GAME_SEED : SANDBOX_SEED` (`:265`). Arena instances need an id-to-kind map, not constants.
- `server/main.ts:239-241`: the `worlds` Map is hard-coded to two entries, and `game` and `world` locals are used for the death handler (`game.onDeathResolved`) and the `nameOfVisitor` lookup. These need to run per world of kind PvP/game.
- Many `w.kind === WORLD_GAME` branches decide role (`player` vs `painter`, `:608`), unknown-token rejection (`:683`), and the input path (`:772`). A creative kind means choosing which branch it takes. The sim also has to know which spells exist per kind; that is a sim input rule, so it is invariant 1 territory.
- Hello routing: `msg.worldId` is already a protocol field (`protocol.ts:93`), so URL to world id routing is client-side only, plus the `unknown world` reject at `main.ts:669`.
- DB: all tables key on `world_id`, with a `worlds` row created on first load (`world.ts:365`). No schema change is needed. `achievements.world_id` is recorded.
- Caps: `MAX_MEMBERS_PER_WORLD = 64` is global, not per kind. Add a per-kind cap and a total-members cap, and `MAX_CONNS_PER_IP = 12` stays.
- Dashboard: `/api/summary` already iterates `worlds.values()` (`main.ts:897`), so new worlds appear, but the dashboard page and the per-world `WorldSummary` labels may assume two.
- Snapshot upload frame cap and `MAX_SOCKET_PAYLOAD` use the max over kinds; an arena at or below the cave size changes nothing.
- A sim-build change: `loadFromDb` verifies each world's snapshot in turn on boot (10 s timeout each, `VERIFY_TIMEOUT_MS`). More worlds means more cold-start verification time, and an "unavailable" result stops the server (D-112). Four worlds is about 4 restores on a cold worker.

## 5. Recommendation

- One process, one verify worker, fixed worlds: 0 sandbox (creative, all spells), 1 cave, 2 and 3 arena instances. Arena sized 512x512 (1 MiB raw, same grid as the sandbox) so it adds about 1-2 MB of snapshot each.
- Add a **total member cap of about 40** across all worlds (and keep 64 per world as the ceiling), because connections, not worlds, drive memory. Make the per-world cap for arena small (about 8-16) since PvP lockstep is input-heavy.
- Keep worlds loaded; skip lazy unloading until there are more than about 6 worlds.
- Make worlds a table `{id, kind, seed, maxMembers}` in one place instead of constants, and use it for `worldKindOf`, the seed, and the caps.

**Main risk:** memory under real load with the verify worker active. The 217 MB soak figure, if it is the server's RSS, leaves under 40 MB before the OOM kill, and a cave-snapshot verify is a transient allocation (decompress plus restore plus hash). Mitigation: measure RSS with 20+ sockets and a cave verify in flight before shipping, and keep the existing 200 MB warning as a hard stop for new joins. Second risk: the shared 4 ms tick timer, where a stall in one world delays all.

**Unmeasured:** per-socket memory, RSS under more than 3 clients, DB growth over a long run, and whether the 217 MB figure was the server.

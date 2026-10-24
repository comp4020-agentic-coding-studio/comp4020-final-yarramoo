# Capacity: how many rooms fit on one Fly machine

Labels: [measured] run here, [code] read in code, [inferred] derived. Raw numbers: `docs/research/capacity-results.json`.
Bench: `pnpm soak:capacity` (`tests/soak/capacity.ts`): real Docker image, `--memory=256m`, tmpfs `/data`, host has 8 cores.

## Method and caveats

- Bots are headless Node clients running the real `Lockstep`/`reactToTick` code, each with a full WASM sim in 4 worker threads. They hash, send LIVE and answer snapshot requests. No thin clients.
- Bots alternate world 0 (sandbox 512x512, ~size S; Paint ~20/s) and world 1 (cave 2048x1536, size L; Pos ~30/s, no casts). Each step is half and half and was held 60 s (15 s settling, 45 s sampled).
- Fly's real CPU: shared-cpu-1x is a quota of 5 ms per 80 ms = **6.25% of a core**, burst balance 5 s initial and 500 s max, bursting at up to 100% [https://docs.fly.io/machines/cpu-performance]. My 1.0 and 0.25 `--cpus` runs are therefore both well above the sustained quota.
- Host sim cost, for scale: 0.09 ms/step in the cave, 0.03 ms in the sandbox [measured]. The server never steps (invariant 11).
- Not measured: sizes M rooms directly, heavily played worlds (snapshots here come from a few minutes of bots), real browsers, the verify worker under real Fly CPU.

## Measurements

**Baseline (fresh DB, idle)** [measured]: `/api/summary` rssMb 104, but cgroup memory 49 MB (`docker stats` 48.6 MiB). RSS counts mapped pages the cgroup does not charge; the OOM killer uses the cgroup figure. The server's own 200 MB warning uses RSS, so it fires about 50 MB before the kernel would. Idle CPU 0.015 to 0.05 core.

**Per step, 1 CPU** [measured] (members total, half per world):

| Members | RSS max | cgroup MB | Lag p99 max ms | Ticks/s (both worlds) | CPU cores | Out B/s per member, world 1 |
|---|---|---|---|---|---|---|
| 0 | 104 | 49 | 45* | n/a | 0.05 | 0 |
| 8 | 160 | 108 | 30 | 60.0 | 0.16 | 2.5 KB |
| 16 | 171 | 119 | 35 | 60.0 | 0.19 | 4.7 KB |
| 32 | 179 | 130 | 46 | 60.0 | 0.28 | 8.8 KB |
| 48 | 198 | 148 | 47 | 60.0 | 0.41 | 10.2 KB |
| 64 | 201 | 153 | 44 | 60.0 | 0.38 | 16.4 KB |

*The lag histogram is reset once a minute and includes startup, so even idle p99 is 23 to 45 ms; at 1 CPU it never discriminates. Ticks/s never fell under 59.9 (the per-sample minimum was 59.1). No OOM kill (`OOMKilled=false`); cgroup peak 153 MB.

- **Per member:** about 0.7 MB cgroup (108 to 153 MB over 8 to 64 members) and about 0.005 core [measured]. The jump from 49 to 108 MB at the first step is not members: it is first activity (both worlds loaded with a log, verify worker started, first snapshots). I did not isolate which; treat as a fixed ~50 MB [measured jump, cause inferred].
- **0.25 CPU** [measured]: 32 members hold 60 tps, lag p99 up to 206 ms; 48 members fall to 54.7 tps with lag p99 1.3 s and 3 bots dropped. Threshold 58 tps is crossed between 32 and 48 members. One earlier 0.25-CPU run died at the 48 step with a dropped HTTP connection (cause unknown, kept in the JSON as `cpus0.25_run1_crashed_at_48`).
- **Outbound** [code + measured]: every closed tick (60/s) goes to every member: 7 bytes empty, plus 7 + payload per input (a Pos is 18 B). Per room, traffic is members x (420 B/s + inputs/s x 18 B), so it grows with members squared. A room of 16 costs each member ~8.8 KB/s; a room of 8 about 4.7 KB/s, i.e. ~37 KB/s per 8-room. World 0 byte counts fell at 32+ members (860 and 576 B/s per member at 48 and 64) and I did not find out why; treat them as unreliable and use the world 1 column.

**Snapshots** [measured]: both worlds took and verified snapshots at every step (`snapshotsAccepted`), no hash failures or resyncs at 1 CPU.

| World | Compressed | Verify time, 1 CPU | Verify time, 0.25 CPU |
|---|---|---|---|
| 0 sandbox (S-like) | ~10 KB | 5 to 116 ms | 6 to 700 ms |
| 1 cave (L) | ~2 KB (generated start, bots dig nothing) | 0.6 to 2.0 s | 5 to 10.8 s (hit the 10 s timeout once; 1 rejected) |

- **Peak RSS during a cave verify with 32 members in world 1**: 198 to 201 MB, against ~198 MB mean without it, so the verify spike is about +3 MB [measured; sampled at 4 Hz, a shorter spike could be missed]. Cgroup peak 153 MB.
- The 2 KB cave snapshot is a floor. The ceiling the server accepts is 4 MiB per upload (S: 1 MiB) [code]. A heavily dug cave will land between. The earlier "2 to 4 MB" estimate is not supported by this run, and nor is it ruled out.

**Disk** [measured, after ~6 min with 64 members]: `game.db` 2.0 MB plus 4.3 MB WAL (WAL is checkpointed lazily). Per world: 5 snapshots kept [code, `SNAPSHOTS_KEPT`] = 51 KB (world 0) and 10 KB (world 1); tick log rows 85 to 289 KB (world 0) and 1.4 to 1.6 MB (world 1, 32 Pos senders), pruned to the oldest kept snapshot.

**CPU budget** [inferred from the table plus Fly docs]: at 0.4 core (64 members) a full 500 s burst balance lasts 500 / (0.4 - 0.0625) = 25 min; at 0.28 core (32 members) 38 min; at 0.16 core (8 members) 85 min. Refill only happens while below 6.25%, which idle (0.015 to 0.05) barely does. Once the balance is gone the server is throttled to 6.25%, which is about the cost of an idle server. Sustained play on Fly is bound by burst credit, not by RAM or by instantaneous CPU.

## Model [inferred]

Memory: budget 200 MB cgroup (leaves 56 MB for spikes), minus 49 idle and ~53 first-activity = ~98 MB, at 0.7 MB per member = **~140 members**. A room's own cost is small: the server holds a compressed snapshot plus up to ~30 s of log (8 players: ~130 KB) [code]. Worst-case snapshot in memory: S 1 MiB, M ~2 MiB, L 4 MiB [code; M assumed by cells].

CPU: the member-driven limit holds at **32 members for sustained play** (60 tps with margin, 38 min of burst) and **~48 as a hard ceiling** at 1 core; below ~0.25 core even 48 fails. Size does not change relay cost; it only changes verify cost (L ~4x M ~16x S by cell count; cave verify 0.6 to 2 s at 1 CPU).

| Room | Players | Loaded rooms, memory-bound (typical / worst snapshots) | Loaded rooms, CPU-bound (32 members) | Binding | Stored rooms, disk (worst-case snapshots / measured-like) |
|---|---|---|---|---|---|
| S | 2 / 4 / 8 | 70 / 35 / 17 (same) | 16 / 8 / 4 | CPU | ~160 / ~3000 |
| M | 2 / 4 / 8 | 70 / 35 / 17 / ~65 / 33 / 16 | 16 / 8 / 4 | CPU | ~100 / ~1500 |
| L | 2 / 4 / 8 | 70 / 35 / 17 / 18 / 14 / 10 | 16 / 8 / 4 | CPU (memory worst case for L at 8 players is 10 vs CPU 4: CPU still wins) | ~45 / ~500 |

(Typical memory columns apply members x 0.7 MB. For M and L the worst case adds 2 or 4 MiB per loaded room. Stored worst case: 5 x cap plus ~1 MB log; measured-like: 5 x measured size plus tail log.)

**Binding constraint: CPU burst credit and the total member count, not rooms.** Memory allows ~140 members and disk thousands of rooms, but 32 sustained members empties the burst balance in ~40 min.

**Recommended caps:**
- Total members: 32 (soft), 48 (hard refuse). Count members, not rooms.
- Loaded rooms: 16 total; of those at most 4 L. L counts as 2 slots (its verify is 4 to 16x dearer and its snapshot ceiling is 4x).
- Players per room: default max 8; `max_players` in 2..8 [plan].
- Stored rooms: 100 total, 20 L, with an expiry for unvisited rooms. This stays under 1 GB even at worst-case snapshot sizes (~45 L).
- Unload empty rooms (free the snapshot and log) once rooms are created on demand; today's server keeps every world loaded forever [code, `main.ts:239`].
- Treat a verify over 5 s as an overload signal (the 10 s timeout was reached at 0.25 core) and skip, not stop the server [code: "unavailable" stops the server today, D-112].

## Architectural decisions for review

1. **Caps count members first, rooms second.** Chosen because per-room cost is near zero and per-member cost drives memory and CPU. Alternative: a room cap alone, which lets 8-player rooms cost four times as much as 2-player rooms. Cost later: the lobby must show "server busy" at the member cap.
2. **L counts as 2 slots.** Cheap to change; slot weights live in one table.
3. **Use cgroup memory, not RSS, for admission.** RSS sat ~50 MB above the cgroup figure. Changing the 200 MB warning to read `/sys/fs/cgroup/memory.current` is a server change, not done here.
4. **Verify must degrade, not stop the server,** as the 0.25-core run shows. Needs a decision before rooms ship.

## Ideas for FUTURE.md

- Admission control on the 1-minute CPU average (cgroup `cpu.stat`), refusing creation when the burst balance is low.
- Expose burst balance and cgroup memory on `/api/summary`.
- Lag histogram window that excludes startup, so p99 is usable as an alarm.
- Compress or coalesce tick frames per member (empty ticks are 420 B/s per member for nothing).
- Re-run with a heavily dug 2048x1536 world to measure a real snapshot ceiling.

## R2c: real rooms, measured (24 Oct)

Plan's milestone-R2 ask: "the capacity measurement (Docker image, 24 sockets over 4 rooms, a forced verify;
pass is under 200 MB)." Bench: `pnpm soak:capacity-rooms` (`tests/soak/capacity-rooms.ts`), new in R2c. Same
real Docker image (`--memory=256m`, tmpfs `/data`, `--cpus=1`) and the same real bot machinery (`Lockstep`,
`reactToTick`, full WASM sim per bot) as the pre-R2 `capacity.ts` bench above, but this one creates its rooms
the real way the game now does: `POST /api/rooms` (not a direct DB write or a fixed world id), then HELLOs 6
bots into each room's real id. Raw numbers: `docs/research/capacity-rooms-results.json`.

**Room mix**: 4 real rooms, all Caves-preset (`CAVES_PVP`, `avatars: 1`) so every bot is a real Pos-sending
avatar (~30/s, no casts) — the same per-tick, per-member cost already measured for world 1 in the pre-R2 table
above, now over real rooms instead of the one fixed cave. 2 rooms at size M, 2 at size S (not L): the brief's
own guidance (item 3) is that an L room's 2-slot weight against `MAX_LOADED_ROOMS = 16` isn't this slice's
concern, so M/S keeps comfortably clear of that cap while still mixing world sizes. A Creative/painter room's
Paint traffic isn't re-measured here; it's already in the pre-R2 table (world 0).

**Forced verify**: `World.requestSnapshot()` is not reachable from outside the process today — no HTTP route
calls it, and the brief's two described paths were "add a thin debug trigger" or "wait out a natural cycle."
This bench took the second, less invasive option: it waits (up to 75 s) for each room's own natural
`SNAPSHOT_EVERY_TICKS` cycle (1800 ticks at 60 Hz = 30 s) to fire and verify, exactly the mechanism the pre-R2
bench already relies on for its own `snapshotsAccepted` numbers, rather than adding a new server route for this
one measurement script. **Flagged under "Architectural decisions for review": this is the choice the brief
asked to have flagged, not a design decision made here** — no debug endpoint was added, so nothing here changes
`server/main.ts`'s route surface.

### Numbers, 4 runs

24/24 bots joined every run, every room's snapshot verified within the wait window, no hash failures, no
resyncs, no bot closed early, no rejects, 60 (±0.1) ticks/s in every room every run.

| Run | cgroup MB post-verify | cgroup MB peak | RSS MB (last) | Verify time per room (ms: M, M, S, S) | Pass (<200 MB)? |
|---|---|---|---|---|---|
| 1 | 171.82 | 172.71 | 154 | 791, 171, 48, 100 | yes |
| 2 | 95.74 | 96.92 | 145 | 632, 183, 29, 106 | yes |
| 3 | 103.90 | 104.49 | 154 | 905, 181, 50, 89 | yes |
| 4 | 104.86 | 107.32 | - | - | yes |

**Pass/fail against the 200 MB bar: PASS, in all 4 runs** — but not by a comfortable, consistent margin. Run 1
sat at 171.82 MB, only ~28 MB under the 200 MB line (86% of budget); runs 2, 3 and 4 landed in a tight ~95-105
MB cluster, roughly half that. This is reported plainly rather than rounded to "well under 200 MB": one run in
four used most of the budget, and nothing in these runs explains why run 1 differs from the rest by roughly
65-75 MB while online count, tick rate, and snapshot behaviour were identical across all of them. The likely
cause (not confirmed here) is the same "first activity" jump the pre-R2 table already found between 0 and 8
members on the fixed worlds (idle 49 MB -> 108 MB at first load) — loading 4 fresh rooms plus their first
snapshot cycle and verify worker spin-up is exactly that kind of one-off cost, and run 1 may have caught more
of it inside the measurement window (its verify times were also the run's slowest for its first room: 791 ms,
though run 3's M-room verify was slower still at 905 ms without the memory to match, so verify time alone does
not explain the gap). **This 1-in-4 outlier is itself the most useful finding**: a single run, or even three
clustered runs, reporting "~100 MB, comfortably under 200 MB" would have been true most of the time and
misleading about the tail.

### Comparison against the pre-R2 two-fixed-world baseline

The pre-R2 table above measured cgroup memory by member count on the two always-loaded fixed worlds (idle 49
MB, 108 MB at 8 members, 130 MB at 32, 153 MB at 64) and modelled per-member cost at about 0.7 MB. This run's
24 members across 4 freshly-loaded rooms (not fixed, always-loaded worlds) landed at 95.74-171.82 MB cgroup —
within or close to the range the old model predicts for 24-32 members on the fixed worlds (it would predict
roughly 49 + 24 x 0.7 ≈ 66 MB plus the ~50 MB "first activity" jump ≈ 116 MB), which the middle two runs (96,
104 MB) roughly match, and the first run exceeds by about 55 MB. The old model was built on worlds that are
already loaded before any bot connects; this bench's 4 rooms incur their "first activity" cost (log, verify
worker, first snapshot per room) four times over, freshly, inside the measurement window — the old model's
~50 MB single fixed jump may not directly transfer to "N freshly-loaded rooms load N times over," and these 3
runs are not enough to separate per-room first-load cost from per-member cost. That split is flagged as unmeasured
rather than guessed at.

### Surprising

- The ~76 MB spread between run 1 and runs 2/3 on an otherwise identical scenario (same code, same bot count,
  same room mix, consecutive runs seconds apart) is larger than anything in the pre-R2 table's own measured
  jumps. It was not chased down further here (see "architectural decisions" above: this slice is a measurement
  job, not a product-code change) but is flagged for anyone relying on a single run's number.
- All 4 rooms' snapshots verified well inside the 75 s wait window in every run (max 905 ms), i.e. forcing a
  verify by waiting out a natural cycle cost at most ~40 s of wall time beyond the join settle, not the 75 s
  budgeted.

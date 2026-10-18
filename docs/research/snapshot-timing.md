# Snapshot timing: why a long log never recovers

> **Correction (D-101):** a side-by-side browser test showed the old code *does* recover once a visitor stays until live, at most ~43 s late. "Never recovers" below overstates it; the cause is visitors leaving during a long catch-up (inferred). The 200k cap trap (Surprise, below) is real.

Labels: **[code]** read in code, **[measured]** run here, **[src]** from a source, **[infer]** inference.

## Summary
- The hypothesis is right in outline, but the mechanism is sharper than "casual visitors leave". The server asks the oldest-connected client for a snapshot even when that client is still replaying, so the request is wasted by construction **[code]**.
- On a cold start with a long log the first request fires on the first tick after the first join (`lastRequestTick = base`, so `last - base >= 1800` at once). It lands on a client that is 100k+ ticks behind **[code]**.
- A snapshot can only succeed once the oldest client has fully caught up, then stays through the next request. Visit-length data is missing, so "visitors leave first" is still **[infer]**.
- Surprise: `MAX_LOG_TICKS = 200_000` makes `hello` reject every join (`server/main.ts:533`). A full log therefore cannot be snapshotted by anyone, and the only exit is an admin reset.
- Smallest fix: only ask a client that has demonstrably caught up, retry sooner after a lapse, and show the log length on `/dashboard`. All of it is server-side TypeScript, with no sim or ABI change.

## Is the hypothesis right

1. **A replaying client is asked anyway.** `requestSnapshot` picks the lowest `seq` member whose `lastBadTick` is clean (`server/world.ts:693-696`). It never looks at whether that member has caught up.
2. **The client cannot answer in time.** `beginReplay` zeroes `wantSnapshotAt` (`client/worker.ts:246`). The `request-snapshot` message sets it (`:291-293`). `reactToTick` uploads only when `tick === wantSnapshotAt` and `tick > catchUpTarget` (`client/lockstep.ts:127-135`). If the client reaches that tick after the server gave up, the upload is ignored: `expectsUpload` needs `request` still set (`world.ts:707-709`).
3. **Give-up window.** The request lapses once `lastClosed > tick + 600` (`world.ts:677`). Tick X is about 120-180 ahead, so the client must be within roughly 700-800 ticks (12 s) of live when asked.
4. **`lastRequestTick` is set at request time and is not rewound on a lapse** (`world.ts:700`; the abandon branch at `:677-681` does not touch it). Futile requests therefore recur every 1800 ticks plus up to 600 for the lapse, about 40 s apart. Each goes to the same oldest client **[code]**.
5. **Cold start primes the pump.** `loadFromDb` sets `lastRequestTick = base` (`world.ts:272`). With L above 1800 the first join triggers an immediate request, to a client with a full-log gap.
6. **Catch-up is two phases, not one.** `fastForward` runs 12 ms slices to `catchUpTarget`, the tick at WELCOME (`worker.ts:578-585`). The ticks that arrived meanwhile are then stepped in "live" mode at `plan()` = base + MAX_EXTRA, at most 5 per frame (`lockstep.ts:97`, `worker.ts:591`). The client sends no HASH until `tick > catchUpTarget` (`lockstep.ts:129`), so the server's `lag()` is the honest "not live yet" signal (`stats.ts:118`).
7. **Measured speed.** On this x86 machine, the 512x512 sandbox with a synthetic lava heap (`/tmp/bench.ts`) runs at **2.3-2.9 ms/tick (about 430 ticks/s)**. That is slower than the brief's 1.5 ms. An empty sandbox runs 99k ticks/s. Slicing at 12 of 16.7 ms gives about 5 ticks/frame, so the gap closes at about 4 ticks/frame (about 250 ticks/s) in both phases. Estimates for this machine: **37k ticks takes about 2.5 min, 130k about 9 min**. A phone is slower **[infer]**.
8. **Cliff.** A request can succeed only if the lag at request time is below about 700 + 12 s x 250 = 3,700 ticks. Above that, success needs the same client to still be connected and live at some later request **[infer from 3, 6, 7]**.

Not culprits **[code]**:
- With one client the majority hash resolves as soon as that client's HASH arrives (`tryResolve`, `world.ts:607-636`). It sends the HASH before the upload (`worker.ts:200-205`), so the upload is not held up.
- D-038 only discards hashes at or before the replay target (`world.ts:588`). It does not block a live hash.
- Verify has a 10 s worker timeout (`verify.ts:8`). It is unlikely to bite on a sandbox snapshot.
- The last player leaving clears `request` (`world.ts:459-468`). It does not reset `lastRequestTick`, and D-042 deliberately skips a final snapshot.
- Growth rate: the clock pauses when empty, so the log grows only with connected time. 130k ticks is about 36 connected minutes without a single success.

## Prior art
- **Factorio**: map download, then a CPU-bound "catching up" phase, and big maps take longer. This is community-forum evidence only ([Steam thread](https://steamcommunity.com/app/427520/discussions/5/3443510323236578659/), [forums](https://forums.factorio.com/viewtopic.php?t=116510)) **[src]**. It is the same two-phase shape we have.
- **OpenTTD**: the server saves the map at a frame number, queues commands for the joiner, and the client catches up. `pause_on_join` removes the catch-up entirely, and `max_join_time` bounds it ([wiki FAQ](https://wiki.openttd.org/en/Manual/FAQ%20multiplayer), [PR 8755](https://github.com/OpenTTD/OpenTTD/pull/8755)) **[src]**. This fits us: a server clock pause is not server stepping.
- **Raft/etcd**: snapshot and truncate by **entry count** (`--snapshot-count`, default 100,000), and keep a small tail so slow followers can catch up ([etcd maintenance](https://etcd.io/docs/v3.5/op-guide/maintenance/), [PR 18825](https://github.com/etcd-io/etcd/pull/18825), [issue 7162](https://github.com/etcd-io/etcd/issues/7162)) **[src]**. The lesson is to trigger on log size. Our trigger already counts ticks, so the gap is who is asked.
- **Kafka**: compaction triggers on a dirty ratio, with `max.compaction.lag.ms` as a forced upper bound ([Confluent](https://developer.confluent.io/courses/architecture/compaction/)) **[src]**. This is the same idea as a hard alarm.
- **Falling-sand multiplayer**: no comparable project found. `slime` and Mieschke's paper cover snapshot hot-join, with no log-bounding policy ([slime PR 11](https://github.com/trochos/slime/pull/11)) **[src]**.
- **Does not fit**: a leader or server that snapshots itself (breaks invariant 11), Raft's "leader sends its own state", and any server-side replay.

## Candidate fixes

| | Fix | Files | Invariant risk | Cost | Proof |
|---|---|---|---|---|---|
| a | Ask only a caught-up client (server checks its HASH lag), so a request is made as soon as one is live | `world.ts` | None | about 10 lines | net test: a stalled-hash member is skipped |
| b | Trigger on log length | `world.ts` | None | Already true: `last - lastRequestTick` is a tick count. The gap is the lapse path | covered by (c) |
| c | Retry about 300 ticks after a lapse, not 1800 | `world.ts` | None | 2 lines | test: a lapse followed by a retry |
| d | Faster catch-up (bigger slices when idle, replay worker) | `worker.ts`, `lockstep.ts` | Low (client only) | Medium | A bigger slice drops frames. The sim is single-threaded (no WASM threads), and a second instance doubles memory |
| e | Alarm at about 100k, raise or relax the 200k cap | `world.ts`, `main.ts`, dashboard | None | Small | dashboard test |
| f | `ticksSinceSnapshot` on `/dashboard` | `main.ts:108-116,749-750`, `dashboard.ts:130-131` | None | Small | `tests/net/dashboard.test.ts` |
| g | `pause_on_join`: hold the clock until a lone joiner reports live | protocol, `world.ts`, `worker.ts` | None (clock only) | Medium, new message | test: log stops growing during catch-up |
| h | Mid-replay snapshot: the replaying client uploads at an already-closed tick | protocol, `world.ts` | Medium (needs a cross-check, since old truth is gone after 1800 ticks) | Large | later |

**(a) detail.** Add to the `requestSnapshot` loop: skip a member unless `timing.lastHashTick > m.minHashTick && last - lastHashTick <= 3 * HASH_EVERY`. When no member is live it returns false before touching `lastRequestTick` (`:697`), so it retries every tick and fires within about a second of the first live hash.
- *Race with the first HASH:* none. X is at least 120 ticks ahead of the client's tick, and the HASH precedes the upload on one socket.
- *Race with the majority rule:* with a second, still-replaying member, `tryResolve` waits up to 2 s (`HASH_WAIT_MS`). That is well inside the 600-tick window.
- *Catch:* a resync does not clear `lastHashTick`, so compare it with `minHashTick` as above.
- *Residual:* the first visitor still has to stay for the full catch-up (about 2.5 min for 37k, much longer on a phone).

**(c) detail.** In the abandon branch set `lastRequestTick = last - snapshotEvery + 300`.

**(e) detail.** At 200k, joins are rejected (`main.ts:533`), so nobody can ever snapshot **[code]**. D-097 reset is the only exit. Options: raise `MAX_LOG_TICKS` (the log is small in RAM, since a tick frame is about 10 bytes); or let joins through when full, since the log is the thing we need someone to replay. An alarm is cheap either way.

**(g) is the real fix for phones.** With the clock paused while the lone member replays, the log stops growing under the joiner. It would be the same trick as OpenTTD's `pause_on_join`. It needs a client message (the client sends no HASH until live, and there is none at the target tick), so it is not a Tuesday change.

## Recommendation
Ship before Tue 20 Oct, server-side only:
1. Fix (a) and fix (c), with two net tests in `tests/net/game.test.ts`, which already boots with `snapshotEveryTicks: 120`. First: a member whose hashes are withheld is not asked. Second: a request lapses and then retries.
2. Fix (f), plus a warn colour above 20k ticks (about 5 min of replay).
3. Fix (e), reduced to raising the cap (or letting joins through when full).

Leave for later: (g), (h), (d). Add (g) and (h) to `FUTURE.md`.

## Open questions
- What was visit length on 14-18 Oct? Log it from now on.
- Is 1.5 ms/tick or 2.3 ms/tick the live heap's speed? The dashboard tick rate cannot show it, because the server does not step. A client p95 is already in the HASH (`stepP95Ms`).
- Phone catch-up of 130k ticks is **[infer]** only, and unmeasured.

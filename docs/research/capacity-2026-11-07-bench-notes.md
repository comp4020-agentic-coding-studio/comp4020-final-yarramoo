# Capacity bench notes, 7 Nov 2026 (image cap-app:9cfd24f, script tests/soak/capacity-ramp.ts)

Raw data: `capacity-2026-11-07-bench.json`. Columns: step | rooms | members | cpuCores (cgroup usage_usec delta / wall) |
throttled periods (throttled ms) | cgroup MB max | tps min over all rooms and samples | lastVerifyMs seen (min..max) / snapshots rejected |
out KB/s per member | DB+WAL growth KB/min | extras. Window is 45 s, extended up to 75 s until every room verified (actual 51-52 s).

## Run 1: --cpus=1, Scenario A (Survival M, 4 bots/room, rooms 1,2,4,6)
Idle (fresh container, 30 s): 0.034 core, cgroup 117.7 MB, RSS 103 MB. Rounds started (`running`) in every room; none ended.
Host load: 2.8 before step 1; 7.3 after step 4 (the other agent's gate began mid-run; steps 3-4 "under rising load").

| step | rooms | members | cpuCores | throttled | MB max | tps min | verify ms / rej | out KB/s/member | DB growth KB/min | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 4 | 0.130 | 7 (500 ms) | 173 | 59.9 | 7..785 / 0 | 2.51 | 1632 | lag p99 62 ms, bot lag 20 ms, load 2.8->3.3 |
| 2 | 2 | 8 | 0.118 | 9 (130 ms) | 187 | 59.9 | 7..327 / 0 | 2.52 | 1607 | lag p99 23, bot lag 20, load 3.2->3.9 |
| 3 | 4 | 16 | 0.191 | 21 (477 ms) | 197 | 59.9 | 276..554 / 0 | 2.51 | 964 | lag p99 24, bot lag 49, load 3.9->5.9 |
| 4 | 6 | 24 | 0.275 | 50 (1293 ms) | 205 | 59.9 | 296..961 / 0 | 2.51 | 682 | lag p99 35, bot lag 150, load 6.2->7.3 |

## Run 2: --cpus=1, Scenario B (Deathmatch M, 8 bots/room, rooms 1,2,3,4)
(Waited for a quiet host; an unrelated full gate delayed the start to 12:37.) Load 2.6 at start, 8.4 at end.
No idle repeat (idle is per CPU setting, done in run 1).

| step | rooms | members | cpuCores | throttled | MB max | tps min | verify ms / rej | out KB/s/member | DB growth KB/min | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 8 | 0.116 | 11 (593 ms) | 166 | 59.9 | 6..1104 / 0 | 4.63 | 1698 | lag p99 25, bot lag 13, load 3.1->4.0 |
| 2 | 2 | 16 | 0.166 | 19 (369 ms) | 184 | 59.9 | 11..628 / 0 | 4.62 | 817 | lag p99 29, bot lag 23, load 4.0->3.7 |
| 3 | 3 | 24 | 0.265 | 52 (2084 ms) | 195 | 59.9 | 570..1901 / 0 | 4.56 | 378 | lag p99 41, bot lag 199, load 3.9->7.1 |
| 4 | 4 | 32 | 0.352 | 72 (2900 ms) | 203 | 59.9 | 570..1175 / 0 | 4.50 | 836 | lag p99 39, bot lag 316, load 6.6->8.4 |

Observations (1 CPU)
- Compare 24 Oct: ~0.16 core at 8 members, ~0.28 at 32 on two worlds. Today: 0.12 at 8 (DM), 0.35 at 32 (DM), 0.27 at 24
  (Survival). Same order of magnitude, no 10x discrepancy, so no second run was needed.
- CPU is roughly 0.01 core per member plus ~0.03 idle, i.e. close to linear; verify spikes dominate (a verify is 300-1900 ms
  of worker time and at --cpus=1 it shows as throttling periods).
- Throttling already occurs at 1 CPU (7-72 periods per 45 s) even though mean use is far below 1 core: bursts (verifies,
  snapshot compress) exceed one core's 100 ms period quota. Mean cpuCores understates what a small quota feels like.
- Bot-side lag grew to 150-316 ms at steps 3-4 as host load rose (8 cores shared with another agent's gate). Bots lagged,
  so the late-step server numbers may be slightly kind (bots hash/relay late) and the host is a confound.
- cgroup memory max reaches 203-205 MB at 24-32 members against a 256 MB limit; includes page cache and the tmpfs WAL
  (WAL grows ~1 MB/min per run, kept in /data tmpfs which counts against the memory limit). Not a leak finding by itself
  (memory.peak = max during the run); a longer soak would be needed.
- DB growth is WAL bytes (db file stays 4096); the per-minute figure falls with step because checkpoints reset the WAL.
  Treat as noise-dominated, indicative of ~0.4-1.7 MB/min written.
- Out bytes: ~2.5 KB/s per member (Survival, 4 bots) vs ~4.6 KB/s (Deathmatch, 8 bots): outbound per member scales with room size,
  as each member receives every other member's inputs.

## Run 3: --cpus=0.0625 (1/16 core), Scenario A (Survival M)
Idle (30 s, no rooms): 0.029 core (46% of the quota), 5 throttled periods, cgroup 51 MB, RSS 104 MB.
Host load 2.7 (quiet). A first attempt (12:47) crashed in the bench: `/api/summary` fetch failed ("other side closed") while
the server was starved; the script was changed to retry summary fetches (20 s timeout, up to 30 tries) and to dump docker logs
on error. The second attempt is reported (12:51).

| step | rooms | members | cpuCores | throttled | MB max | tps min | verify ms / rej | out KB/s/member | DB KB/min | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 4 | 0.062 (at quota) | 3205 (723 s) | 94 | 57.7 | 10272..62603 / 8 | 1.22 | 516 | lag p99 6.2 s, window 51 s+ |
| 2 | 2 | 8 | 0.062 (at quota) | 4934 (1098 s) | 142 | 45.7 | 11300..94600 / 25 | 0.80 | 72 | lag p99 25.5 s |

Failed at the first step: a single Survival room of 4 on 1/16 core already misses 58 tps (57.7), has event-loop lag p99 6 s, and
snapshot verifies take 10-60 s with rejections (the bench's step-1 `snapshotsRejected` 8 includes rejections by timeout
during the lobby->running transition). No bots dropped. Step 2 (the "failing step plus one") collapses further: tps 45.7,
lag p99 25 s, verifies up to 95 s. The ramp stopped after step 2 per the rule.

## Run 4: --cpus=0.0625, Scenario B (Deathmatch M), INCOMPLETE
Host load 6.3 at step start (settling), 3.4 at end.

| step | rooms | members | cpuCores | throttled | MB max | tps min | verify ms / rej | out KB/s/member | DB KB/min | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 8 | 0.062 (at quota) | 2395 (432 s) | 120 | 59.3 | 299..8801 / 2 | 1.70 | 506 | lag p99 2.7 s, window 243 s (extended to wait for verify, which took until the bench's 75 s guard failed to bind; see below) |

Step 1 already failed (verify rejected 2; lag p99 2.7 s; tps 59.3 min is marginally above the 58 bar). Step 2's room creation
or join then made `/api/summary` unreachable for over 30 retries and the bench exited with "fetch failed"; I did not
investigate further (spend cap reached). No step-2 numbers exist. Treat Scenario B at 1/16 core as: 1 room of 8 does not
hold (verify rejections, multi-second lag), 2 rooms did not complete a step.

Known bench caveat: the "extend until all rooms verified, max 75 s" rule uses elapsed time inside the loop but the
summary fetch retries inflated windows to 243-300 s at tiny quotas, so cpuCores there is still a valid ratio (usage delta / wall).

Observations (1/16 core)
- 0.0625 core cannot carry even one 4-member Survival room: the quota is pinned (cpuCores = 0.062 = the limit), CFS throttles
  in 3000-5000 periods, event-loop lag reaches seconds, verifies time out. Idle (0.03 core) alone uses half the quota.
- Memory is not the limit at this size (94-142 MB), CPU is.

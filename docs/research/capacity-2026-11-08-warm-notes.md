# Capacity re-measure with warm verify lanes, 8 Nov 2026 (image warm-app:3c5cecd, bench tests/soak/capacity-ramp.ts)

Raw data: `capacity-2026-11-08-warm.json`. "Before" is `capacity-2026-11-07.md` / `-bench-notes.md` (image cap-app:9cfd24f).
Hold = tps min >= 58, verifies accepted, no rejects, lag p99 < 1 s (the 7 Nov reading). The bench now also records `verifyLog`
(cumulative lane_opened/lane_refused and cold/warm `snapshot.accepted` counts from `docker logs`). Verify micro skipped: it
times the worker job, which lanes do not change; the 7 Nov cold/warm numbers stand.

## Run 1: --cpus=0.0625, Scenario A floor (Survival M, 2 bots, WINDOW_S=150)
Host load 2.7 before, 3.0 after (quiet).

| | cpuCores | throttled | MB max | tps min | lag p99 max | verify ms seen | accepted / rejected | lanes opened/refused | cold/warm (cumulative) |
|---|---|---|---|---|---|---|---|---|---|
| before | 0.061 | n/a | n/a | n/a | 1.3 s | 10-17 s each | 0 of 5 / 5 | n/a | n/a |
| after | 0.0615 | 2071/2134 periods (214 s) | 117 | 57.9 | 4.6 s (last sample 0.1 s) | 0, 15799 (first), then 563, 1582, 79, 278, 76, 2001 | 7 / 0 | 1 / 0 | 0 cold / 7 warm |

Window ran 213 s (summary fetch retries, 34, stretched it). The first verify still took 15.8 s (lane prewarm and the first
snapshot during the join), every later one was 0.1-2 s. Lag p99 max 4.6 s is probably the join/prewarm phase; last sample 0.1 s.

First attempt at run 2 (06:36) crashed on an unretried `/api/rooms`/`/api/players` fetch ("other side closed"; the bench only
retried summary fetches); `rfetch` retry added (commit 46fe25d) and the run repeated. The JSON holds the repeat only.

## Run 2: --cpus=0.0625, Scenario A (Survival M, 4 bots/room), MAXSTEPS=2
Host load 2.5 before step 1, 2.8-3.0 after (quiet).

| step | rooms | members | cpuCores | throttled periods | MB max | tps min | lag p99 max (last) | verify ms seen | accepted / rejected | lanes opened/refused | cold/warm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| before 1 | 1 | 4 | 0.062 | 3205 | 94 | 57.7 | 6.2 s | 10.3-62.6 s | n/a / 8 | n/a | n/a |
| after 1 | 1 | 4 | 0.062 | 655 | 107 | 59.0 | 0.51 s (0.30 s) | 0.7-4.1 s | 2 in window / 0 | 1 / 0 | 0 cold / 3 warm |
| before 2 | 2 | 8 | 0.062 | 4934 | 142 | 45.7 | 25.5 s | 11.3-94.6 s | n/a / 25 | n/a | n/a |
| after 2 | 2 | 8 | 0.062 | 997 | 163 | 57.7 | 5.2 s (1.8 s) | 0.4-9.6 s | 3+3 in window / 0 | 2 / 0 | 0 cold / 11 warm |

Step 1 holds under the 7 Nov bar (tps 59.0 >= 58, all verifies accepted, none rejected, lag p99 under 1 s; the bench's own
stricter 500 ms bar is marginally missed at 505 ms, which flagged the step as failing and so ran step 2). Step 2 does not hold:
tps 57.7, lag p99 up to 5.2 s, though no verify was rejected. cgroup max 163 MB with two lanes against the 256 MB limit
(before 142 MB without lanes); 0 refused.

## Run 3: --cpus=0.0625, Scenario B (Deathmatch M, 8 bots/room), MAXSTEPS=2
Host load 2.2 before step 1; step 2 began at load 10.8 (another job on the host, not ours) so step 2 is "under load"
(its window ran 449 s) and is weaker evidence.

| step | rooms | members | cpuCores | throttled periods | MB max | tps min | lag p99 max (last) | verify ms seen | accepted (window) / rejected | lanes opened/refused | cold/warm (cum.) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| before 1 | 1 | 8 | 0.062 | 2395 | 120 | 59.3 | 2.7 s | 0.3-8.8 s | n/a / 2 | n/a | n/a |
| after 1 | 1 | 8 | 0.062 | 1053 | 112 | 58.2 | 5.7 s (0.9 s) | 0.3-5.3 s | 3 / 0 | 1 / 0 | 0 / 5 |
| before 2 | 2 | 16 | n/a (did not complete) | | | | | | | | |
| after 2 (under load) | 2 | 16 | 0.062 | 4490 | 187 | 49.3 | 15.1 s (9.6 s) | 0.3-24.4 s | 11+11 / 0 | 2 / 0 | 0 / 35 |

Step 1: tps and rejections hold (58.2, 0 rejected, all warm) but lag p99 peaked at 5.7 s, so it does not hold under the 1 s
bar (it did settle to 0.9 s). Step 2 does not hold (tps 49.3, lag to 15 s), though nothing was rejected and the bench completed
where it did not before.

## Run 4: --cpus=1, Scenario A (Survival M, 4 bots/room, rooms 1,2,4,6) with --idle
Idle: 0.043 core, 0 throttled, cgroup 52.7 MB, RSS 107 MB (before: 0.034 core, 117.7 MB cgroup). Scenario B at 1 CPU not run (cap).
**Host load was high and not from us** (5.0 at start, 13 after step 1, 17 after step 3, 30 after step 4), so every step is
"under load" and the CPU columns are inflated by host contention; compare memory and verify counts, not cores.

| step | rooms | members | cpuCores | throttled | MB max (before) | tps min | lag p99 max | verify ms seen (before) | rejected | lanes opened/refused (cum.) | accepted cold/warm (cum.) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 4 | 0.147 (0.130) | 1 (7) | 119 (173) | 59.9 | 34 ms | 0..41 (7..785) | 0 | 1 / 0 | 0 / 2 |
| 2 | 2 | 8 | 0.146 (0.118) | 0 (9) | 171 (187) | 59.8 | 41 ms | 0..26 (7..327) | 0 | 2 / 0 | 0 / 7 |
| 3 | 4 | 16 | 0.241 (0.191) | 35 (21) | 221 (197) | 59.9 | 81 ms | 0..1070 (276..554) | 0 | 2 / 3 | 4 / 11 |
| 4 | 6 | 24 | 0.644 (0.275) | 282 (50) | 240 (205) | 59.4 | 151 ms | 0..6316 (296..961) | 0 | 2 / 9 | 14 / 17 |

Lanes: with 4 bots a room is M-size and the 100 MB estimated budget held only two lanes; from step 3 the rest were refused and
their rooms verified cold on the overflow worker (those cold verifies show as 790..6316 ms at steps 3-4, slower than before
partly because of the host load). Memory is the visible cost: cgroup max 221-240 MB against the 256 MB limit at 16-24 members
(before 197-205), i.e. about 16-35 MB more, and nothing OOM'd. Warm verifies are 0-70 ms.

## Before / after at the quota (--cpus=0.0625), hold = tps >= 58, no rejects, lag p99 < 1 s
| scenario | before (7 Nov) | after (warm lanes) |
|---|---|---|
| floor, 1 room of 2 | 0 of 5 verifies accepted, lag p99 1.3 s | holds on verifies (7 accepted, 0 rejected), tps 57.9, lag p99 peak 4.6 s (join/prewarm), 0.1 s after |
| Survival M, 1 room of 4 | fails: tps 57.7, lag 6.2 s, 8 rejected | holds marginally: tps 59.0, lag 0.51 s, 0 rejected |
| Survival M, 2 rooms of 4 | fails: tps 45.7, lag 25.5 s, 25 rejected | fails: tps 57.7, lag 5.2 s, 0 rejected |
| Deathmatch M, 1 room of 8 | fails: 2 rejected, lag 2.7 s | tps ok 58.2, 0 rejected, lag peak 5.7 s (settles 0.9 s): fails the lag bar |
| Deathmatch M, 2 rooms of 8 | incomplete | fails: tps 49.3, lag 15 s, 0 rejected (under host load) |

**Headline: rooms held at the quota: before 0, after 1 (Survival M, 4 members, marginally; with Deathmatch 1 x 8 tps-ok and
reject-free but lagging).** Warm lanes remove the verify rejections entirely at the quota (0 rejected of ~60 verifies, all warm,
vs 8-25 rejected before) and cut throttled periods 3-5x, but the quota is still CPU-bound (cpuCores pinned at 0.062): event-loop
lag still reaches seconds, and two rooms do not hold. At 1 CPU nothing regressed on tps or rejections; the cost is memory
(+16-35 MB cgroup at 16-24 members) and a lane budget that admits only two M lanes.

## Caveats
Single samples per cell; step 1 of run 2 passed by 0.5 s of lag and the bench's own 500 ms bar failed at 505 ms. Run 1's window
stretched to 213 s (summary retries). Run 3 step 2 and all of run 4 ran under host load from outside (10-30). The first
verify per room still takes 4-16 s at the quota (join/prewarm), so lag p99 peaks come from the join phase. Verify micro skipped.
`snapshots accepted` for "before" was not recorded per window, so "before accepted" is stated from the 7 Nov notes only.

## Architectural decisions for review
- Bench now counts `verify.lane_*` and `verify_cold` from cumulative `docker logs` per step (regex over log lines); cheap but
  it depends on the log line shape and on `log.limited` (10 s) not hiding lane events, so lane counts could undercount.
- Added `rfetch` (30 retries, 30 s timeout) for room/player/wasm fetches so a starved server does not crash the bench. Raw JSON
  therefore reflects retries; summary retry count is recorded.
- Kept the 7 Nov pass/fail rule (tps 58, lag 500 ms in the bench) but report the 1 s lag bar the brief set in the tables.

## FUTURE
- Raise the lane budget or make it adaptive (only two M lanes fit 100 MB; a 4-room Survival at 1 CPU refuses 9).
- Prewarm the first verify during the lobby rather than at first join, to cut the 4-16 s first verify at the quota.
- Record lag p99 only after the first verify so join-phase spikes do not mask steady-state.

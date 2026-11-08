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

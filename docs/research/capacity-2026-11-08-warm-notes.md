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

# D-088 late-join failure (M4b test): findings

## Verdict
Not a sim or cache bug. The test's assumption was timing-dependent: it asserted the late joiner's snapshot had bolts in flight, but a snapshot only has bolts for a few ticks of each cast cycle, and the test locked the snapshot onto the bolt-free phase.

## Evidence
- Hypothesis (cache-hit restore alters entities, so snapshots with bolts fail verification) is false: instrumented the failing run, `snapshotsAccepted: 1, snapshotsRejected: 0`. The verified snapshot was tick 240, accepted normally.
- Per-tick projectile count seen by client A (ticks 151..261): bolts exist only in 8-tick windows starting at ticks 155, 180, 204, 228, 252 (period 24, i.e. 4 shooter periods of 6 ticks at 100 ms, because the Push cooldown is 20 ticks). Tick 240 is 12 ticks past the last bolt's death window: zero bolts.
- Snapshots are requested at multiples of HASH_EVERY (60), in the test at 120-tick cadence, so the snapshot tick is always 0 mod 24 (every multiple of 120 is). The phase is the same every time, so every snapshot is bolt-free. Rejoining 20 times (the earlier retry) re-fetched the same snapshot, so it never helped. Why it passed 2 runs in 3 before D-088 is not established (likely where the first cast landed relative to the snapshot tick, which depends on startup timing); D-088 does not change the restored state, which the verifier confirmed.
- Server stats and verifier path (worker reuses its sim, cache-hit restore) were fine: restored hash matched.

## Fix
Test only: shooter period 117 ms (about 7 ticks, so the cast cycle is not a divisor of the snapshot cadence and its phase walks), snapshot every 60 ticks, and C rejoins on each newly verified snapshot until one has bolts (max 10 tries).

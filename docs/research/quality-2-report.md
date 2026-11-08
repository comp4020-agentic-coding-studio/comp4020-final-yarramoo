# quality-2: the Survival claims test made load-proof (D-219), and the slow-net quiet re-run

Lead: Opus, 8 Nov evening, branch `quality-2` from `multa` `a2c0ea8`. No workers dispatched (done directly; briefing
would have cost more). Spend: B0 = $391.79.

## Part A: D-219

### Reproducing it

External CPU load does **not** reproduce it on this Mac: 4/4 green beside 8 `yes` hogs, 5/5 beside 16, 3/3 with the
test under `taskpolicy -c background` (`/tmp/q2-logs/load1..9.log`, `bg10..12.log`). The scheduler shelters the test,
and the run time barely moved (17.8 s quiet, 18.6 to 20.7 s with 16 hogs). The original gate failure ran 36.7 s
(`/tmp/phoneperf-cs-3.log`), so what the gate does is **starve the test's own event loop**: the server, both Node
clients' sims and the script all share it.

So the test was run with an in-process busy-wait (temporary hook, not committed: it busy-waits `stall` ms of every
`period` ms), plus file probes (`/tmp/q2-logs/probe-version.diff`):

| Starvation (stall/period) | Original test | Probe evidence |
|---|---|---|
| 30/50, 60/80, 200/230 | 6/6 green | kill on cast 1 or 2 |
| 500/560 (89%) | 2/2 green | A down to **15 hp**, three casts (`probe-stall500-*.txt`) |
| 1000/1060 (94%) | **2/2 red**, "timed out waiting for enemy kill resolved by majority" (`stall1000-1.log`, `-2.log`) | A at **hp 0** by cast 1, then 39 casts from a corpse (`probe-stall1000-*.txt`) |
| 1500/1560 (96%) | **2/2 red** (test timeout) | same: hp 0 from cast 0 |

### The cause

Every pacing step was wall clock: `sleep(90)` per 40-cell walk step, `sleep(400)` after the pickup, `sleep(100)`
before a cast, `sleep(300)` after it. The server's tick clock is also wall time, so a starved loop turns each of those
into tens of sim ticks. A then spends ten times more sim time crossing the map, among enemies that keep acting.
The quiet path reaches the pickup at tick 259; at 94% starvation it reaches it at tick 762 with 65 hp
(`probe-fix4-*.txt`). It then follows its slime deeper (y 4600 instead of 3104), aims at where the slime *was*
before the walk, and dies. After that, nothing could resolve the kill. The seed was not the cause, as D-219 already says.
**No product bug**: the server, claims and sim behaved correctly in every probe (zero Pos rejections, the kill resolves
the moment A lands a hit).

A second, smaller race turned up under starvation: `expect(a.achievements).toContain("slime_slayer")` read A's socket
in the same turn the server resolved the award, before the message arrived (`/tmp/q2-logs/final-stall-1.log` of the
NODE_OPTIONS run).

### The fix (test-only, `tests/net/claims-survival.test.ts`)

- The walk is paced by the **server's closed ticks** (the clock `maxPosJump` is measured against): each step covers
  6 cells per server tick since the last step, capped at 300 cells and inside the server's Pos bound (9 cells per tick
  plus 10 ticks of slack), one step per 3 ticks (under the input rate limit). A crosses the map in the same sim time
  whether the process wakes every tick or once a second.
- Every other wait counts **A's sim ticks** (`ticks(n)`), not milliseconds.
- Each try targets the **nearest live slime** and aims at its position **after** the walk.
- A dead caster fails at once with `A died before killing a slime (tick, try)` instead of timing out on the majority.
- The award is awaited (`waitFor` on `a.achievements`) instead of read synchronously.

The whole-sim alternative (step the server clock from the test) would need a product change to `World`'s `now`
(it is `performance.now()`, not injectable per world). Not done: the brief asks for test-only.

### Green runs (clean file, stall hook added only for the run and removed after)

| Condition | Fixed test |
|---|---|
| Quiet, whole file | **5/5** green, 4/4 tests each (`final-quiet-1..5.log`) |
| 89% starvation (500/560) | **5/5** green (`final-s500-1..5.log`); the original passed here only with A at 15 hp |
| 94% starvation (1000/1060) | **3/5** green (`final-stall-1..5.log`); the original was 0/2 |

The residual at 94% is honest and stays: when this process wakes once a second, A can react only once per 60 ticks
while enemies act every tick. One run died (`A died...`, the clear message), one timed out on the kill. A real gate's
starvation is far below 94% (the failing gate stretched the test about 2x, roughly 50%), where the fix is 5/5 and
the original's margin was already thin.

### Gate

Planner: tier **tests** (typecheck + net). Result and log below.

## Part B: slow-net quiet re-run

(below)

## D-row draft (update to D-219)

| D-219 (closed) | 2026-11-08 | **Cause found: wall-clock pacing, not load or seed.** Under a starved event loop the scripted walk's `sleep(90)` steps each cover tens of server ticks, so A spends ten times the sim time among enemies, follows its slime deeper, aims where it was, and dies before the first hit (probe: hp 0, then 39 casts from a corpse; red 2/2 at 94% in-process starvation; external `yes` hogs never reproduce it on macOS). **Fix (test-only)**: the walk is paced by the server's closed ticks inside `maxPosJump`, every other wait counts A's sim ticks, each try targets the nearest live slime at its post-walk position, a dead caster fails with a clear message, and the award is awaited instead of read in the same turn. Green 5/5 quiet and 5/5 at 89% starvation (the original was down to 15 hp there), 3/5 at 94% (original 0/2). | quality-2; `docs/research/quality-2-report.md` |

## FUTURE ideas (listed, not added)

- **A test-steppable world clock**: `startServer({ worldNow })` so a net test can advance ticks by hand. Makes every
  scripted-play test fully deterministic under any load, at the cost of a small product change to `World`'s `now`.
- **A starvation hook for the net suite** (`Q2_STALL`-style busy-wait from a vitest setup file) so "does it survive a
  loaded gate" is a reproducible test condition rather than an accident. This run found external hogs useless on macOS.

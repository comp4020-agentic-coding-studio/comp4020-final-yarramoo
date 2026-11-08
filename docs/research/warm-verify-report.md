# Warm verify lanes (D-228; implements D-213 recommendation 1): report

> Merged as `ba65844` and recorded as **D-228**. The code and this report first cited it as "D-214", a number already
> taken (the supply alcove); the code was renumbered at merge, mentions below are kept as written.

Two sessions. **Session 1** (8 Nov, the original brief) designed and built the lanes and stopped at its cap with the gate
red; its report is kept at the end. **Session 2** (8 Nov evening, backlog run item 1, Opus lead, cap $22) rebased,
fixed the red tests, pinned the owned-room lifecycle, gated, had a cold review and acted on it, and re-measured capacity.

## Headline
**Rooms held at the Fly sustained quota (`--cpus=0.0625`, 256 MB): before 0, after 1**, and that one only just: a
Survival M room of 4 (59.0 tps, 0 rejected, lag p99 0.51 s). Warm lanes **end verify rejections at the quota** (0
rejected of about 60 verifies, all warm, against 8-25 rejected before; the 2-player floor went from 0 of 5 accepted to
7 of 7). But the quota stays CPU-bound (0.062 core pinned): two rooms still do not hold, and Deathmatch 1 x 8 is now
reject-free but peaks at 5.7 s of lag. **The quota number moves from 0 to 1, not further.** The code: an occupied **cave** room gets its own verify worker ("lane"),
prewarmed with the room's own seed and config at the first join, so its verifies are warm: in a real two-browser L room
on :8086 every verify was warm on the lane, 15-64 ms (cold L on a full core: 0.7-0.9 s, 7 Nov).

## Session 2

### Commits on `warm-verify` (on `multa` 21cd335)
| Commit | What | Gate |
|---|---|---|
| `bb90b52` | session 1's WIP, rebased (was `8eeb81e`) | red (session 1) |
| `68fb313` | fix the three red tests; owned-room lane test | **full**, green |
| `3c5cecd` | act on the cold review (S2-1..4, S3) | **server** tier, green; `pnpm check` on :8086 green |
| `506f953` | capacity worker brief | docs |
| `f1fdba3`, `46fe25d` | bench: count lane events and cold/warm verifies per step; retry room/player/wasm fetches (Sonnet worker) | docs (`check:evidence`) |
| `60f2a98`, `a76b3eb`, `a871f8d`, `f44b12f` | capacity runs 1-4, notes, before/after table (Sonnet worker) | docs |
| (this) | this report | docs |

### Rebase
Clean, no conflicts (owned sandboxes, slow-net and the architecture audit had landed). The worktree had no wasm; built.

### The three red tests
1. **"a hung worker is terminated"** (`game.test.ts`): `hang-worker.ts` never answers the lane's prewarm, so the job
   waited on the fixed 120 s warm-up bound. Fix (`server/verify.ts`): unless given, `warmTimeoutMs` is the job timeout
   times the default ratio (`timeoutMs * LANE_WARM_TIMEOUT_MS / VERIFY_TIMEOUT_MS`, 12x): production keeps 120 s, a
   test's 600 ms gives 7.2 s. **Red first**: with the old fixed bound the test times out at 40 s, the gate's failure
   (`/tmp/warm-probe/red-hung-fixed-warm-bound.log`).
2. **"the tick clock does not stall"** (`game.test.ts`): diagnosed: **not a stall** (worst tick gap 17-28 ms). The failing
   assertion was `lastVerifyMs > 100` ("a real world was regenerated off-thread"): the game world's lane now generates at
   the join, so the verify was warm (16-28 ms). The test now runs twice: **overflow** (lanes off: the verify regenerates,
   > 100 ms, one cold restore) and **warm lane** (a lane, no cold restore; the closed-tick window starts before the join so
   it covers the generation). Both keep the < 120 ms worst gap and the main-thread control. Note: removing the join-time
   `warm()` call leaves the lane variant green (the lane then opens at the first verify, still off-thread); the join-time
   open is pinned by `warm-verify.test.ts` "a World opens its lane on the first join".
3. **"waterworks at exactly 100"** (`achievements-live.test.ts`): **unrelated to warm verify, and it fails on `multa`**.
   A probe recorded the server's cast count, `stats.droppedRate`, and the count 2 s later:

   | Build, host | Runs | Count at 99 casts | Dropped by the rate limit |
   |---|---|---|---|
   | branch, quiet (load ~2), lanes on / off | 3 + 3 | 99 | 0 |
   | branch, 8 `yes` hogs, lanes on / off | 3 + 3 | 99 | 0 |
   | branch, 24 hogs, lanes on / off | 4 + 4 | **98** | **1** |
   | **`multa` 21cd335**, 24 hogs | 3 | **98** | **1** (test fails: "expected 98 to be 99") |

   The 99th cast is dropped by the input rate limiter (`INPUT_RATE_LIMIT` 40 in a fixed 1 s window, `server/main.ts`
   "input"): the test sends 10 casts every 400 ms, and a loaded server reads two bursts in one window. A test-timing fault
   on `multa`, not changed here (logs `/tmp/warm-probe/ww-*.log`, `ww-multa-load24-*.log`). Fix idea in FUTURE below.

### Owned rooms: unload and reload
Every unload path goes through `World.shutdown()` (owned unload in `scheduleUnload`, `deleteRoom`,
`discardIfFreshlyLoaded`, `failWorld`, server close), which releases the lane at once; a reloaded room reads its seed
from its row before any join. **But owned sandboxes are `CLASSIC_SANDBOX`, empty-box terrain, and the sim caches a base
only for cave worlds** (`sim/src/sim.rs` `Base`, built only in the `TERRAIN_CAVES` arm), so a lane bought them nothing
(the "warm" the first version of my owned test saw was only the worker's telemetry key). After the review (S3-7): **no
lane for a box room**. The owned test now pins "no lane, verifies accepted across an unload and a reload" (red with the
caves check removed: `/tmp/warm-probe/red-owned-no-caves.log`); a cave room's unload release and fresh warm lane on
reload is pinned at the `World` level (`warm-verify.test.ts` "a lane lingers ... a reload opens a fresh warm lane").

### Cold review (`docs/research/review-warm-verify.md`, Sonnet, read-only; brief `docs/briefs/warm-verify-review.md`)
No S1. Every claim below was checked in the code before acting; each fix has a test shown red by a mutation.

| Finding | Checked | Done | Red-first (`/tmp/warm-probe/`) |
|---|---|---|---|
| S2-1 lane open/close logged with `log.event` on every first join / last leave | confirmed | `log.limited` per room | (logging; no test) |
| S2-2 join/leave churn regenerates the world each cycle; draining workers outside the budget | confirmed | lane **lingers 60 s** (`LANE_LINGER_MS`) after the last leave, unload/delete/shutdown release at once; draining lanes count in the budget until the worker exits | `red-no-linger.log`, `red-drain-uncounted.log` |
| S2-3 a drain during a hung warm-up disarmed the warm timer: verify never answered, worker ref'd | confirmed | drain keeps `warming`; the bound still kills it | `red-drain-disarms.log` (hangs 5 s) |
| S2-4 a release lifted the bar (churn defeated it); crashes never barred | confirmed | bar by time, `LANE_BAR_MS` 5 min, on timeout **or crash** | `red-release-unbars.log` |
| S3-7 lanes for non-cave rooms buy nothing | confirmed (`sim.rs`) | caves only | `red-no-caves-check.log` |
| S3-4 a failed prewarm dropped the seed/config guard | confirmed | guard kept | (no test: needs a config the build refuses) |
| S3-1 the fixed game world (L, ~93 MB est.) fills the 100 MB budget alone | confirmed | **not changed**: decision 7 below | |
| S3-2/3 overflow worker outside the budget; lanes never shed when the room gate refuses | confirmed | not changed (as before D-214 for overflow) | |
| S3-5 overflow timers start at send (pre-existing) | confirmed | not changed | |

The test hang worker (`tests/net/hang-room-worker.ts`) was made faithful: after a hung prewarm it answers nothing, as a
real worker stuck generating would (before, a job after it regenerated and answered, which hid S2-3).

### Gates
- `68fb313`, **full tier** (the branch touches `shared/events.ts`), host load 4.6 at start: cargo 478 passed, clippy,
  typecheck, determinism **53/53**, net **525 passed, 1 skipped (73 files)**. Logs `/tmp/warm-g-{cargo,clippy,tsc,det,net}.log`.
- `3c5cecd`, **server tier** (`gate-plan.ts --files` on the commit's paths: `server/`, `tests/net/`, docs): typecheck,
  net **530 passed, 1 skipped**. Logs `/tmp/warm-g2-{tsc,net}.log`. Then `APP_URL=http://localhost:8086 pnpm check`
  against the branch's own server (built client, `/tmp/warm-data-check`, since removed): green
  (`/tmp/warm-check-8086.log`).

### Open it and look (:8086, two `agent-browser` sessions in the game world, L caves)
`verify.lane_opened` at the first join (est. 93 MB); with two players ("Who (2)", both avatars on both screens,
`/tmp/warm-shots/b3.png`) four verifies, all `verify_path: lane`, `verify_cold: false`, **27, 33, 64, 15 ms**, none
rejected. Both left; a rejoin 17 s later reused the lingering lane (no second `lane_opened`). `pnpm check`'s own spec
clients earlier showed the lane closing exactly 60 s after the room emptied.

### Capacity re-measure (Sonnet worker; brief `docs/briefs/warm-verify-capacity.md`)
Image `warm-app:3c5cecd`, the 7 Nov scenarios and bench (`tests/soak/capacity-ramp.ts`), `--memory=256m`, port 8085.
Notes and tables: `docs/research/capacity-2026-11-08-warm-notes.md`; raw: `capacity-2026-11-08-warm.json`. I re-read
every cell below from the JSON. "Holds" is the 7 Nov reading: tps min >= 58, no verify rejected, lag p99 under 1 s.

| At the quota (0.0625) | Before (7 Nov) | After (warm lanes) | Holds after? |
|---|---|---|---|
| floor: 1 Survival M x 2 | 0 of 5 accepted, all 10-17 s; lag p99 1.3 s | **7 accepted, 0 rejected, all warm**; tps 57.9; lag p99 4.6 s peak (join), 0.1 s after | no (tps 57.9, lag peak) |
| 1 Survival M x 4 | 57.7 tps, lag 6.2 s, 8 rejected | **59.0 tps, lag 0.51 s, 0 rejected**, 3 warm | **yes** |
| 2 Survival M x 4 | 45.7 tps, lag 25.5 s, 25 rejected | 57.7 tps, lag 5.2 s, **0 rejected**, 11 warm | no |
| 1 Deathmatch M x 8 | lag 2.7 s, 2 rejected | 58.2 tps, **0 rejected**, 5 warm; lag 5.7 s peak, 0.9 s after | no (lag peak) |
| 2 Deathmatch M x 8 | did not complete | 49.3 tps, lag 15 s, 0 rejected, 35 warm (**under host load 10.8**) | no |

Throttled periods fell 3-5x (Survival x 4: 3205 to 655). The first verify per room still takes 4-16 s at the quota (it
waits behind the lane's generation), and that is where the lag peaks sit. Hosts: quiet (2.2-3.0) for every quota row
except Deathmatch step 2.

**At a full core** (Survival, 1/2/4/6 rooms; **under outside host load 5-30**, so weak evidence): tps 59.4-59.9, lag p99
34-151 ms, 0 rejected: no regression. The cost is **memory**: cgroup max 119 / 171 / 221 / 240 MB at 4 / 8 / 16 / 24
members, against 173 / 187 / 197 / 205 before. Every room was created and joined (the room-load gate reads 200 MB and
was not reached while rooms were being created), but **with lanes a server at 16+ members sits above the 200 MB gate and
would refuse the next room load** sooner than before (7 Nov reached ~200 MB only at 24-32 members; caveat as then: /data
is tmpfs, charged to the cgroup). Lanes opened: 2; then 3 and 9 refused, and those rooms verified cold on the overflow
worker (4 and 14 cold accepts). **Correction to the worker's notes**: it attributes the refusals to the 100 MB budget,
but `laneBytes(1)` is 32.3 MB, so three M lanes (96.9 MB) fit the budget; the third was refused by the **160 MB cgroup
cap** (cgroup 171 MB at step 2). That is the cap doing its job (lanes give way before the room gate), but it means that
on this memory the lanes help at most two rooms. Scenario B at 1 CPU and the verify micro were not run (cap; the micro
times the worker job, which lanes do not change).

### Architectural decisions for review
1. **A worker per room** (session 1, kept): the only way measured to give a world's memory back promptly is terminating
   its worker. Cost ~12 MB and ~120 ms CPU per lane boot.
2. **Budget 100 MB estimated + 160 MB cgroup cap**: 3 M lanes or 1 L; the rest verify cold on the overflow worker.
3. **Caves only** (new): a box world has no cached base, so a lane is pure cost. Owned sandboxes, the classic sandbox
   (world 0) and Creative (solid box) rooms verify on the overflow worker, exactly as before D-214 (their restore does
   not generate, so it is cheap anyway).
4. **Linger 60 s after the last leave** (new, review S2-2): a quick rejoin keeps the warm world, and a join/leave loop
   costs one generation per minute at most. Cost: an emptied cave room holds its lane's memory for up to a minute
   longer (and its budget share). An unload/delete releases at once.
5. **Bar by time, 5 min, on timeout or crash** (new, review S2-4): a room whose world cannot generate in time (or crashes
   its worker) verifies cold for 5 min whatever its members do. The alternative (bar until release) was defeated by churn.
6. **The warm-up bound scales with an overridden job timeout** (12x): tests that shorten the job timeout get a short
   warm bound too; production is unchanged (120 s).
7. **Not changed: the fixed game world takes a lane like any room** (review S3-1). While anyone is in it (L, ~93 MB
   est.), no other room gets a lane. Options for the session model: exclude fixed worlds, or a lower priority for L, or
   shed the idlest lane on demand. I left it: the game world is the one room whose cold verify (35-50 s on the quota)
   always times out, so it benefits most.
8. **A lane refuses a snapshot of another seed/config** (session 1, kept): a new refusal on the trust path; an honest
   client's snapshot always matches.
9. **The 160 MB lane cap binds before the 100 MB budget on this memory** (capacity run): at a full core with 8+ members,
   only two M lanes open. Raising the cap means lanes compete with the 200 MB room-load gate, which a server with lanes
   already crosses at 16 members (tmpfs-inflated). Left as is; the session model decides whether rooms or warm verifies
   matter more at the showcase.
10. **Kept as the 7 Nov method**: "holds" means tps min >= 58, verifies accepted, lag p99 under 1 s.

### D-row draft (D-2xx)
| D-2xx | 8 Nov | **Warm snapshot verification: a verify worker per occupied cave room** (D-213 recommendation 1). Each occupied cave room gets its own verify worker ("lane"), prewarmed at the first join with the server's own seed and config, so its verifies reuse the sim's cached base (D-088) instead of regenerating: L verifies 15-64 ms on a lane vs 0.7-0.9 s cold on a full core. Lanes sit under a 100 MB estimated budget and a 160 MB cgroup cap; the rest (box rooms, rooms past the budget, start-up) verify on a one-shot overflow worker, cold, as before. A lane lingers 60 s after its room empties, is terminated on unload/delete, kills only its own jobs on a timeout, and a timeout or crash bars the room for 5 min. A lane refuses a snapshot with another seed/config. At the Fly quota rooms held went from 0 to 1 (Survival M x 4) and verify rejections from 8-25 per run to 0; two rooms still do not hold (CPU). At a full core the cost is about +20-35 MB of cgroup at 16-24 members, and the 160 MB cap admits two M lanes. | `server/verify.ts`, `server/verify-worker.ts`, `server/world.ts`; `tests/net/warm-verify.test.ts`; `docs/research/warm-verify-report.md`, `review-warm-verify.md`, `capacity-2026-11-08-warm-notes.md` |

### Engineering-decisions entry draft
**Warm verifies: one worker per room, because wasm memory only comes back when its worker dies.** The 7 Nov capacity
run found that at the Fly quota no snapshot was ever accepted: every room has its own seed, the one verify worker
caches one generated world, so each verify regenerated (6-18 s at M, 35-50 s at L, against a 10 s timeout). The obvious
fix, a map of sim instances in one worker, was measured and rejected: dropped instances were not reclaimed (RSS 159 to
408 MB after five L replacements), so eviction would free nothing. Instead each occupied cave room gets its own worker,
prewarmed at join, under a byte budget and a cgroup cap, terminated on unload. The cold review then found that churn
could regenerate worlds on demand (now a 60 s linger), that a bar meant to stop regeneration loops was lifted by
every last leave (now a 5 min time bar), and, checking one note against the sim, that box worlds have no cached base at
all, so lanes are now caves-only. Capacity before/after, at the sustained quota: rooms held 0 to 1, verify rejections 8-25 per run to 0, but two rooms
still do not hold: the quota is CPU-bound, and warm verifies were necessary rather than sufficient. Links: D-213, D-2xx, `docs/research/warm-verify-report.md`,
`review-warm-verify.md`, commits `68fb313`, `3c5cecd`.

### FUTURE ideas (listed, not added)
- `waterworks` test: space the casts under the 40/s window (e.g. 10 per 300 ms is still bursty; send at 30/s) or wait on
  the server's count, so a loaded gate cannot drop one (it fails on `multa` under load today).
- A sliding-window or token-bucket input limiter: a fixed 1 s window punishes a burst that a loaded server reads late.
- Shed the idlest lane when the room-load gate refuses a room (review); expose lanes, in-use MB and cold restores on the
  admin dashboard (the counters exist).
- At the quota, the first verify of a room waits behind its lane's generation (4-16 s) and that is where the lag peaks
  sit: skip or defer the first snapshot request until the lane reports warm (capacity worker's observation).
- Exclude or deprioritise the fixed game world's L lane if rooms matter more than world 1 at the showcase (decision 7).

### Spend
B0 (week) $359.09. Cold reviewer (Sonnet): about $1.5 (read at $364.22 with my own work in between). Capacity worker
(Sonnet): about $2 ($368.56 at dispatch, $370.25 at its end, with a little lead work in between). Total: week $359.09 to $370.70, **$11.61** for item 1 (lead, reviewer and capacity worker together; the proxy gives one
week figure, so per-worker shares are estimates: reviewer about $1.5, capacity worker about $2, lead the rest). Cap $22.

## Session 1 (8 Nov, original brief, $20 cap): kept as written

Built and tested; **not done**: the full gate with `pnpm check` on :8086, the cold review, and the capacity re-measure (budget cap reached at $214.75 of $215.47).

## Design
One worker ("lane") per occupied room, prewarmed with `init(room seed, room cfg)` on the first member's join, terminated
(after any in-flight verify answers) when the room empties or shuts down. Lanes are admitted against an estimated byte budget
(`VERIFY_WARM_BUDGET_BYTES` 100 MB, `laneBytes` = 12 MB + 27 B/cell) and a cgroup cap (`VERIFY_LANE_MEMORY_CAP_BYTES`
160 MB, 40 MB under the 200 MB room-load gate). A room without a lane and start-up checks use a one-shot overflow worker
(cold, as before). Timeouts kill only their own lane; a timed-out room is barred from a new lane until released. A lane's
first generation has its own bound (`LANE_WARM_TIMEOUT_MS` 120 s); a job's 10 s clock starts once the world is generated.
A lane refuses a snapshot whose header seed/config differ from its room's (new refusal; stops a hostile upload forcing regeneration).

Alternatives: (a) one worker, `Map<id, Sim>` of instances: rejected, measured that dropped wasm instances are not reclaimed
promptly (RSS 159 -> 408 MB after replacing 5 L-sized instances), so eviction would not free memory; (b) worker per room: chosen;
(c) a sim-side base cache keyed by world: needs `sim/` change, not taken.

## Measured (local, M-series Mac, 8 Nov)
- Warm lane RSS: about 29 MB at M (wasm 17-20.5 MB), about 76 MB at L (wasm 59-83.5 MB); idle worker 12 MB. Terminate gives most back.
- Restore after prewarm with the room's seed: 3-19 ms vs cold 416-2338 ms (full core); hash identical.
- Worker boot about 120 ms CPU (cost of the one-shot overflow worker).

## Tests (`tests/net/warm-verify.test.ts`, `tests/net/hang-room-worker.ts`)
8 tests; green 3/3 runs. Red first: all 8 red on multa's server code (`/tmp/warm-probe/red-first.log`); mutations each turn
the matching test red: lanes off (6 red, `red-lanes-off.log`), no release on leave (`red-no-release.log`), no room check
(`red-no-room-check.log`), timeout closing all lanes (`red-timeout-all.log`), all under `/tmp/warm-probe/`.

## Architectural decisions for review
1. Worker per room, not instances in one worker (memory reclaim, isolation). Cost: ~12 MB fixed per lane, ~120 ms CPU per boot.
2. Budget 100 MB + cgroup cap 160 MB: at most 3 M lanes or 1 L lane warm; others verify cold. Costs: L rooms beyond the first stay cold (and time out at the quota).
3. Lane released when the room empties (not only on unload): frees memory during the 2-minute grace; a rejoin re-generates.
4. Lane refuses foreign seed/config snapshots: a new refusal path; honest snapshots always match.
5. Overflow worker is one-shot (terminated after each job) so it never pins a world of memory.
6. Warm-up has its own 120 s bound; a timed-out room is barred until released (no regeneration loop).

## Not done (for the session model)
Gate (`pnpm check` against :8086), Sonnet cold review of `server/` diff, Docker re-measure at --cpus=0.0625 and 1, D-row and engineering-decisions entry.

## Gate: RED, so nothing is committed (8 Nov)
`pnpm typecheck` was green. `pnpm test:net` failed 3 of 466 tests (log `/tmp/warm-probe/gate-testnet.log`):
- `game.test.ts` "a hung worker is terminated": `hang-worker.ts` never answers the lane's prewarm either, so jobs wait on `LANE_WARM_TIMEOUT_MS` (120 s), not the 600 ms test timeout. Likely fix: a lane job's own timer covers the warm-up too, or `verifyWarmTimeoutMs` follows `verifyTimeoutMs` when it is overridden.
- `game.test.ts` "verifies a game snapshot in a worker: the tick clock does not stall": not diagnosed. It is probably the L prewarm running at join, which this test's timing does not expect.
- `achievements-live.test.ts` "waterworks at exactly 100": not diagnosed. It may be unrelated or flaky, and has to be checked against multa.

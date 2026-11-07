# Warm verify lanes (D-214 draft): report, stopped at the $20 cap (8 Nov)

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

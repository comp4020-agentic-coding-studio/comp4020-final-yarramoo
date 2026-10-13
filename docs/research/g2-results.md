# Gate G2 results (2026-10-14, measured overnight, nothing fixed)

Harness: `tests/soak/n1.ts` (`pnpm build:client && pnpm soak:n1`), `tests/soak/p1.ts` (`pnpm build:sim:devpaint && pnpm soak:p1`).

## N1: PASS (all five criteria)

Seed 20261014, 600 s (607 s actual), 36506 ticks, 3 Chromium clients through per-client delay proxies (20-150 ms,
order preserved). Server: 0 incidents (`stats.incidents`, `desync_incidents` rows, sandbox too), 0 resyncs, 20
snapshots verified, 0 rejected. 608 HASH frames per client, read off the wire: all 608 ticks agree across the three
clients. Final shared checkpoint tick 36480, all three hash `ac5e63ddf6a23aef`. No reconnects. All three live at the
end (28/40/52 ticks behind the server's last closed tick). Throttled client: 0 resyncs, live throughout, but it ran
behind: max lag 323 ticks (5.4 s), mean 50, against max 42 / mean 24 for the others; its step p95 was 14-20 ms.
Bots made about 500 move plans and 270 casts each. Host process RSS at end 198 MB (server + proxies + driver in one
Node process; Chromium is separate).

## P1: FAIL against p95 <= 8 ms

Worst case (4 players 600 cells apart, each with a wood/gunpowder fire and a 3-row water flood, 1800 ticks):

| | p50 | p95 | max | chunks/step (mean, max) |
|---|---|---|---|---|
| native | 7.6 ms | 9.0 ms | 118 ms | 69, 74 |
| 4x CDP throttle | 30.1 ms | 36.0 ms | 401 ms | 69, 74 |

Splits (same run): fire only, 4 players: p95 1.3 ms native, 5.7 ms throttled (fire burns out; chunks mean 7, max 42).
Flood only: p95 9.6 ms native, 44.4 ms throttled, 70 chunks. 1 player fire+flood: p95 2.4 / 11.2 ms, 15 chunks.
4 idle players: p95 0.3 / 1.6 ms, 3 chunks. Two earlier runs gave native p95 10.2 and 9.0, so the miss is robust.

Reading it against plan 12.3: cost is roughly 0.11 ms per awake chunk, so it is the number of chunks that cannot
sleep, and the flood causes it (liquid keeps moving, so its chunks stay awake for the whole run). Remedy 1 (tune
sleeping and dirty-rect skipping: a settled pool should sleep) and remedy 2 (liquids every other tick, which roughly
halves the dominant phase) are the ones the numbers point at. Remedy 3 (smaller active rectangle) would not help
here: 70 of about 80 reachable chunks are the flood itself. I did not profile phases inside the sim.

Limits of this P1: the flood is painted with Paint (dev_paint wasm, D-056), about 3 x 160 x 64 cells of water per
player placed in one tick, far more water than the Water spell can produce in a game, so this is worse than play
can reach. The scenario holds players still (Pos fixed); each step time is wall time around `step()` in the page
main thread. A real phone was not measured (plan asks for one).

## What N1 does and does not prove

- CDP `Emulation.setCPUThrottlingRate` throttles the page's main thread only. Chromium refuses it on a worker
  ("only supported for pages"), and the sim steps in the worker. Measured: a 3e7-iteration loop took 75 ms in a worker
  before and after throttling, 300 ms on the main thread. The harness therefore also wraps the throttled client's wasm
  `step` to take 4x as long. That slows only `step`, not decode, hashing or snapshot work. It also means "the
  throttled client keeps up" was tested with a stand-in; the real-world P1 4x number is the one in the table above.
- The bot walks, jumps, casts Push and Blast only; it never patches holes, never meets water, fire or lava, and the
  world sim therefore stays nearly asleep (chunks about 15). N1 exercises the protocol, playout and hash path
  heavily, but not heavy simulation load. The throttled client's lag under a P1-like load was not tried.
- Delay is per WebSocket frame, with a wandering base latency (retargeted every 0.5-3 s across 20-150 ms) plus
  +/-10 ms jitter, ordered per direction. It is not per TCP packet, has no loss, no bandwidth cap.
- `?server=host:port` exists, but registration is a cross-origin fetch with no CORS headers, so each client loads the
  page through its own proxy instead (same origin). Chromium also needed `--disable-features=LocalNetworkAccessChecks`
  to open the proxied ws:// on 127.0.0.1.
- All three clients are Chromium on one machine with the server: no cross-engine or cross-architecture coverage.
- Desync is checked at 60-tick checkpoints, so a transient divergence that re-converged between checkpoints is invisible.

## P1 after profiling (2026-10-14)

Benchmark: `sim/examples/p1_bench.rs` (`cargo run --release --features dev_paint --example p1_bench`), the P1 layout through the
real `Sim` API, 1200 timed ticks after a 300-tick warm-up. Phases cannot be timed from inside `sim/src` (time APIs are banned), so
the two cheap phases are replayed from outside on the same state: a 3.1 MB buffer fill (what `moved.fill(0)` costs) and
`set_active_around`. Entity update and `resolve_explosions` are not timed separately: with four still players and no
gunpowder left burning they are a few comparisons, and the step total minus the replayed phases is the cell pass.

Before (native, step p50 / p95, noisy machine, runs 4.4-6.4 / 6.1-9.5 ms): `moved.fill` about 0.11 ms (2-3% of the step),
`set_active_around` 0.005 ms, the rest (over 95%) is the cell pass over about 72 chunks, almost all of it water.

Cause found in the cell pass: `liquid_move` drew the left/right rng for every water cell that could not fall, which is nearly
every cell of a settled flood. Each draw is three `mix` rounds. The draw only decides the order when both sides are open; with
one open side the result is the same whatever the draw says, and with none nothing moves. So the draw is now taken only when both
sides are open. Every result is bit-identical.

| | p50 | p95 |
|---|---|---|
| native, bench, before | about 4.6 ms | about 7.5 ms |
| native, bench, after | 2.4 ms | 2.8 ms |
| native, P1 in Chromium, before (above) | 7.6 ms | 9.0 ms |
| native, P1 in Chromium, after | 3.0 ms | 4.8 ms |
| 4x throttle, P1 in Chromium, before | 30.1 ms | 36.0 ms |
| 4x throttle, P1 in Chromium, after | 11.4 ms | 16.0 ms |

P1 now passes the 8 ms native budget. At 4x it is 16 ms, so a slow phone is still over, and the every-other-tick liquid option
remains the user's call for that. `moved.fill` was left alone: 0.11 ms is under 5% of the step.

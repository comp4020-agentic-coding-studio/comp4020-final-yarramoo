# R2c worker report: real-room capacity re-measure

Brief: `docs/briefs/r2c-capacity-remeasure.md`. Plan ask: "24 sockets over 4 rooms, a forced verify; pass is
under 200 MB."

## What I built

`tests/soak/capacity-rooms.ts` (`pnpm soak:capacity-rooms`), a new script modelled on the existing
`tests/soak/capacity.ts` (same real Docker image, same real headless-bot machinery: real `Lockstep`,
`reactToTick`, a full WASM sim per bot in worker threads, same `--memory=256m`/tmpfs/`cap-bench`-style
container pattern) but adapted so bots join **real rooms created over the real HTTP API**
(`POST /api/rooms`) instead of the two fixed world ids. I chose a new script over a mode flag on the existing
file because the join/room-creation setup differs enough (creating 4 rooms up front, tracking `BotCounters` by
room id instead of a fixed `world: 0|1`) that a flag would have meant threading two different code paths
through most of `main()`; a separate file keeps both benches simple to read on their own.

**Room mix**: 4 rooms, all Caves-preset (`CAVES_PVP`, `avatars: 1`) so every bot is a real Pos-sending avatar
(~30/s), 2 at size M and 2 at size S. Caves (not Solid-box/Creative) because the avatar/Pos path is the real
per-tick cost this bench exists to measure — a painter/Paint room's cost is already in the pre-R2 table. M/S
(not L) per the brief's own item 3: an L room's 2-slot weight against `MAX_LOADED_ROOMS = 16` isn't this
slice's concern, and M/S stays comfortably inside every cap while still mixing world sizes.

**Forced verify**: `World.requestSnapshot()` has no HTTP route reaching it today. Per the brief's own two
offered options, I took the less invasive one — the bench waits (up to 75 s) for each room's own natural
`SNAPSHOT_EVERY_TICKS` cycle (1800 ticks @ 60 Hz = 30 s) to fire, the same mechanism the pre-R2 bench already
relies on for its own `snapshotsAccepted` numbers. **No debug endpoint was added; no route or lifecycle code
was touched.** I flagged this as "architectural decisions for review" in `capacity-rooms.md` per the brief's
own instruction, and also wrote the gap (a gated debug route would make this faster and less fragile for
future benches) into `FUTURE.md`.

## Numbers — 4 runs (ran it 4 times, brief asked for at least 2)

All 4 runs: 24/24 bots joined, every room's snapshot verified inside the wait window, no hash failures, no
resyncs, no bot closed early, no bot rejected, 60 (±0.1) ticks/s in every room every run.

| Run | cgroup MB post-verify | cgroup MB peak | Pass (<200 MB)? |
|---|---|---|---|
| 1 | 171.82 | 172.71 | yes |
| 2 | 95.74 | 96.92 | yes |
| 3 | 103.90 | 104.49 | yes |
| 4 | 104.86 | 107.32 | yes |

**Pass/fail against the 200 MB bar: PASS in all 4 runs.** But I want to be explicit rather than round this
away: run 1 landed at 171.82 MB, only ~28 MB (14%) under the 200 MB line, while runs 2-4 clustered tightly at
~95-105 MB — roughly half the budget run 1 used. The scenario was byte-for-byte identical across all 4 runs
(same code, same room mix, same bot count, consecutive runs seconds apart), and online count/tick rate/
snapshot behaviour were the same in all 4, so nothing in these runs explains the ~65-75 MB gap. My best guess,
not confirmed, is the same "first activity" jump the pre-R2 table already documents (idle 49 MB -> 108 MB at
first load on the fixed worlds): loading 4 fresh rooms plus their first snapshot cycle and verify-worker
spin-up is exactly that kind of one-off cost, and run 1 may have landed its sampling window closer to more of
that cost than runs 2-4 did. Full detail and the comparison against the pre-R2 two-fixed-world baseline is in
`docs/research/capacity-rooms.md`'s new "R2c: real rooms, measured" section. Raw JSON:
`docs/research/capacity-rooms-results.json`.

## Anything surprising

- The 1-in-4 outlier run is the main surprise and the main finding worth acting on: a single-run capacity
  measurement here would have reported either "borderline" (run 1) or "comfortably under" (runs 2-4) purely by
  luck. I logged this as a `FUTURE.md` idea (multi-run-by-default for capacity benches).
- Forcing a verify by waiting out a natural cycle was fast in practice — every room verified well inside the 75
  s budget (slowest observed: 905 ms after the wait fired), so the "wait, don't add a route" choice cost at
  most ~30-40 s of wall time per run, not the full 75 s budgeted.

## Product bugs found

None. I did not touch `sim/`, `shared/room.ts`, `shared/protocol.ts`'s wire format, `server/main.ts`'s route
logic, or `server/world.ts`'s lifecycle code, and nothing I observed while building or running this bench
looked like a bug in that code — the room-creation API, HELLO/room-join path, and snapshot/verify cycle all
behaved exactly as R2a/R2b's own tests and docs describe.

## FUTURE.md entries written

Two new entries added directly to `FUTURE.md` (not just mentioned here, per the brief):
1. "A debug route to force `World.requestSnapshot()` for test benches" — a gated (`ADMIN_TOKEN`) route would
   remove the up-to-30s-per-room wait this bench and any future one pays.
2. "Capacity benches should run N>=3 times by default, not once" — this slice's own numbers (one run in four
   ~70 MB above the rest) are the argument.

## Gate

`pnpm typecheck` is clean. No `DECISIONS.md`/`engineering-decisions.md` rows were written (per the brief,
that's the session model's job from these numbers). Single commit, not pushed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

# Cold review: warm-verify server diff (read-only, Sonnet)

Reviewed the working tree of /tmp/wt-warm (branch warm-verify) against multa: server/verify.ts, verify-worker.ts, world.ts, main.ts, shared/events.ts. Nothing run. "Confirmed" = read in the code; "suspect" = inferred.

## S1 (must fix before merge)
None found. The trust path (decompress cap, restore, tick/hash compare) is untouched; the worker adds only a seed/config guard. Job attribution is sound: every handler checks `this.worker !== w`, ids come from one shared counter so they never collide across lanes, and lost()/retire() both check lane identity.

## S2 (should fix)

### S2-1 Unrate-limited log events on join/leave churn (confirmed)
verify.ts `warm()` logs `verify.lane_opened` with `log.event`; `release()` logs `verify.lane_closed` with `log.event`. world.ts:733 (first member joins) and :795 (last leaves) fire these. CLAUDE.md: anything a client can trigger repeatedly goes through `log.limited`; never one line per client action.
Trigger: one client (up to 12 conns/IP) joins and leaves an empty room in a loop: two lines per cycle, flooding the ring the admin dashboard reads.
Fix: `log.limited` (key per room or global) for both; or log opened/closed only for lanes that lived more than N s.

### S2-2 Join/leave churn re-generates worlds without bound (confirmed mechanism, cost suspect)
Every empty-to-occupied transition spawns a Worker, loads the wasm and generates the room's world (35-50 s CPU at L on the Fly quota, 120 s warm bound). Every last-leave terminates it. There is no cooldown, and `release()` also clears `barred`, so churn defeats the timeout bar (see S2-4). Worker.terminate() is async and the draining/killed worker's memory is not counted in `laneBytesInUse` (the lane is removed from the map immediately), so repeated cycles can hold several workers' memory at once while old ones tear down. Also a lane in the draining state with an in-flight verify stays alive up to 10 s while a fresh lane for the same room opens: two worlds for one room.
Trigger: loop connect, HELLO, close on a size-L room (the GAME world is L and always loadable); the quota CPU is spent regenerating, starving the tick clock.
Fix: a per-room minimum lane lifetime or a re-open cooldown (e.g. no lane re-open within 30-60 s of the last release; use overflow meanwhile), and count draining lanes in the byte budget until their worker has exited.

### S2-3 Drain during warm-up can leak a ref'd worker and a never-resolving verify (confirmed in code, trigger needs a stuck generation)
`drain()` with pending jobs sets `warming = false`. The warm timer callback then returns early (`!this.warming`), and a job queued during warming has `timer: null` (armed only on the `warmed` message). If the worker never posts `warmed` (wedged generation, or wasm trap that kills the thread without an `error`), nothing ever fires: the job's promise never resolves (World.verifying stays true until reset), `w.ref()` keeps the process from exiting, and the worker is not terminated. In the normal case `warmed` arrives, jobs get armed, and idle() kills it, so this only bites on a hang.
Fix: in drain(), if pending, keep the warm timer authoritative (do not clear `warming` for the timer's purposes, or arm job timers immediately when draining).

### S2-4 Barred set: defeated by churn; crashes are never barred (confirmed)
`release()` calls `barred.delete(id)`; release runs on every last-leave. A room whose world cannot be generated within the bound (the case barring exists for) gets a fresh 120 s attempt each time it empties and refills. In the other direction `retire(..., "crashed")` does not bar, so a lane whose worker crashes (OOM inside the worker, trap) is reopened by the next verify's `warm()` and regenerates again, once per verify.
Fix: bar by time (e.g. 10 min since the timeout) rather than by emptiness; bar on a second consecutive crash.

## S3 (notes)

- S3-1 The GAME world (size L, about 93 MB estimated) takes a lane on first join and alone consumes the 100 MB budget (confirmed: warm() is called for every World; `laneBytes(2)` = 12 MB + 2048*1536*27 B). While anyone is in the game world, no M or other L room gets a lane and they all verify cold, i.e. the old behaviour. Decide whether the fixed world should have priority, or the budget be raised (see S3-3).
- S3-2 Overflow-worker memory is outside every budget (confirmed): a cold L verify allocates a full world in the one-shot worker while 100 MB of lanes are held. Lane cgroup cap 160 MB only checks at lane open, from `memory.current`, which lags a lane still generating (two quick opens both read the old figure; the byte budget protects only up to 100 MB). Worst case: 100 MB lanes + about 90 MB overflow + main process, against a 200 MB room-load gate and a 256 MB machine. Suspect it is tight, not confirmed by measurement.
- S3-3 160 vs 200: the comment says lanes give way to new rooms; true only for lanes opening after memory is high. Existing lanes are never shed when the room-load gate (200 MB) starts refusing rooms. Consider releasing the idlest lane when `register.refused scope=memory` fires.
- S3-4 In the worker, a failed prewarm sets `room = null` (verify-worker.ts catch), which silently removes the seed/config guard for that lane, so an upload with another seed can make the lane regenerate. Config comes from the server, so this needs a build that refuses its own room config; low risk. Better: keep the room key set and refuse everything, or have the lane report failure so the verifier retires it.
- S3-5 Overflow worker: all concurrent cold jobs share one worker and arm their 10 s timers at send time. One slow cold verify makes queued ones time out, and a timeout kills them all (confirmed; this is pre-existing behaviour, now with a `path: "overflow"` label).
- S3-6 `log.limited` keys `verify:lane_lost:${id}` add one window per room id; swept only past 5000 keys. Fine in practice. On `close()` every lane logs a warn `lane_closed` (reason closed) through retire; harmless but noisy at shutdown (limited per id).
- S3-7 Warm-up reuse claim (suspect, not verified): the guard `cold = key !== cached` assumes `sim.init` leaves a `Base` for restore to reuse. I did not read sim/src/lib.rs `init`; for non-caves terrain (classic sandbox, creative solid box) the sim comment says only caves are cacheable, so those lanes spend memory without being warmer. If true, skip lanes for non-caves rooms and save the budget.
- S3-8 Lifecycle checks that passed (confirmed): `World.reset` keeps the lane (same seed/cfg, correct); `shutdown()`, `deleteRoom`, `failWorld`, `discardIfFreshlyLoaded` and the owned-sandbox unload all go through `shutdown()` or `leave()` and so `release()`; `close()` kills lanes; refused joins before `World.join` never open a lane; a reload racing a drain gets a fresh lane and the old one cannot retire it (identity check). Process-exit rule: idle() refs while pending or warming, unrefs otherwise; the warm and job timers are `unref`'d.

## Architectural decisions for review
1. Lane per room, opened on first join (cost paid by every join of an empty room) versus lazily on first upload. Lazy would remove churn cost (S2-2) but put generation back inside the first verify.
2. Fixed worlds competing with rooms for one byte budget (S3-1).
3. Budgets are estimates plus a point-in-time cgroup read; overflow and draining workers are unaccounted (S3-2, S2-2).
4. Barred-until-released is a lifecycle bar, not a time bar (S2-4).

## FUTURE ideas
- Shed the idlest lane when the room-load gate refuses a room.
- Expose lane count, in-use MB and cold-restore count in the admin dashboard (the fields already exist: `timeouts`, `coldRestores`, `laneBytesInUse()`).

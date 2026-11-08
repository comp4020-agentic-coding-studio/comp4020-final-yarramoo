# Brief REVIEWFIX-COLD: cold read-only review of the review-fixes diff (Sonnet, read-only)

Cap: you alone, Sonnet, no subagents, about 40 tool calls. Read-only: do not edit, build, run tests, start servers or
browsers anywhere. Write your findings to `/tmp/reviewfix-cold-review.md` AS YOU GO (append after each finding), so a
run that dies still leaves something. Never `rm` anything.

## What to review
The diff is `/tmp/reviewfix-diff-server-sim.patch (the diff of `86243ca..3da71bb` before it was committed)` (server/ and sim/ changes against `multa`, plus two new files). The
code is in the worktree `/tmp/wt-reviewfix` (a gate may be running there: read only). Read the diff first, then the
surrounding code it touches. Project rules: `/tmp/wt-reviewfix/CLAUDE.md` (sim invariants 1-11 and "Server logging and
identity"). Do not read docs/ prose about these fixes: judge from the code.

The changes claim to:
1. Make the cached chunk-hash of an ice cell's chunk invalidate when the ice freezes a neighbour (`sim/src/grid.rs`).
2. Add a deterministic per-tick paint budget in `Sim::step`/`Sim::paint` (`sim/src/sim.rs`, `sim/src/tuning.rs`).
3. Count HASH votes once per registered player (game worlds) or per IP tag (sandbox), never per socket; spectators
   never define the majority or supply snapshots (`server/world.ts`: `voterKey`, `votesOf`, `majority`, `tryResolve`,
   `requestSnapshot`).
4. Bound HASH state: ignore hashes older than `HASH_WINDOW_TICKS`, prune `truth` to the window, rate-limit HASH/PING
   frames per connection (`server/main.ts`).
5. Let a catch-up burst exceed `MAX_BUFFERED_BYTES` by its own size until the peer drains (`trySend`, `sendCatchUp`).
6. Enforce `cfg.maxPlayers` at HELLO (`server/main.ts`, `World.avatarPlayers`).
7. A per-IP-tag paint token bucket (`server/paintrate.ts`, `paintOverBudget` in `server/main.ts`).

## What to look for (correctness first)
- Determinism: can the paint budget differ between clients (anything client-local, restore vs played-through, a
  snapshot taken mid-tick, `paint_budget` initial value after `restore`)? Is it state that should be hashed/snapshotted?
- The trust path: can a non-voter still influence `truth`, the snapshot source or `checkUpload`? Can an honest player
  now be wrongly resynced (e.g. a player whose `playerId` is set but who is replaced; two tabs of one player; a sandbox
  where everyone shares one NAT tag; a world with zero voters; ties)? Does anything else read `checkpoints`/`truth`
  that the change breaks (chunk diagnosis `startDiagnosis`, `diverged`, `checkUpload` timing, `reset`)?
- Bounds: can `checkpoints` still grow without limit? Does the control-frame rate drop anything an honest client
  needs (LIVE is excluded on purpose)?
- `catchupSlack`/`inCatchUp`: can a slow live peer keep the slack forever and so dodge the cap? Re-entrancy?
- maxPlayers: off-by-one, the reload path, rooms whose players reconnect after a server restart, spectators.
- Logging rules (log.limited for client-triggerable events, no raw IP), and `server/` not importing `client/`.

## Output
`/tmp/reviewfix-cold-review.md`: numbered findings, each with severity (high/medium/low), file:line, the scenario,
confidence (verified in code / suspected), and a suggested fix. Then a short "looks correct" list. Finish with
"Architectural decisions for review" (anything in the diff you think shapes later code and deserves a second look),
and "Ideas for FUTURE.md" if any. Then return a 10-line summary.

# Cold review of the review-fixes diff (read-only, Sonnet)

## Findings

1. LOW-MEDIUM, server/main.ts:712/777 + server/paintrate.ts:571 (suspected). ipTag derives from the `fly-client-ip` header, which is
   trusted from any caller. If the origin is ever reachable without the Fly proxy, one attacker rotates the header and gets a fresh
   paint bucket, a fresh sandbox hash vote (H1) and a fresh connection quota per tag. In PaintRate.take, a new key with
   `size >= 4096` calls prune(), which is O(n) and removes only FULL buckets, so a spoofer who spends one token per key keeps the map
   above 4096 and pays an O(n) scan per new key (CPU, and the map is not actually bounded). Fix: hard-evict the oldest bucket
   when still over the cap after prune; make sure the deploy only accepts proxy traffic (document the assumption).

2. LOW, server/world.ts:615-617 (verified in code). catchupSlack persists until the peer's queue first falls to <= MAX_BUFFERED_BYTES.
   A peer that stays above 8 MiB after its burst keeps `MAX + burst` as its cap forever (burst up to 64 MiB). It is not unbounded:
   it is closed once it buffers MAX beyond the burst. The WeakMap entry is also never cleared if the peer never sends again, which is
   harmless. Fix (optional): expire slack after N ms or when the peer is `live`, so a slow live peer reverts to the plain cap.

3. LOW, server/world.ts:1065-1078 and requestSnapshot (verified). A game world with only spectators has zero voters: no truth is
   ever set and no snapshot is ever requested (requestSnapshot skips every member). The sim still steps and the log grows toward
   MAX_LOG_TICKS with nothing to compact it. Before the change a spectator could supply the snapshot. Fix: if the world has no
   voters, fall back to the longest-connected live spectator for snapshots only, or let it idle/hold; at least log a warning.

4. LOW, server/main.ts:1286 (verified). maxPlayers counts connected avatars only. A player who disconnected mid-round while a
   latecomer took the free slot is refused on reconnect ("room is full"), with no priority for a known returning player. Also the
   check and join are synchronous after identity.resolve, so no race (confirmed: no await between them). Fix: accept, or document.

5. LOW, sim/src/tuning.rs:456 comment (verified arithmetic). "2 x 541,977" is wrong: 129 * 65 * 65 = 545,025 (the const and the test
   use the right formula). Comment only.

6. LOW, server/main.ts:1376-1385 (verified). The control-frame limit silently drops HASH, so a client in a long burst (stalled tab
   returning, replay then live) that sends > 20 HASH frames in a second loses checkpoints and is then not compared. That is safe
   (only a missed comparison), and the brief says replayed ticks send no HASH, so I believe an honest client stays under 20. The
   drop is not counted in stats.droppedRate; suggest counting it so the dashboard sees it.

7. LOW, sim/src/sim.rs:536-546 (verified, design note). One early Paint in the tick can exhaust the shared per-tick budget and
   starve every later painter's input in that tick, on every client alike (deterministic). The per-IP bucket bounds an attacker to
   about one worst-case stroke per tick on average, but its 2 s burst lets it take 60 worst-case strokes at once, which starves
   others for a couple of ticks. Acceptable; a per-player share of the budget would be fairer but costs state.

8. LOW (suspected), sim format. The budget changes behaviour for any logged Paint flood in a persisted log. Old logs replayed by
   the new sim.wasm can differ from what the old clients produced. Check that a stored snapshot/log whose simBuild differs is
   discarded or reset on load (invariant 10 implies the build gate), otherwise a joiner replaying an old log would diverge.

## Looks correct
- Determinism of the paint budget: `paint_budget` is written only at the top of `step` (reset) and in `paint`; `apply` is only
  reachable from `step`; it is never read across ticks, so a restore (initial 0) is identical to a played-through client, and a
  mid-tick snapshot cannot occur. Not hashing it is right. Endpoint clamp and `r.min` happen before the cost is computed.
- paintCost mirrors the sim's upper bound (raw coordinates only over-estimate); the payload length is checked before the DataView.
- Ice fix: `touch(i)` after `aux[i] -= 1` is the missing dirty mark; the other direct `aux` writers in grid.rs (806, 924, 951, 999,
  1124, 1162, 1195, and crumble_cells) already call touch.
- Voting: one vote per registered player in game worlds (join replaces the prior connection of a playerId, so two tabs cannot vote
  twice); sandbox per ipTag with the per-key majority; spectators are compared against truth but cannot make it; checkpoints
  resolved with no voters are deleted (no leak); the `waiting` loop ignores non-voters; chunk diagnosis and checkUpload still read
  `truth`/`checkpoints` consistently; `reset` still clears both; resync still deletes the member's hashes.
- Window: onHash rejects ticks older than the window and truth is pruned by the same bound, so checkpoints and truth stay bounded
  (checkpoints resolve after HASH_WAIT_MS at the latest, and only window ticks can open one).
- Replaced snapshot source now clears request/waitingUpload (as leave() does).
- Catch-up: `inCatchUp` is set and cleared in try/finally on a single thread; a repeat RESYNC to an undrained peer is still dropped
  because the queue is cumulative while slack is not.
- maxPlayers: a reload with the same token has `connOf` non-null so it is exempt; spectators and sandbox are exempt; a fresh load
  is discarded on rejection via discardIfFreshlyLoaded.
- Logging: new events use `log.limited` with a per-conn or per-tag key, `ctl_rate` is forgotten on close, only ipTag is logged
  (no raw IP), `rate_limited` is in the catalogue, server/paintrate.ts imports nothing from client/.

## Architectural decisions for review
- Voter identity is `playerId` in game worlds but IP tag in the sandbox: a classroom behind one NAT is one vote there. Revisit if
  the sandbox is used with a majority of NAT'd users (a single bad tab on a shared tag still gets its tag's vote only if it is the
  tag's majority).
- Mirrored constants in server/paintrate.ts (radius 32, stroke 128) duplicate sim values with no test linking them; a drift
  silently weakens the server bucket. Suggest a test reading the sim's constants or exporting them via the ABI.
- Sim paint budget is a new global per-tick cap: any later input kind that costs work needs the same treatment.

## Ideas for FUTURE.md
- Per-player share of the paint budget (or round-robin) so one painter cannot starve others inside a tick.
- Counting dropped control frames in the admin dashboard.

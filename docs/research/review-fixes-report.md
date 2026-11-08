# Review fixes: report (Opus lead, 8 Nov)

Brief: `docs/briefs/review-fixes.md`. Review: `docs/research/code-review-2026-11-08.md`. Branch `review-fixes` from
`multa` @ `381577f`, worktree `/tmp/wt-reviewfix`. Written as the work went.

## Outcome per finding

| Finding | Outcome | Test (red first) |
|---|---|---|
| S1 `update_ice` aux without touch | **Fixed** (`self.touch(i)`) | `sim/tests/hash_cache.rs` |
| Invariant hunter (cached hash = fully dirtied hash, plus snapshot round-trip) | **Added**; found nothing else | same |
| H1 hash votes per socket | **Fixed**: one vote per registered player (avatar worlds), per IP tag (sandbox); snapshot only from a voter | `tests/net/hash-votes.test.ts` (6 tests) |
| M1 old-tick hash spray | **Fixed**: 30-checkpoint window, `truth` pruned to it, HASH/PING rate 20/s per connection | `hash-votes.test.ts` (M1) |
| H2 paint flood | **Fixed**: sim `MAX_PAINT_WORK_PER_TICK`; server per-IP-tag paint bucket | `sim/tests/paint_bound.rs` (2 new), `tests/net/paint-rate.test.ts` |
| M3 `maxPlayers` | **Fixed** at HELLO, "room is full; spectate or try another room" | `tests/net/max-players.test.ts` |
| M2 catch-up vs 8 MiB cap | **Holds (measured)**, **fixed**: catch-up slack | `hash-votes.test.ts` (M2) |
| L1 replaced tab left the snapshot request | **Fixed** (2 lines, alongside H1) | no dedicated test (mirrors `leave()`) |
| M4, M5, other lows | **Not tonight** (brief) | — |

## S1 and the hunter

- Verified: `update_ice` (`grid.rs` ~977) did `self.aux[i] -= 1` with only the neighbour going through `set`.
- `sim/tests/hash_cache.rs`: after each step, the per-chunk cached hashes must equal the hashes recomputed after
  marking every chunk `dirty_since_hash` (the refresh changes no sim state, so it does not perturb the run), and at the
  end the state hash must equal a snapshot round-trip's (the `pristine` twin bug: a changed chunk left out of snapshots).
  Scenarios: S1's own case (ice at x = 127, water at x = 128), a busy sandbox with every paintable material across the
  x = 128/256 edges hashed every tick, and two game worlds (Creative casting every spell while walking, Survival).
- **Red on the unfixed code:** `ice by water at x = 127|128: chunk-hash cache stale at tick 11, chunks [33]`
  (`/tmp/reviewfix-s1-red.log`). Chunk 33 is x 64-127, y 256-319: the ice's chunk. Green after the fix.
- **Hunt:** grep of every runtime `mat`/`aux` write in `sim/src` (not `gen.rs` and test code): grid.rs 430, 806, 924,
  951, 997, 1122, 1160, 1193 all `touch` right after; the island fall swaps (364-365) touch both cells; `copy_from_slice`
  in `sim.rs` 90 is the base-cache world build. The busy and game-world runs stayed green. **No other stale write.**

## H1: votes

- Verified in code: `onHash` took any member's hash, `tryResolve` counted one per connection, a tie went to the oldest
  connection, `requestSnapshot` took the oldest live member with no player check. Spectators in avatar worlds are
  anonymous (`identity.resolve` "unknown" is fine for a spectator), and sandbox painters are always anonymous-capable.
- Fix (`server/world.ts`): `voterKey(m)`: avatar worlds `p<playerId>` for a member with a player (spectators: none);
  sandbox `ip<ipTag>` (a member with no tag, only unit tests, counts per connection). `votesOf` takes each key's own
  majority (tie to its oldest member), then `majority()` across keys, tie to the oldest connection. Checkpoints wait
  only for voters; a non-voter's hash is still compared (against the checkpoint's truth, or the stored truth if it
  arrives later) and resynced when it differs. With no voter reporting, no truth is set and nobody is resynced.
  `requestSnapshot` skips non-voters. `main.ts` passes `ipTag` into `join`.
- **Sandbox decision:** one vote per IP tag. A school NAT is then one vote for many honest painters; that only matters
  if the honest group behind it disagrees with each other, which is a real desync anyway.
- **Red on the old server (all 6):** `only the spectators are resynced: expected 1 to be 3`; spectator first wins a
  1-1 tie (`expected false to be true`); the checkpoint waited for a silent spectator (`expected +0 to be 1`); `the
  spectator was asked: expected true to be false`; spectators alone set a truth (`expected 1 to be +0`); five sockets of
  one address resynced two honest painters (`an honest painter was resynced`). Log `/tmp/reviewfix-h1-red.log`.

## M1: hash spray

- `HASH_WINDOW_TICKS = 30 * HASH_EVERY`: `onHash` ignores older ticks; `truth` is pruned to the window by key (the old
  code deleted exactly `tick - 30*HASH_EVERY`, so an old resolved tick stayed for good). `MAX_CONTROL_FRAMES_PER_SEC =
  20` HASH+PING frames per connection in `main.ts` (`input.rate_limited`, `what: hash|ping`, `log.limited` per conn).
  LIVE is excluded: it is O(1) after the first and ends a catch-up hold.
- **Red:** `open checkpoints: expected 3600 to be less than or equal to 31` (an hour of checkpoint ticks sprayed by one
  member; on the old code the test also took 20 s, the O(checkpoints x members) pass the review predicted).

## H2: paint budget

- Sim (`sim.rs`, `tuning.rs`): `MAX_PAINT_WORK_PER_TICK = 2 * 129 * 65 * 65` (two worst-case strokes, 1.09 M cells
  of disc bounding box). `step` resets `paint_budget` before applying the tick's inputs; `paint` charges each stamp
  `(2r+1)^2` and stops at the first stamp that does not fit, zeroing the budget so later Paint inputs that tick draw
  nothing. Applied in queue (input) order inside `step`, from nothing client-local. Not state: it is reset at the start
  of every step and never read across ticks, so no hash/snapshot/format change.
- One legal input always paints whole (it costs at most half the budget). Eight painters at radius 8 x 40-cell strokes
  every tick use under a quarter of it.
- Server (`server/paintrate.ts`): each Paint charged `stamps x (2r+1)^2` (the sim's clamps) to a token bucket per IP tag,
  30 worst-case strokes a second with a 2 s burst; over it the input is dropped before it is stamped (`droppedRate`,
  `input.rate_limited` `what: paint_work`, `log.limited` per tag). Buckets are pruned when idle past 4096 tags.
- **Red:** with the sim budget disabled, `the third stroke of the flood is not painted` (`/tmp/reviewfix-h2-red.log`);
  with the bucket bypassed, `12 worst-case strokes against a 2-stroke burst: expected 0 to be >= 9`
  (`/tmp/reviewfix-m3-h2srv-red.log`). The "typical stream untouched" tests pass on both sides, as they should.
- Golden/perf pins: none of their scripts paint more than the budget in a tick, so no pin moved (gate confirms).

## M3: maxPlayers

- Verified: nothing in `server/` read `maxPlayers`. Now a non-spectator HELLO to an avatar world is refused when its
  avatar players (members with a `playerId`) reach `cfg.maxPlayers`, unless that player is already in (a reload
  replaces its tab). Spectators and sandbox painters are exempt (the sandbox preset says 8 but the public sandbox has
  always taken up to 64 painters; the menu offers the stepper only for game types).
- **Red:** the third player was admitted (`promise resolved ... instead of rejecting`).

## M2: catch-up vs the send cap

- **Measured** (`/tmp/reviewfix-m2/probe.mjs`, real `ws` over loopback, a client reading normally): a synchronous send
  loop gets no drain at all. 1.5 MiB snapshot + 600 k ticks of 20 B: 12.9 MiB sent, peak `bufferedAmount` 14.1 MiB,
  over 8 MiB at tick 309,806. So a world with a 1.5 MiB snapshot and about 300 k logged ticks (83 min with no accepted
  snapshot, which is when verification keeps failing) dropped every joiner, as the review suspected.
- Fix: `sendCatchUp` computes its burst size and lets the peer exceed `MAX_BUFFERED_BYTES` by that much (capped at
  `MAX_CATCHUP_SLACK_BYTES` = 64 MiB); the slack stays with the peer (a `WeakMap`) until its queue first drains under
  the cap, then the live cap applies again.
- **Red:** `closed partway through its own catch-up: expected 'too slow' to be null` (`/tmp/reviewfix-m2-red.log`).
  The same test checks the cap returns after the drain.

## Gate

- **Gate 1** (11:16-11:48, quiet machine after another job's net run): cargo (all, golden and perf pins **unchanged**),
  clippy, tsc, determinism (53/53, `/tmp/reviewfix-g-det.log`) green; **net red, 1 of 479**: `chunk-diag.test.ts` "rate-limits
  requests per window and recovers after it", `expected 'unavailable' to be 'pending'`. Cause: the test's "fresh
  window" step hashed tick 2400 when the clock was about 5400: 50 checkpoints back, which M1 now ignores on purpose. An
  honest client never sends one that old. The test now hashes the current checkpoint (it still checks that a fresh
  window recovers). Nothing was committed.
- **Gate 2** (after the chunk-diag change and the cold-review follow-ups): **green**: cargo all ok (golden and perf pins unchanged), clippy, tsc, determinism 53/53, net 480 passed 1 skipped. The four commits were chained on its exit code (11:50-12:23). Each intermediate commit typechecks on its own (checked in a temporary worktree). Then `pnpm build:client` and `APP_URL=http://localhost:8077 pnpm check` against my own server: 9/9. Two agent-browser tabs in the :8077 sandbox (one IP tag), one painting rock and one water: identical worlds, and no desync, resync or rate_limited in the server log. Logs `/tmp/reviewfix-g-cargo.log`,
  `-g-clippy.log`, `-g-tsc.log`, `-g-det.log`, `-g-net.log`; driver `/tmp/reviewfix-commit/gate.sh`, `/tmp/reviewfix-gate2.log`.

## Cold review (`docs/research/review-review-fixes.md`, Sonnet, read-only, 13 tool calls)

No high or medium findings; every claimed fix held in code. Checked each against the code:

| # | Finding | Checked | Action |
|---|---|---|---|
| 1 | Paint buckets: prune drops only full buckets, so many spent keys keep the map over 4096 | true | **Fixed**: hard-evict the oldest after the prune; test red first (`expected 4596 to be <= 4096`) |
| 2 | Catch-up slack lasts until the first drain under 8 MiB | true, bounded (cap + burst, burst <= 64 MiB) | Accepted, documented here |
| 3 | A game world with only spectators never sets truth or asks for a snapshot | true | Accepted: no player means nothing worth snapshotting changes much (no active player, the world is frozen; spectators cause no Join), and the log only grows with ticks. A brief item below if it matters |
| 4 | maxPlayers: a returning player whose slot a latecomer took is refused | true | Accepted (that is what a cap means); the reason text tells them to spectate |
| 5 | tuning.rs comment arithmetic (541,977 should be 545,025) | true | **Fixed** |
| 6 | Dropped HASH/PING not in `droppedRate` | true | Left: logged via `input.rate_limited` (`what`); FUTURE idea |
| 7 | One early Paint can use the tick's whole budget and starve later painters that tick | true, deterministic | Accepted; the per-IP bucket bounds it; per-player shares are a FUTURE idea |
| 8 | Old persisted Paint floods replay differently under the new budget | **not a bug** | `World.loadFromDb` (`world.ts` ~497) clears the tick log on any sim build change (plan 9.3) |
| arch | Paint-rate mirrors had no test | true | **Fixed**: a test parses `MAX_PAINT_RADIUS`/`MAX_PAINT_STROKE` from the Rust source |

## Not done tonight (briefs)

- **M4** (layouts held by hand: `activePlayersIn`'s `ENTITY_AT`/`PLAYER_RECORD`, the lockstep ceiling, `ENEMY_MAX_HP`):
  a refactor. `tests/net/entity-layout.test.ts` and `spells-table.test.ts` already pin two of these mirrors. Brief:
  export `PLAYER_BYTES`, the snapshot header size and an `active_players` view from the wasm, read them in
  `server/world.ts`; pass the room config to `client/lockstep.ts`'s ceiling. Sonnet, ~$5, gate required.
- **M5** (admin token in `fly.toml`): the user's step at deploy: `fly secrets set ADMIN_TOKEN=...` and remove the
  `[env]` line.
- **Spectator-only snapshots** (cold review 3): if wanted, let `requestSnapshot` fall back to a live spectator only
  when the world has no voter, with the upload still checked against... nothing (no voter means no truth), so it would
  need the verifier's own restore hash as the only check. Not worth it before the deadline.
- L2-L8 untouched.

## Architectural decisions for review

1. **Voter identity differs by world kind.** Avatar worlds: one vote per registered player (`p<playerId>`); sandbox:
   one per IP tag. Alternatives: per visitor id (anonymous sandbox painters have none), per socket (the bug). Cost: a
   classroom behind one NAT is one sandbox vote. That only matters if they disagree with each other, which is a real
   desync anyway. Reversible: `World.voterKey` is the only place.
2. **Non-voters are compared but never define truth, and are never the snapshot source.** With no voter reporting, a
   checkpoint resolves to nothing (no resync). Spectators can no longer cause resyncs of players; a diverged spectator
   is still resynced and kicked by its own budget.
3. **The paint budget is per tick and shared, not per player**, and is not state. Charged per stamp at its bounding
   box (what `disc` scans), first-come in input order, cut at the first stamp that does not fit, and everything after
   it that tick dropped. Sized at two worst-case strokes, so one legal input always paints whole. A per-player share
   would be fairer but needs per-tick player bookkeeping. Changing the constant changes behaviour, so it would need a
   new sim build. No format bump (nothing persisted changed).
4. **The server paint bucket mirrors the sim's cost model** (`server/paintrate.ts`), pinned by a test to the Rust
   constants. 30 worst-case strokes a second per IP tag, 2 s burst, 4096 tags at most.
5. **Hash window 30 checkpoints** (`HASH_WINDOW_TICKS`), the same span the old code meant to keep `truth` for. HASH
   and PING are rate-limited at 20 per second per connection; LIVE is exempt.
6. **Catch-up slack** rather than paced or batched catch-up. A peer may exceed the 8 MiB cap by its own burst (up to
   64 MiB) until its queue first drains. It is smaller than streaming the catch-up over timer passes, which is the
   better long-term fix (review improvement 9).
7. **maxPlayers counts connected avatar players** at HELLO. A reload is exempt. Spectators and sandbox painters are
   exempt (the public sandbox has always taken 64 painters, against a preset saying 8).

## D-row drafts

*Session model, at merge: recorded as **D-221 to D-224** in `docs/DECISIONS.md` (D-218 to D-220 were already taken).*

| D-218 | 2026-11-08 | **Hash votes are per player, not per socket** (independent review H1): avatar worlds count one vote per registered player, the sandbox one per IP tag; spectators and anonymous members are compared against the majority but never define it, and only voters are asked for snapshots. Hash ticks older than 30 checkpoints are ignored and the majority is kept for that window; HASH/PING frames are capped at 20/s per connection (M1). | review-fixes |
| D-219 | 2026-11-08 | **A per-tick paint budget in the sim** (review H2): `MAX_PAINT_WORK_PER_TICK` = two worst-case strokes of disc bounding box, charged per stamp in input order inside `step`, not state; plus a per-IP-tag paint token bucket on the server (`server/paintrate.ts`). Normal painting is unchanged; a flood is cut identically on every client. | review-fixes |
| D-220 | 2026-11-08 | **maxPlayers enforced at HELLO; catch-up slack over the send cap** (review M3, M2 measured): a full room refuses new players ("room is full; spectate or try another room"), reloads exempt; a joiner's catch-up burst may exceed the 8 MiB queue cap by its own size (64 MiB at most) until the queue drains. Also S1: ice touches its own cell, with a cached-hash invariant test. | review-fixes |

## Engineering-decisions entry draft

**46. Who gets to say what the world is.** The independent review (8 Nov) found the trust path counted HASH votes per
socket. Three spectator tabs could outvote a real player, have them resynced three times and kicked, and could be
asked for the snapshot that every later joiner restores. Claims had been counted per registered visitor since D-120,
but hashes never were. The fix gives the vote to players (one per registered player in avatar worlds, one per IP tag
in the sandbox). Everyone else is checked against the majority but cannot make it (D-218). The same review found a
stale-cache bug: ice changed its own budget without marking its chunk. Only a joiner restored from a snapshot would
see it, so every test that plays through had passed over it. A new invariant test, "the cached hash equals the hash
recomputed from scratch, and a snapshot round-trips to it", catches that class. It was red on the bug and found no
other. The review's suspected catch-up bug was measured rather than argued: a synchronous `ws` send loop never drains,
so the queue grows by every byte sent. A log of about 300 k ticks behind a 1.5 MiB snapshot would have dropped every
joiner (D-220). Paint got a budget per tick as well as per input (D-219), so the bound CLAUDE.md asks for ("an input
must not be able to cost unbounded work") now holds across a tick's inputs, not only within one. Commits: `86243ca` (S1), `bf8fd8d` (H2), `6d0f314` (H1, M1, M2, L1), `3da71bb` (M3).
Report: `docs/research/review-fixes-report.md`; cold review: `docs/research/review-review-fixes.md`.

## Spend

B0 **$285.87**. Readings: $290.77, $297.65, $301.57, $302.60, $303.75, $305.76, $306.84, $309.91 (after the gate and the browser check). Total about **$24** of the $35 cap. One worker: the cold
reviewer (Sonnet, 73 k tokens, about $1 by token count; the proxy reports the whole session). No implementation
workers: each fix was a few dozen lines on code I had already read, so briefing would have cost more than writing.

## Commits on `review-fixes` (not pushed)

- `86243ca` S1: ice touches its own cell; hash-cache invariant test
- `bf8fd8d` H2: deterministic per-tick paint budget (sim) and per-address paint rate (server)
- `6d0f314` H1, M1, M2, L1: hash votes per player, bounded hash window, catch-up slack
- `3da71bb` M3: enforce maxPlayers at HELLO
- (this report and the cold review in a docs commit)

## Ideas for FUTURE.md (session model decides)

- A per-player share of the per-tick paint budget, so one painter cannot starve another inside a tick (cold review 7).
- Count dropped control frames (HASH/PING) in the admin dashboard's dropped-rate (cold review 6).
- Stream the catch-up over timer passes, or as one batched frame, instead of the slack (review improvement 9).

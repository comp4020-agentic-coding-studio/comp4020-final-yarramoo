# M4: binary layouts from the wasm (backlog item 6), report

Lead: Opus, 8-9 Nov 2026. Branch `layouts` (worktree `/tmp/wt-layouts`, from `multa` `36d1bed`). No worker: the change is
about 140 lines across known files, and a brief would have cost more than doing it. Cap $8; week spend at start
$405.35 (first read); see Spend.

## What changed

The finding (`docs/research/code-review-2026-11-08.md` M4) named three hand-held copies of binary facts.

1. **Snapshot layout from the wasm; a failed parse is logged.**
   - `sim/src/lib.rs`: three constant exports, `snapshot_format_version()`, `snapshot_header_bytes()`,
     `player_record_bytes()` (u32; `snapshot::HEADER` made `pub`). They read constants only: no state, no format bump,
     no pinned hash moves. `WebAssembly.Module.imports` is still `[]`.
   - `shared/sim.ts`: `SnapshotLayout` and `snapshotLayout(bytes)`, which instantiates the module once and throws for a
     build without the exports (the v1 fixture).
   - `server/main.ts`: reads the layout once at start, from the same file it hashes for the build check, and passes it to
     every `World` (`WorldOptions.snapshotLayout`).
   - `server/world.ts`: `activePlayersIn(compressed, layout, maxRaw)` no longer catches. It throws on a bad magic, a
     format other than the build's, an entity section past the end, or a player section past the entity section. It
     decompresses under the room's own ceiling (`maxSnapshotRawFor(this.cfg)`), not the fixed caves 7 MiB. The cold-start
     caller (`snapshotPlayers`) logs a failure as **`snapshot.unreadable`** (new in `shared/events.ts`; `log.limited`, 60
     s per room, level `error`, fields `world, tick, bytes, error`) and counts no one active, as before. It also parses
     once instead of twice.
2. **The client's decompression ceiling is the room's.** `client/lockstep.ts` used `w*h > 512*512 ? CAVES_PVP :
   CLASSIC_SANDBOX`, so a size-M room (1024 x 768) got the L ceiling and a size-S game room the sandbox one. It now uses `maxSnapshotRawForDims(sim.width(), sim.height())`. That is a new helper in
   `shared/protocol.ts`, and `maxSnapshotRawFor(cfg)` is now defined through it, so the two cannot drift. `init` set the
   sim to the room config's size before any snapshot arrives (the worker inits from WELCOME's config bytes), so this is
   the room config's ceiling, the same number the server checks uploads against.
   - In numbers: S 1 MiB, M 2 MiB, L 7 MiB. Before, M got 7 MiB: a looser zip-bomb guard than the server's, never a
     refusal of a legitimate snapshot, so nothing visible changes. S was already right by coincidence.
3. **One `ENEMY_MAX_HP`.** Removed from `client/worker.ts` and `client/hover.ts`; one copy, exported from
   `shared/sim.ts` (next to `NUM_ENEMY_KINDS`, which already mirrors `tuning.rs` the same way).
   `tests/net/spells-table.test.ts` pins it to `ENEMY_STATS[k].hp`, `BOSS_HP` and `COLOSSUS_HP`, and fails if any file
   under `client/` declares its own `ENEMY_MAX_HP` again.

Tests: `tests/net/snapshot-layout.test.ts` (new, 12 cases), `tests/net/entity-layout.test.ts` (uses the wasm layout; its
hard-coded `HEADER = 70` and player size are gone), `tests/net/spells-table.test.ts` (the hp test rewritten).

## Red-first evidence

Each new or rewritten test was run against a deliberate break of what it guards, then the file was restored from a copy
(`cmp` confirmed) and the three files went green again (18/18, `/tmp/layouts-green.log`).

| # | Break | Result | Log |
|---|---|---|---|
| R1 | lockstep ceiling put back to the area rule | 1 failed: "size 1: a stream just under the cap restores..." (M got 7 MiB, so the at-cap stream was accepted) | `/tmp/layouts-red1.log` |
| R2 | the `log.limited` call replaced by `void e` (swallowed, as before) | 3 failed: corrupt bytes, other format, no layout | `/tmp/layouts-red2.log` |
| R3 | `snapshotLayout` returns the old hand formula off by one byte (`21 + 6*NUM_SPELLS + 8`) instead of the wasm's | 3 failed: both entity-layout parser tests and the cold-start orphan test | `/tmp/layouts-red3.log` |
| R4 | the hp table copied back into `client/hover.ts` | 1 failed: "...is the only copy" | `/tmp/layouts-red4.log` |
| R5 | `ENEMY_MAX_HP[4]` = 801 | 1 failed: the hp pin | `/tmp/layouts-red5.log` |

## Gate

**Full tier, green; committed as `5c41bd7`.** The planner said full because of `client/lockstep.ts`, `client/worker.ts`,
`shared/*` and `sim/src/*`. The commit was chained on the exit code (`/tmp/layouts-gate.sh`). It queued behind another
agent's cargo run and started 00:40, quiet apart from that run.

| Step | Result | Log |
|---|---|---|
| cargo test --release | 478 passed, 0 failed | `/tmp/layouts-g-cargo.log` |
| clippy wasm32 -D warnings | clean | `/tmp/layouts-g-clippy.log` |
| typecheck | clean | `/tmp/layouts-g-tsc.log` |
| test:determinism | 53/53 (11 files) | `/tmp/layouts-g-det.log` |
| test:net | 567 passed, 1 skipped (76 files) | `/tmp/layouts-g-net.log` |

No pinned hash moved (golden and perf_equiv are in the cargo run), as expected: the new exports read constants.

**The review follow-up** (`server/world.ts` comment and two test files) is server tier by
`node scripts/gate-plan.ts --files ...`: typecheck and net, chained to its commit (`/tmp/layouts-gate2.sh`; logs
`/tmp/layouts-g2-tsc.log`, `/tmp/layouts-g2-net.log`). Its two new tests were shown red first:
- R6: both bounds checks removed from `activePlayersIn` gives 2 failed (`/tmp/layouts-red6.log`).
- R7: a probe file `client/zz-red-probe.ts` holding the hp literal under another name gives 1 failed
  (`/tmp/layouts-red7.log`). The probe was removed by literal path.

Not opened in a browser. The visible paths are the hp bars and the hover label, which now read the same numbers from
an import. A snapshot restore in the client goes through the net suite's real `Lockstep` clients, at every size the
tests use.

## Cold review

Read-only Sonnet review, cold, from the saved diff: `docs/research/review-layouts.md`. It found no High or Medium issues
and confirmed the parse offsets, the bounds arithmetic, the ceiling equivalence, the single client `Lockstep` site, and
the logging rules. Response, each claim checked in the code:

- **Low 1** (`server/world.ts` header still says the only sim use is the verifier): true. Fixed in the follow-up commit.
- **Low 2** (`snapshot.unreadable` at `error` is new noise): intended. It fires only on corrupt or mismatched stored
  data, at most once a minute per room.
- **Low 3** (the only-copy guard misses a copy under another name): true. The guard now also matches the hp literal (R7).
- **Nit 4** (a parameter shadows `snapshotLayout`): renamed.
- **Nit 5** (the client-ceiling test uses a stand-in sim): accepted. It pins the arithmetic, and real restores are
  covered by the net clients.
- **Nit 6** (no crafted-buffer tests for the two "runs past" branches): added (R6), plus an unedited control.
- **One review claim was wrong:** "no room in the repo uses size 1 today". Survival and Creative are both size M
  (`shared/room.ts`). So the client change does apply to real rooms. It is still safe:
  - An M snapshot is at most 192 chunks x 8194 + 128 KiB, about 1.7 MB, under the 2 MiB cap.
  - The server verifies every snapshot it stores under that same `maxSnapshotRawFor(cfg)` before sending it to anyone.
  - The net suite's Survival and Creative rooms restore through it, green.

## Architectural decisions for review

1. **Three constant exports, not an `active_players` view.** An `active_players(ptr, len, out)` export would have to
   restore (or half-parse) a snapshot inside the wasm. The server is not supposed to run the sim (invariant 11; the
   verifier restores only in worker threads, and a game restore regenerates a world: seconds). Constants keep the parse
   in TypeScript and take only the offsets from the build. Cost: TypeScript still knows the record *shape* (`id u32`
   first, `active u8` at +4, players first in the entity section). `entity-layout.test.ts` pins that shape against the
   real sim, and `entities.rs` says players stay first because the server reads them.
   - Reversible: the exports are additive; an `active_players` view could be added later beside them.
2. **The layout is read once in `main.ts` and passed in, not read by `World` itself.** `main.ts` already reads that exact
   file to hash it (invariant 10), so the layout and the build hash describe the same bytes. `World` stays free of file
   paths, and its unit tests build Worlds without a wasm. A World built without a layout logs `snapshot.unreadable` at
   its first game-snapshot cold start rather than reading nothing silently (pinned by a test).
   - Cost: one extra `WebAssembly.Instance` at start (1.1 MB of linear memory, under a millisecond; it is
     garbage-collected after). `server/verify.ts`'s header comment is updated ("the ONE place the server *runs* the sim").
3. **The parse checks the format version against the build's.** A stored snapshot from another format would be read
   at the wrong offsets. In practice `loadFromDb` already resets a world whose snapshot this build cannot restore, so
   this only fires on corrupt or hand-edited data. It throws and logs rather than guessing.
4. **The client ceiling comes from the sim's size, not a config object.** `Lockstep` is constructed with a `Sim` in five
   places (the worker, the net-test client, three soak scripts). The soak scripts still init from a bare world kind. The
   sim's size after `init` *is* the room config's size, so `maxSnapshotRawForDims(w, h)` gives exactly
   `maxSnapshotRawFor(cfg)` (one formula) with no signature change.
   - Alternative: pass the `RoomConfig` to `Lockstep`'s constructor. That changes five callers, and the soak scripts
     would need a config they do not have.
5. **`ENEMY_MAX_HP` stays a TypeScript table, pinned by a source-reading test**, not a wasm export. An export would mean
   the worker reading it from the instance at init, for a render-only number. The pin reads `tuning.rs`, as the
   neighbouring spell-table pins already do.

## D-row draft

| D-2xx | 2026-11-09 | **Snapshot layout facts come from the sim build** (review M4): `sim.wasm` exports `snapshot_format_version`, `snapshot_header_bytes`, `player_record_bytes` (constant u32s, no imports); `main.ts` reads them once from the wasm it hashes and passes them to every World. `activePlayersIn` checks magic, format and section bounds under the room's own ceiling, and a cold-start parse failure logs `snapshot.unreadable` instead of being swallowed. The client's snapshot ceiling is `maxSnapshotRawForDims` of the sim's size (= the room config's), not an area guess; `ENEMY_MAX_HP` has one copy (`shared/sim.ts`), pinned to `ENEMY_STATS`/`BOSS_HP`/`COLOSSUS_HP`. Constants, not an `active_players` view: the server does not run the sim. | layouts |

No engineering-decisions entry suggested: it is a hardening of an existing path, not a structural decision.

## FUTURE.md ideas (listed, not added)

- **Export the entity section's record sizes too** (`PICKUP_BYTES`, `PROJECTILE_BYTES`, `BAG_BYTES`, `ENEMY_BYTES`,
  `HEAL_BYTES`). `entity-layout.test.ts` still writes them by hand to walk the sections. Only a test reads them today,
  so they were left alone.

## Spend

Week spend: $405.35 at my first read, $426.18 at the report. That $20.8 is the whole proxy, with the session's other
agents (main, writeup, the owner of the other cargo runs) running at the same time, so it is an upper bound on this
item, not its cost. My own share is the Opus lead (about 80 tool calls) plus one Sonnet review (15 tool calls, ~71k
tokens). No worker. The gates spent no tokens while they ran. The week stayed under the $450 stop.

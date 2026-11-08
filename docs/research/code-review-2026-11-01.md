# Code-quality review, 1 Nov 2026 (`multa` at `5fc9634`)

Three independent Sonnet reviewers each read one part of the code:

- the sim (`sim/`);
- the server and shared protocol (`server/`, `shared/`, `tests/net/`);
- the client (`client/`).

They were told not to read the decision logs, research notes, briefs or earlier reviews, so they judged the
code fresh. Their priorities, in order: stability, multi-user consistency, then ease of future development.
Security came last. They read the code and ran nothing. Their full reports, with every finding, are:

- [`code-review-sim.md`](code-review-sim.md): 14 findings;
- [`code-review-server.md`](code-review-server.md): 17 findings;
- [`code-review-client.md`](code-review-client.md): 11 findings.

**The session model checked the top claims against the code** before writing this summary. Each row below
says whether it was **verified** that way or rests on the reviewer alone.

## Overall verdict

**The deterministic core is in good shape.** The edges around it are where the bugs are.

- **Sim:** the reviewer found no panic reachable from a hostile snapshot or input. It also found no
  iteration-order or `usize` hazard, and no float use.
- **Hashing, snapshots and lockstep:** they agree with each other, are defensive, and have tests.

**The bugs sit at the boundaries:**

- **the server's error handling:** one bad room load can take down the whole process;
- **connection lifecycle:** resync, reconnect and dead sockets;
- **the cost of a single input.**

**The biggest drag on future work is structure, not correctness.**

- Three files are each one huge closure or class: `server/main.ts`, `server/world.ts` and `client/room.ts`.
  `client/worker.ts` holds about 70 module-level mutable variables.
- The entity and snapshot layouts are written by hand in two languages.
- Recent slices packed new state into existing fields to avoid format bumps.

## Fix first (stability and consistency)

| # | Finding | Where | Severity | Status |
|---|---|---|---|---|
| 1 | **One failed room load crashes the whole server.** The HELLO handler calls `void getOrLoadRoom(...).then(...)` with no `.catch`. `World.load()` throws on purpose when a stored snapshot can't be verified under a new build, and the production `unhandledRejection` handler rethrows. One client opening that room kills every world. `handshaking` is never reset either. | `server/main.ts:1020`, `server/world.ts:407`, `server/main.ts:1336` | high | **verified** |
| 2 | **One Paint input can cost about 6.6 M cell writes on every client.** The endpoints and radius are clamped, but the stroke length isn't. A corner-to-corner stroke at radius 32 on a 2048-wide world takes 2047 steps, each writing a disc of about 3,200 cells. This affects only rooms with brushes (the sandbox and Creative). CLAUDE.md's own rule ("an input must not be able to cost unbounded work") is only half met. | `sim/src/sim.rs:491-504` | high | **verified** |
| 3 | **DB errors while handling hashes kill the process.** `recordIncident` and `updateIncident` have no guard inside the 4 ms timer, unlike `flush()`, which already retries. A full or locked volume crashes every room. | `server/world.ts:907, 924, 1046` | medium | reviewer |
| 4 | **A persistent divergence resyncs forever.** Every checkpoint (about 1 s) sends the full snapshot and log, inserts an incident row that is never pruned, and logs `desync` and `resync` without `log.limited`, which breaks the CLAUDE.md logging rule. In a 2-player room, a bad first joiner wins the hash tie-break and keeps the other player in a permanent resync. | `server/world.ts:891-916, 1068-1081` | medium | reviewer |
| 5 | **A resync wipes every other player's name.** `beginReplay` clears `names`, and the server resends names only on WELCOME, not on RESYNC. After any resync, everyone else shows as "Player" until they reconnect. | `client/worker.ts:313`, `server/world.ts:595-598` vs `:1080` | medium | **verified** |
| 6 | **Joins and resyncs block the event loop.** `sendCatchUp` makes one synchronous `ws.send` per logged tick, which can be 200k or more. That stalls every room's tick timer during a join or resync, which ties into #4. | `server/world.ts` `sendCatchUp` | medium | reviewer |
| 7 | **No liveness timeout.** The server pings every 2 s but never drops a silent socket. Ghost members pin rooms in memory, delay every hash checkpoint, and inflate the death-claim quorum. | `server/world.ts` | medium | reviewer (the missing timeout is confirmed; its effect is not measured) |
| 8 | **Fatal client errors are invisible.** The wasm `fetch` has no `res.ok` check. A worker `error` only writes "worker error" in the status line, and exceptions in the socket's `onmessage` are uncaught. The page freezes on a stale status with no prompt to reload. There is no WebGL context-loss handling either. | `client/room.ts:564`, `client/worker.ts` | medium | reviewer |
| 9 | **Created rooms never report deaths to stats or achievements.** `onDeathResolved` is wired only on the fixed game world. This blocks F7's kill and boss achievements as written. | `server/main.ts:465` | medium | **verified** |
| 10 | **Room creation and loading are unbounded.** Anonymous room creation has no rate limit, since the limiter is keyed on `creatorPlayerId`, which the route always passes as null. Rooms and snapshots are never deleted. The loaded-room cap ignores loads still in flight. | `server/main.ts`, `server/rooms.ts` | medium | reviewer |

### Consistency details worth knowing

- **Snapshot bytes are not canonical** (sim #2). A chunk's `pristine` flag reflects history, not content, so
  two clients with identical cells can produce different snapshot bytes. The state hash is unaffected.
  Harmless today, because nothing compares snapshot bytes. It would bite any future dedupe, or any test that
  compares snapshot bytes.
- **The snapshot ceiling is guessed from the world's size** (client #2). `lockstep.ts:69` picks
  `CAVES_PVP` or `CLASSIC_SANDBOX` from `width*height`. The same assumption made size-S rooms draw as
  sandboxes (D-169). The two 512x512 configs happen to share a 1 MiB ceiling, so it is harmless today, but a
  new size could break reconnects. **Verified.**
- **Replay edges in the client** (client #4 and #7):
  - `pendingEvents` silently drops the newest events past 300;
  - the last replayed tick's events play as live;
  - some per-connection state (`enemySeen`, `bossPhase`, `lastSentPos`) isn't reset on a reconnect.
  The likely symptom is a duplicate toast or sound on join.
- **Not a real issue:** sim #3 suspected that a snapshot could miss queued, unstepped inputs. The networked
  driver (`client/lockstep.ts` `stepOne`) pushes and steps one tick at a time, so a snapshot never has a
  queued input. **Verified unreachable today.**

## Ease of future development

Across the three reviews:

1. **Very large closures and classes.**
   - `server/main.ts` is one closure of about 1,100 lines, with the request-body reader copied 3 times.
   - `World` mixes five concerns: clock, membership, hashing, persistence and snapshots.
   - `client/room.ts` is one `startRoom` closure of about 1,250 lines.
   - `client/worker.ts` has about 70 module-level `let`s and a 200-line `gameFrame`.
   Each new feature in these files adds more shared mutable state. A cheap first step is to extract the HUD
   pieces (lobby, boss bar, round banner, late panel) from `room.ts` into modules, and the body reader and
   routes from `main.ts`.
2. **Layouts written by hand twice.** The entity view, snapshot sections and tick frames are encoded in Rust
   and decoded again in TypeScript, with sizes summed by hand. `entity-layout.test.ts` pins the snapshot
   parser, which is good, but every format change still means editing both sides. A single generated table,
   or more pinning tests of the same kind, would help.
3. **Packed and reused fields** (sim #5).
   - `round_started` is documented as "first kill or death" but is really two bits: `ROUND_RUNNING` and
     `ROUND_BOSS_KILLED`.
   - The boss's phase lives in `Enemy.state`, and its summon counter in `hop_until`.
   Every later slice must know about these. Since the game is not live, replacing them with named fields in
   one format bump is cheap now and gets expensive after launch.
4. **Adding content touches many parallel tables** (sim #7). A new enemy, spell or material means editing
   `tuning.rs` tables, `if` chains in `spells.rs` and `enemy.rs`, client sprite and SFX maps, and hand-mirrored
   constants such as `ENEMY_MAX_HP` in TS. A per-kind trait or table would shrink that.
5. **Message switches aren't checked for exhaustiveness.** `FromWorker` and `ToWorker` are typed where
   messages are sent, but the switches that handle them don't use `assertNever`, so a new message kind can be
   silently ignored.
6. **Tests.**
   - Many net tests assert against real-clock timing windows, which can flake.
   - The sim has no golden regression test: no checked-in v9 snapshot, and no scripted-run hash.
   - `restore` accepts exactly one format version, so the first format change after launch will orphan
     every stored world. That doesn't matter until launch, and then it matters a lot.

## Security (low priority, noted only)

- Anonymous room creation has no rate limit (#10).
- A hostile client can hold a peer in a resync loop in a 2-player room (#4).
- Only the "input" frame type is rate-limited (server #9, suspected).

## Strengths the reviewers called out

- **Determinism discipline is real.**
  - The rng is counter-based, the scan order alternates by tick parity, and maths is integer-only with `i64`
    for squared distances.
  - There is no `HashMap`, and only fixed-width values are hashed.
  - The D7 sleep tests are many and good.
- **The snapshot restore is defensive.**
  - The length maths is overflow-checked, and chunk indices must be in order.
  - Restore stages the new state and swaps it in, so a failed restore keeps the old sim.
  - A test feeds it hostile bytes.
- **The server's snapshot acceptance is careful.**
  - A snapshot is accepted only when it was requested, its hash matches the majority's, and a worker
    restore reproduces both the tick and the hash.
  - The `resetGen` counter stops a stale verify from saving after an admin reset.
  - Building the sim no longer resets a world on a mere verify timeout.
- **The lockstep core is clean.** It is pure and DOM-free (`lockstep.ts`, `catchup.ts`), shared with the Node
  tests, and enforces contiguous ticks. The rule that TypeScript only writes sim state through `push_input` is
  respected everywhere the client reviewer looked.

## Recommended order

1. **Before any deploy**, all small, all stability:
   - #1, catch the room-load and join failure;
   - #3, guard the incident DB writes;
   - #2, cap the Paint stroke length or the total cells per input.
2. **With F7**, which touches these paths anyway:
   - #9, wire `onDeathResolved` for every room, because achievements need it;
   - #5, resend names on RESYNC;
   - #4, a resync budget per member, plus `log.limited`;
   - #7, a liveness timeout.
3. **Before launch, while format breaks are free:**
   - replace the packed `round_started` bits and the boss's reused fields with named state, in one format bump;
   - add a golden snapshot and a scripted hash test.
4. **When time allows:** the structural refactors (`main.ts` routes, `room.ts` HUD modules,
   `World` concerns), #6 (async catch-up), #8 (fatal-error UI), and the rest of the reports.

Cost of this review: three Sonnet reviewers (about 70 tool calls in total) plus the session model's checks.

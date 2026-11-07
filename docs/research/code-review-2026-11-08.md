# Simulta: independent code review

Reviewer: Opus, working from the code only (no Markdown or prose docs read, by me or the worker). Branch `multa` @ `7d5b004`.
Read-only: nothing was built, run or tested. Line numbers are at that commit.

## 1. Summary (the five that matter most)

1. **High: anonymous connections decide the "truth" hash.** One HASH vote per socket, spectators and anonymous painters included. Three spectator tabs can get every real player resynced and then kicked. A crafted snapshot can be verified and saved, and the same thing happens by accident when one spectator's browser diverges (`server/world.ts:964-1010`, `1406-1421`).
2. **High: Paint has a per-input bound but no aggregate bound.** At 40 inputs/s per socket and 12 sockets per IP, one anonymous address can make every sandbox client do about 200 M cell writes a second (`sim/src/sim.rs:523-570`, `server/main.ts:69,1352-1362`).
3. **Medium: `update_ice` writes `aux` without `touch`.** Across a chunk edge, the chunk-hash cache goes stale. A client that restored from a snapshot then disagrees with every client that played through, and the joiner is resynced and kicked (sandbox and brushes rooms with painted ice next to water, `sim/src/grid.rs:975-978`).
4. **Medium: HASH frames for old ticks open checkpoints and `truth` entries without limit.** Each 4 ms timer pass then costs O(checkpoints x members) (`server/world.ts:964-1004`).
5. **Medium (suspected): the catch-up burst is capped by the same 8 MiB `bufferedAmount` check as live play.** A world whose snapshot plus log is larger than that drops every joiner partway through, and they retry forever (`server/world.ts:533-552,686-693`).

Next in line: `max_players` is validated everywhere but enforced nowhere (M3), and binary layouts are held twice, by hand, on the server and client (M4).

## 2. Findings

### High

**H1. Hash majority and snapshot truth can be sybilled by anonymous members**
- `server/world.ts:964-985` `onHash` takes a HASH from any member, with no `playerId` or `visitorId` test. `tryResolve` (`world.ts:987-1010`) counts one vote per *connection*, and a tie goes to the longest-connected member.
- `server/main.ts:1247-1262` admits spectators (`HELLO_SPECTATE`) and sandbox painters anonymously. Limits are 12 sockets per IP (`main.ts:69`) and 64 members per world (`main.ts:67`).
- `client/worker.ts:318-321`: honest spectators send HASH as well.
- By contrast, claims (`world.ts:1333-1356`, `1386-1401`) already require a registered visitor and count one vote per visitor. Hashes do not.
- Failure scenarios:
  - **DoS:** three spectator sockets send the same wrong hash at every checkpoint. They form the majority, so each real player is "divergent" and resyncs, which resends the whole snapshot and log. After `RESYNC_BUDGET` = 3 in a minute, each player is closed with 4001, "out of sync, reload" (`world.ts:1213-1225`). This works in any room, including someone else's Survival run.
  - **No attacker needed:** one player plus one spectator whose browser diverged. If the spectator connected first, it wins the 1-1 tie. The healthy player resyncs, computes the same correct hash, loses again, and is kicked after three rounds.
  - **State injection:** `requestSnapshot` (`world.ts:1406-1421`) picks the longest-connected live member with no player check. If that member is the attacker, it uploads any snapshot that restores, made in its own copy of the wasm, and its sockets vote that snapshot's hash at the checkpoint. `checkUpload` then finds restored hash = claimed hash = majority hash (`world.ts:1459`), saves the snapshot (`world.ts:1462`) and serves it to every later joiner.
- Confidence: **verified in code** for every step. The end-to-end attack was not run.
- Fix:
  - Count hash votes as claims are counted: once per registered visitor, among members with a `playerId`.
  - Compare spectators and anonymous painters against the truth, but never let them define it.
  - Request snapshots only from players.
  - In the sandbox, where everyone is anonymous, at least cap votes per IP tag.
  - Add a test with a spectator majority.

**H2. Paint flood: there is no per-tick or per-address work budget**
- `sim/src/sim.rs:523-570` bounds one Paint to `MAX_PAINT_STROKE + 1` = 129 stamps of radius at most 32, about 415 k cell writes. Each write goes through `grid.set` and `touch`: chunk arithmetic plus up to four wakes (`grid.rs:167-196`).
- `server/main.ts:1352-1362`: the rate is 40 inputs/s *per connection*. 12 connections per IP (`main.ts:69`), sandbox painters anonymous.
- Cost: one address sends 480 paints/s x 415 k, about 200 M cell writes/s, and every client in the sandbox (or a brushes room) has to apply all of them. Every client freezes. The per-input bound exists; there is no aggregate one. The sim already caps bombs per tick (`MAX_BOMB_EXPLOSIONS_PER_TICK`, `tuning.rs:128`), which shows the pattern.
- Confidence: **verified in code** (the cost is arithmetic, not measured).
- Fix: a deterministic per-tick paint-area budget in the sim, with stamps past it dropped, applied in input order. Also rate-limit inputs per IP tag on the server, and/or charge each connection the painted area (from the payload's length and radius) rather than counting inputs.

### Medium

**M1. HASH frames for old ticks grow `checkpoints` and `truth` without limit**
- `server/world.ts:966` accepts any multiple of 60 in `(minHashTick, lastClosed]`. Only the newest 30 `truth` entries are pruned (`world.ts:1004` deletes only `tick - 30*HASH_EVERY`).
- A hash for an older tick opens a new checkpoint that waits `HASH_WAIT_MS` for every member. `resolveDue` walks every open checkpoint times every member on each 4 ms pass (`world.ts:983-989`, `main.ts:73`), and each resolved old tick leaves a permanent `truth` entry.
- Non-input frames have no rate limit, so one connection can open thousands of checkpoints a second (one per checkpoint tick of world age: 1,440 per hour) and keep re-sending them.
- Confidence: **verified in code**.
- Fix: accept hash ticks only within a few `HASH_EVERY` of `lastClosed`, allow one open checkpoint per member, and rate-limit frames per connection.

**M2. The catch-up burst shares the live send-queue cap (suspected)**
- `sendCatchUp` (`world.ts:686-693`) sends WELCOME, the snapshot frame and *every* logged tick as separate frames, in one synchronous loop. Each goes through `trySend` (`world.ts:533-552`), which closes the peer with "too slow" once `bufferedAmount` > 8 MiB.
- Nothing drains during the loop. A game snapshot can be up to 4 MiB compressed (`maxUploadFrameFor`), and `MAX_LOG_TICKS` now only warns (`world.ts:46-49`), so snapshot plus log can pass 8 MiB.
- Worst case: when verification keeps timing out (a busy 256 MB machine), no snapshot is accepted and the log grows. Joiners are then dropped partway through catch-up, the client reconnects with backoff (`worker.ts:512`), and no member stays long enough to supply the snapshot that would shrink the log.
- Confidence: **suspected**. Whether it bites depends on how much the kernel socket absorbs before ws starts counting.
- Fix: skip the cap until the member is live (or raise it), batch log ticks into one frame, or spread catch-up over timer passes.

**M3. `max_players` is never enforced**
- The field is validated in `sim/src/config.rs:93` and `shared/room.ts:42`, and the menu sets it (`client/menu/screens.ts:282`). Nothing reads it to admit anyone: the sim caps players at `MAX_PLAYERS` = 1024 (`sim.rs:431`) and the server caps members at 64 (`main.ts:1222`). Grepping `server/` for `maxPlayers` finds nothing.
- A "2 player" room accepts 64.
- Confidence: **verified**.
- Fix: refuse a non-spectator HELLO when the room's players (`playersIn`) reach `cfg.maxPlayers`. Optionally cap in the sim's `join` too, deterministically, so the rule cannot drift.

**M4. Binary layouts held twice, by hand**
- `server/world.ts:1497-1513` `activePlayersIn` parses the snapshot's entity section with `ENTITY_AT = 70` and `PLAYER_RECORD = 21 + 6*NUM_SPELLS + 9`. Both match `snapshot.rs` HEADER and `entities.rs:27` `PLAYER_BYTES` today. Nothing but a test ties them to `FORMAT_VERSION`, and the parse sits inside `try { } catch { }`, so a mismatch fails silently. That leaves orphan players active at cold start, which keeps their regions awake.
- `client/lockstep.ts:69` picks the decompression ceiling with `w*h > 512*512 ? CAVES_PVP : CLASSIC_SANDBOX` instead of the room config it has. A size-S game room gets the sandbox ceiling. That is fine today, because the two ceilings coincide for S, but it is fragile.
- `ENEMY_MAX_HP` is copied in `client/worker.ts:225` and `client/hover.ts:7`, and mirrors the sim's `ENEMY_STATS` and `BOSS_HP`.
- Confidence: **verified**. The mirrors agree today.
- Fix: export the layout constants (or an `active_players` view) from the wasm, or read the room config. Keep a single TypeScript copy of the enemy hp table.

**M5. The committed admin token gates a destructive endpoint**
- `fly.toml` `[env] ADMIN_TOKEN = "w-9dwbvsOY0f"` is public by design (per the comment). It unlocks `/api/admin/reset` (`main.ts:698-748`) for every world, and the admin dashboard with player `name#id`s and the event feed.
- Anyone who reads the repo can wipe the shared worlds.
- Confidence: **verified**. It is a recorded choice, but a risky one once the app is live.
- Fix: set the token as a Fly secret and remove it from `fly.toml`.

### Low

- **L1.** `server/world.ts:661-671`: when a tab is replaced, the old member is deleted without clearing `request` or `waitingUpload` if it was the snapshot source. `leave()` clears them (`world.ts:701-702`). The request then lingers until `SNAPSHOT_GIVE_UP_TICKS` (10 s), which only delays the snapshot.
- **L2.** Stats and achievements are credited from unverified inputs. `main.ts:1383-1390` bumps cast stats and runs `achievements.onStat` for every Cast before the sim checks charges or cooldown, so 40 casts/s earns cast achievements. Pos depth is credited (`main.ts:1376-1381`) even when `stampClient` then drops the input.
- **L3.** `POST /api/rooms` (`main.ts:763-829`, `rooms.ts:113-125`) never checks that `mode` and `config` agree. Mode "sandbox" with a Creative-style config (avatars plus brushes) is accepted, so "creative retired" is only a label.
- **L4.** `client/worker.ts:117,266,350`: `sentAt` grows whenever the server drops a paint (rate limit or a held world), which skews the paint-latency readout. Display only.
- **L5.** `server/world.ts:~520`: `loadFromDb` calls `db.ticksAfter` twice, reading the whole tick log twice at boot.
- **L6.** `World.log` holds one `Uint8Array` per tick, about 100+ bytes of V8 overhead for about 10 bytes of data. 200 k ticks is about 20-30 MB per world, and nothing hard-caps it now. That matters on a 256 MB machine with up to 16 rooms.
- **L7.** Static files are served with `readFileSync` on every request (`main.ts:1009-1019`), on the thread that runs the tick timer. Same for `/readme/` (`readmePage`, which re-parses the Markdown on each request).
- **L8.** `events()` truncates at `MAX_EVENTS` = 256 (`shared/sim.ts:109`). Every client truncates identically, so claims are lost together. Harmless, but silent.

### Sim core (worker 1, Sonnet; I re-read finding S1 myself)

**S1 (medium). `update_ice` decrements `aux` without `touch(i)`: stale hash cache and pristine flag** (`sim/src/grid.rs:973-978`)
- After freezing a Water neighbour it does `self.set(n, ICE, 1); self.moved[n] = 1; self.aux[i] -= 1; return;`. Every other in-place `aux` write in the file is followed by `self.touch(i)` (`grid.rs:951-952`, `997-998`, `1122-1123`, `1160-1161`); this one is not.
- `set(n, ..)` marks only chunk(n) as `dirty_since_hash` and not `pristine`. When the ice cell is on a chunk edge and the water is across it, chunk(i)'s cached hash (`hash.rs:19-27`) keeps the old bytes.
- Only ice with `aux > 1` freezes neighbours, and that is fresh *painted* ice. Generated ice and Freeze-spell ice are written spent (`aux` 1: `gen.rs:1378-1419`, `spells.rs:255`), and the fresh-to-`ICE_COLD + 1` step goes through `set`, which does touch. So chunk(i) is never pristine here, and it always appears in snapshots with its real bytes.
- Scenario: in the sandbox (or any brushes room), painted ice sits on a chunk edge with water across it. Chunk(i) is hashed at a checkpoint, which clears its dirty flag. Then the ice freezes a neighbour and its `aux` drops with no touch. Every client that played through still hashes chunk(i) from the stale cache, so they all agree, until something else touches that chunk.
- A joiner that restores from a snapshot meanwhile calls `mark_chunk` on every chunk it receives, recomputes from the real bytes, and disagrees with the majority. It is resynced from the same snapshot and disagrees again; after three resyncs a minute it is kicked with "out of sync, reload". A desync diagnosis would also point at a chunk whose bytes actually agree.
- Confidence: **verified in code** (the missing touch and the cache mechanics). The observed desync is **suspected**: not run.
- Fix: add `self.touch(i)`. Add a generic invariant test: `state_hash()` equals the hash after marking every chunk dirty, run across the sleep and perf-equivalence scenarios. That would catch this whole class of bug.

**S2 (low). Restore range-checks counts but not every value** (`sim/src/entities.rs:324-517`)
- Player and projectile coordinates, projectile `age`, unknown material ids and SEED `aux` are taken raw.
- In release wasm these only wrap. In a native debug build they could overflow-panic (`q.age += 1`, `spells.rs:354`; `aux + 1`, `grid.rs:1191`), so debug tests and release could differ on a hostile snapshot.
- Combined with H1, a hostile snapshot is a real input.
- Fix: reject out-of-world positions, `age` past its maximum lifetime, and unknown `mat` ids.

**S3 (low/medium, efficiency). Memory and join latency**
- `Grid::new` allocates `island_stamp` and `island_anchor` as two `w*h` u32 arrays, about 25 MB at L (`grid.rs:47-145`), for a flood capped at a few thousand cells per tick.
- `gen.rs:2375` `box_reach_to` rebuilds a 12.6 MB prefix-sum table on every call (per site, per lava-lake attempt, per hall fallback). That is world-generation time, which a joiner waits for when the base cache misses.
- On a 256 MB server the verify worker holds one world of each, so this matters there too.

**S4 (low). Hot path and per-tick allocations**
- `touch` does two divisions by a runtime divisor and is called twice per swap. Widths are always powers of two, so shifts would do (`grid.rs:167`).
- `stepping_set` and `refresh_active` each build Vecs and each run twice per tick.
- `set_active_around` is O(chunks x players).
- The `fall_one` blocker scan runs per island cell (`grid.rs:354`).

**S5 (low). Runtime salts 260-267 reuse the generator's salt values** (`sim/src/rng.rs:128-148`). Harmless today (generation uses tick 0), but nothing enforces uniqueness. A const uniqueness test would pin it.

The worker checked these and found them sound: chunk-sleep completeness per material rule, woken/active bookkeeping on restore, falling-island bounds and their snapshot validation, no `usize` in hashed or snapshotted state, enemy-id uniqueness (summon ids only grow), i64 where products grow, and input work caps. I did not re-verify these one by one. The parts I read myself (`sim.rs`, `snapshot.rs`, `hash.rs`, the `touch`/`set`/`step_cells` sections of `grid.rs`) agree.

## 3. Improvements (not bugs), in pick-off order

1. **(small) Add the "cached hash equals fully dirtied hash" invariant test** to the sleep and perf-equivalence suites. It turns S1-type bugs from silent into red, and costs about 20 lines.
2. **(small) Add a net test with a spectator or anonymous hash majority, and an old-tick hash spray.** These pin H1 and M1 before they are fixed, and show both red first.
3. **(small) Rate-limit non-input frames per connection** (HASH, PING, LIVE) with a token bucket in `onConnection`. It closes M1-like abuse generally.
4. **(medium) Pull every "vote" into one quorum helper.** Hashes, claims and the snapshot source should share one eligibility rule (registered player, counted per visitor) instead of three code paths (`onHash`/`tryResolve`, `vote`/`eligibleAt`, `requestSnapshot`). That fixes H1 structurally and keeps the next voted thing from regressing.
5. **(medium) Give the sim a deterministic per-tick input-work budget** that every input kind charges (paint area, dig box, spell boxes), alongside the existing per-input caps. It fixes H2 and holds for future input kinds.
6. **(medium) Export layout facts from the wasm** (`PLAYER_BYTES`, header size, enemy max hp, an `active_players` view) and read them in TypeScript, instead of hand mirrors in `server/world.ts:1497` and `client/worker.ts:225`/`client/hover.ts:7`. Removes a class of silent drift.
7. **(medium) Split the big files along the seams they already have.**
   - `server/main.ts` (1642 lines): the HTTP routes, room lifecycle, the WS message handler and the timers are separate modules waiting to happen.
   - `server/world.ts` (1555 lines): claims, chunk diagnosis and snapshots each work as a class or module with a narrow interface to World.
   - `client/worker.ts` (1340 lines) and `client/room.ts` (1556 lines): over a hundred module-level `let`s; network, avatar, FX/HUD and frame loop can split.
   - `sim/src/grid.rs` (2148 lines): per-material rules (~800 lines) and islands become their own modules.
   - `sim/src/gen.rs` (2895 lines): splits by generation phase.
8. **(small) Deduplicate in `enemy.rs`:** the "nearest target" loop appears six times and the phase-from-hp computation twice. Compute the hitbox `Box5` list once per tick instead of three times.
9. **(medium) Batch and stream the catch-up.** Send log ticks as one framed blob, or spread them over timer passes. This fixes M2 and cuts per-frame overhead for long logs. Store the in-memory log as one growable buffer with an offset table rather than one `Uint8Array` per tick (L6).
10. **(small) Reuse scratch Vecs** on Sim/Grid (`stepping_set` once per tick, the `refresh_active` centres, `fall_step` keep), and use shifts in `touch`.
11. **(medium) Shrink resident memory:** replace the two `w*h` u32 island stamp arrays with a touched-list reset, and reuse the `box_reach_to` scratch in `gen.rs`. Worth about 25-40 MB per L world, on a 256 MB machine.
12. **(small) Lower the server timer.** It runs at 4 ms (`main.ts:73`) for a 60 Hz clock and sweeps every world on each pass. 8 ms would halve idle cost with no change to tick timing (the clock closes by elapsed time).
13. **(small) Cache static files and the rendered README in memory at boot** (L7).
14. **(small) Enforce `mode` and config agreement in `createRoom`** (L3), and enforce `maxPlayers` at HELLO (M3).

## 4. What looks good

- **The wasm ABI is careful.** `lib.rs` caches the bytes `snapshot_size` builds, so `snapshot_write` can never write more than was sized. Every export clears that cache. `restore` keeps the old sim on failure and reuses the generated base.
- **Snapshot restore treats input as hostile.** `snapshot.rs:55-171` checks lengths without wrapping on wasm32, requires chunk indices in increasing order, requires zero padding bits, puts falling seeds on structural cells, and rejects heals and lobby ticks from the future. `entities::decode` uses u64 arithmetic for counts.
- **Inputs are decoded strictly.** `input.rs` checks exact lengths and rejects unknown kinds. The paint flag bit is masked, Pos is clamped to the world, and a stale `life` is ignored.
- **The server never steps the sim.** Verification runs in a worker thread with a timeout that kills a hung worker, and "unavailable" is kept apart from "refused" (`verify.ts`), so a slow machine never resets a world.
- **Death and event claims are well designed:** one vote per registered visitor, an eligibility test, conflict handling, bounded FIFOs and a per-connection rate.
- **Tick-clock semantics are clean** (`clock.ts`): closes are contiguous, pause and resume re-base, and the u16 input count is guarded at both the cap and the encoder.
- **Security edges are covered:** origin checks on the WS upgrade and POSTs, body-size caps, `decodeURIComponent` guarded, static paths kept inside the client directory, constant-time admin compare, IP tags instead of IPs, rate-limited logging.
- **The tests are broad:** 50 Rust integration tests, about 60 net tests and a determinism suite covering four engines.

## 5. Spend and coverage

- Weekly spend read at the start (B0): $262.11. At the last reading: $279.48. Total for this review is about **$17.4**, under the $25 cap and the $20 dispatch cap.
- **Worker 1** (Sonnet, sim core: `grid.rs`, `entities.rs`, `enemy.rs`, `spells.rs`, a skim of `gen.rs`): about $4-5. The proxy reports spend for the whole session, so this is estimated from its 200 k tokens; it ran alongside my own reading. Its findings are in `/tmp/code-review/worker1-sim.md`.
- **Reviewer (Opus, me):** about $12. I read `sim/src/lib.rs`, `sim.rs`, `snapshot.rs`, `input.rs`, `config.rs`, `hash.rs`, parts of `grid.rs`, `server/world.ts` (all of it), `server/main.ts` (the WS path, HTTP routes, room lifecycle), `clock.ts`, `verify*.ts`, `log.ts`, the relevant parts of `db.ts`/`rooms.ts`/`dashboard.ts`/`stats.ts`, `shared/protocol.ts`, `sim.ts`, `avatar.ts`, `room.ts`, `client/lockstep.ts`, and the network, frame and message parts of `client/worker.ts` and `render.ts`. Also the Dockerfile, `fly.toml` and CI.
- Only one worker was dispatched. A second (client) worker would have pushed past the $20 dispatch line, given what the first cost.

**Not covered, or only skimmed:**
- `client/room.ts` (DOM/UI, 1556 lines): only the worker setup and the message switch. Listener and interval leaks are not assessed: the page never tears down, because navigation is a full page load, so leaks are unlikely to matter.
- `client/fx.ts`, `music.ts`, `sfx.ts`, `ambient.ts`, `menu/*`, `avatar.ts` (the controller's physics against the server's Pos bound was not traced in full).
- `sim/src/gen.rs` was only skimmed, by the worker. `spells.rs`/`enemy.rs` were read by the worker, not by me.
- `server/achievements.ts`, `dashboard.ts` page rendering (HTML escaping of player names on the admin pages was **not verified**), `db.ts` migrations.
- The test suites were sampled for what exists, not read for what they assert. Nothing was run, so every performance figure is arithmetic, not measured.
- `deprecated/` was ignored (the runtime image does not copy it).

---
**Session model's check (8 Nov), against `multa` in code:**
- **S1 confirmed.** `update_ice` (`sim/src/grid.rs` ~973-978) decrements the ice cell's own `aux` directly; only the
  neighbour's write goes through `set`, so across a chunk edge the ice cell's chunk is never marked dirty and its
  cached chunk hash misses the change. A one-line `self.touch(i)` fixes it; the suggested invariant test (cached hash
  equals the hash with every chunk dirty) would catch the whole class.
- **H1 core confirmed.** `onHash` (`server/world.ts` ~978) stores votes keyed by `memberId` (one per socket) with no
  `playerId` check, while claims count one vote per registered visitor. Whether a spectator can be fully anonymous was
  not traced here; the reviewer's other steps remain as it labelled them.
- The rest is as the reviewer labelled it (verified-in-code by the reviewer or its worker, or suspected); nothing was
  reproduced.

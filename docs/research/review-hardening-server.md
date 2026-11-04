# Hardening review: server, shared, tests, scripts (range 3110766..0099809)

Scope: the diff for `server shared tests scripts` (15 files, +254/-17), plus the claim path (`onClaim`, `onKillClaim`, `onRoundStartClaim`, `onRoundEndClaim`, `admitClaim`, `vote`) and room-create/HELLO round handling in `server/main.ts` and `server/world.ts`. Read only; nothing run. Budget was small, so `world.ts` was read around the claim code rather than top to bottom.

No MUST-FIX findings.

## F1 SHOULD-FIX: paint stats count materials the sim refuses
- `server/main.ts:1247-1248` and `:1257-1258` call `counts.paint(materialKey(payload[0]))` and `playerStats.bump(paintStat(payload[0]))` before the sim sees the input. `payload[0]` is any byte. `MATERIAL_NAMES` now includes 21 Pebbles (`shared/names.ts`), which the sim marks unpaintable (`sim/src/grid.rs:1738`), as it does Bedrock/Stem/Flower.
- Scenario: a client sends Paint with material 21 (or 0..255 junk) in a loop. The sim drops it, but the server credits `paints_pebbles` or `paints_mat200`. That inflates stats and achievements, and gives each player up to 256 distinct stat keys.
- Impact: wrong stats and a bounded key-space leak. It is not a desync, because the server only stamps and the sim rejects.
- Fix: reject `payload[0] > COAL` (or the sim's paintable set, mirrored in `shared/`) with `badInput` before counting. Test: a Paint of material 21 leaves `paints_pebbles` unset.
- Confidence: medium. I did not check whether `PAINT_PAYLOAD_LEN` validation covers the material byte elsewhere, or whether the stats table caps keys.

## F2 NOTE: Creative-room refusal leaves the old loader path alone
- `server/rooms.ts:116-117`: Creative is refused with `mode_retired`. `ROOM_MODES` still includes it, so old rows load. Correct.
- `server/main.ts:~715` maps every failure to 400 and logs `room.create_rejected` through `log.limited` keyed by ipTag, so there is no flood risk. The new reason string is returned as `error` JSON. Whether the client's room-create UI handles `mode_retired` was not checked (client reviewer's area).
- The new test (`tests/net/rooms.test.ts`) says "over HTTP too" but only calls `RoomsStore.createRoom`. The HTTP path is untested. Impact is low. Fix: add one `fetch` POST in a route test asserting 400 and `{error:"mode_retired"}`.

## F3 NOTE: `claims-live` bomb test depends on a native measurement
- `tests/net/claims-live.test.ts`: the `LOB` angle and `GAP = 34` were measured on seed 20261014 (D-179). The test needs open ground for `GAP + 6` cells, which `bombPickup()` checks. The comment records that 4 to 20 degrees works and 8 is mid-band, so the margin is good.
- It still uses real-clock `sleep(500)` and `sleep(700)` loops with 12 tries. Under load it is slower, not wrong, because the loop retries until a `claim.death` is logged. Acceptable. Any sim change that moves bomb physics will silently break it. That is the right failure, but not obvious from the message.

## F4 NOTE: `hidden-tab.test.ts` is partly self-referential
- It asserts `frames < 50` and `simTick - start > CATCHUP_THRESHOLD`, which are meaningful because they would fail with the old 8-ticks-a-frame behaviour. However, it uses a fake clock `() => (t += 0.01)` that advances per call. The budget check is therefore a function of how many times `driveFrame` calls the clock, not real time. It exercises the catch-up logic, not real frame cost. The waiting `waitFor(buffered > threshold + 60, 10 s)` depends on tick rate from a real server, so it is slow but bounded.
- It imports `client/lockstep.ts` from `tests/`. That is allowed, since the rule only bans `server/` and `shared/` importing `client/`.

## Read and found sound
- `server/dashboard.ts`, `server/main.ts` (README page): title-only changes; the build string is still passed through `esc`.
- `server/db.ts`: `SNAPSHOT_FORMAT_VERSION = 11` matches `sim/src/snapshot.rs` `FORMAT_VERSION: u16 = 11`.
- `shared/sim.ts`: `EV_HEAL = 16` and `ENT_HEAL = 8` do not collide with the neighbouring constants in the diff context. (Collision with other values elsewhere in the file was not checked.)
- `shared/names.ts`: `MATERIAL_NAMES` and `MATERIAL_CLASS` both gain entry 21, so the arrays stay aligned.
- Claim handling: every claim kind goes through `admitClaim` (registered voter, rate window `CLAIMS_PER_WINDOW`, tick within `CLAIM_WINDOW_TICKS` and after `minHashTick`). Rejections use `elog.limited` keyed per connection. Open tallies are capped by `MAX_OPEN_CLAIMS`. Kill claims are bounds-checked (`kind < NUM_ENEMY_KINDS`, x/y within the world). Round-end claims require known player ids and a survivor for a win. Nothing in the range loosens these.
- Logging: the new and changed code has no `console.*`, no raw IP (`ipTag` is used) and no token. Victim and killer `name#id` appear only in `log.event` (log and admin side), not in the toasts.
- Imports: no `client/` import in the changed `server/` or `shared/` files.
- Round handling at HELLO (`main.ts:1104`): a finished round refuses non-spectators. Unchanged in this range.

## Architectural decisions for review
None.

## Session model's resolution (4 Nov)

- **F1 (junk paint stat keys): fixed.** `isPaintable` in `shared/names.ts` mirrors `sim/src/materials.rs`
  `paintable`, and both paint paths in `server/main.ts` count stats only for it. A test in
  `tests/net/stats.test.ts` was red without the guard (six junk keys).
- **F2 (Creative refusal tested below HTTP): note.** Logged in FUTURE.md's test-gaps line if it is ever touched.
- **F3, F4: no change.**

# Cold review of the `layouts` change (review M4)

Scope: /tmp/layouts-diff.patch against /tmp/wt-layouts, read only. Nothing was run.

## Findings

No High findings, and none that make the change incorrect.

### Medium

None.

### Low

1. **server/main.ts:311 (comment drift: server/world.ts:1-3, invariant 11 wording). Confidence: verified.**
   world.ts's header still says "the only sim use is SnapshotVerifier.restore". main.ts now also instantiates the wasm once
   (`snapshotLayout`). verify.ts's comment was updated to say so, but world.ts's was not. Invariant 11 itself is intact:
   the instance never calls step or pushInput, and the module has no imports.
   Fix: one clause in the world.ts header.

2. **server/world.ts `snapshotPlayers` (~line 595-606), behaviour change worth knowing. Confidence: verified.**
   Before, a world with no `layout` or with an unreadable snapshot was silent. Now each cold load logs `snapshot.unreadable`
   at "error", at most once a minute per room. That is the intent. The orphan-Leave consequence (the players stay active
   until they rejoin) is unchanged and documented in the doc comment. No fix needed. It is worth a one-line mention in the
   dashboard or ops docs if "error" level triggers alerts.

3. **tests/net/spells-table.test.ts:27. Confidence: verified.**
   The "only copy" guard is `/ENEMY_MAX_HP\s*(:[^=]*)?=/`.
   - It also matches `ENEMY_MAX_HP === x` and `ENEMY_MAX_HP == x`, because `=` matches the first `=` of the operator.
     That is not an issue today.
   - It does not catch a re-copied table under another name (`const MAX_HP = [20, 30, ...]`). The guard is weaker than the
     test title claims.
   Fix: also assert no client file contains the literal `[20, 30, 60, 90, 800` sequence. Optional.

### Nit

4. **tests/net/snapshot-layout.test.ts:`load(data, snapshotLayout)`.** The parameter shadows the imported `snapshotLayout`
   function. It is legal, and the function is not needed inside `load`. Rename to `lay`. Confidence: verified.

5. **tests/net/snapshot-layout.test.ts, client-ceiling test.** It uses a stand-in sim (width, height, tick, restore), so it
   proves the ceiling arithmetic and not that a real `init` yields that width and height. That is fine for what it claims.
   The real path is covered by the existing net tests that go through `Lockstep` with a real sim.
   Confidence: verified.

6. **Missing parser tests.** There is no test for a truncated entity section (`entityLen` larger than the buffer), a huge
   `n` (the "run past" branch), or a sandbox snapshot. Both throw branches are only exercised indirectly, through the
   corrupt-bytes and format-mismatch cases. Fix: add one crafted-buffer test each (cheap, no sim needed). Confidence: verified.

## Checked and fine

- **Header size.** `HEADER = CFG_AT + CONFIG_BYTES + 4 + 2 + 2`, where `CFG_AT = 4+2+32+8 = 46` and `CONFIG_BYTES = 16`. That
  gives 70, equal to the old hard-coded constant, and the test asserts `4+2+32+8+16+4+2+2`.
- **Layout of `write`.** It writes `HEADER` bytes, then the entity length u32 at offset H, then the entity bytes. The entity
  bytes begin with the player count u32 at H+4, then the records at H+8.
  `entities::encode` writes `players.len()` and then `p.write`. `Player::write` writes id u32, then `active` u8, so
  `active` is at +4. The parser's `o = H + 8`, `raw[o+4] === 1` and `getUint32(o)` match.
- **Record size.** `PLAYER_BYTES` is the real constant, and the test checks the parser against sim-reported actives.
- **Bounds.**
  - `raw.length < H + 8` is rejected first, so both header reads are in range.
  - `H + 4 + entityLen > raw.length` is checked.
  - `4 + n * recordBytes > entityLen`. For n up to 2^32-1 and a record of about 100 bytes, the product is about 4e11, which
    is exact in a JS double. There is no overflow, and the loop is bounded by `entityLen`.
- **Sandbox.** `snapshotPlayers` is called only when `kind === WORLD_GAME && snap`. A sandbox snapshot (`entityLen` 0) is
  never parsed. If it were, `4 + n*rec > 0` would throw (reported, not misread).
- **`maxSnapshotRawForDims`.** It computes `(w/64)*(h/64)*8194 + 128K` and rounds up to MiB, which is exactly the old
  `chunkCountFor * ...`. SIZE_DIMS are all multiples of 64 (512x512, 1024x768, 2048x1536), so the division is exact. The
  results are 1, 2 and 7 MiB, and the existing game.test pins 1 MiB and more than 6.4 MB.
  `maxSnapshotRawFor` is now defined through it, so server and client cannot drift.
- **Client behaviour change.** The old code picked 7 MiB for any area above 512x512, so a 1024x768 room got 7 MiB. It now
  gets 2 MiB, which matches the server's upload check for that room, so it is tighter and consistent. No room in the repo
  uses size 1 today.
- **Sim size at `loadSnapshot`.** The only `new Lockstep` in the client is `beginReplay` in client/worker.ts:403, immediately
  after `sim.init(seed, cfg)`, so width and height are the room's. A resync reuses the same `ls` and sim, and `restore`
  rejects a size mismatch (sim/src/snapshot.rs). Soak scripts (tests/soak/capacity*.ts) construct `Lockstep` with the
  same signature, unchanged. The slow-frames and review-m4b tests are unaffected (`loadSnapshot` is not called with a fake sim).
- **Wasm at server start.**
  - The only `startServer({ wasmPath })` in tests is dashboard.test.ts, with the real `WASM`.
  - `sim-v1-deployed.wasm` is used only in determinism/compat and in the new "refused" test, never to start a server.
  - `buildHash` already reads the same file, so the wasm must exist at startup.
  - Instantiation calls no `init` or `step`, and the module has zero imports, so invariants 4 and 11 hold. I did not
    measure the "about 1 MB" claim.
- **Logging.**
  - `snapshot.unreadable` is added to the EVENT_NAMES catalogue.
  - It goes through `elog.limited` with a per-world key and a 60 s window.
  - Its fields are world, tick, bytes and a truncated error message: no token and no IP.
  - It is "error" level, reasonable because it means a stored snapshot cannot be read.
- **ABI and invariants.** The new exports return u32 constants only (invariant 2). There is no float and no host import.
  `snapshot::HEADER` was made `pub` only.
- **ENEMY_MAX_HP.** The shared table matches tuning.rs: `ENEMY_STATS` hp 20/30/60/90/800/40/30/600, `BOSS_HP` 800 and
  `COLOSSUS_HP` 600. Only the client files worker.ts and hover.ts used it, and both now import it. The test asserts the
  length equals `NUM_ENEMY_KINDS`, so it is not vacuous.
- **Callers.** `activePlayersIn` has a single caller (world.ts `snapshotPlayers`) plus the tests, all updated to the new
  signature. `MAX_SNAPSHOT_RAW_GAME` is no longer imported in world.ts but is still exported and used by tests.
- **Tests not vacuous.**
  - The entity-layout test checks the parser against sim-reported active players (3, 27, 81).
  - The cold-start test checks the orphan-leave count of 2, expecting 9 to be inactive.
  - The corrupt, format-mismatch and no-layout cases each assert `snapshot.unreadable` with the expected field or message.
  - The ceiling test checks both sides of the cap (cap-1 restores, cap throws "too large").

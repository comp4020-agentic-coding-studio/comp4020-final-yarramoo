# Review: chunk-level desync diagnosis

Diff `a5b3fe9..ab39fbe`. Reviewer: independent Sonnet, cold read. Source untouched.

## Findings

### S (must fix): none

### N (should fix)

**N1. A `C_CHUNK_HASHES` frame is fully decoded before it is known to be asked for, and unsolicited ones are never throttled or closed.**
`server/main.ts:644` runs `decodeClient` on every frame before the per-type size check at `:737`. In `shared/protocol.ts` (`case C_CHUNK_HASHES`) the decoder allocates a `BigUint64Array(n)` and makes `n` `getBigUint64` calls (BigInt allocations), with `n` up to 4096. Only afterwards does `frameCap` apply (6,151 bytes in the game world) and only afterwards does `World.onChunkHashes` drop the frame as unsolicited.
Scenario: a joined client sends 6 KB `C_CHUNK_HASHES` frames in a tight loop. Each costs 768 BigInt allocations on the single server thread. Nothing closes the socket, because the unsolicited counter only logs, once per 10 s per connection. The input rate limit (`MAX_INPUTS_PER_SEC`) applies to `input` frames only. A sandbox frame of a world with a game-sized `n` (up to 32 KB, rejected after decode) costs 4096 allocations once, then the socket closes, so that case is fine.
Not covered by the worker's claim: "ignored without work" is true after decode, not before.
Fix: either (a) in main.ts, peek `buf[0] === 0x08` before `decodeClient` and check the world's `frameCap` and "is a diagnosis open for me" (needs the tick at bytes 1-4) before decoding the array; or (b) count unsolicited frames per connection and close with 1008 past a small budget (for example 8 per 10 s). Option (a) is cheap and keeps the invariant that unasked frames cost nothing.

### M (minor)

**M1. Tie-break and liar behaviour is sane but untested.** `maybeFinish` (`server/world.ts` ~364-376) groups agreeing replies by joined string and picks the biggest group, tie to the lowest `seq`. A single liar among agreeing members can win only on a 1-1 tie where it is the longer-connected one; it then yields a misleading (but harmless, diagnostic-only) chunk list. Agreeing members that disagree with each other are not flagged. Suggest noting `groups.size > 1` in the incident (for example `refDisagree: true`), which would itself be a useful determinism signal.

**M2. Per-chunk key building.** `Array.from(arr, x => x.toString(36)).join(",")` is up to 768 BigInt-to-string conversions for each of up to 16 members, once per diagnosis, capped at 6 per 60 s. Acceptable. A cheaper key is a plain 64-bit fold of the array.

**M3. A leaving member stalls `maybeFinish` only until the sweep.** `onChunkHashes` calls `maybeFinish`, which checks `this.members.has(id)`, but a leave does not trigger it. Resolution waits for the next `sweepDiagnoses` tick, so this is fine (bounded by 3 s).

## Checked and found fine

- **Recovery is not delayed.** In `onHashesDiverged` (around `world.ts:862-885`) the incident row is inserted, `startDiagnosis` sends the requests synchronously, then `resync(m)` runs in the same run. Nothing awaits a reply. `maybeFinish` runs from the tick sweep and from replies only, so it never blocks a later checkpoint, desync or snapshot request. `diagnoses.clear()` on reset (`world.ts:773`) is correct.
- **Order matters and is right.** The request is queued before the RESYNC on the same ordered socket, so the client answers from its ring before the resync empties it.
- **Count check.** A reply whose length differs from `chunkCountFor(kind)` is stored as `null` (unavailable); it cannot reach the diff, so `ref.arr[i]` is never out of range.
- **Memory bounds.** At most 4 open diagnoses, at most 24 asked (8 divergent + up to 16 total), one reply per member (`replies.has` rejects duplicates), `list` capped at 64, and `byPlayer` only holds divergent members. No unbounded growth from replies. Incident rows grow as before (one per divergence).
- **Trust.** The divergent client only influences its own `byPlayer` entry and the `list` of indices (bounded by the world's chunk count). It cannot choose the reference, which comes from agreeing members only. A misleading incident is the worst case.
- **Invariant 9.** The client only calls `sim.chunkHashes()` (read-only) and stores the result in `Lockstep.chunkRing`. Nothing from it reaches `pushInput` or sim state. The `Lockstep` change records after `stateHash`, which is the same call that refreshed the hashes.
- **Socket cap.** `MAX_SOCKET_PAYLOAD` is unchanged (`new WebSocketServer({ maxPayload: MAX_SOCKET_PAYLOAD })`); the chunk-hashes cap is applied one layer up and is smaller than the upload cap.
- **Frame cap by world kind** (`maxChunkHashesFrameFor`: 7+8*64 and 7+8*768) is correct, and a pre-join frame of any type other than hello is rejected.
- **DB.** No schema change; `details` is a JSON blob. `recordIncident` now returns the row id; `updateIncident` updates by id; `recentIncidents` is a read. `MIGRATIONS` is untouched. Dashboard rows tolerate old rows with `chunks: null`.
- **`localPaint`.** It lives only in `tests/net/helpers.ts` and is used only by `tests/net/chunk-diag.test.ts`. A grep of `shared`, `client` and `server` finds none. No production path applies a local-only paint.
- **Tests.** `pnpm vitest run --config vitest.net.config.ts tests/net/chunk-diag.test.ts`, 3 runs: 16/16 passed each time (7.6 s each). No retry-dependence seen. I did not mutation-test each rule.

`git status` after review: only the pre-existing `.gitignore`, `README.md` and untracked `tests/net/chunk-grid.test.ts`, plus this file.

## Resolution (fixed by the orchestrating session)

- **N1 fixed.** A `C_CHUNK_HASHES` frame is now checked from its tag byte and tick, before decoding: over the world's cap closes with 1009, and one this connection does not owe (`World.wantsChunkHashes`) is counted, logged once, and never decoded. After `MAX_UNASKED_CHUNK_FRAMES` (3) the socket is closed with 1008; an honest client only answers requests, and the allowance absorbs a reply that crosses a diagnosis timeout. The old test "shrugs off a flood of valid-size ones" asserted exactly the behaviour the review flagged and was replaced; the new flood test timed out (socket never closed) without the close rule. The honest reply path still decodes and records: the forced-desync test still names chunk 9.
- **Also added:** `tests/net/chunk-grid.test.ts` pins the protocol's hard-coded chunk grid against the real wasm (`chunkHashes().length`, `width()`, `height()`); it fails on a wrong grid ("expected 768 to be 736").
- **M1–M3** left: M1 (a liar can win a 1-1 tie for the reference array) only mislabels a diagnostic, never state; M2 is bounded at 6 diagnoses a minute; M3 is covered by the 3 s sweep.

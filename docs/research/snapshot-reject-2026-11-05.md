# Snapshot rejects in the 5 Nov ship check: not reproduced (investigation, no fix)

Question: why did every periodic upload in the Docker ship check (size M Survival, two players) end in
`snapshot.rejected`, "does not decompress, or the sim refused to restore it" (verify worker returned ok:false)?

## What was run, all restoring cleanly

1. Native Rust (`snapshot::write` then `snapshot::restore`), seed 7, `RoomConfig::survival()` with size 1 (M), two
   joined players, both Ready, countdown passed, Pos inputs digging down plus a cast of every spell id every 30 ticks.
   Restore checked every 100 ticks for 4000 ticks: always Ok. Second version: players teleport next to the nearest
   enemy every 8 ticks so enemies are hit, heals and bolts exist; restore checked every 25 ticks for 6000 ticks: always
   Ok (220 s). Script kept at `/tmp/snapcheck/snapshot_play.rs` (not committed).
2. Through the real wasm and TS path (`/tmp/snapcheck/play.ts`, `play2.ts`): same play for 3000 ticks, snapshot,
   `compressSnapshot`, `decompressSnapshot(maxSnapshotRawFor(cfg))`, restore into a fresh sim: hash equal at every check.
   Also through `SnapshotVerifier` (the worker, `server/verify.ts`): `kind: "ok"` every time, and again when the same
   job is sent three times in a row (first job about 2.5 s while the worker loads and regenerates, later ones 30-160 ms).
3. Inside the shipped image `simulta-shipcheck:5nov` with `--memory 256m`: a Survival snapshot (two players joined,
   600 ticks, compressed on the host) verified `ok` three times through the image's own `server/verify.ts` and wasm.

So: the format-12 write and restore agree on every state reachable in this play, the worker and the image's wasm accept
a good snapshot, and no `return Err(())` fired. The suspects in the brief (round-tail validation, enemy phase and summons,
heal `expires_at`, player fields after death) were not hit.

## What is therefore still open

The snapshot in the ship check was produced by a browser client, not by these probes. Differences not yet exercised:
- the bytes a real browser uploads (client `worker.ts` line 319, `encodeSnapshotUpload`; server decode takes `b.slice(13)`);
  check that the uploaded frame is not truncated or reordered by the 4 MiB / per-frame caps, and log the verify error
  class (decompress throw versus restore code) in `verify-worker.ts`, which today swallows both into one `ok:false`;
- a client sim that restored from a server snapshot or caught up (its `base` cache and woken bitset path) rather than
  one that stepped from tick 0;
- a client in a real round with a boss, 8+ minutes in (the ship check ran about 5 minutes, but players only dug).
- the local `sim.wasm` mtime (4 Nov 18:52) predates the format-12 commit time (19:22); cargo reports it fresh, so it is
  probably the format-12 build, but the image's wasm was the one verified in step 3.

## Suggested next step (cheap, decisive)

Make `verify-worker.ts` post which stage failed (`decompress` or `restore`, plus the `restore` return code and the
error message) and have `snapshot.rejected` log it. Rerun the Docker two-browser check once; the field names the cause.
Alternatively save the rejected `u.data` to `/tmp` when `SIMULTA_DEBUG_SNAPSHOTS` is set and feed it to the native
`restore` to see which check fires.

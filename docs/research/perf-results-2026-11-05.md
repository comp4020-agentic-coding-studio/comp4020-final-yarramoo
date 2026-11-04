# Sim performance results, 5 Nov 2026

Branch `perf` (from `multa` at `c9552f8`), worktree `/tmp/wt-perf`. Follows the read-only audit
`perf-audit-2026-11-05.md`. Small isolated tests and micro-benchmarks only; no full-game runs.

**Equivalence rule.** Every change must leave every state hash identical. Evidence per change is
`sim/tests/perf_equiv.rs`: a trace recorded from the unmodified code (fixture `sim/tests/fixtures/perf-trace.txt`)
of the state hash and an independent hash of the raw `mat`/`aux` planes every 10 ticks, plus the final snapshot
bytes' hash, for nine scenarios. Every change must reproduce it line for line, and `cargo test --release`
(determinism, golden, sleep, wake) and wasm clippy must be green before its commit.

**Measurement caveat.** The machine was at load average 500-580 throughout (other agents). Wall-clock numbers are
the minimum over repeated runs (load only adds time, so the minimum is the least contaminated estimate), and
where possible a deterministic work count is given instead.

## Summary

| # | Optimisation | Equivalence | Measured effect | Ready to merge |
|---|---|---|---|---|
| 1 | `codegen-units = 1` in `[profile.release]` | perf_equiv trace unchanged; full `cargo test --release` and wasm clippy green; wasm imports 0 | wasm 216232 -> 210754 bytes (-2.5%). Speed: no measurable change (sand+water 2.70 -> 2.80 ms/tick, sparse 0.658 -> 0.637; within noise) | yes |
| 2 | `Grid::touch` and `chunk_of` use shifts and masks (`CHUNK_SHIFT`, compile-time asserted to equal `CHUNK`); also derives cx, cy from x, y instead of dividing c | perf_equiv unchanged; cargo test and clippy green | touch micro 10.87 -> 10.54 ns/call (-3%); sand+water 2.80 -> 2.52 ms/tick (about -10%, partly noise); sparse 0.637 -> 0.630 | yes |
| 3 | `snapshot_size` keeps the bytes it builds; `snapshot_write` takes them (cache cleared by every other export, `init` and `restore`) | perf_equiv unchanged (its snapshot hash is of `snapshot::write`, which is untouched); cargo test and clippy green; `pnpm test:determinism` 53/53 on the final tree | halves the snapshot work per request in the wasm path: native size+write micro is 0.012 -> 0.010 ms (L), but that micro calls `snapshot::write` once, so it does not exercise the export path; the saving (one `write` fewer per request) is by construction, not measured. Costs one snapshot-sized buffer held between the two calls | yes, but see decisions |

## Per optimisation

Baseline (`7b3a2e5` plus fixture): sand+water 512 2.697 ms/tick, sparse 512 0.658, touch 10.85 ns, snapshot L 0.012 ms.
All figures are the minimum of 5 runs of `perf_micro` (load fell from ~500 to under 10 during this session, so later
runs are not systematically slower). Differences under about 5% are noise. The fixture was recorded once, from the
unmodified code, and never regenerated.

1. wasm size 216232 -> 210754 bytes, imports 0. `wasm-opt` is not installed here (`which wasm-opt` empty), so
   `wasm-opt -O3` was not measured. If added later: run it on `sim.wasm` as a post-build step, then re-check
   `WebAssembly.Module.imports(...)` is empty and run `pnpm test:determinism`. Not added to package.json or Dockerfile.
2. Behaviour identical by construction (`x >> 6` equals `x / 64` and `x & 63` equals `x % 64` for unsigned values;
   `cx = x >> 6` equals `c % cw`) and by the trace.
3. Final wasm after all three: 211716 bytes (the cache adds ~1 KB), imports 0.

## More opportunities found

Next (not attempted this session): audit item 4 (`update_cell` ordering) and item 5 (the `moved.fill` stamp).

## Architectural decisions for review

- Snapshot cache: a `static` `Option<Vec<u8>>` in `sim/src/lib.rs`, cleared by `with` (so by every export that touches
  the sim), `init` and `restore`. Alternative: have `snapshot_write` re-run `write` (status quo) or change the ABI so
  the export writes once and returns length (needs a client/server change, so avoided). Cost later: any new export
  that mutates the sim without going through `with` must clear `SNAP`. A caller that calls `snapshot_write` without
  `snapshot_size` still works (falls back to writing).

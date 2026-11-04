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
| (filled in as each lands) | | | | |

## Per optimisation

## More opportunities found

## Architectural decisions for review

# Hardening review: sim/ (range 3110766..0099809, checkout /tmp/wt-review)

Read-only review: no builds or tests run. Findings are from reading the diff and the surrounding code.

## F1 SHOULD-FIX: `refresh_active` now runs twice a tick, O(chunks x active players) each
- `sim/src/sim.rs:199` (new) and `:204`; `grid.rs:185` `set_active_around` loops every chunk against every centre.
- A room with many active players (MAX_PLAYERS is 1024) pays the double cost on every tick, and on the catch-up
  fast-forward path that is repeated tens of thousands of times. Not a desync, a constant factor of 2 on a cost that
  was already player-count dependent.
- Fix: skip the first call when no `Pos`, `Join` or `Leave` input is queued and no cell write precedes it, or cache
  the centres and recompute only when a player moved chunk. Red test: a timing check is awkward, so assert equality
  of `active` between the two calls on a no-input tick and skip the first then.
- confidence: medium (did not measure; the wake load example uses one player).

## F2 SHOULD-FIX: a restored snapshot may carry `woken` bits the running sim could never hold
- `sim/src/snapshot.rs` (woken read, new tail). Only padding bits are checked. A hostile or corrupt snapshot can set
  `woken` on any chunk, including in a sandbox or a world whose chunks are all active, where a running sim always
  has all false (`set_active_around` and `set_all_active` clear them).
- Effect: `state_hash` appends the bitset when any bit is set (`hash.rs`), so that client's hash differs from every
  peer until its first `step` clears the bits. It resyncs itself on the next tick, so this is a transient hash
  mismatch (a spurious desync report) and not a lasting desync. A frozen chunk with a forged bit runs until quiet:
  bounded by the grid.
- Fix: after restore, if `!cfg.has_players()` require all bits zero (`Err`), and in game worlds clear bits for
  chunks that are active under `refresh_active`, or reject them. Red test: restore a sandbox snapshot with one bit
  patched and expect `Err`.
- confidence: medium (checked the restore and hash paths; did not check how the server uses a restore hash).

## F3 NOTE: woken chunks holding Acid or generated lava never re-freeze (accepted cost, D-176)
- `grid.rs` `update_cell`: Acid is still unconditionally volatile, and lava's new condition holds while a flammable,
  Coal, Ice or Sand cell touches it. A woken frozen chunk containing either stays running for the whole session.
- Work stays bounded by the grid (chunks x 4096 cells) and the load example measured it, so not a freeze. Mentioned
  only because the active-chunk count can only grow over a long session in a Survival room. Not rechecked.

## F4 NOTE: `drop_heal` on a death inside Lava or Water still drops (open = Empty or gas)
- `sim/src/spells.rs` `drop_heal`: a heal at a liquid cell rises up to 12 cells to open air. In a lake the heal
  can sit under 12 cells of water; it then falls no further (the fall rule needs Empty or gas below) and expires.
  Deterministic and bounded, only a gameplay oddity. Heal cells inside liquid after a later liquid fill also stay put.

## F5 NOTE: heal x,y are not checked against solid ground on restore
- `entities.rs` decode checks bounds, amount and (in snapshot) lifetime only. A heal inside rock is harmless: bounded
  by `MAX_HEALS`, expires within `HEAL_LIFETIME`. Not a bug.

## Read and found sound
- Heal state is in `encode` (hashed) and `decode`, in the same order (count after enemies, heals in spawn order,
  round tail last); the length check fixes the total exactly with `u64` arithmetic, no wrap on wasm32; `MAX_HEALS`
  bounds the allocation; `FORMAT_VERSION` 11 bumped.
- `drop_heal` and `update_heals`: integer only, players iterated in id order, heals in spawn order, remove-while-
  iterating index handled (`i` not advanced after a remove), eviction of index 0 deterministic. The heal drop rng is
  counter-based with a fresh salt (257), and `cx as u32` is non-negative for in-world enemies.
- Heal sleep invisibility: the fall reads only `mat` and writes none, so sleeping cannot change it.
- Woken bitset: written unconditionally in the snapshot, restored with exact length and canonical padding;
  `awake` differing after restore (all true) converges because `update_woken` reads `awake` only after a run, and a
  restored chunk that runs and finds nothing ends with the same bit a skipped chunk had. Review W F1 fix (refresh
  active first in `step`) is present and covers the touch-before-refresh path.
- `touch` and `wake`: neighbour waking is bounds-checked; `woken` stays false when every chunk is active (cleared
  in `set_active_around`, `set_all_active`, `step_cells` and `update_woken`).
- `crumble_islands` anchor stamping: cells in the stack are connected to the anchored flood, so marking them is
  correct; a budget-capped flood errs towards "anchored" (nothing crumbles), the safe side; `island_anchor` is reset
  with the stamp on wrap, is not hashed and not state (empty between ticks).
- Paint: clamping, radius and stroke caps unchanged; the Seed sprinkle draw depends only on cell and tick so
  overlapping stamps agree; `set_unseeded` writes and touches like `set`; paintable range excludes Bedrock, Stem,
  Flower, Pebbles.
- Pebbles: new salt, powder rules shared with Sand, class solid matches `shared/names.ts` (id 21 "solid"), added to
  the dissolvable and dig lists and the spawn ground test.
- Liquid resting rule reads only the 3x3 neighbourhood, so touch's radius suffices; lava's `liquid_can_move` and
  neighbour check make it volatile exactly while it can act.
- Snapshot restore of heals refuses them in rooms without enemies and an immortal `expires_at` by wrapping distance.

## Architectural decisions for review
None. One alternative worth noting for F1/F2: derive `woken` for active chunks from `awake` only at snapshot time
rather than storing active-chunk bits, which would remove the forged-bit class. Rejected by D-176 for good reason
(the bit is real state for frozen chunks), so no change recommended.

## Session model's resolution (4 Nov)

- **F1 (two `refresh_active` calls): kept.** The first call is review W F1's restore fix: it makes `active` the same
  on a restored and a continuous client before inputs write cells. The second gives the region after this tick's
  movement, which `step_cells` has always used. Merging them would change which chunks step on the tick a player
  crosses a chunk edge, which is a behaviour change for a cost (chunks x active players, at most 8) that is small
  next to `step_cells`. Left as is; the double call is commented in `step`.
- **F2 (forged `woken` bits in a sandbox restore): note.** A hostile snapshot gives one client a one-tick hash
  difference, which the server already handles by resyncing it. Snapshots come from the verified majority.
- **F3-F5: accepted** (F3 is D-176's known open risk, measured by brief HR's wake-load run).

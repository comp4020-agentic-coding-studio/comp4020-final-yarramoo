# Review: falling rock v0 (b55f593..9e4901a), independent cold read

Read only; nothing was built or run. Line numbers are in `sim/src/grid.rs` at 9e4901a unless stated.

## F1. Seed queue saturates on a big dig or blast, so real free islands are missed (should-fix)
`set` (l.180) and `seed_neighbours` (l.190-203) queue the structural neighbours of each removed cell at the
moment of removal. `dig` (l.~945) and `carve` remove cells in row-major order. A neighbour that is about to be
removed in the same call is still structural when it is queued, so it becomes a stale seed. The flood skips
it later (`!is_structural`). With `MAX_ISLAND_SEEDS` 32, about the first 8 removed cells fill the queue. The
rest are dropped silently.
Scenario: a player digs a radius-DIG_RADIUS capsule (hundreds of cells) under a small rock slab. The first
32 seeds are the top row of the capsule plus its stale in-row neighbours. The slab sits at the bottom or side
of the hole and is never seeded. It floats and never crumbles, because nothing retries it. Gunpowder blasts
(`carve`) behave the same way. The tests only cut single cells, which is why they pass.
Fix, any one of:
- Seed after the removal loop, not during it (dig/carve collect the boundary, or record a removed-cells
  bounding box and scan its perimeter once).
- Dedupe, and drop the stale seeds by checking `is_structural` again at queue time against a removed-cell mark.
- Queue the removed cell index, cap the queue much higher (for example 1024), and let `ISLAND_WORK_MAX` do the bounding.
Add a test: dig a capsule beside a free slab and assert it crumbles.

## F2. Determinism and D7 (no issue found)
- `crumble_islands` reads only `mat`, `island_stamp` and `island_seeds`. It never reads `awake` or `active`.
- Seeds come only from `Grid::set` calls that go from a structural to a non-structural material. The direct
  `self.mat[..] =` writes in `swap` (l.277, powder/liquid moves) never touch structural cells. Structural
  cells are static solids, and none of them is swapped.
- Every `set` call happens inside the cell update of an awake chunk. A skipped sleeping chunk would
  provably have done nothing, which is the existing D7 contract. Chunk order and in-chunk order are fixed,
  so the seed order is deterministic. The neighbour order (up, left, right, down) is fixed, and so is the
  flood pop order (LIFO stack).
- The `d7_freed_island_sleep_is_invisible` test is real: the island and the player are in the active region. It only
  exercises a cut made by a direct `set` before the step. Nit: it does not cover an acid-driven or
  fire-driven cut. Extend it with an Acid cell touching a joined slab if you want D7 evidence on the
  sim-driven path.

## F3. Hidden state (no issue found)
- `island_seeds` is always cleared at the end of `crumble_islands`. Seeds past the cap or the budget are
  dropped, identically on every client.
- The crumble loop writes `mat`/`aux` directly and does not call `set`, so there is no recursion and no
  re-seeding. Sand is non-structural anyway.
- Nit: seeds queued by `set` calls made outside `step` (tests or restore) would sit until the next tick's
  end. This is harmless. Inputs are applied inside `step`, so they are covered.
- `island_tick` and `island_stamp` are scratch. Different values across clients cannot change results. The u32
  wrap path is handled (fill(0), tick=1).

## F4. Bounded work (no blocker; one nit)
- Visits are capped by `ISLAND_WORK_MAX` per tick. An island is capped at `ISLAND_MAX`, and the
  `limit` is clamped to the remaining budget.
- Buffers are reused. `island_stamp` is allocated once, `w*h` u32 (4 bytes per cell; 1 MB at 512x512).
  The Vecs are cleared, not reallocated, after warm-up.
- The stamp is deliberately not reset between floods in one call. This is correct: every stamped cell belongs to
  a component that was already classified. A budget-truncated flood leaves stack cells stamped but unvisited,
  and they belong to that same component, which is anchored by the rule.
- Nit: after a cell becomes anchored (edge or bedrock) the flood keeps going up to the limit
  (`continue`, not `break`), so an anchored fill wastes up to 400 visits. Breaking at once would save budget
  and let more seeds be examined, which helps F1. It must still stamp nothing wrongly: breaking leaves stamped,
  unvisited cells, which is safe for the same reason.

## F5. Anchored rule and budget (confirmed safe)
Hitting `ISLAND_MAX`, the budget, bedrock or the edge all set `anchored`, so none of them can crumble
anything. A thin-connection overhang that the budget truncates is left alone: the failure mode is "does not
fall", never "falls wrongly". Consequence (should-document, not fix): a free slab of more than 400 cells
(or one examined late in a busy tick) floats forever. A deliberate v0 limit.
Note: 4-connectivity means a rock mass joined to the rest only by a diagonal touch counts as free. Cave
walls from cellular automata often have such diagonal-only joins (nit, and a stability risk, see F6).

## F6. World stability is under-tested (should-fix)
Only seed 1, size 1 with a still player for 600 ticks is tested. A generated world may already contain
4-disconnected rock bits (diagonal-only joins, small stray rock, small ice or coal pockets, the tree
branches that start in the air next to a trunk). Any removal next to such a bit (acid in a generated pool
eating a neighbour, fire burning Wood, lava) seeds a flood that crumbles it on tick 1. That does not
collapse the world, since only free islands under 400 cells fall, but it can visibly erase generated
features (ice caves, coal seams, tree tops) before a player acts.
Fix: add a test across seeds 2-8 and sizes S and M (a loop, no player needed and also with one) that runs
600 ticks and bounds `island_crumbled`. Better, a one-off audit test that seeds every structural cell of the
fresh world and counts how many islands would crumble. If the count is not zero, fix it in gen (anchor the
rock) or accept and document it.

## F7. Traversal (should-fix, low severity)
`traversable_to_every_band` runs at generation only. Free islands become Sand, a sand pile can plug a narrow
shaft on the guaranteed path. Sand is diggable and flows, so a player is never hard-blocked, and a pile that
blocks a shaft only costs a dig. But a bot or a spawn-protected path assumption would be wrong. It is not
a blocker. Suggest logging an `island.crumbled` count in `input.summary` and playing a few seeds, and put
this in FUTURE.md rather than gating.

## F8. Changed fixture (fair)
`enemy_acid.rs` adds a Bedrock row under the loose Rock floor. The floor was a free 15x1 island that now
crumbles by design. The assertion (slime reaches the player) is unchanged, and the fixture is now what
the test always meant. Fair. Nit: the comment is good; no other tests build detached rock via `set`, as far as
the diff shows.

## F9. Materials and trees (design note)
Wood, Ice, Glass and Coal are structural. Coal and Wood become Sand and lose their burn behaviour, a one-way
change. Trees are Wood (`gen.rs` ~l.862-880) planted in Dirt. A trunk cut at the base or a mid-trunk
removal frees the upper part: the whole tree (under 400 cells) turns into sand. A 2-wide trunk 14-30 tall plus
branches is about 40-100 cells, so trees always crumble in full. Likely fun ("chop the tree and it
collapses"), but the result is sand, not logs, and a burning tree that burns through the base also turns the
crown to sand mid-fire. Note in FUTURE.md: Wood islands could become Fire or a Wood-falling variant instead.
Acid dissolving Dirt under a tree does the same.

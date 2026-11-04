# Cold review: N4 falling rock v0.5 (falling-rock-v05 vs d93730e)

Read-only review of `sim/src/grid.rs` (`flood`, `fall_one`, `fall_step`, `find_islands`), `hash.rs`, `snapshot.rs`,
`sim.rs` (blockers) and the test list. Nothing was built or run. The worker's report was read after this was written.

## F1 SHOULD-FIX: a merged island over the cap is dropped as "anchored" and hangs in mid-air
sim/src/grid.rs:361-377 (`fall_step`, `flood(s, stamp, FALL_ISLAND_MAX + 1)`).
Scenario: island B (70 cells) is waiting above a player (`Fall::Entity`, kept in `falls`), island A (70 cells) falls
onto it. Next tick the flood from A reaches B too, hits the limit (121) and returns `anchored == true`. `fall_step`
reads that as "landed or joined to something anchored" and drops both. Nothing crumbles, nothing is re-seeded, so 140
cells of rock hang in the air indefinitely over the player. The same happens whenever two tracked islands merge
past 120 (a landed pair, an entity-blocked pair). `flood` cannot tell "limit hit" from "Bedrock touched".
Why it matters: the invariant "a free island never stays hanging" is what the whole feature (and the world sweep)
claims. It is deterministic, so no desync, only a visible bug.
Fix: in `fall_step`, if the flood stopped because `island_cells.len() > FALL_ISLAND_MAX` and it was not really
anchored, crumble it (re-run with limit `ISLAND_MAX`, or have `flood` return an enum {Free, Anchored, TooBig}).
Test (red now): two 70-cell slabs, lower one over a player hitbox (or lower one resting on a pinned blocker rect),
upper one dropped onto it; assert after N ticks no ROCK island of 140 cells hangs (it crumbles or is on the floor).
Confidence: medium-high (traced by hand, not run).

## F2 SHOULD-FIX: a free island that lands on a non-structural solid is untracked forever and hangs when that support goes
sim/src/grid.rs:325-327 (`material_class == CLASS_SOLID` returns `Fall::Terrain`), 377 (`Terrain => {}`).
`material_class` calls Sand, Pebbles, Seed, Stem, Flower (and any powder) CLASS_SOLID, so a falling island stops on
a sand heap, and an island cut free while resting on sand never falls at all (v0 crumbled it). It is then out of
`falls` and nothing seeds it again. When the sand flows or is dug away, it hangs. Dig is the common action here:
dig under a sand-supported rock and the rock is left floating, which v0 never allowed (except deliberate painted
rock, D-175).
Fix options: on `Terrain` caused by a non-structural support, keep the seed in `falls` (it is re-flooded each tick
and moves the moment the support leaves; bounded by the 16 cap, but a slot is held), or treat powders under the
island as "free below" and only stop on structural/bedrock. Decide and record it as a D-row.
Test: rock slab free-standing on a 3-cell sand layer over empty space; dig a hole under the sand; run 200 ticks;
the rock must come down or crumble. Confidence: medium-high.

## F3 NOTE: islands in `falls` that rest are held slots; entity-blocked islands can starve the cap
sim/src/grid.rs:376 (`Fall::Entity => keep.push(s)`), 425-427. A player standing still under a slab keeps that slot
for as long as they stand there; 16 such islands make every later free island crumble (v0 behaviour, safe). Not a
bug; worth one line in the report. Confidence: high.

## F4 NOTE: a falling island fuses to anything structural it slides alongside
sim/src/grid.rs:361-377. Movement is a straight drop; only the cells below are checked. After a move the island may
be 4-adjacent to a ledge or tree beside it, and next tick the flood finds it anchored and stops it there (welded in
mid-air). Consistent with the connectivity rule and deterministic, but a log falling past a wall bump stops dead.
No fix needed unless it plays badly. Confidence: high.

## F5 NOTE: Stem and Flower are not structural, so a cut tree leaves its flowers behind
sim/src/grid.rs:9 (`is_structural` has Wood but not Stem or Flower). The brief says "Wood, and its Stem and Flower
if any". They are neither moved nor crumbled, same as v0, so flowers/stems on a falling log stay in the air as
powder-like solids and then drop as their own rules say. Visual only. Confidence: medium (depends on how those
materials move; I did not read their step code).

## F6 NOTE: restore test only covers a count of 255
sim/tests/falling_islands.rs:322-333 sets only the count byte. The checks at snapshot.rs:113-128 are right (the
`fat` position is checked `< b.len()` before `b[fat]` is read, the total is compared with exact arithmetic that
cannot wrap on wasm32 for fnum <= 16, each index is `< w*h`). Missing tests: an index at `w*h`, an index of
`u32::MAX`, a count byte of 16 with the wrong remaining length, and a falling index pointing at a non-structural
or a huge anchored cell (all are safe: each flood is capped at 121 visits and a stale seed is just dropped).
Confidence: high.

## Checked and found sound
- Hash and snapshot: `falls` is real state, hashed (fixed-width u32 LE, tag 0xFA, appended only when non-empty so
  an idle world hashes as before) and snapshotted in the same order. It is rebuilt (`keep`) every tick, so no stale
  entries differ between a continuous and a restored sim. The scratch the pass reads (`island_stamp`,
  `island_anchor`, `island_tick`) is keyed by a fresh stamp each pass, so a restored sim (zeroed arrays) behaves
  as a continuous one. `fall_blockers` is rebuilt from entity state each tick before `crumble_islands`, after the
  `refresh_active` that the W review (D-176) required, and `fall_step` does not read `active`. No float, no
  HashMap, no usize in the hash.
- Double moves: after `fall_one` the new cells are stamped, so a second seed in the same island is skipped, and the
  second seed of an island that was kept as `s + w` next tick is deduped by the stamp. I traced the case of one
  island's vacated/new cells being treated as "own cells" by another island's `fall_one` and found it unreachable:
  a cell below island C that belongs to island A would have been 4-adjacent to C, so they would be one island.
- Split mid-fall: a dig or blast calls `set`, which seeds `island_removed`; `find_islands` runs before
  `fall_step`, so fragments are flooded and registered fresh; a fragment that contains the tracked seed is deduped
  via `falls.iter().any(contains)`, and a seed whose cell was dug is dropped by `!is_structural`. Fragments over
  the cap crumble.
- Order and bound: seeds are found in `island_removed` order (deterministic), `falls` keeps that order; per-tick
  work is at most 16 floods of 121 cells plus 1920 swaps; `touch` per swapped cell is bounded too. The blocker
  test is O(cells x blockers) only for non-solid cells under the bottom edge. `island_visits` is restored after the
  falling pass (telemetry only, not hashed).
- Hitboxes: every non-island cell directly below an island cell is checked against live-player and enemy
  rectangles, including pockets inside the island, and the whole move is refused (`Entity`) if any is blocked.
  Cells are only ever written for cells in the island and the cells directly under them.
- Liquids: the bottom-up swap in descending index order moves the fluid to the top of each column run correctly;
  aux is swapped with it.
- Sleeping: `fall_step` reads neither `active` nor `awake`, writes through `touch` (which wakes chunks and
  neighbours); D7 and a frozen-edge test exist.

Read and found sound

## Where I disagree with the worker's report (read after the above)
- Report decision 3 notes that powders stop an island but treats it as intended. It misses the consequence in F2: an
  island that rests on sand or pebbles is dropped from `falls` and hangs when the support goes.
- Report "Known limits" says a falling island freezes at the active-rectangle edge. The code does not: `fall_step`
  reads neither `active` nor `awake`, so it keeps falling everywhere (which is what invariant 8 needs). The report
  text is wrong, the code is right.
- The report does not mention F1 (merged islands over the cap vanish from tracking as "anchored").

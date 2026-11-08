# Review: fix-a liquids (087f34c..7b7602b), read-only, nothing run

## F1 (should-fix, confidence medium) sim/src/grid.rs:~463 `liquid_free` strands liquid in 1-high channels
Scenario: a roofed or walled 1-high horizontal tunnel/trench fed from a shaft or pool. Cells inside have bedrock/rock below and
nothing above or below that is liquid, so `liquid_free` is false and they never slide. Only the feeding cell (liquid above) slides,
at most `reach` (water 6, oil 5, lava 3) cells, and the later cells queue behind it. Liquid never travels further than `reach` from
the feed. Before, the random walk diffused along the tunnel. Same for a 1-deep open trench. Playtest needed.
Mitigation idea: also free when a liquid is horizontally adjacent (3x3 only, so waking still holds) or when the side has liquid beyond.

## F2 (note, confidence high) sleeping invisibility holds for the rule itself
`liquid_free` reads only (0,-1) and (0,1); `liquid_can_move` reads down, diagonals, sides: all inside the 3x3 that `touch` wakes
(corners included). A not-free cell with an open side does nothing, and any change next to it calls touch. Slide only begins when the
adjacent side is open (k=1), so `liquid_can_move` matches `liquid_move`. rng is only drawn when a move happens. The `moved` skip sets
vol_seen. I found no stale-chunk path.

## F3 (note, confidence medium-high) lava volatility check
Reactive list (4-neighbour flammable incl. oil/gas/seed/stem/flower/wood, COAL, ICE, SAND) matches the reactions in `update_lava`
(~l.670-680); water is instant and turns lava to rock. Gunpowder primes from its own update (needs a touch when lava arrives, which
the lava move gives). Lava that is at rest with none of these and no move available sleeps correctly. On odd ticks `liquid_can_move`
keeps the chunk awake. Not covered: nothing else in grid.rs reads LAVA except gunpowder (l.947) and powder_ok. Cost: lava touching sand
or wood never lets its chunk sleep (perf only).

## F4 (should-fix, confidence high) tests/liquid_rest.rs wake test is vacuous for the new rule
`a_resting_cell_wakes_when_a_gap_opens_within_reach_across_a_chunk_edge`: the drop at x=63 is not free, so its behaviour no longer
depends on cell 68 (5 away); removing the shelf cell changes nothing near it. The doc comment ("reads up to `reach` cells away") is stale.
The on/off equality passes with or without the fix. Replace with a case that does matter: a drop at the chunk edge with the shelf
cell diagonally below-right (x=64) removed, or liquid placed above a resting drop across the edge, comparing sleep on and off.

## F5 (note, confidence high) `a_pool_on_a_ledge_still_pours_over_the_edge` assertion `on_ledge <= 40` is vacuous
`on_ledge` counts columns in 30..70 (max 40). The effective checks are `below >= 5` and rows <= 2. It would likely also pass
without the fix, so it is a regression guard only. Fine, but drop or tighten the vacuous clause. Not run, so the outcome at 3000
ticks is unverified by me.

## F6 (note, confidence high) other new tests
Lone water/lava/oil/acid and 1-deep film tests would fail pre-fix (random walk) and are deterministic (fixed seed 9, integer sim).
Acid is volatile so its chunk never sleeps; the acid test correctly only checks `mat`. liquid_walls tests are on/off-equality and
front-reach checks; the on/off ones are meaningful, the front test has an eprintln (swallowed, harmless). Active-region test documents
a design limit, fine.

## F7 (note, confidence medium) changed unit tests
- `fire_melts_ice`: `<= 1` to `<= 2` of 4 ice. The rationale (meltwater clings beside the fire and the fire turns to steam and dies)
  is consistent with the rule, but it is a real loosening; the ice-melting rate under fire is now lower. Acceptable; maybe assert
  `<= 2` plus fire count 0 to show the cause.
- `density_order`: now accepts SAND|GLASS at the sunk cell. Legitimate: lava displaced up now rests on the sand and glazes it 1 in 10
  per tick. Still proves the sand sank (cell is not lava/empty). Gameplay note: a lone lava drop on sand now permanently glazes the
  sand under it, since it no longer slides away.

## F8 (note, confidence high) gameplay consequences of resting
- A 1-deep film or lone drop clings, including at 1 cell short of a ledge edge (does not drain over). Intended per D-172.
- A 1-deep step is still taken (diagonal move precedes the rule). Oil on water still spreads (liquid below makes it free).
  Water sinking through oil unaffected.
- Ragged 1-deep tails at the edge of levelled pools are now permanent.


## Session model's resolution (3 Nov)

- Should-fix 2 (vacuous wake test): **fixed.** Replaced with `a_resting_cell_wakes_when_the_floor_beside_it_goes_across_a_chunk_edge`, which removes the diagonal-below floor cell in the next chunk and asserts the drop moves, with sleep on and off compared. Shown red by disabling `touch`'s left-neighbour wake (panic at `liquid_rest.rs:123`), green with it restored.
- Should-fix 1 (1-high channels): **not changed; for the user to playtest.** Recorded as D-172's cost.
- Notes: accepted.

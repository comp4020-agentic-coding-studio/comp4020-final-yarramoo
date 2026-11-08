# Biomes plan (branch `biomes`, 5 Nov)

Lead: Opus session in `/tmp/wt-biomes`. Budget $50 hard: **B0 = $30.46** (week spend at start); stop dispatching at
$72.46, stop all work at $80.46. At most 6 sub-agents, one at a time, Sonnet for implementation, Haiku for mechanical
jobs. Not merged into `multa`: the session model merges after the user playtests.

The user's ask (5 Nov): small biomes, distinct regions of the cave world with their own materials and hazards "to use
against enemies and other players": lava lakes, a livelier surface (hills, a lake, trees and shrubs, tame animals), ice
caves with frozen lakes and sliding, a moss and mushroom grotto, an old mine. Build as many as fit, cheapest and most
fun first.

## 1. How biomes are assigned

**Sites, not a partition.** A biome is a *site*: an ellipse `(kind, cx, cy, rx, ry)` centred on a point of the
guaranteed worm path, the same anchoring the open chambers use (D-151). A site centred on a path point is joined to the
tunnel network by construction, so a biome can never be an unreachable pocket. Regions between sites stay ordinary
caves. This keeps biomes small and distinct (the ask), and it leaves every existing pass, band and guarantee where it is.

`pick_sites(g, seed, path, sc, arena) -> Vec<Site>` (in `sim/src/gen.rs`, or a new `sim/src/biomes.rs` it calls):

- Kinds are visited in a fixed order (lava lake, ice cave, grotto, mine); kind `b`'s site `k` tries up to 64
  candidates `t`, each the path point `rng(seed, 0, k * 64 + t, b, SALT_GEN_BIOME) % n` among the `n` path points in
  that kind's depth band. Counter-based, integer-only, no `HashMap`; the result is a `Vec` in visit order, so it is a
  pure function of `(seed, size)` and identical in every engine.
- A candidate is rejected if its ellipse grown by 40 cells overlaps an earlier site, comes within `near_border`, lies in
  the spawn clearance (`|x - w/2| <= ENEMY_SPAWN_CLEAR` and above `shallow_top + ENEMY_SPAWN_ROWS`), or overlaps the
  boss arena grown by `ARENA_KEEP_OUT + rx`. A site that finds no candidate is skipped (bounded: 64 tries per site).
- Counts and radii scale with `scale_count` and the width percentage the chambers use, with a floor of one site per
  kind, so S (512 x 512) still gets each biome where it fits.
- Depth bands (L rows, scaled with `scale_u`): ice cave `shallow_top .. shallow_top + 300`; grotto
  `shallow_top + 120 .. deep_top`; mine `shallow_top + 200 .. deep_top + 250`; lava lake `deep_top + 60 ..
  repair_depth - 80`.

The **surface** is a biome of its own, not a site: it changes the heightfield and decorates the strip above
`shallow_top`, away from the spawn columns.

**What must keep holding.** Sites are picked after `carve_arena`, so they avoid it. Everything a biome places runs
before `clear_arena`, `repair_traversal` and `reseal_floor`, which therefore still have the last word: the arena is
cleared of liquids, the traversal path is cut through anything that blocks it, and the floor is resealed. Pickups,
enemies and the supply pile are placed afterwards on the final grid by the unchanged band rules, so they never land
inside a biome's solids. Biomes apply to every Caves world (Deathmatch, Survival, PvP presets); the Solid and Empty box
terrains are untouched.

**Format.** Generation decides what a pristine chunk holds, and snapshots store only non-pristine chunks, so a snapshot
from the old generator would restore onto the new terrain. `FORMAT_VERSION` goes 13 -> 14 in the first slice (server
`SNAPSHOT_FORMAT_VERSION` too) so stored worlds reset rather than mix. The game is not live, so a reset is fine. No ABI
change: material ids are bytes in the grid, and no new input kind is added.

## 2. Per biome

Costs are worker-hours at Sonnet speed including tests; risk is what could go wrong in lockstep or traversal.

### A1. Lava lakes (deep band) — most fun per cost
- **Materials:** none new (Lava, Rock).
- **Generation:** carve a wide, shallow cavern (rx 70-110, ry 28-40 at L) on the site's path point, then fill its basin
  with `try_pool` at a much larger cap (about 9000 cells at L) and width limit (the 70-cell pond limit lifted for this
  call only). Rock lining under it as `place_lava` does. Two or three rock ledges or a narrow rock bridge over the lake,
  so there is somewhere to stand and push from. Lakes go in before `place_lava`, so the ordinary pools, gunpowder (8-cell
  keep-away) and water (foe check) all respect them.
- **Hazards and interactions:** Push and Blast knock players and enemies; lava already damages both (imps are immune).
  Water spells turn the surface to Rock (a bridge you can make). Coal seams that meet the shore get lit.
- **Risk:** a lake on the path. Air above the lake keeps `box_reach` connected; if an exit is drowned, `repair_traversal`
  cuts and drains a tunnel. Sleeping: quiet lava sleeps since D-172.
- **Bumps:** gen only. **Cost:** 1.5 h.

### A2. Ice caves with frozen lakes (shallow band) — cheap, and sliding is cheaper than feared
- **Materials:** none new (Ice, Water). Generated ice is written with `aux = 1` (spent), so it is static and never
  volatile: it does not keep freezing the lake and its chunks sleep.
- **Generation:** replaces the scattered `place_ice` chambers: inside an ice site the rock and dirt lining becomes Ice,
  a water pool in its basin gets an ice lid two or three rows thick, and a few icicles hang from the ceiling.
- **Sliding:** client only. In `client/avatar.ts`, while on the ground with Ice under the feet, the horizontal blend
  factor drops from 0.4 to about 0.04, so you keep sliding after letting go and turn slowly. **Speed is not raised**: the
  target velocity is still `WALK`, and knockback keeps its cap, so the fastest the controller can move is unchanged and
  the server's `maxPosJump` needs nothing. Remote players see the slide through ordinary Pos inputs. Enemies do not slide
  (that would be sim work; deferred).
- **Hazards:** fire or lava melts the lid and drops you into the water; ice blocks into the lake.
- **Bumps:** gen, and a client avatar change with a unit test. **Cost:** 1.5 h.

### B1. Surface — hills, a lake, canopies and shrubs
- **Materials:** none new. Leaves are static `Stem` (id 8, aux 0: green, flammable, does not grow); shrubs are Stem
  with a few Flower cells.
- **Generation:** one or two smooth hills and at most one small mountain added to `surface_heights` (integer bump
  profile), kept away from the spawn columns. A surface lake: a basin dug into the Dirt in a dip, filled with Water, only
  where the whole rim and floor are solid (no entrance shaft under it). Tree canopies on the existing trunks, and shrubs.
- **Risk:** the heightfield feeds the cave threshold and the entrances, so every world moves; spawn must still find
  clear ground (shrubs stay out of the spawn columns).
- **Bumps:** gen only. **Cost:** 1.5 h.

### B2. Sand traps (my idea, picked from three)
- Above a few roomy chambers, a lens of Sand sits behind two or three rows of Rock ceiling. Break the ceiling (Blast,
  Bomb, Dig) and it pours on whoever is below. A trap to use against enemies and players, made only of existing rules.
- Considered and not picked: a glass geode with treasure inside (pickup placement would change band ids), an oil swamp
  (mostly exists already as layered oil pools).
- **Bumps:** gen only. **Cost:** 0.5 h.

### C1. Moss and mushroom grotto (shallow to mid band)
- **New materials:** `MOSS` = 23: static solid, not structural, flammable but slow: Fire ignites it 1 in 40 per tick
  (Wood is 1 in 12), so a front creeps along the walls; acid dissolves it; Dig and blasts clear it; paintable.
  `MUSHROOM` = 24: static solid, not structural, flammable 1 in 6, dissolvable, paintable; caps on `Stem` stalks.
- **Generation:** moss replaces the rock and dirt lining of the site (like the ice lining, so walkability is unchanged);
  giant mushrooms (Stem stalk, Mushroom cap) on the floor with headroom; a marsh-gas pocket under the roof where the old
  rule allows, so a spark flashes the gas and leaves the moss smouldering.
- **Bumps:** two material ids (colours, names, `MATERIAL_CLASS`, hotbar, paint-range mirror). **Cost:** 2 h.

### C2. Old mine (shallow to deep band)
- **New material:** `BRICK` = 22: inert, structural solid; Dig and explosions clear it; **acid does not**; not flammable;
  paintable.
- **Generation:** a roomy hall on the site's path point; vertical Wood beams floor to ceiling with Wood platforms
  between them, leaving gaps so the hall stays walkable; one or two brick rooms (hollow, a door each side) on the floor;
  a coal seam forced through the hall wall next to a beam; a small gunpowder crate in a room (lava keep-away as usual).
- **Interactions:** beams burn (Wood) and light the coal; burning a beam removes structure, so a small platform falls
  as itself and a big one crumbles (falling rock v0.5).
- **Bumps:** one material id. **Cost:** 2 h.

### D. Tame animals (surface) — likely past the cut line
- A new enemy kind 5 (passive critter): wanders, hops, never hurts, flees from players; drops a heal when killed.
  Survival-only, because enemies exist only there. Touches `NUM_ENEMY_KINDS` (sim and `shared/sim.ts`), the stats table,
  enemy AI, the renderer in `client/fx.ts`, the server's kill claims and achievements, and the snapshot's enemy
  validation (format already bumped). **Cost:** 3 h. **Risk:** server and client changes in the input-adjacent path.

## 3. Build order and cut line

| # | Slice | Worker | Why this order |
|---|---|---|---|
| 1 | Site picker, format 14, lava lakes, ice caves, ice sliding (A1 + A2) | Sonnet | Sets the structure; no new materials; the two most fun-per-cost |
| 2 | Brick, Moss, Mushroom; grotto and mine (C1 + C2); ice floors; gen-time fix | Sonnet | New materials are what the user asked for most; slice 1 made L gen 2.5x slower (270 -> 691 ms) and its ice caves had no floor to slide on |
| 3 | Surface and sand traps (B1 + B2) | Sonnet | Gen only; brief ready in `docs/briefs/biomes-surface.md` |
| 4 | Cold review of the whole branch diff | Sonnet | Required for structure-setting slices |
| — | **cut line at the dispatch ceiling** | | |
| 5 | Tame animals (D) | Sonnet | Most expensive and most server/client surface |
| 6 | Fixes from the review | Sonnet | Spare |

If spend after slice 3 leaves less than about $10 under the dispatch ceiling, the review moves up and animals are cut.

## 4. Tests per biome

Generation invariants, over seeds 1-8 at all three sizes, in Caves PvP and Survival (the shape the boss slice's test
missed, entry 30):
- **Traversal:** `traversable_to_every_band` and the Survival equivalent stay green unchanged; arena tests in
  `boss_gen.rs` stay green (open, flat, liquid-free, reachable, enemies and supply pile outside).
- **Present:** each site kind appears in every seed at L and M, and in most seeds at S (the test states the count).
- **Bounded:** lava cells per lake and in total, Ice, Moss, Brick and Wood counts have upper bounds; `pick_sites` makes
  at most `sum(count) * 64` attempts.
- **Placement:** a lava lake is a closed basin (every lava cell rests on something, as the existing liquids test checks);
  generated ice is spent (`aux == 1`); no site overlaps the arena or the spawn columns; the surface lake rests on solids.
- **Materials:** a unit test per new rule (moss ignites slower than wood, acid leaves brick, Dig clears brick), the
  paintable and class tables pinned, and sleep on/off identical (D7) with each new material painted into the sandbox
  script.
- **Engines:** determinism D2 in Node, Chromium, Firefox and WebKit, and native vs wasm (D3), already run caves worlds,
  so new generation is covered there.
- **Client:** an avatar unit test shows sliding on Ice (red first with the friction change removed) and that the top
  speed stays under `MAX_AVATAR_SPEED`.
- **Pinned results:** `golden`, `perf_equiv`, the scripted Survival hash and `non_survival_worlds_are_byte_for_byte_unchanged`
  move with generation; each slice re-records them on purpose and lists which scenarios moved.

Every slice: the full gate (cargo, clippy for wasm32, typecheck, determinism, net) re-run by the lead before push, then
a look at `/game` worlds on the lead's play server (port 8091, data dir `/tmp/simulta-biomes`).

## Amendment after slice 1 (5 Nov, 17:45)

Slice 1 cost about $17 of the $50 (spend B0 + $20.7 after the gate, with other agents on the same account), so at most
one more build slice fits under the dispatch ceiling, plus a cheap cold review. The order above was swapped: slice 2 is
now the new materials (grotto and mine), because they are the biomes the user described in most detail and the only ones
with new sim rules; it also carries two fixes to slice 1 (generation time at L rose from 270 to 691 ms native; the ice
caves had no floor to slide on). The surface is the first thing cut if the budget runs out; its brief is ready.

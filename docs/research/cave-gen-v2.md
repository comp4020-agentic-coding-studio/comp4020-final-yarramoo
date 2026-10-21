# Cave generation v2: traversability and starting tools

Builds on `noita-caves.md` (Wang tiles, biome maps, technique table); not repeated here. Prior-art claims in section C are from general knowledge, not fetched this session (no web calls made), and are marked (G).

## A. Diagnosis

`gen.rs` implements recipe steps 1-3, 5-6, 7-9 of the note. It skips step 4 (the CA cleanup); there is no smoothing pass and no minimum-width guarantee anywhere.

Where narrow passages come from:

- **Noise caves are thin ribbons.** `PARAMS` (line 80) opens a cell when the field is below 1250 (shallow, 30%) rising to 1500 (deep, 37%) of 4096. Near a 30% threshold, value noise gives long thin lobes where two blobs almost touch. `carve_noise_caves` (line 500) also adds a detail octave within +/-120 of the threshold (line 527), which roughens edges and pinches lobes to 1-3 cells.
- **Worm brush radii.** Entrance shafts use r 5..9 (line 671-672: diameter 11-19, fine). Branches use `wm.r - 1` clamped at `r_min` 5 (line 645). Horizontal link worms start at r=5 with `r_min: 3` (line 691-692): diameter 7 at the narrow end, under the 10-cell hitbox height. They also zig-zag, so the effective vertical clearance is lower.
- **`wander_link`** (line 744) digs radius 3 + (st/17)%3 = 3..5, so a repair tunnel is 7 cells wide for a third of its length.
- **`connect_and_prune`** fills pockets under 400 cells with Rock and runs a final fill of anything unreachable (line 819), which can cut the necks of chambers further. It tests 4-connectivity of single cells, not box-fit.
- **The material pass plugs passages.** `pile` (sand r 12-30, gunpowder), `try_pool` (water up to 14 deep, basin cap 900 cells, lava cap 1800) all fill the narrow floors. A 14-deep pool in a 12-high tunnel is a full plug (water is passable by swimming only if the sim allows; the probe below treats it as blocking).

Measurement (throwaway probe at `/tmp/probe`, not in the repo): for seeds 1-8, the open fraction by band (Empty cells only) and a BFS over every position where a box is fully Empty, starting from the surface at the world's centre column. Open fraction: 260-500: 17-25%; 500-800: 20-40%; 800-1100: 15-31%; 1100-1472: 7-18%. So the density is healthy; the problem is connectivity at body size.

| seed | 5x10 box reaches y (bottom) | deepest band reached (800+ is "deep") | 6x11 box |
|---|---|---|---|
| 1 | 995 | 800-1100 | stops at 704 |
| 3 | 891 | 800-1100 | 875 |
| 4 | 1056 | 800-1100 | 1056 |
| 5 | 973 | 800-1100 | (start unfit) |
| 7 | 593 | shallow only | 568 |
| 8 | 1048 | 800-1100 | stops at 367 |

Seeds 2 and 6 gave "start not fit" at the centre column (probe artefact: the real `spawn_point` scans 16 columns, so these are not necessarily failures). **No seed lets a hitbox-sized body reach the 1100-1472 band from the surface by walking, and seed 7 never reaches the deep band at all.** The existing test `every_open_cell_is_reachable_from_the_sky` (line 861) is single-cell 4-connectivity through liquids and sand, so it cannot see this. Caveats: the probe treats Water, Sand and Lava as blocking (a player can wade water, and dig nothing), and the deepest 1100+ pickups exist, so cell-level connectivity is real, only body-level is missing. The point stands: the world is only traversable for a body about 2-3 cells wide.

## B. Starting tools: what each spell does to terrain today

- **Push (0), Blast (1):** `blast` (spells.rs line 104) only knocks players. No terrain effect. Water (2), Rose (3): not terrain-breaking. Fire bolt (4): ignites flammables. Bomb (5): `grid.carve` radius `BOMB_RADIUS` 18 (spells.rs line 250, grid.rs line 650), erasing everything but Bedrock. Bombs are a deep-band pickup (5 charges), so they are the only digger and sit past the wall the player cannot cross. That is complaint 1.

Options:

| Option | Sim cost | Client cost | Determinism | Effect on live world 1 |
|---|---|---|---|---|
| 1. New spell 6 "Dig" in the starting loadout (`START_CHARGES`, tuning.rs line 8): a short-range carve, radius ~4, Rock/Dirt/Sand only, infinite charges, cooldown ~8 ticks | New spell id, one carve call, a cooldown constant. Bounded work (radius clamp, per CLAUDE.md). NUM_SPELLS 6 to 7 changes snapshot/bag shape (bag count, D-111 territory): needs a format bump | Spell bar slot, icon, aim already exists | Rebuild fixtures; every D-test script that enumerates spells; changes the sim build hash | Build hash changes, so a deploy forces the stored snapshot through the build-change path (D-112). The world survives only if the snapshot still restores; a new spell count likely breaks it |
| 2. Make Blast carve soft materials (Dirt/Sand/Wood, not Rock) in its cone | Small: a scan of the cone, no new id | None | Same hash change; no format change | Live world kept if the snapshot format is untouched; existing players' behaviour changes |
| 3. Pickaxe action (a non-spell input, new input kind) | New input kind, bounded radius | New key and UI | Highest: ABI input, plus protocol and the generators | Same build-change cost, plus protocol version |
| 4. Guaranteed shafts from the surface to each band | Pure generation change | None | Only generation tests | Changes the seed output, i.e. resets world 1 |

Cheapest: option 2 (no new id, no snapshot shape change), with Dig as a variant of Blast limited to Dirt/Sand/Wood. Rock should stay Bomb-only, so the deep pickups still matter. Option 1 is cleaner design, costs a format bump.

## C. Prior art (G, not re-fetched)

- **Noita:** the starter wand is a digging-capable bolt (a spark bolt that damages and can be swapped), and the Mines, Coal Pits and the Holy Mountains between biomes gate progress by vertical shafts and the player's tools rather than by minimum-width geometry; its Wang tiles encode open connections at every tile edge, so connectivity is a property of the tile set.
- **Terraria:** the player starts with a pickaxe and every block is breakable; tunnels are cosmetic.
- **Spelunky:** guaranteed critical path built from a room grid first (a random walk of rooms from top to exit), only then filled with decoration. Connectivity is built before content.
- **Dwarf Fortress / Starbound:** caverns are separate layers reached by digging or by fixed vertical connectors (DF's chasms); Starbound ensures a surface-reaching tunnel per region.

Common lesson: guarantee the path first, at the player's size, then add decoration that cannot sever it. Integer-friendly techniques: (1) a worm backbone with a minimum radius at least the hitbox; (2) **dilate by the hitbox**: after all carving, compute the "body-passable" mask with a box-fit prefix-sum (what the probe does, O(cells)); (3) repair by carving from the nearest reached body-passable cell.

## D. Gen v2 recipe

Order of passes (changes marked NEW):

1. Fill, surface heightfield (unchanged).
2. Noise caves (unchanged, but raise `thr_*` by about 10% and drop the detail octave inside caves, line 527, to avoid pinching).
3. **NEW backbone:** per entrance (3-5) one worm with `r_min` 7 (diameter 15, 1.5 x hitbox height), no radius shrink on branches, target depth 1380. Add one backbone worm per depth band edge. Horizontal links: `r_min` 5, `wander_link` radius 5-6.
4. **NEW sweep:** open-cell width fix. A morphological opening on the open mask at 1/4 resolution (erode by 1, dilate by 2 quarter-cells) to widen necks under 8 cells. About 2 passes over 750K quarter-cells.
5. Connectivity (existing) and **NEW box-fit repair**: compute the 6x11 fit mask using 2-D prefix sums (3M adds), flood fill from the spawn through fit cells, and for each band top (260, 800, 1100) that is unreached, wander-carve a 7-wide tunnel from the nearest reached fit cell down to the band. Re-run once.
6. Materials (sand, lava, gunpowder, water): **NEW** protect the backbone path (a mask of cells within 8 of any path sample), and never place a pool over it. Pools are the main plug.
7. Pickups (as now).

Cost on 3M cells: prefix sum plus box-fit about 12M ops, the flood about 3M visits, so about 25-40 ms natively on top of the current generation. On wasm it is about 3x that. Generation runs once at `Sim::new`, so fine, but check client load time on the 256 MB machine.

Test: `traversable_to_every_band` in `gen.rs`: for seeds 1-20, build the box-fit mask for 6x11 (a margin over the 5x10 hitbox), flood from `spawn_point`, assert the bottom reaches `y >= 800`, `>= 1100` and `>= 1380`, and report which seed fails. Liquids count as blocking in the test, to stay strict. This test is red on the current code (shown above: seed 7 and all seeds for 1100+), which satisfies the "show it red first" rule.

## E. The live world constraint

World 1's state is the seed's output plus its input log; changing `gen.rs` changes every cell, and D-014 forbids an accidental reset. D-086 (pickup counts per seed) and D-114 (the M5 script follows pickups from the generator) would be re-verified but not broken, if the new generator keeps the pickup counts.

- **(i) Gen v2 only for new kinds.** Safe: no reset. Gate by `world_kind` in `Sim::new`, with `generate_v1` kept verbatim for kind 1 (never edit it, tests pin it). Needs the planned arena/creative kinds to exist; `docs/plan-game-modes.md` did not exist when I checked. Complaint 2 stays for world 1 until a reset.
- **(ii) Deliberate reset of world 1.** Allowed by D-097 (`POST /api/admin/reset`, ADMIN_TOKEN); the new sim build still loses the stored snapshot under D-112. Cost: wipes the classmates' state. The single cleanest fix to complaint 2.
- **(iii) Runtime fix only.** Blast carves soft materials, or Dig spell: solves complaint 1 and partly 2 (the player can dig out of a narrow neck, except through Rock), with no generation change. A build change still triggers D-112's snapshot check; Blast-only (no format change) restores fine.

**Recommendation:** do (iii) first with option 2 (Blast carves Dirt/Sand/Wood, small radius, bounded), since it cures the blocker without touching generation and it preserves the live world. Ship gen v2 as `v2` for new world kinds (i), and do (ii) only if the user decides to accept a wipe, ideally together with the next sim build.

## Architectural decisions for review

1. **Blast carving soft materials only** vs a new Dig spell: chosen the former (no NUM_SPELLS or snapshot change); alternative costs a format bump and fixtures. Cost later: Blast gets two jobs.
2. **Versioned generator (`generate_v1` frozen)** so live worlds never change under a refactor. Cost: code duplication, and tests pinning v1.
3. **Hitbox margin:** test and repair use a 6x11 box against the 5x10 hitbox. Cost: slightly more open caves.
4. **Liquids count as blocking** in the traversal test. Cost: stricter than gameplay, which may force more carving.
5. Rock stays Bomb-only so the deep pickups remain meaningful.

## Ideas for FUTURE.md

- A `gen-report` dev tool that prints, per seed, the body-reachable depth and the open fraction by band; it should run in CI as a table.
- Min-width heatmap overlay in the dev viewer (distance transform of the open mask), to tune by eye.
- Noita-style "Holy Mountain" safe rooms at each band edge with a guaranteed digging pickup.
- Reachability-aware pickup placement: reject spots not inside the body-passable mask.

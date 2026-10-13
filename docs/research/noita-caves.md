# Noita cave generation: research notes

## 1. How Noita does it (verified unless marked)

- Two layers. A fixed **biome map** (PNG, one pixel = one 512x512 chunk; default world is 70 chunks = 35,840 px wide) says which biome sits where. Each pixel colour looks up a biome XML, which names a **Wang tile template** PNG and a Lua script.
- Inside a biome, terrain is laid out by **herringbone Wang tiles** (Sean Barrett's method; Purho confirms in the 80.lv interview and Game Developer IGF piece). Tiles are hand-drawn images; grey shades are filled with the biome's `<Materials>`, other colours place specific materials or trigger Lua spawn functions (enemies, orbs, chests).
- After tiling, hand-made **pixel scenes** (max 512x512) are stamped on top: vaults, shops, puzzle rooms, guaranteed pickups.
- Fixed: biome layout, tile art, pixel scenes, guaranteed spawns. Seed-random: which tile goes where.
- Unverified: Noita tile pixel size. Herringbone tiles: 2:1 and 1:2 rectangles interleaved, each side two edge segments. Edge-colour matching gives 64 tiles per orientation for a complete set. Barrett notes his own game ignored the edge constraints. Connectivity can be built into tile design (each half-square's outer edges join internally), which "guarantees no unreachable areas" but sometimes forces roundabout paths.

## 2. What the caves look like (checklist for judging screenshots)

Verified from the wiki (Mines page) plus general knowledge of the game (marked G).

- [ ] Narrow, winding passages and chambers; the player is about 10-20 px tall (G), so tunnels are typically 20-60 px wide with occasional 100+ px chambers (G, unverified).
- [ ] Many small slopes and dips; liquids collect in them. Pools are small and sit in crevices.
- [ ] Biome identity by depth: surface forest/desert/snow, then Mines, Coal Pits, Snowy Depths, Hiisi Base, Jungle, Vault, Temple, Laboratory, with a Holy Mountain between each of the 8 main biomes.
- [ ] Stalactites, moss and glowing fungus (G, unverified: not on any page I read).
- [ ] Caves are connected but with dead ends and loops; wide open vertical shafts connect layers.


## 3. Technique comparison (cost figures are my estimates)

| Technique | Noita-like | Integer determinism | Cost on 3M cells | Connectivity |
|---|---|---|---|---|
| (a) Herringbone Wang tiles | Highest: it is what Noita uses | Easy (hash picks tile index) | Very cheap, copy blocks | By tile design, at 2:1 tile level |
| (b) Integer value noise, thresholded, domain-warped | Blobby, organic; wide caves, not winding | Easy with fixed-point lattice hash + integer lerp/smoothstep | Moderate: 3 octaves x 3M is about 10M lerps, fine | None; needs carved tunnels or flood-fill check |
| (c) CA smoothing (45% fill, 4-5 passes) | Lumpy "swiss cheese"; least Noita-like at scale | Trivial; double-buffer is order-independent | 5 passes x 3M x 8 neighbours = about 120M reads, tolerable at coarse res | Poor; leaves islands, needs flood fill |
| (d) Worm/random-walk tunnels | Good for winding passages if brush size varies | Easy: walker state from hash(seed, id, step) | Very cheap (walkers, not cells) | Strong: walk is continuous; start at a surface entrance |
| (e) Combination | Best fit | as above | as above | Worm backbone + noise caves |


## 4. Recommended recipe

Work at 1/4 resolution where noted (512x384 grid), then expand, to cut cost. All integer; every random call is `rng(seed, 0, x, y, salt)`. Walkers use their index and step count as x and y with distinct salts.

1. **Fill.** Rock everywhere. y below ~200 and above is Empty (sky). Bedrock: bottom 64 rows and 16-column side walls.
2. **Surface heightfield.** Sum of 3 integer value-noise octaves along x (wavelengths 256, 64, 16; amplitudes 24, 8, 3) around y=230. Rows from surface to +10 are Dirt, then Rock. Aim for the band y 200-260.
3. **Noise caves.** 2D value noise in 1/4-res cells with fixed-point (16.16 or Q8) lattice hashing. Domain-warp: add a lower-frequency noise offset (up to +/-24 cells) to the sample coordinates. Two octaves, wavelength 96 and 32 cells at full res. Carve where the combined value is below a threshold. Shallow band: threshold gives about 22% open, deeper than y=800 about 32% open, and open pockets are larger there. Stretch noise vertically (x wavelength greater than y wavelength by about 1.5x) for more horizontal chambers.
4. **Cleanup pass.** One or two CA smoothing passes (rock if 5 or more of 8 neighbours are rock) on the carved mask to remove single-cell specks. Do this at 1/4 res so cost is low.
5. **Entrances and worms (guarantee).** Choose 4 entrance x positions by hash, spaced at least 300 apart and at least 64 from side walls. Each spawns a walker at the surface that heads down. Per step: bias dy>0 (about 70% of steps), dx random in -2..2, brush radius 5-9 cells varying slowly by hash. Run to y about 900 (deep band), 2-3 branches per walker splitting every ~150 steps. Add 3-4 extra horizontal worms at y about 500 and about 1100 linking the walkers. A worm clipping the bedrock border is stopped.
6. **Connectivity check.** Flood-fill (iterative stack, no recursion) from the entrances over Empty cells. Any open region with at least 400 cells not reached: carve a straight worm to the nearest reached cell. Remove unreachable regions smaller than 400 cells by filling them with rock. Cost is one pass over 1/4-res or full-res mask.
7. **Materials.**
   - Dirt: cells within 3 of a cave opening on the surface side (and most of the top 40 rows).
   - Sand pockets: pick blob centres by hash in the shallow band, radius 12-30; replace Rock with Sand when adjacent to caves, or place sand fully inside open space at the cave floor.
   - Gunpowder pockets (deep band): the same, radius 6-14, placed on the cave floors; keep them sparse (about 1 per 150x150 area).
8. **Liquids (basin fill, not placement).** For each cave region, scan columns bottom-up. For a chosen pool centre x, find the floor y, then fill upward row by row. For each row, flood-fill limited to cells connected to the seed cell at that y and bounded by solid on both sides. Stop at a row that leaks (the fill row's span touches a cell with open air below it that is not already filled or solid) or at max depth (4-14 rows water, 6-20 rows lava). Result: a flat-topped pool in a basin, so the sim has nothing to settle. Water in the shallow band, 1 pool per ~250x150 area; lava in the deep band, bigger and bounded below by Rock (put a 2-cell Rock lining under lava so it can't leak into water). Keep at least 8 cells between lava and gunpowder.



9. **Pickups.** Place on a cave floor in the right band, check against the flood-fill mask.

## Sources

- https://noita.wiki.gg/wiki/World_generation : tiles + pixel scenes, fixed vs random.
- https://noita.wiki.gg/wiki/Modding:_Making_a_custom_environment : biome map = 512 px per pixel, wang tile colour handling, pixel scene size.
- https://noita.wiki.gg/wiki/Biomes : biome order by depth, landmarks, 35,840 px width.
- https://noita.wiki.gg/wiki/Mines : look of the Mines: slopes, pools, props, structures.
- https://nothings.org/gamedev/herringbone/herringbone_tiles.html : herringbone tile geometry, tile counts, connectivity patterns.
- https://80.lv/articles/noita-a-game-based-on-falling-sand-simulation : Purho on herringbone tiles (via search snippet only).
- https://www.gamedeveloper.com/game-platforms/road-to-the-igf-nolla-games-i-noita-i- : tool list including the herringbone generator (via search snippet only).
- https://www.youtube.com/watch?v=prXuyMCgbTc : the GDC talk; not watched (unverified).
- Section 3 costs, the recipe parameters and checklist items marked G are my own estimates and general knowledge, not sourced.

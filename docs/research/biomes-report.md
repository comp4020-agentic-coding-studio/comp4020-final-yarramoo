# Biomes: report (branch `biomes`, 5 Nov)

Lead: Opus session in `/tmp/wt-biomes`. Plan: `docs/biomes-plan.md` (amended after slice 1). Briefs: `docs/briefs/biomes-1.md`,
`biomes-2.md`, `biomes-3.md`, `biomes-surface.md` (written, not run). Worker reports: `docs/research/biomes-w1-report.md`,
`biomes-w2-report.md`, `biomes-w3-report.md`. **Not merged into `multa`.**

## What was built, per biome

| Biome | State | What a player finds |
|---|---|---|
| **Lava lakes** (deep band) | Built | 1 site at S/M, 3 at L. A wide, flat-floored cavern with a lake of lava up to ~9000 cells at L, a Rock lining, and 2-3 Rock ledges 6-10 rows above the surface to push from. Lava already hurts players and enemies (imps immune), so Push and Blast into the lake is an environmental kill. |
| **Ice caves** (shallow band) | Built | 1 site at S/M, 3 at L. A cavern lined with Ice, a floor of solid Ice two rows deep across the whole cavern, a water pool under a two-row ice lid that reaches the shore, icicles. All generated Ice is spent (`aux = 1`): static, never freezes water, sleeps. |
| **Ice sliding** | Built (client only) | On Ice the avatar's horizontal blend drops from 0.4 to 0.04: you keep sliding after letting go and turn slowly. **No speed is raised** (the target is still `WALK`), so `MAX_SPEED_FIXED` and the server's `maxPosJump` are unchanged and remote players see the slide through ordinary Pos inputs. Enemies do not slide. |
| **New materials** | Built | Brick 22 (inert, structural, acid-proof), Moss 23 (flammable 1 in 40, wood is 12: burns slowly), Mushroom 24 (flammable 1 in 6). End to end: sim rules, names, `MATERIAL_CLASS`, colours, hotbar (all three paintable), hover names. |
| **Moss grotto** | Built, sparse | 1 site at S/M, 3 at L. Moss over the cavern lining, 3-6 giant mushrooms (Stem stalk, pink Mushroom cap), moss tufts, a gas pocket under the roof where the old rules allow (a spark flashes it and the moss smoulders). About 100-480 moss and 130-250 mushroom cells per L world. |
| **Old mine** | Built, **with visible defects** | 1 site at S/M, 3 at L. Wood beams, Wood platforms, Brick rooms, a coal seam through the roof beside the first beam, a gunpowder pile in deep mines. See known issues: beams and rooms can float, rooms are mostly roof. |
| **Surface** (hills, lake, canopies, shrubs) + sand traps | **Cut** | Brief written (`docs/briefs/biomes-surface.md`), not run: the budget ran out after the materials. Gen only, no format or client change, so it can be done any time. |
| **Tame animals** | **Cut** | Was below the cut line in the plan: a new enemy kind touches the sim, `shared/sim.ts`, the renderer, the server's kill claims and achievements. About 3 h. |

## Gate results and commits

Every pushed commit passed the full gate, run by the lead (chained `&&`, logs in `/tmp/bl-*.log`): `cargo test --release`
(44 binaries), clippy for wasm32 `-D warnings`, `pnpm typecheck`, `pnpm test:determinism` (53/53: D1, D2 in Node,
Chromium, Firefox and WebKit, D3, D6, D7, D10, D11), `pnpm test:net` (399 passed, 1 skipped). The last gate (on `9cbe5da`): cargo 44 binaries ok, determinism 53/53, net 399 + 1 skip.

| Commit | What |
|---|---|
| `a4b54e3` | Plan |
| `f7ca386` | `dump_world` example: seed, size, preset, PPM with the full palette |
| `e20541c` | Snapshot format 14 (no layout change; stored worlds from the old generator reset) |
| `a558a26` | Site picker, lava lakes, `sim/tests/biomes.rs` |
| `c09fa76` | Ice caves replace `place_ice` |
| `eb52df2` | Ice sliding (client) + avatar test |
| `a71b0af` | Briefs; plan amended (materials before surface) |
| `7b33212` | Gen time: one depth check for all sites, one-pass prefix sums, early exit (L 682 -> ~490 ms) |
| `3b44bde` | Ice floors, lid to the shore |
| `dafaa70` | Brick, Moss, Mushroom end to end + `sim/tests/biome_materials.rs` + D7 sleep script |
| `3e1e896`, `84f7d99` | Worker reports and WIP patches for the grotto and mine |
| `f0bfc19` | Brief 3 |
| `9cbe5da` | Grotto and mine (lead finished it from the WIP: no bowl for hall sites, fallback removed, test strengthened) |
| (this commit) | This report, screenshots, the mine draft patch |

**Pinned results** moved only on purpose, each in the commit that changed generation: `golden-v14.bin` and
`SCRIPTED_HASH`, the three `boss_gen` non-survival hashes, and the `survival_l` lines of `perf-trace.txt`. No sandbox
scenario moved in any commit, except the snapshot-byte lines at the format bump (the version byte is in the header).

**Tests shown red first:** sites removed, overlap check removed, lakes removed, ice `aux = 0`, `place_ice` removed, ice
floor on the old code, brick made dissolvable, moss at 1 in 12, the avatar slide with the ice branch disabled, and the
grotto/mine test with `place_mine` stubbed (the site-count-only version passed that way; the lead added the material
assertion).

## Spend

- **B0** (week spend at start): $30.46. **Final:** $71.11 at the report commit (B0 + $40.65). The account is shared with other agents on this machine
  (a client worker on `feel`, the session model on `multa`), so the difference is an upper bound on this run.
- Worker 1 (Sonnet, slice 1, 124 tool calls, ~2.5 h): about $17 (spend $30.5 -> $47.9 across its run).
- Worker 2 (Sonnet, slice 2, 111 tool calls): about $9 ($52.0 -> $57.3).
- Worker 3 (Sonnet, finishing, 64 tool calls): about $2.5 ($60.7 -> $63.1).
- The lead's own review, gates, renders and finishing: the rest.
- 3 of 6 permitted sub-agents used; dispatching stopped at $64.7, before the $72.46 ceiling, because what was left
  could not fund another slice and the finish.

## Screenshots

Renders by `cargo run --release --example dump_world -- SEED SIZE PRESET out.ppm`, in `docs/art/shots/biomes/`:
- `world-L-seed2-survival.png`: a whole L Survival world (half size): flat red lava lakes in the deep band, ice caves
  top left and right.
- `lava-lake-L-seed2.png`: one lake, flat surface, a ledge either side.
- `ice-cave-L-seed2.png`: two ice caverns, lining, icicles, the lidded pool.
- `grotto-L-seed1.png`: moss rim, three giant mushrooms on a mossy floor.
- `mine-hall-L-seed1.png`: three beams and a brick room roof, floating above the hall floor (the known issue).
- `world-M-seed3-survival.png`, `world-S-seed5-pvp.png`: the smaller sizes.
- `play-8091-final.png`: the browser joined to an L room on the play server running `9cbe5da`, connection dot green.

## Known issues

1. **The mine floats.** Grotto and mine sites have no bowl (the lead's fix: a bowl is what sealed off the arena), so the
   hall's "floor" row from `site_floor` can be open space. Beams stop 12 rows above that row and rooms are built on it,
   so on most seeds they hang in the air. A draft fix (find the real floor under the centre, beams run to the first solid
   below, rooms need ground within 4 rows and get a brick footing) is in `docs/research/biomes-mine-floor-draft.patch`.
   It is **not tested**: with it, the beams reach the ground but no room passed the grounding check on seeds 1-3 (only one
   mine reached room placement; a probe showed `floor 799 ... grounded false` for the one candidate room). Next step: pick the room's x from columns
   whose floor is within 2 rows of `floor`, not a random span.
2. **Brick rooms are mostly roof.** Rooms are 12-16 tall with a 10-row door on each side, so only the roof and short
   wall stubs show. The draft patch cuts the doors to 8 rows.
3. **Halls are sparse.** A hall's decoration is undone whole when it shortens the walkable depth or strands open cells,
   so some sites keep a bare cavern. At L the counts are moss 240-480, mushroom 130-250, brick 126-216 per world.
4. **Generation time.** Native at L: multa 270 ms; now best 524 ms, worst 902 ms (best of 4 seeds, loaded machine; the
   worst case is the per-site fallback that clones the grid). Worlds are generated once and cached (`Base`), so this is
   join latency for the first player, not per-tick cost. FUTURE: a bounded local flood instead of whole-grid checks.
5. **Some lava sites stay empty** (a floor, the cap, or the "lake drowns the route" undo blocks the fill): the test
   asserts at least half reach 1500 cells at L. The vertical lava "rivers" in deep tunnels are the old `place_lava`
   ponds (a narrow, deep tunnel passes its 70-column width check), not the lakes; they predate this branch.
6. **Ice sliding is client-only.** Enemies and remote prediction do not slide; a remote player's slide is just their Pos.
7. **Not looked at in a live two-browser session after slice 1.** The play server on 8091 runs the final build
   (rebuilt at the end), and the renders are from the same sim source, but nobody has walked onto ice or pushed a
   slime into a lake in a browser.

## Architectural decisions for review

1. **Snapshot format 14.** No layout change: bumped because generation decides what a pristine chunk holds and snapshots
   store only non-pristine chunks, so an old snapshot would restore onto new terrain. Stored worlds reset (the game is
   not live). `server/db.ts` `SNAPSHOT_FORMAT_VERSION` mirrors it.
2. **Region assignment = sites, not a partition.** `Site { kind, cx, cy, rx, ry }` on `World.sites`, picked in
   `pick_sites` right after `carve_arena`, centred on worm-path points open to the sky in each kind's depth band, in a
   fixed kind order (lava 1, ice 2, grotto 3, mine 4), 64 tries per site with counter-based draws (salts 260, 261).
   Rejected if it overlaps an earlier site (grown by 40; 90 between lava and halls, `LAVA_SITE_GAP`), the border, the
   spawn clearance, or the arena (grown by `ARENA_KEEP_OUT + rx`, plus `HALL_ARENA_GAP` = 60 for halls). Everything a
   biome places runs before `clear_arena`, `repair_traversal` and `reseal_floor`, which keep the last word; pickups and
   enemies are placed on the final grid by the unchanged band rules. Counts `scale_count(w, h, 3, 1)`.
3. **Lake sites get a bowl and a dam; hall sites do not.** Lava and ice caverns get a flat Rock bowl below `site_floor`
   and a rim dam (`seal_site`), each undone if it shortens the walkable depth or strands more than `DAM_STRAND_MAX` =
   1500 cells; a lava lake that shortens the depth is undone. Grotto and mine get neither (their bowl sealed off the
   arena on S seed 7 and L seeds 4 and 7). The WIP's "regenerate without halls" fallback was removed: its `arena_ok`
   check also failed on every no-hall world it fired on.
4. **New material ids 22 Brick, 23 Moss, 24 Mushroom.** All static with no update rule, so never volatile and invisible
   to sleeping. Brick is structural (forms falling islands, anchors like Rock); Moss and Mushroom are not (they never
   anchor or fall as islands). `paintable` and `isPaintable` are now two ranges (10-20 and 22-24; 21 Pebbles stays a
   hole); bit 7 (fill-empty) stays free, so ids up to 127 remain possible.
5. **Ice sliding is a client blend factor, not a sim rule.** Reversible, and it needs nothing from the server because no
   speed rises. `ICE_ID = 18` is duplicated in `client/avatar.ts`.
6. **`try_pool` gained `max_w`** (existing calls pass 70, so their results did not move). `pick_spots` tries went
   4000 -> 60000 (the loop stops at `want`; full worlds unchanged) because lakes and halls take floor.
7. **Generated Ice is spent (`aux = 1`).** A fresh-ice lake would keep freezing and keep its chunks awake.
8. **`dump_world`** is now a general tool (`SEED SIZE PRESET out.ppm`, full palette).

## Suggested D-rows (for the session model; `docs/DECISIONS.md` was not edited)

- **D-193** Biomes as sites: `Site` on `World.sites`, picked after `carve_arena` on worm-path points in each kind's band;
  rules and bounds as in decision 2 above. Everything biome-specific runs before `clear_arena`/`repair_traversal`/
  `reseal_floor`, so the traversal and arena guarantees are unchanged and their tests pass unmodified.
- **D-194** Snapshot format 14 for new generation only (no layout change); stored worlds reset.
- **D-195** Lava lakes and ice caves: bowls and dams for lake sites, undone when they cost walkable depth; generated
  Ice is spent; ice floors two rows deep.
- **D-196** Ice sliding in the client only: blend 0.04 on Ice, no speed raised, so `maxPosJump` is untouched; enemies
  do not slide.
- **D-197** Brick 22 (structural, acid-proof), Moss 23 (flammable 1 in 40), Mushroom 24 (1 in 6), all paintable,
  static, never volatile.
- **D-198** Grotto and mine halls: no bowl (it sealed off the arena), decoration only into Empty, undone per site when it
  costs depth or strands cells; the regenerate-without-halls fallback was rejected after a probe. Mine geometry has known
  defects (floating beams, roof-only rooms); a draft fix is on file.
- **D-199** Cut: surface (brief ready) and tame animals (below the line). Order changed after slice 1: materials before
  surface.

## Ideas for FUTURE.md (not added; the session model decides)

- A rock bridge across each lava lake (plan A1), and lava lakes as the boss arena's moat.
- Ice sliding for enemies (a sim rule: slimes keep their hop velocity on Ice).
- Pick biome sites before the worms and the arena, so the network is built around them instead of repaired after.
- A bounded local reachability check per site instead of whole-grid floods (generation time).
- `dump_world` drawing site outlines.

## Play server

`http://localhost:8091`, PID 31605, data dir `/tmp/simulta-biomes`, serving `9cbe5da` from the worktree
`/tmp/wt-biomes-play` (detached at that commit; `dist/` and `sim/target` built there, wasm hashes match). Rooms: `/r/HPAPXT`
(Deathmatch L), `/r/THVS7S` (Survival M). Stop it with `kill 31605`, then `git worktree remove /tmp/wt-biomes-play`
and `rm -rf /tmp/simulta-biomes`.

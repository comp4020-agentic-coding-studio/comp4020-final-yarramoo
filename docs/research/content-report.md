# Track B (content): overnight 8-9 Nov report

Lead: Opus. Cap $50 (B0 = $236.32 at 04:46; stop dispatching at $276.32, finish by $286.32; hard stop if the week
reads $366). Branch `content`, worktree `/tmp/wt-content`, ports 8083 / 5183, data `/tmp/content-*`.

## Plan (written before any dispatch)

### Ranking the candidates

| Candidate | Showcase value | Cost / risk | Verdict |
|---|---|---|---|
| **Surface ruins and wells** (user's addition, 8 Nov) | High: the surface is the first thing every player sees (FUTURE "A livelier surface"); a ruin that burns, a well as a second way down | Generation only (`gen.rs`), existing materials (Brick 22, Wood 6), no new sim rules, no enemy budget. Format bump 19, no layout change. Risk is in traversal and spawn columns, both well tested. | **Build (W1)** |
| **Per-biome cave walls** (FUTURE "Dev tools and rendering follow-ups") | Medium-high: every screenshot in a cave changes; ice caves read blue, lava lakes red | Client-only (`client/render.ts` shader plus a per-chunk or low-res tint texture computed once from the pristine world, like D-211's `groundLine`). No sim, no format. Needs a pure helper with a test. | **Build (W3) if budget allows** |
| Rabbits (passive enemy kind) | Medium: life on the surface | New enemy kind across sim, shared, client, server tables; `MAX_ENEMIES` 64 to 80 changes the decode bound; lobby stepping changes the lobby's frozen-enemy rule. A cold review would almost certainly find something on submission eve. | **Cut**: too wide a change the night before submission |
| More frost sprites per ice cave | Low-medium | An L Survival world already generates exactly `MAX_ENEMIES` = 64, so more frost sprites means fewer of something else or raising the budget | **Cut** |
| Surface lake and hills (`biomes-surface.md`) | Medium | Hills move `surface_heights`, which feeds the cave threshold, entrances, the spawn and traversal: the riskiest generation change on the list | **Cut** (a small lake is a later idea; a well with water gives a little of it) |
| Sandbox rooms | Medium for creative play | Server, menu and config work across `server/`, `shared/room.ts` and the menu; not "content" in the sim sense; its own review | **Cut** for this track (could be its own brief) |

### Order and workers (at most 3, one at a time)
1. **W1 (Sonnet, $14 cap): ruined houses and wells**, `docs/briefs/content-w1-structures.md`. Format 19.
2. **W2 (Sonnet, $5 cap): cold review** of W1's sim diff into `docs/research/review-content.md` (read-only).
3. **W3 (Sonnet, $8 cap): per-biome cave walls** (client-only) if spend after W1 + W2 + fixes is under B0 + $30.
The lead keeps planning, the full gate, the screenshots (two seeds at M and L, real room on :8083) and the report.

## W1 (Sonnet): surface ruins and wells
Brief `docs/briefs/content-w1-structures.md`. Commits `b8217d9` (houses and wells, format 19), `bb2e997` (wells, salts,
enemy-budget tests, report). Worker spend $243.05 -> $248.33 ($5.3). Report `docs/research/content-w1-report.md`.
Counts over seeds 1..=8, both presets: M 1 house and 1 water well per world; L 3 houses and 2 wells (half cave, half
water) per world. L Survival still generates exactly 64 enemies.

**Lead review:** the house's walls stopped above both doors, so the lintels and roof formed an arch resting on nothing
(the worker said so and relaxed the float test to "below the door line"). That breaks D-200, and the fault was my
brief (two 12-row doors cannot be grounded in a side view). Sent back to the same worker: one door per house on an rng
side, far wall to the floor (the mine's room rule), float test strict again and shown red against `b8217d9`.
**Salts:** the worker found 260-267 each declared twice (`SALT_MUD_MOVE`/`SALT_GEN_BIOME`, ...): pre-existing, one
group is generation-only (tick 0) and the other is runtime, so draws differ in `tick` only at tick 0 where no material
moves. Not fixed tonight (it would move every pinned world); the new test checks salts from 285 on. Listed for the user.

**W1 fix** (`d385ea7`, same worker, +$2.6): one door per house on an rng side, far wall to the floor, roof gap top row
only; strict float test red against the two-door code ("house at 44 has a floating cell at 77,49"), green after.

## Gate (lead, on `d385ea7`, worktree `/tmp/wt-content`, quiet machine)
`cargo test --release` 473 passed 0 failed (`/tmp/content-g-cargo.log`), clippy wasm clean (`/tmp/content-g-clippy.log`),
typecheck (`/tmp/content-g-tsc.log`), determinism 53/53 (`/tmp/content-g-det.log`), net 464 passed 1 skipped
(`/tmp/content-g-net.log`). Exit 0.

## Open it and look (vite :5183, `/game?world=game[&cfg=survival]&seed=N`, L = default PvP preset, M = Survival)
Seeds 3 and 7 at L and M (`docs/research/shots/content/`). **Found a bug by eye** the gate could not see: the house
interior and the air above a well's coping drew as dark cave wall (02), because `groundLine` counted Brick as ground
and the shaft-rim rule then closed the interior. Fixed by the lead in `client/background.ts` (Brick is built, not
ground; a mine's Brick is always under the surface dirt), test red first ("expected 14 to be 30"), after-shot 03, and
a stray dark column beside a well's coping disappeared too. Commit `73e4550`. Houses read as small ruined lean-tos
(a full far wall, a broken roof, a chimney); wells read clearly (posts, coping; a cave well drops into a tunnel, 05).

## Cold review (W2, Sonnet, read-only, $256.4 -> ~$258) `docs/research/review-content.md`
No must-fix. Verdict: merge. Lead checked each claim in the code:
- **S1 liquid in a cave well's shaft** (oil/acid/gas/ice water placed after the wells): real gap in the test only (the
  shaft's Empty check already covered `floor..bottom`; nothing covered the opening rows). The well test now rejects any
  liquid or gas in `floor..=bottom+3`; shown red by injecting Oil at `bottom+2` in the generator ("15 in the cave well's
  shaft at 741,161"), restored; green on seeds 1..=8 x 3 sizes x 2 presets, so no generator change was needed.
- **S2 dead arena/deep guards in `place_well`**: true (120 rows of reach never get near `deep_top`); kept as cheap
  belt-and-braces, noted here.
- **S3 vacuous test parts**: the fire test now asserts it lit at least 2 houses (red with 4: "the fire test lit only 3
  houses"); dead `reach`, `sky`, `wide` removed.
- Nits (door a step above lower outside ground; `HashSet` in a test file) left: the body steps up 3 and jumps 15.

Final gate on `c34acbf`: cargo 473/0 (`/tmp/content-g2-cargo.log`), clippy wasm (`/tmp/content-g2-clippy.log`), typecheck
(`/tmp/content-g2-tsc.log`); net 465 passed 1 skipped on the same HEAD (`/tmp/content-g3-net.log`). Determinism 53/53 was
on `d385ea7` (`/tmp/content-g-det.log`); the commits after it change only `client/background.ts` and sim tests.

## Cut, and why
- **W3 per-biome cave walls**: cut at B0 + $34 (W3's $8 cap plus review and screenshots would end near the $50 limit).
  Brief ready, client-only: `docs/briefs/content-w3-cave-walls.md`.
- Rabbits, more frost sprites, hills and lake, sandbox rooms: see the plan table above.

## Spend
B0 $236.32. W1 $243.05 -> $248.33 (+$5.3), W1 fix -> $250.89 (+$2.6), W2 review ~$4; lead the rest
(planning, gates, screenshots, backdrop fix). Total at hand-back about $276.3 (B0 + $40).

## Architectural decisions for review
1. **Structures are generation only** (`place_structures` after `place_trees`, before `place_greenery`); `World.structures`
   is test-only output, never sim state. No snapshot layout change; **format 19** so stored worlds reset (not live yet).
2. **A house has one door**; the far wall stands to the floor and grounds the roof (D-200). Two doors cannot be grounded
   in a side view (the first version's roof was an unsupported arch). Cost: houses are one-sided lean-tos.
3. **Well kind per spot**: a cave well (shaft to a cave within `scale_u(h, 120)` rows, a second way down) or a water well
   (solid-walled pit with Water at `>= shallow_top + 6`). M worlds mostly get water wells (60 rows of reach).
4. **`clear_door_yards`** removes shrub and flower cells above 2 rows within 8 columns of a door, rather than widening
   the greenery exclusion (which starved size S and broke `greenery.rs`).
5. **The backdrop treats Brick as built, not ground** (`client/background.ts`); a mine's Brick is always below the
   surface dirt so nothing underground changes; painted Brick never mattered (the line is captured at init, D-211).
6. **Salts 260-267 are each declared twice** (generation and runtime pairs), pre-existing. Not fixed: it moves every
   pinned world. `salts_are_unique` checks salts from 285 on. Worth a decision from the user.
7. Wells' arena and `deep_top` guards are unreachable at today's reach (review S2), kept as cheap guards.

## D-row draft
| D-2xx | 2026-11-08 | **Surface ruins and wells** (Track B): generation places 1 (M) to 3 (L) ruined Brick-and-Wood houses with one 12-row door and the far wall grounding the roof, and 1-2 wells (a 7-wide shaft to a cave, or a water pit) on the real ground, outside the spawn columns and the arena; greenery avoids them. Format 19, no layout change. The backdrop no longer counts Brick as ground. | The user's 8 Nov addition. The first version's roof was an unsupported arch (two doors), sent back. Cold review: no must-fix; S1 and S3 tightened tests. Seen on seeds 3 and 7 at M and L; the backdrop bug was found by eye. `docs/research/content-report.md`, `review-content.md`. |

## Engineering-decisions entry draft
"A surface you can read": ruins and wells as generation-only content (no new sim rules, no enemy budget), held to the
mine's D-200 rule that nothing floats, which is why a house has one door. The screenshot caught what 473 tests did
not: the backdrop's ground line (D-211) treated a ruin's Brick as terrain and painted the inside of every house as
cave. Links: commits `b8217d9`, `d385ea7`, `73e4550`, `c34acbf`.

## FUTURE.md ideas (listed, not added)
- House interiors worth entering (a table, a chest pickup, a ladder to the roof gap) (W1).
- Draw water from a well into a bag (W1).
- Per-biome cave walls (brief ready, cut tonight).
- Fix the duplicated salts 260-267 at the next deliberate generation change.

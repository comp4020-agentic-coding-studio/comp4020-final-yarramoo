# Brief LIFE: more green, passive creatures, and little things that make the world feel full (Opus lead)

Written 7 Nov by the session model from the user's request: "the world could use more green. More plant life and
non-hostile mobs. Investigate this and little features and things to make the world feel more full." **Spend no more
than $30.** You are the **Opus lead**: investigate, decide what is worth building in the budget, brief and review
**Sonnet/Haiku** workers (one at a time), and own the result.

## Budget and stopping (hard: nothing enforces these but you)
- **$30 total** for you and every worker. Read spend at the start (B0), after every worker returns, and every ~25 of
  your own tool calls:
  `curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
  **Stop dispatching at B0 + $24**; finish, verify and report by **B0 + $30**. Each worker's brief states its own cap
  (Sonnet slices ~$5-8, Haiku ~$1) and its own `/api/me` checks.
- **At most 3 workers, one at a time** (parallel cargo builds wreck the machine's gates). Workers never dispatch.
- Write `docs/research/world-life-report.md` **as you go** (after the investigation and after each slice).
- Spend the first ~$4 investigating and writing a short plan into the report **before** dispatching anything: what
  exists, what's cheap and high-impact, what you're cutting. A small thing finished beats a big thing half done.

## Where
`git worktree add /tmp/wt-life -b world-life multa`. You and every worker work there only. Never touch the main
checkout, never push, never merge into `multa` (the session model gates and merges). Ports: vite **5189**, node server
**8089** with `/tmp/life-data`. Build both wasms in the worktree before vite. Kill everything you start (never the
user's :8080: PID is in `HANDOVER.md`). Remove temp dirs by literal path.

## What exists (read before planning)
- **Plants in the sim** (`sim/src/grid.rs`): Seed (7) grows a Stem (8) with Flowers (9) (`update_seed`, `update_stem`,
  `grow_main`, `grow_branch`); Moss (23, flammable, D-197), Mushroom (24); trees as Wood on the surface (`place_trees`
  in `sim/src/gen.rs`); the moss grotto biome (D-198). Seeds are paintable; Stem/Flower aren't.
- **The cut surface work**: `docs/briefs/biomes-surface.md` (hills, a mountain, a surface lake, tree canopies, shrubs,
  sand traps), cut on 6 Nov for budget (D-199), and FUTURE.md's "A livelier surface" and "Biome follow-ups" entries.
  Read them: some of it may be the cheapest path to "more green".
- **Enemies** (`sim/src/enemy.rs`, `sim/src/tuning.rs`): kinds 0-7 (slime, imp, acid slime, worm, Deep Mage, lava
  wisp, frost sprite, Sand Colossus), `ENEMY_STATS`, placement in `enemy_spots`/`imp_spots`/`floor_spots`
  (`sim/src/gen.rs`), `MAX_ENEMIES` = 64 and **a size-L Survival world already generates exactly 64** (the budget is
  full: `sim/tests/boss_choice.rs` guards it). A passive creature as an enemy kind must fit that budget (a separate
  small cap, or fewer of something else) and must not count as a kill target that blocks or changes a round.
- Client mirrors for any new kind: `shared/sim.ts` `NUM_ENEMY_KINDS`, `client/worker.ts` and `client/hover.ts`
  `ENEMY_MAX_HP`, `client/fx.ts` sprites, `client/toasts.ts` names and death text, `shared/stats.ts` `isBossKind`.
- The menu backdrop (`client/menu/backdrop-config.ts`, D-210) is a real Caves sim: new life shows there for free.
- The background is fixed at generation now (D-211).

## Ideas to weigh (yours to pick, cut, or replace)
- **Green on the surface**: grass (a thin living layer on exposed Dirt that spreads slowly and burns), tree canopies
  (leaves on the existing trunks), shrubs, flowers seeded by generation, vines down cave mouths, more moss on cave
  walls near water. A new material is a sim change: cell rules must keep chunk sleeping invisible (invariant 8: a
  slow or chance rule must keep its chunk awake while it can still act: see D-208 and the Mud rule for the pattern).
- **Passive creatures**: e.g. surface critters (rabbits/birds) that hop or fly, flee players, never deal damage; cave
  bats; fireflies or glow bugs near the grotto. Cheapest honest version first. **Mobs are sim entities**: client-only
  drawn critters would be decoration, not world state; say which you chose and why.
- **Small touches**: falling leaves, pollen, drips from cave ceilings, ambient sounds. Prefer client-only cosmetics
  (render/fx) where they're honest decoration, since they cost no format bump or determinism risk.

## Rules that bind this work (CLAUDE.md; break one only by asking the user via the session model)
- Sim invariants 1-11: integers only, no floats in `sim/`, counter-based rng with **new unique salts** (grep every
  `SALT_` constant; the last ones used are around 275-277 and the spells' salts), no HashMap, sleep invisibility, and
  **every per-tick behaviour bounded**.
- Any sim change: bump `FORMAT_VERSION` if a record or the grid's meaning changes (sim and `server/db.ts`), regenerate
  golden pins as `sim/tests/golden.rs` documents, re-aim determinism M5 cuts only by probing (never loosen guards).
- **Show every new test red first.** Grep constants, not just functions, when adding a kind or material (the boss
  slice left `server/` counting only kind 4; a net test once used a now-real id as "unknown").
- New materials: every mirror (`shared/names.ts` MATERIAL_NAMES/MATERIAL_CLASS, `client/materials.ts` palette,
  `isPaintable`, hover names, the spells/material tables tests).
- Run the full gate (the `run-tests` skill) in the worktree before handing back if anything in `sim/` changed, and
  `APP_URL=http://localhost:8089 pnpm check` against your own server (it defaults to the user's :8080).

## Verify and hand back
- **Look at it**: screenshots of the surface, a cave, and the menu backdrop at 1280x800 (dev-tools skill), before and
  after; Read every png. Two seeds at least, M and L.
- `docs/research/world-life-report.md`: what was built and cut, per-worker spend and total, gate results with log
  paths, screenshots under `docs/research/shots/life-*.png`, **Architectural decisions for review**, a D-row draft and
  an engineering-decisions entry draft, FUTURE.md ideas (listed, not added).
- Branch `world-life` committed, not pushed. Commits end with the writing model's `Co-Authored-By` line (Opus:
  `Claude Opus 5.5 <noreply@anthropic.com>`; Sonnet: `Claude Sonnet 5.5 <noreply@anthropic.com>`; Haiku:
  `Claude Haiku 5.5 <noreply@anthropic.com>`).

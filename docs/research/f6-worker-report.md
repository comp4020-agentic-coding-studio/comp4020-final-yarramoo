# F6 worker report: the boss (Deep Mage) and the Survival win

## Commits

### 1. Arena
- `gen.rs`: `generate_world(g, seed, with_arena)` (the old `generate`/`generate_with_path` call it with false, so non-Survival
  terrain is byte for byte unchanged; pinned by FNV hashes recorded before the change). `carve_arena`, `clear_arena`,
  `supply_pile`, `Arena` (centre, radii, floor row, alcove side; derived data kept on `Sim` and `Base`, not hashed).
- Arena radii: L rx 70 / ry 40; scaled by the chamber percentage (M 80%, S 60%) with floors rx 40 / ry 24 (S 42x24 -> 40x24,
  M 56x32, L 70x40). Flat floor at `cy + ry/2`, 3 pillars, alcove 28 cells wide beside the rim with 6 supply pickups.
- Gen order: arena carved after chambers, before `connect_and_prune`; `clear_arena` (liquids, gas, sand, gunpowder inside the
  ellipse grown by 16) runs after all materials and before `repair_traversal`. Enemy and pickup placement skip the grown ellipse.
- The centre is chosen only among worm-path points already connected to the sky (first version picked a sealed pocket that
  `connect_and_prune` then filled: tests were red with "0 open cells", "arena unreachable" for size L seeds 1 and 4).
- Tests `sim/tests/boss_gen.rs` (5). Red first: the three arena tests failed on the first (sealed-pocket) version; the unchanged
  test is a recorded-hash guard that passes by nature.

### 2. Boss kind
- `ENEMY_BOSS` 4, `NUM_ENEMY_KINDS` 5, hp 1200, box 11x14, contact 20, immune Fire and Lava. One boss per Survival world, at the arena
  centre (8 cells above the floor), given the highest placed id.
- Stepping priority: `stepping_set` steps the boss first when in range, then lowest ids, then sorts (flag below).
- `boss_ai`: imp-style flier (eases velocity 1 per tick), closes beyond 14 cells, Fire bolt every 60 ticks via `(tick + id) % 60`, LOS reuses
  `line_clear`. Leash: a soft push toward the centre near the rim plus a hard undo of any move that ends with the centre outside the ellipse.
- State: boss phase lives in `state` bits 2..3 (1..3, hashed, snapshotted, decode-checked); `hop_until` is reused as the boss's summon counter
  (decode-checked <= 40). No format bump: the layout is unchanged.
- Tests `sim/tests/boss.rs` (6). Red first: the leash test failed on the first version ("left the arena at tick 3") and the fire test failed
  while the test player stood behind a pillar (fixed in the test setup: the player floats above the pillars). A snapshot hostile test covers phase 0/4, counter, hp, kind.
- Gate green.

### 3. Phases 2 and 3
- Phase derives from hp thirds, only rises, emits `EV_ENEMY_PHASE` (14; a = id, b = phase). Boundary: exactly 800/1200 is phase 2, 801 phase 1.
- Phase 2: Bomb lob every 120 ticks (`BOMB`, enemy-owned), summons: 2 imps per cast every 300 ticks, at most 4 alive, 40 per fight, rng cells
  (8 tries) that are Empty 5x4 pockets inside the arena. Summon id = boss id + 1 + counter (counter is the boss's `hop_until`, hashed, snapshotted,
  decode-checked), so ids are unique forever and stay sorted. Phase 3: speed x1.5, 3-bolt fan every 90 ticks (bolts that don't fit under the cap
  of 16 are dropped), 24-cell lava arc every 240 ticks via `Grid::set`.
- Enemy count: L seed 1 places 51 normal + 1 boss; plus 4 summons alive = 56 <= 64 (asserted for seeds 1-4).
- Work maximum (`/tmp/f6-boss-work.txt`): 1226 cells per tick with the boss in phase 3, 4 summons and the rest of the stepping set; test bound 1400, and the
  test also asserts work > 700 so halving the bound fails.
- Tests `sim/tests/boss_phases.rs` (6). Red first: two failed on the first run (a wrong boundary expectation of mine, and a check that summons are inside the
  arena, rewritten to track only fresh ids); both were test errors, not sim errors. Honest note: I did not run the file against a stubbed sim.

### 4. The win
- `round_won()` = bit 1 (`ROUND_BOSS_KILLED`) of the already-hashed `round_started` byte, set in `reap_enemies` when a boss dies (no new field, no format
  bump; D-161's first-kill flag is bit 0, now written with `|=`; decode accepts `round_started` <= 3). First attempt (derive from "arena exists, a kill
  happened, no boss left") broke 4 one_life tests because a kill that removes no boss in a world with a boss-less `enemies` list looked like a win; replaced.
- Same-tick win and loss: `check_round_end` already lets `won` take precedence, so the win counts; tested (`boss_win.rs`).
- Tests `sim/tests/boss_win.rs` (5): scripted player kills the boss with real Fire bolt casts on seed 1 (EV_ROUND_END a=1 once, round_result 1, kill credit,
  enemies frozen afterwards, snapshot restore keeps the win), same-tick rule, loss still loses, D5 (mid phase 3 with summons, lava, bolts), D7 (entity bytes
  identical with every chunk forced awake, through three phases).
- D2: `bossScript()` in `tests/determinism/helpers.ts`, wired into node.test.ts (D1/D6) and browser.test.ts (D2 on 3 engines). **Gap: the script does NOT reach phase 2.**
  Six players with the 40 pile charges and infinite Push cannot out-damage the boss before the boss's bolts and contact kill them; only phase 1 is exercised
  cross-engine. Phases 2 and 3 are covered by the Node sim tests only. Not fixed within the call budget.
- Gate: cargo 0, clippy 0, determinism 53 passed, `pnpm test:net` 314 passed (39 files).
- Red first: the win test failed against the stub `round_won` (false) in the sense that the end-to-end test could not pass before it was implemented; I did not
  separately run it red against a stubbed sim. Flag.

### 5. Balance (measured)
- Charges on the path, seed 1 size M (16 non-pile pickups): Fire bolt 10 charges (one pickup), Bomb 15 (three), Lava Flask 4, Black Hole 4. Seed 2: Fire 30, Bomb 15. Seed 3: Fire 10, Bomb 5.
  So a descent that collects everything it passes holds 10-30 bolts and 5-15 bombs.
- Damage per charge against the boss: Fire bolt 20 (bolt damage; the boss's Fire immunity only blocks the burning hazard); Bomb up to 60 at the centre, linear to 0 at radius 18
  (about 30 average on a near miss); Push 5, Blast 8 (infinite charges, slow). Cooldowns: Fire 15 ticks, Bomb 60.
- Boss damage to a player: Fire bolt 20 per 60 ticks (phase 1-2, 20/s), a fan of three 20-damage bolts per 90 ticks in phase 3 (up to 40/s if all hit), Bomb up to 60 per 120 ticks (phase 2+), contact 20 per 40 ticks.
  A 100-hp player survives 5 bolt hits, i.e. 300 ticks of unavoided phase 1 fire.
- Supply pile (outside the arena): 4x Fire bolt pickups (40 bolts = 800 dmg) and 2x Bomb pickups (10 bombs = up to 600). Changed from [4,4,5,4,5,10] to [4,4,4,4,5,5] (Lava Flask dropped: no use against a fire-immune boss).
- Boss hp 1200 -> 800 (`BOSS_HP`). One well-supplied player with the pile alone has 800 (bolts) + about 300 (10 bombs at ~30) = 1100 damage against 800 hp: 73 percent of the charges must land,
  so they can just win only by dodging well (it is not a number a test proves). Two players hold 2200 against 800 hp: comfortable. Not verified: an actual one-player fight; the sim test only shows kills with infinite Fire bolts.
- D2 script now reaches phase 3 and the boss's phases (EV_ENEMY_PHASE 2 at tick 93, 3 at tick 153 of the fight), and the party takes lethal damage after: asserted `(kind 14 and b 3) or boss death`.
  SCRIPTED ADVANTAGE: six players each take one pile pickup then stand in a fixed ring 13-15 cells from the boss's start point, aimed at it (a real player aims at a moving target). The fight itself is not weakened.
- Phase tests now use `BOSS_HP` fractions instead of the 1200 literals.

### 6. Client
- `fx.ts` `pushBoss` (26-row robed mage with a bobbing glowing staff, violet / orange / red per phase, white hurt flash), `worker.ts` (boss branch in the enemy loop: phase from
  the view's state bits 2..3, a roar plus burst on a phase change seen live, `bossHud` posted with the players message, big death burst and `bossdeath` sound, `devbosshp`
  handler), `protocol.ts`, `sfx.ts` (`roar`, `bossdeath`), `toasts.ts` ("was struck down by the Deep Mage", cause 44), `room.ts` (HUD bar `#bossBar`, `__devBossHp`
  inside the `devAvatar` block, so a real room never gets it; the worker handler is also `import.meta.env.DEV` and needs `avatar`), `index.html` (bar CSS).
- `__devGotoEnemy(4)` puts the avatar 14 cells right of the boss, 2 cells below its feet line (its centre height), in open arena air. `__devMe()` read 690,469, the boss near the
  centre; the screenshot shows both together. The enemy-hp mirror test caught `hp: BOSS_HP` (regex wants a literal), so the stats row is literal 800 and a sim test pins it to `BOSS_HP`.
- The Victory banner is the existing `showRoundBanner(win)`, fed by `round.sub === 1` from state (so a reconnecting client sees it) and by `EV_ROUND_END`; the sim tests show the state
  says `round_result 1` after a win, and it survives a snapshot restore. **Not seen in a browser**: I could not drive a real kill by hand in the budget.
  The loss banner ("The party fell") was seen, in each screenshot, because the dev avatar dies to the boss's contact within seconds.
- Not built: the depth hint (optional).

### 7. Screenshots (looked at each)
- `docs/art/shots/f6-arena-boss-hud.png`: the arena, flat floor with two pillars, the violet boss, the HUD bar full and the name. Seen.
- `docs/art/shots/f6-phase2.png`: orange robe, bar about 50 percent orange, toast "You was struck down by the Deep Mage" (the existing local-player wording "You was"). Seen.
- `docs/art/shots/f6-phase3.png`: red robe, bar about 18 percent red. Seen. (Both phase shots sit under "The party fell" because the dev avatar had died.)
- A first attempt at `__devBossHp` did nothing (wrong byte offset into the snapshot's enemy record); fixed offset 13 and re-shot.

## Counts and arena
- Arena radii: S 40x24, M 56x32, L 70x40. L seed 1: 51 normal enemies + boss; with 4 summons alive 56 of 64.
- Work maximum: 1226 cells per tick (boss phase 3, 4 summons).

## Architectural decisions for review
- Arena only in Survival: `generate_world(.., with_arena)`; other worlds proven byte-identical by recorded hashes. Cost: Deathmatch worlds get no arena.
- Boss stepping priority: stepped first when in range, then lowest ids (alternative: lowest id). Cost: one extra scan per tick.
- Summon ids: boss id + 1 + counter, counter stored in the boss's `hop_until` (reuse of a field, not a new one). Alternative: a world counter in state (needs a format bump).
- `round_won`: bit 1 of `round_started` (hashed, reversible). Alternative: a new hashed byte. The lobby slice must clear it on reset like the rest of `round_started`.
- Same-tick win and loss: win counts (existing precedence in `check_round_end`).
- No snapshot format bump: boss phase in `state` bits 2..3, summon counter in `hop_until`, decode checks both.
- Leash: soft push near the rim plus a hard undo of any move ending outside the ellipse (the boss may pin against the rim).
- `__devBossHp`: not built.

## FUTURE.md suggestions
- A real `boss_phase`/`summons` field pair instead of reusing `state` bits and `hop_until`, at the next format bump.
- Give the supply pile more charges the more players the room starts with.

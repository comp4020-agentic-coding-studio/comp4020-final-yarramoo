# INT-2 report: the Sand Colossus as a per-seed boss (branch `int-boss`)

## Commits (on `int-boss`, from multa 702ca1b)
1. `f79c665` sim: Colossus as kind 7, `Enemy.last_hp`, format 15, per-seed `boss_kind`, tests, golden and perf re-recorded.
2. `e03af12` client: sprite, hover box, name, death toasts, boss bar named by kind.
3. docs commit (this report, D-205, FUTURE.md, screenshots).

## Per-file changes
- `sim/src/tuning.rs`: `ENEMY_COLOSSUS = 7`, `NUM_ENEMY_KINDS = 8`, stats row (600 hp, 11x12, weak to water), the `COLOSSUS_*` constants (no `COLOSSUS_SIZE`).
- `sim/src/enemy.rs`: `colossus_ai` (24 shed, 361-cell scan, 10-cell shower per tick), `is_boss`, stepping priority and win/heal-drop use `is_boss`. **Bug fixed from the branch:** the re-form pass ran on an enemy already at 0 hp and could revive it, so a lethal hit sometimes did not win the round (test `a_lethal_hit_kills_on_every_tick_phase`, shown red first on offset 0).
- `sim/src/sim.rs`: `boss_kind(seed)`; arena spawn picks the Colossus (standing on the floor) or the Mage (hovering).
- `sim/src/rng.rs`: salts 275 (boss kind), 276, 277 (shed, shower); grep showed 274 was the highest.
- `sim/src/entities.rs`, `snapshot.rs`, `server/db.ts`: `last_hp`, format 15, `ENEMY_BYTES` 40, decode validation (above).
- `shared/sim.ts`, `client/{worker,hover,fx,toasts,room}.ts`: kind 7 mirrors. `__devBossHp` now finds either boss and matches its kind byte.
- Tests: new `sim/tests/colossus.rs` (11) and `boss_choice.rs` (3); `MAGE_SEED = 2` in `boss.rs`, `boss_phases.rs`, `boss_win.rs`, `lobby.rs`, `golden.rs`; `boss.rs` one-boss test uses seeds 2-5; `boss_gen.rs` uses `is_boss`; format and byte-size pins in `bags.rs`, `heals.rs`, `config_state.rs`, `enemies.rs`, `tests/net/entity-layout.test.ts`; `golden-v14.bin` renamed `golden-v15.bin`.

## Which seeds roll which boss
`rng(seed,0,0,0,275) & 1`. Over 1..=64: 21 Colossus (1, 6, 10, 12, 16, 25, 27, 30, 31, 32, 35, 40, 42, 47, 48, 49, 50, 56, 58, 59, 61), 43 Mage (2-5, 7-9, 11, ...). Over 1..=4096: 2045 Colossus (49.9 %). The 64-seed test requires at least 16 of each.

## Budget
Size L generates exactly 64 enemies including the boss (one boss, not two), so the count did not grow. `the_enemy_budget_holds_and_every_world_round_trips` checks seeds 1-32 at sizes S, M, L, both Caves presets with enemies: count <= `MAX_ENEMIES`, and `restore(write(s))` equal in enemies and hash. The Colossus does no summoning, so its enemy count cannot grow at all. The Mage's summons check `MAX_ENEMIES` before spawning (`enemy.rs`).

## Golden pins
Moved: `SCRIPTED_HASH` (seed 1 now rolls the Colossus, and format 15 changes the hash input), the golden snapshot bytes, and `perf-trace.txt`: every `survival_l` hash line and the 9 snapshot-hash lines. The mat/aux plane hashes in the non-survival scenarios did not change (first columns identical; only the final snapshot hash moved, because of the new field). Determinism M5 cuts: see gate result.

## Looked at (vite :5195, `docs/research/shots/`)
- `int-boss-colossus-p1.png`: seed 1, `__devGotoEnemy(7)`; the tan Colossus beside the player, bar "The Sand Colossus" full, purple.
- `int-boss-colossus-p2.png`: `__devBossHp(380)`; bar orange at 63 %.
- `int-boss-colossus-p3.png`: `__devBossHp(150)`; bar red at 25 %. The sprite is small at this zoom; eye colour per phase is not legible.
- `int-boss-mage-seed2.png`: seed 2 rolls the Mage; unchanged ("The Deep Mage" bar, purple robed sprite).
- First attempt (not kept) showed the death toast "You was buried by the Sand Colossus": the Colossus kills a standing player in about 3 s on contact (20 contact damage per 40 ticks, a 20-hp player), as the Mage does.

## Architectural decisions for review
1. **Boss kind by `rng` parity of the seed** (salt 275). Alternatives: by size (the branch), by a config byte. Costs: every seed's boss is fixed, so a changed salt or formula changes which seed has which boss and every pinned seed; it is a pure function so tests can pin it.
2. **Real `Enemy.last_hp u16`, format 15**, rather than reusing `summons` or deriving last hp from the previous tick. Alternative: `last_hp` held only in a `Vec` in `Sim` outside the record (rejected: must be hashed and snapshotted). Cost: all enemy records grow 2 bytes (about 130 bytes per L world); old stored worlds reset (game not live).
3. **Colossus is the odd-draw boss, standing on the floor** at the arena centre, same arena as the Mage. Fit checked at S: hit box clear at spawn, stays inside the leash ellipse for 600 ticks of fighting. Cost: the arena was designed for a flier; pillars (4 wide) can block its walk (it steps up, as slimes do).
4. **`is_boss(kind)` helper in `enemy.rs`** is the single place that lists the boss kinds; any third boss must be added there.
5. **Re-form guard `e.hp > 0`** (bug fix above), cheaper than moving reaping.
6. `MAGE_SEED = 2` pinned in five test files rather than a shared helper (reversible: a common `tests/common` module would be tidier but adds a module to every test binary).

## FUTURE.md
Added: balance pass for the Colossus; show the boss on the room card or lobby.

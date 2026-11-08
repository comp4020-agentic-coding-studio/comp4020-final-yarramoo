# Review: int-enemies (lava wisp, frost sprite)

Diff read: `multa..int-enemies`, sim, client and shared parts. Read-only; nothing run.

Nothing serious found. No blocker, no should-fix.

## Checked clean (checked in code)
- Determinism: no floats, no HashMap, no usize in a hash. Salts 270..274 are unique (script over every `pub const SALT_*` found no duplicate values). Anchored picks use `rng(seed, 0, k, 0, salt)` only. The trail uses `tick` and `e.id`; the only state it keeps is `state` bit 0, which is reset every step.
- Sleep invisibility: the trail writes through `grid.set`, which calls `touch`, so chunks wake. The scan reads `grid.mat` directly, which is the same with sleep on or off. Stepping is decided by `stepping_set` (distance to players), not by chunk sleep.
- Bounds: `wisp_trail` is one shared budget of 1 per tick, passed to every `wisp_ai` call. The 81-cell scan is added to `enemy_work` (enemy.rs:160) and only runs after the cheap gates (hunting, budget left, the tick modulus, centre cell Empty). `stepping_set` is capped at 24. Placement loops are capped at 6000 tries per kind.
- Snapshot: decode accepts kinds below `NUM_ENEMY_KINDS` (7), `hp` is bounded by `ENEMY_STATS[kind]` (entities.rs:455-468), `state <= 3` still holds, and phase and summons must be 0 for non-bosses. `ENEMY_STATS` has 7 entries. The TS mirrors (`shared/sim.ts`, `worker.ts`, `hover.ts`, `toasts.ts`, `fx.ts`) were all extended to 7 entries, and the hp values match the Rust. The `CAUSE_ENEMY_BASE + kind` toast array has 7 entries.
- Placement: indices are safe (`y >= 8`, `y + 7 < h`, x clamped to 40..w-41). The 13x13 Empty pocket check rules out rock, liquid and sealed pockets smaller than 13x13. The arena keep-out and the pickup and spacing checks are kept.

## Findings

1. nit, gen.rs:675-686, checked in code. `imp_spots` still has no spawn-column clearance (`ENEMY_SPAWN_CLEAR` / `ENEMY_SPAWN_ROWS`), although its doc comment says "off the spawn column". The old imp rows sat deep enough that this did not matter. The anchored frost sprites take their y from an ice site's bounding box, with no row floor beyond `y >= 8`. If an ice-cave site ever reaches the top rows near the world centre, a sprite could spawn near the player spawn. Failure scenario: a frost sprite at the spawn, with contact damage 6. Suspected: I did not check how shallow ice sites can be placed. Suggested fix: reuse the spawn-clearance test used in `floor_spots`.

2. nit, gen.rs:672, checked in code. Anchored picks only require a 13x13 Empty pocket near the site, with the biome material within 24 cells. The pocket may not connect to the walkable cave, so a wisp or sprite can sit in an enclosed pocket. It is a flier and the trail is capped, so the effect is harmless, and a sealed one only wakes when a player comes within the active box.

3. nit, tuning.rs:178 and enemy count, checked by arithmetic. At size L, 25 slimes + 8 imps + 10 acid slimes + 8 worms + 6 wisps + 6 sprites + 1 boss = 64, exactly `MAX_ENEMIES`. Decode refuses more than 64. Any future added kind or a minimum-count floor that raises the total would make generation produce a snapshot its own decoder rejects. Worth a debug assert or a test that the generated count is at most `MAX_ENEMIES`. Suspected for other sizes, since the `*_MIN` floors apply per kind; I did not compute them.

4. nit, enemy.rs:148-160, checked in code. The local cap is a 9x9 box with at most 5 trail cells, and a trail cell is only written into an Empty centre cell. A fallen Lava trail cell flows away, so the cap does not bound total lava in the world over time, only the write rate (1 per tick across all wisps). That matches the stated design.

5. nit, gen.rs:673, style only. There is a double space in `h ||  (0..13)`.

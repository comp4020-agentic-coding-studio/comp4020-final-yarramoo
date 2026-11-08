# Brief life-W2: rabbits, a passive creature as a sim enemy kind

**Model:** Sonnet. **Dollar cap: $8.** Read your spend at the start and after every commit:
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
If you are $7 over your starting figure, stop, commit only what is green, and finish the report. **Tool-call cap: 110.**
**Do not dispatch subagents.** Work only in `/tmp/wt-life` (branch `world-life`). Never touch the main checkout
(`/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`), its :8080 server, `multa` or `main`. **Do not push.**
Do not start servers or browsers (the lead does). Every `rm` names a literal absolute path.

Read first: `CLAUDE.md` (sim invariants), `.claude/skills/run-tests/SKILL.md`, `docs/research/life-w1-report.md`
(the slice before yours: surface greenery, format 17), and: `sim/src/enemy.rs` (`step_enemy` slime branch,
`update_enemies`, `stepping_set`, `reap_enemies`, `enemy_contact`, `boss_summon`'s id rule), `sim/src/tuning.rs`
(enemy kinds, `ENEMY_STATS`, `MAX_ENEMIES`, slime constants), `sim/src/gen.rs` (`enemy_spots`, `floor_spots`),
`sim/src/sim.rs` (enemy creation in `Sim::new`, `in_lobby`, `spawn_point`).

**Report as you go** to `/tmp/wt-life/docs/research/life-w2-report.md` (append after each commit: what landed, each
test shown red and how, commit hash, spend). It ends with **"Architectural decisions for review"** (what, the
alternatives, why, the cost later; when unsure take the more reversible option and flag it), and may suggest
FUTURE.md ideas (the lead decides).

## Files you may touch
`sim/src/enemy.rs`, `sim/src/tuning.rs`, `sim/src/gen.rs` (rabbit placement only), `sim/src/rng.rs` (new salts:
the next unused numbers after W1's; grep `pub const SALT_` to confirm), `sim/src/sim.rs` (only if needed for the
lobby rule), `sim/tests/*.rs`, `sim/tests/fixtures/*`, `shared/sim.ts` (`NUM_ENEMY_KINDS`), `shared/stats.ts`,
`server/main.ts` (`onKillResolved` only), `server/achievements.ts` (only if cleaner than main.ts),
`client/worker.ts` (`ENEMY_MAX_HP`, death/hurt burst colour and sfx choice for kind 8, nothing else),
`client/hover.ts` (`ENEMY_MAX_HP`), `client/toasts.ts` (`ENEMY_NAMES` and death text), `client/fx.ts` (the
rabbit sprite in `pushEnemy`), `tests/net/*.test.ts` that pin these tables, and your report.

## What to build

A **rabbit**: enemy kind `ENEMY_RABBIT = 8` (`NUM_ENEMY_KINDS` 8 -> 9 in Rust and `shared/sim.ts`).
- **Stats**: hp 10, body 5 x 4, `contact_damage: 0` (so `enemy_contact` returns early), no immunities, no weakness.
  It never deals damage in any way.
- **Behaviour** (a new `rabbit_ai` beside the slime branch of `step_enemy`, integer only, reusing `integrate` and
  `enemy_blocked`): when grounded and its hop timer has passed,
  - if the nearest alive target is within `RABBIT_FLEE_CELLS` (about 40) it **flees**: hops away from that player
    (vx about 6, vy about -11, timer 10-20 ticks via counter rng), facing away;
  - otherwise it **idles**: about 1 in 3 timer expiries a small hop (vx 2-3, vy -7) in an rng direction, else sits;
    timer 40-120 ticks. Use new salts, never reuse the slime's.
  - Gravity, fall cap and step-up as the slime. It never targets, never trails anything, never hunts.
- **Placement**: on the **surface** only, in worlds with enemies (`cfg.has_enemies()`, i.e. Survival and the menu
  backdrop; PvP and the sandbox get none: say so in the report). Count `scale_count(w, h, ENEMY_RABBITS_L = 16,
  ENEMY_RABBITS_MIN = 5)`. A spot: an rng column x in `40..w-40`, outside the spawn columns
  (`|x - w/2| > SPAWN_JITTER + 7*16 + 8`), scan down from row 0 to the first non-Empty cell, which must be **Dirt**
  (not a tree, canopy, shrub or water); the 5 x 4 body above it must be Empty; at least 24 columns from every other
  rabbit. Bounded tries (e.g. 40 x the count). Append rabbits **at the end of `enemy_spots`'s list**, so they get
  the highest placed ids **below the boss** (the boss is pushed after `enemy_spots` in `Sim::new`, and its summons
  take ids `boss id + 1 + n`, so nothing may be placed after the boss). Lowest ids step first, so hostile enemies
  keep the stepping budget when a crowd exceeds 24.
- **Budget**: `MAX_ENEMIES` 64 -> 80 (decode bound and summon cap; no layout change, format stays 17 from W1).
  Keep `sim/tests/boss.rs`'s `enemies.len() + BOSS_SUMMONS_ALIVE <= MAX_ENEMIES` and `boss_choice.rs`'s budget test
  green unchanged (they read the constant), and add a test that hostile counts per kind are unchanged by the rabbits
  (compare against the counts with rabbit placement disabled, or pin them for seeds 1..=4 at sizes 1 and 2 from a run
  of the code before your change).
- **Lobby**: Survival rooms sit in the lobby on the surface, where the rabbits are, and `update_enemies` returns in the
  lobby. Let **only passive kinds** step in the lobby (hostile enemies still freeze; nothing can be damaged there
  anyway, `damage_enemy` returns in the lobby). Keep it a pure function of hashed state.
- **Death**: no heal drop for a rabbit (skip it in `reap_enemies`), and no round effect (`round_won` reads only
  `boss_killed`: keep it so). It still emits `EV_ENEMY_DEATH` (the client's burst and the claim path need it).
- **Server**: a rabbit kill must not count for achievements or kill stats. Add `isPassiveKind(kind)` to
  `shared/stats.ts` (`ENEMY_KIND_RABBIT = 8`) and return early from the achievements/stat bumps for it in
  `onKillResolved` (`server/main.ts` ~589). The `kills`/`killsByKind` log counters may keep counting it.
  `server/` must not import from `client/`.
- **Client**: `ENEMY_MAX_HP` gets `10` appended in **both** `client/worker.ts` and `client/hover.ts`; `ENEMY_NAMES`
  gets `"Rabbit"` (and the death text helper must still produce "Killed by a rabbit" for the table test);
  `pushEnemy` in `client/fx.ts` draws a 7 x 5 pixel rabbit (long ears, white or light-brown body, dark eye, a
  pink inner ear, a fluffy white tail; a "hop" frame when `air === "rising"`), mirrored by facing (the view's bit 7
  is in `e.health`; pass it through only if it is a one-line change, otherwise draw it facing right). A soft beige
  burst colour on hurt and death; reuse an existing quiet sfx (e.g. "squelch" at volume 0.25), no new sound.

## Tests (new `sim/tests/rabbits.rs`; also extend existing tables' tests)
- placement: Survival at sizes 1 and 2, seeds 1..=8: at least `ENEMY_RABBITS_MIN` rabbits, all standing on Dirt
  within 3 rows of the surface line, none in the spawn columns, all ids below the boss's;
- passive: a player standing on a rabbit for 300 ticks (round running) loses no health;
- flees: a player placed 20 cells left of a grounded rabbit: after 120 ticks the rabbit's x has increased by at least
  8 cells (state what you measured); with the player 20 cells right, it moves left;
- lobby: in the lobby a rabbit near a player moves (it fled), while a slime placed near the player does not move;
- dies and drops nothing: kill a rabbit (Blast it, or damage via a hazard) and check `EV_ENEMY_DEATH` with `c == 8`,
  no heal created, `boss_killed == 0`, round not over;
- hostile counts unchanged (above); the enemy budget tests still pass;
- sleep invisibility: an existing sleep-on vs sleep-off hash test that runs a Survival world with a player on the
  surface for >= 600 ticks still passes (name it in the report; add one if none covers the surface);
- net: the tables tests (`tests/net/spells-table.test.ts` `ENEMY_MAX_HP`, `tests/net/toasts.test.ts`,
  `tests/net/claims-events.test.ts` `NUM_ENEMY_KINDS`) pass with the new kind; add a unit test that
  `onKillResolved` (or the helper you add) does not bump `enemy_kills` for kind 8 if a test harness for it exists
  (`tests/net/achievements*.test.ts`), else test `isPassiveKind`.
**Show each new test red first** (break what it guards, e.g. give the rabbit contact damage, reverse the flee
direction, drop the lobby rule, let it drop a heal), see it fail on that assertion, restore from a copy, record it.

## Pins
Placement changes every Survival world and the menu backdrop: re-record on purpose, as each file documents:
`HF_REGEN=1 cargo test --release --test golden -- --nocapture` (fixture + `SCRIPTED_HASH`), `PERF_REGEN=1 cargo test
--release --test perf_equiv` (say which scenarios moved; the sandbox must not). `non_survival_worlds_are_byte_for_byte_unchanged`
must **not** move (rabbits only exist with enemies): if it does, stop and say why. Run `pnpm vitest run --config
vitest.net.config.ts tests/net/menu-backdrop.test.ts`: if the vignettes still hold, leave them; if it fails, report
it and do not change the vignette constants (the lead decides).

## Commit checklist (one commit each; message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`)
- [ ] sim: kind 8, stats, AI, lobby rule, no heal, placement, `MAX_ENEMIES` 80, salts, `sim/tests/rabbits.rs`,
      re-recorded pins, `shared/sim.ts` `NUM_ENEMY_KINDS` (so the kind-count test stays green)
- [ ] client and server mirrors: sprite, tables, names, `isPassiveKind`, the server skip, net tests
- [ ] report finished

**Per commit** (repo root `/tmp/wt-life`, chained, logs to files, never piped; `uptime` first, wait if load > 16):
```
(cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release > /tmp/w2-cargo.log 2>&1) \
 && (cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings > /tmp/w2-clippy.log 2>&1) \
 && pnpm typecheck > /tmp/w2-tsc.log 2>&1 \
 && git add <files by name> && git commit -q -F /tmp/w2-msg.txt; echo "exit $?"
```
For the client/server commit also chain the net tests you touched, by file
(`pnpm vitest run --config vitest.net.config.ts tests/net/<file>.test.ts ...`). The lead runs the full determinism
and net suites. Iterate with single files (`cargo test --release --test rabbits`).

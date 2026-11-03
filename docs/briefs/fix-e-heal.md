# Brief E: heal drops from killed enemies

**Why:** 3 Nov playtest note 11: "In survival, there needs to be a way to recover health". The user decided (3 Nov):
**heal pickups dropped by killed enemies.** Survival has one life, and today nothing heals, so every hit is
permanent.

Read these first:
- `CLAUDE.md` (the sim invariants are binding);
- `docs/playtest-2026-11-03.md` note 11;
- D-157, D-158, D-176 and D-177 in `docs/DECISIONS.md`.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 100 tool calls. You work on `multa`
directly (no other worker is running). Rules:
- `CLAUDE.md`;
- red-first tests;
- gate on exit codes chained with `&&`;
- `rm` only on literal absolute paths;
- **no pushing**;
- never weaken a test;
- stop any vite or server you start.

Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`. Run single test files while iterating, and the full gate once per
commit. `pnpm test:net` takes about 8 minutes, so run it in the background.

## The design (defaults the session model chose for the user to tune; flag anything that doesn't work)

- **A new entity, `Heal`** (a small `Vec<Heal>` on `Sim`, like `bags`): a cell position (u16 x, u16 y), an
  amount (u8), and `expires_at` (u32).
- **Dropped in `reap_enemies`** (`sim/src/enemy.rs`) for each enemy that dies:
  - a normal enemy drops one with chance **1 in 3**;
  - the **boss always drops one**, though the round is won then, so this is mostly for show; keep it simple;
  - the draw is counter-based: `rng(seed, tick, x, y, SALT_HEAL_DROP)` with the enemy's cell position. Add a new
    salt. **No stateful RNG** (invariant 6). Hash only fixed-width integers (invariant 7).
- **Amount:** **25 hp**, capped at `HEALTH_MAX` (100).
- **It falls and is collected exactly like a bag:**
  - `update_bags` (`sim/src/spells.rs`) moves a bag one cell down through Empty or gas, then a living
    player whose hitbox covers it takes it, in player-id order. Do the same in a sibling `update_heals`,
    called right after `update_bags` in `update_entities`;
  - a full-health player does **not** take it (it stays for a teammate);
  - a dead player can't take it.
- **Lifetime:** `HEAL_LIFETIME` = 3600 ticks (60 s). **Cap:** `MAX_HEALS` = 16. At the cap, the oldest is evicted,
  as bags do.
- **Where it applies:** only in worlds with enemies (`cfg.has_enemies()`), which means Survival. No change to
  Deathmatch or the sandbox.
- **An event:** `EV_HEAL` (a new event kind) with the player, the amount and the position, so the client can
  play a sound and a toast. It's read-only, never an input (invariant 9).
- **Entity view:** expose heals in `entities()` as a new `ENT_HEAL` type (position, amount), mirrored in
  `shared/sim.ts`, so the client can draw them.
- **State:** heals are in the **state hash** and the **snapshot**. Bump `FORMAT_VERSION` 10 to 11 and the
  `server/db.ts` mirror (a net test pins them). The pinned format tests in `sim/tests/bags.rs` and
  `config_state.rs` move to 11.
- **Bounded:** at most `MAX_HEALS` heals, each with a few cell reads per tick.
- **Sleep invisibility:** like bags, a heal only reads the cell below it and lives outside the grid. Say so in a
  comment, as `update_bags` does.

## Client (render-only)

- Draw a heal in `client/worker.ts` next to the bags (`pushBag` pattern): a small red cross or heart, about 3 x 3
  cells, with a gentle pulse so it reads at 1x zoom.
- On `EV_HEAL` for the local player: a short sound (reuse an existing `sfx` name such as `pickup`, or add a soft
  "heal" synth in `client/sfx.ts`), and a small "+25" floating text if there's an existing pattern (`fx.ts`
  particles or toasts). Keep it light.
- Nothing else in `client/`.

## Tests (red first)

- A killed enemy drops a heal deterministically for a known seed, tick and position. Find a case where the draw
  passes, and another where it doesn't, and assert both.
- The boss always drops one.
- A hurt player who walks onto it gains 25 (capped at 100), and the heal is gone. A full-health player leaves it.
  A dead player can't take it.
- It falls through empty space and stops on ground. It expires after `HEAL_LIFETIME`. At most `MAX_HEALS` exist.
- Snapshot round-trip with heals present, then run on, hashes the same as an uninterrupted run (D5-style).
- Sleep on and off, identical, with a heal falling.
- Determinism suite unchanged. If any recorded scripts kill enemies, their expectations may change: update them
  only where the deliberate rule change causes it, and say which.
- **Balance note (report only, don't tune):** with these defaults, how much healing does a full solo descent
  offer? Count the enemies on seed 1 at size M, multiply by 1/3 and by 25, and compare with the boss fight's
  damage.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

## Commit checklist (commit each separately)

- [ ] 1. Tests, red (`#[ignore]`d if they can't compile yet, as earlier slices did).
- [ ] 2. The `Heal` entity, drops, falling, pickup, expiry, the event, the entity view, the hash, snapshot format 11
      and the db mirror. Tests green.
- [ ] 3. Client drawing, sound and toast.
- [ ] 4. Your report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Files you may touch

- `sim/src/{sim,enemy,spells,entities,snapshot,hash,tuning,lib}.rs`, `sim/tests/*.rs`;
- `shared/sim.ts`, `server/db.ts` (the format mirror only);
- `client/worker.ts`, `client/fx.ts`, `client/sfx.ts`, `client/room.ts` (only the toast or sound hook);
- `tests/determinism/*` (expectations only), `tests/net/*.test.ts` (only if a pin needs it);
- your report.

## Report

Write `docs/research/fix-e-heal-report.md` as you go. It should cover:

- per commit: the hash, what changed, and the red-first evidence;
- the balance note;
- what you couldn't verify;
- **"Architectural decisions for review":** the `Heal` entity shape, the drop rule and rng inputs, the pickup
  rule (full health leaves it), and the snapshot and hash layout. For each: what you chose, the alternatives, why,
  and what it costs later.
- FUTURE.md ideas, suggested only.

# Brief B: falling rock and painting (Pebbles, hard-material paint, seed sprinkle, no Stem/Flower)

**Why:** 3 Nov playtest notes 5, 14, 7 and 8, plus the user's decisions recorded in the plan at the top of
`docs/playtest-2026-11-03.md`. Read those notes. Look at `docs/art/playtest-2026-11-03/paint-spikes-and-fill.png`
and `dig-sand-column.png`. Then read `CLAUDE.md` (the sim invariants are binding), D-165 (falling rock v0) and
D-172 (the liquid resting rule that just landed) in `docs/DECISIONS.md`.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 100 tool calls. Rules:
- `CLAUDE.md`;
- red-first tests;
- gate on exit codes chained with `&&` (never `;`, never through `grep`);
- `rm` only on literal absolute paths;
- **no pushing**;
- never weaken a test;
- stop any vite or server you start (check `pgrep -fl "vite.js|server/main"` before you finish).

Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`. Run single tests while iterating
(`cargo test --release --test <file>`). Run the full gate once per commit; `pnpm test:net` takes about 8 minutes,
so run it in the background.

## 1. The sand spikes and columns: find the cause first

The symptom has two forms:
- thin vertical sand spikes below paint strokes over dirt (note 5);
- after a single Dig, a 1-2 cell sand column about 100 cells deep through grey rock (note 14).

Sand can't fall through rock (`powder_ok`). Candidates:
- `crumble_islands` (`sim/src/grid.rs`) treating a thin strip as unanchored;
- a hidden 1-cell shaft the sand filled.

Write a native test that reproduces a spike from one Paint stroke of Sand over a Dirt block in a sandbox, and
another from one Dig in a game world if you can. Dump the materials before and after. Say what the cause was,
with evidence, before fixing it. If it's a crumble bug (for example a sliver between brush stamps counting as
an island, or a wrong anchor check), fix it.

## 2. Hard-material paint never triggers falling rock

The user's rule (confirmed):
- A Paint stroke **of a structural material** (`is_structural`: Rock, Dirt, Wood, Ice, Glass, Coal) records
  **no** crumble seeds, so painted rock may float.
- Strokes of anything else (Sand, Water, Empty and so on) still record seeds as today, so they can cut rock
  free, like a spell.
- Spells, bombs, acid and the rest are unchanged.

Implement it in `Sim::paint`/`disc` (`sim/src/sim.rs`). For example, write without seeding for structural
strokes, through a `set` variant that skips `seed_neighbours` but still `touch`es. Paint is an input, so this
stays deterministic.

Tests, red first:
- a Rock stroke that encloses Dirt leaves the Dirt intact;
- a Sand stroke that encloses Dirt still crumbles it;
- a sleep-on/off comparison for both.

## 3. Crumbled rock becomes Pebbles, not Sand

- Add a new material, **Pebbles**, id **21**.
- It's a powder that moves like Sand (`powder_move`, its own diagonal salt), with the same `powder_ok`
  displacement.
- It's **not** structural, not flammable, and doesn't react with lava (no glazing; lava just displaces it, or
  it sinks through lava as sand does, matching sand's density rule).
- `crumble_islands` writes Pebbles instead of Sand. Ice still becomes Water.
- Name it "Pebbles" in `shared/names.ts`, with class solid or powder, matching however Sand is classed in
  `MATERIAL_CLASS`.
- Colour: a grainy grey-brown distinct from Sand and Rock, about `0x8a8178`, in `client/materials.ts`. The
  palette table already covers ids up to 31; check `render.ts`'s `uPal[32]` needs nothing more.
- **Not paintable** (keep it out of `paintable`), so it only comes from falling rock.
- Check every exhaustive match or table over material ids (`grep -n "COAL" sim/src shared client`) and extend
  them: names, class table, the hash or snapshot (material bytes are already u8, so no format change is
  expected; say if you find otherwise), and the client's avatar controller (Pebbles is solid ground to stand
  on but a falling powder, like Sand).

Tests: an island crumbles to Pebbles; Pebbles fall and pile like Sand.

## 4. Seed sprinkles; Stem and Flower can't be painted

- **Seed:** in `disc`, when `mat == SEED`, write only cells where `rng(world_seed, tick, x, y, SALT_PAINT_SEED)`
  passes a small threshold. Aim for a few seeds per stamp at the default radius; pick the constant and say
  what it gives at r = 4 and r = 16. Add a new salt constant beside the others. Use the sim's existing world
  seed and current tick, as other paint-time randomness would.
- **Stem and Flower:** remove them from `paintable` (`sim/src/materials.rs`) and from the client palette
  (`client/materials.ts` `MATERIALS`, and anywhere the sandbox brush list is built). Keep their colours in the
  palette table, since they still exist in the world.
- Tests:
  - a Paint of Stem or Flower changes nothing;
  - a Seed stroke places some seeds but far fewer than the disc's area, deterministically;
  - D7.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

## Commit checklist (commit each separately)

- [ ] 1. A spike/column repro test and its cause (and the fix if it's a bug).
- [ ] 2. Hard-material paint doesn't seed crumbles, with tests.
- [ ] 3. The Pebbles material, crumbles produce it, with tests.
- [ ] 4. Seed sprinkle; no Stem/Flower painting; the client palette; tests.
- [ ] 5. Your report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Files you may touch

- `sim/src/{grid,sim,materials,tuning,rng}.rs` (or wherever the salts live), and `sim/tests/*.rs`;
- `shared/names.ts`, `shared/sim.ts` (only if it mirrors material ids);
- `client/materials.ts`, `client/render.ts` (only if the palette needs it), `client/avatar.ts` (only the
  material class);
- `tests/determinism/*` (expectations only);
- your report.

## Report

Write `docs/research/fix-b-paint-rock-report.md` as you go. It should cover:

- per commit: the hash, what changed, and the red-first evidence;
- **the cause of the spikes and columns**;
- the seed sprinkle density;
- what you couldn't verify;
- **"Architectural decisions for review":** how paint skips seeding, the Pebbles material's rules and class,
  and the sprinkle rng inputs. For each: what you chose, the alternatives, why, and what it costs later.
- FUTURE.md ideas, suggested only.

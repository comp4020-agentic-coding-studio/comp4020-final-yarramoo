# Brief N4: falling rock, the next level (v0.5 and falling logs), on its own branch

**Why:** the user, 4 Nov, asked for "the next levels in falling rocks". Today (v0, D-165, D-174, D-175) a solid island
cut free crumbles to Pebbles (`sim/src/grid.rs` `crumble_islands`), and a cut tree crumbles to Sand. The plan in
`docs/research/rigid-bodies.md` section 7 names the next steps: **v0.5**, small islands fall straight down **as
themselves** in the grid, no entity; and FUTURE.md "Falling rock: logs, not sand": a cut tree falls as Wood, so it
still burns. v1 (a `Body` entity) and v2 (rotation) are **out of scope**: too big for this week.

**This lands on its own branch, not `multa`:** it's a sim change two days before the deploy. It merges only after the
user has played it. So the branch can change hashes and behaviour freely, but it must be green on the **full**
gate, including determinism, because it will merge.

**Worker:** one Sonnet worker. Create the worktree first:
`git -C /Users/mitch/code/courses/comp4020/comp4020-final-yarramoo worktree add /tmp/wt-rock -b falling-rock-v05 multa`,
then `pnpm install` in `/tmp/wt-rock`. Work only there. No subagents, about 120 tool calls. Rules: `CLAUDE.md` and the
11 invariants, every one; commits only on a green gate chained with `&&` (never `;`, never through `grep` or
`tail`); red-first tests; `rm` only on literal absolute paths; **no pushing**; never weaken a test; prefix cargo with
`PATH="$HOME/.cargo/bin:$PATH"`. Your ports: vite **5182**; `agent-browser` sessions `rock-*`. Run single test files
while iterating and the full gate once per commit, in the background. Kill everything you start by PID.

Read first: `docs/research/rigid-bodies.md` (sections 1, 4, 5, 7), `docs/research/review-falling-rock.md`, D-165,
D-174 and D-175 in `docs/DECISIONS.md`, `sim/src/grid.rs` `crumble_islands` and the `island_*` fields,
`sim/tests/falling_rock.rs`, `sim/tests/paint_spikes.rs`, `sim/tests/pebbles.rs`.

## What to build

1. **Falling islands (v0.5).** When the island flood finds a free island (today it crumbles), and the island is
   small enough (choose a cap, e.g. at most 64-120 cells, in `tuning.rs`), it **falls as a whole, keeping its
   materials**, instead of crumbling:
   - each tick it moves down one cell if every cell under its bottom edge is free (Empty, a gas, or a liquid: decide
     whether a falling slab displaces liquid, and say so); when it can't, it stops and stays as it is;
   - it's grid state only: no entity, no new snapshot section. The island's cells are ordinary cells; what must be
     tracked between ticks is "which islands are falling". Find the cheapest deterministic way: re-detect each tick
     from a small set of seeds (the island's cells moved, so its neighbours changed), or keep a short list of
     falling islands in hashed state (then it **is** snapshot state: add it to the snapshot and hash, bump
     `FORMAT_VERSION` to 13, and say so). Prefer the stateless way if it works; flag the choice either way;
   - larger islands, or ones that can't be described cheaply, still crumble to Pebbles as now;
   - landing on a player: the sim must not write cells over a live player's hitbox. Follow the research's v1 rule
     (stop above players; no crush damage in this slice), or explain a better one;
   - bounded work, always: a cap on islands moving per tick and cells moved per tick, like `ISLAND_WORK_MAX`. One
     input must not be able to cost unbounded work (CLAUDE.md).
2. **Falling logs.** A cut tree (Wood, and its Stem and Flower if any) falls as Wood under the same rule instead of
   crumbling to Sand. Check `paint_spikes.rs` and `pebbles.rs` for the rules that exist on purpose (painted rock
   may float, D-175).
3. **Chunk sleeping and waking** must stay invisible (invariant 8): a falling island crosses chunk edges and wakes
   chunks; D7 (sleep on vs off) must stay green, and a frozen-chunk test with a falling island across a frozen edge.
4. **The world-sweep test** (FUTURE.md "A world-sweep test for falling rock"): dig at a grid of sites across several
   Survival seeds and assert that rock only ever moves or crumbles when it was really cut free. Native, a few
   seconds.

## Tests (red first where they catch something)

- a small rock island cut free falls and lands intact (same cell count and materials, shifted down);
- a large one still crumbles;
- a falling island stops above a player and never writes over the hitbox;
- a cut tree falls as Wood and still burns;
- determinism: snapshot mid-fall, restore, step both, hashes equal every tick; sleeping on vs off identical;
- bounded: the worst case (many small islands cut at once) stays under the per-tick cap;
- the world sweep.

## Look at it

`pnpm dev:client` on 5182, `/game?world=game&avatar=1&cfg=survival` (dev paint is on in the dev build): dig under an
overhang, cut a tree, watch it fall. Screenshots or a short sequence to `docs/art/shots/n4-*.png`.

## Commit checklist

- [ ] Falling islands (v0.5) with their tests.
- [ ] Falling logs.
- [ ] Sleeping, waking, snapshot and determinism tests; the world sweep.
- [ ] `docs/DECISIONS.md` row, `docs/research/n4-report.md` with "Architectural decisions for review" (stateless
      versus tracked falling, the size cap, liquids, players, the format if it changed).

## The gate (every commit)

```
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

About 8 minutes. Write each step's output to `/tmp/n4-*.log` if you need to read it. A cold independent review
follows your report before anything merges.

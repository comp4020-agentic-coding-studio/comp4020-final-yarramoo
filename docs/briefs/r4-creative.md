# Brief R4: Creative

Written 25 Oct by the session model, after R3 (the menu) landed and was pushed (`multa` at `2b0fa55`). Milestone
R4 of `docs/plan-game-modes.md`: Sandspiel-style brushes, all spells unlimited, fill-empty paint mode, damage
off, measured at 8 painters. Creative is the first mode where a room can have **both** avatars and brushes
active at once (today's two fixed worlds are mutually exclusive: the sandbox paints with no avatar, the cave
world has an avatar with no brushes), so this slice is partly new sim rules and partly a client UI that has to
show both panels and let a player switch between them.

**Dispatch:** one Sonnet worker, medium effort, about 80 tool calls. No independent reviewer — per the plan's
review column, R4's own review is "two browser contexts" (watching two painters/avatars interact live), which
the session model does directly, the same as R1 and R3.

---

## Context for the worker

Repo `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`, branch `multa`. Read `CLAUDE.md` first (the
sim invariants: integer-only ABI, no floats, bounded per-input work — "an input must not be able to cost
unbounded work" is directly relevant here, since brush radius is exactly that kind of input). Then
`docs/plan-game-modes.md`'s "Sandspiel-style brushes (Creative)" section in full, and the "Presets" table's
Creative row (`terrain: Solid box or Caves, size M, damage: none, spells: all, brushes: on, respawn 1s,
pickups respawn on, round: none`). The game is not live: sim/protocol changes are fine, nothing to migrate.
Rust needs `PATH="$HOME/.cargo/bin:$PATH"`. Never use port 8080 (Docker check uses 8093).

## What exists already (read before touching anything)

- **The Paint input** (`shared/inputs.ts`'s `encodePaint`, `sim/src/input.rs`'s `Input::Paint`) is a 15-byte,
  byte-exact frame: `player u32, mat u8, x0 i16, y0 i16, x1 i16, y1 i16, radius u8`. `sim/src/sim.rs:298`'s
  `paint()` clamps `radius` to `MAX_PAINT_RADIUS` (32, already the plan's own ceiling) and clamps both
  endpoints to the world before drawing a line of discs (`disc()`, `:314`). Materials are ids 0-14
  (`sim/src/materials.rs`), so `mat`'s `u8` has unused high bits — the plan's "fill empty only needs one flag
  bit in the Paint input" fits here without widening the frame. Read `paintable()` (`materials.rs:20`) for
  which materials `paint()` currently allows.
- **`Sim::cfg.paint_allowed()`** (`sim/src/config.rs:93`) already gates Paint by `cfg.brushes == 1`
  (R0a/R1). Today only `classic_sandbox` (`brushes: 1, avatars: 0`) and nothing else actually has brushes on;
  Creative is the first preset with `brushes: 1` **and** `avatars: 1` together.
- **`cfg.all_spells()`** (`config.rs:97`, `cfg.spells == 1`) and **`cfg.damage_from_players()`/
  `damage_from_env()`** (`:86-90`) already exist as config-derived rule helpers from R0a, but nothing in
  `sim/src/sim.rs` reads them yet for spell charges or damage — R0a's own report flagged this as deferred ("R2+
  work"). **This is R4's job for `spells`** (Creative needs unlimited charges on every spell) and for `damage`
  (Creative needs damage off entirely, env and player both) — check every place `sim.rs` currently applies
  damage or checks spell charges (`grep -n "charges\|damage" sim/src/sim.rs sim/src/spells.rs`) and wire these
  two config fields in, rather than leaving them inert.
- **The client palette** (`client/materials.ts`'s `MATERIALS` array) already lists every paintable material
  with a name and colour, and `client/room.ts`'s existing palette-building loop (`:60-77`) already renders
  every entry in `MATERIALS` as a button — **there is no missing UI here for the base palette**, confirmed by
  reading the code; R3's own screenshot just didn't show the full scrollable list at its captured width. What's
  genuinely missing: an Eraser option (paint `EMPTY`, not in `MATERIALS` today), a brush-size slider (the
  `#brush` range input exists and is wired, confirm its max matches `MAX_PAINT_RADIUS`), a fill-empty-only
  toggle (no UI or sim support at all yet), and a way to switch between the brush panel and the spell bar when a
  room has both (`client/room.ts:591`'s `spellBar.hidden = !steersAvatar() || !m.spells` and the palette's own
  visibility are currently mutually exclusive, written for a world that only ever had one or the other).
- **Spell bar and charges** (`client/room.ts:540-591`): already renders cooldowns and charge counts per spell
  from the entity view; this doesn't need rebuilding, just needs to coexist with the palette.

## What to build

1. **Fill-empty paint mode, sim-side.** Add one bit to the Paint input's `mat` byte (e.g. bit 7, since ids 0-14
   fit in 4 bits — document the exact bit in a comment at both ends) meaning "only paint into currently-Empty
   (or gas) cells, never overwrite anything else." `sim/src/sim.rs`'s `paint()`/`disc()` need the extra check:
   when the flag is set, `disc()` skips any cell that isn't `EMPTY` (or a gas material — check `materials.rs`
   for what counts; the plan's own wording is "paint sand without erasing rock", i.e. don't overwrite solids or
   liquids, but painting over smoke/steam is probably fine — use your judgement and explain it). Still bounded:
   the existing radius and endpoint clamps are unchanged, this flag only changes which cells within the already
   -bounded disc get written. `shared/inputs.ts`'s `encodePaint` needs a `fillEmpty: boolean` parameter that
   sets the bit; `sim/src/input.rs`'s decode needs to extract it back out (mask `mat` when decoding into the
   existing `mat: u8` field, or add a new field — your call, explain the choice).
2. **Spells wired to config.** `cfg.all_spells()` (brushes is a separate field from spells — don't conflate
   them) means every spell has effectively unlimited charges in a Creative room: read how charges are granted
   and decremented today (pickups grant charges; casting decrements them — `grep -n "charges" sim/src/sim.rs`)
   and make a config with `spells == 1` either grant every slot a very large charge count at spawn/respawn, or
   skip the decrement/check entirely when `cfg.all_spells()` is true — pick whichever is the smaller, more
   consistent change given how charges are currently represented (check if there's already an `INFINITE`
   sentinel value used elsewhere, e.g. Push/Blast's existing unlimited-charge slots per D-109's bag rules — if
   so, reuse that exact representation rather than inventing a second "unlimited" concept).
3. **Damage off.** `cfg.damage_from_players()` and `cfg.damage_from_env()` both false for Creative
   (`damage: 0`, per the preset table). Find every place damage is currently applied unconditionally (explosion
   damage, fire/lava hazard-scan damage, D-103/D-106's rules) and gate each on the relevant config check — a
   Creative room's player cannot die or take damage at all, but spells still have their terrain effects (Blast
   still carves, Fire bolt still ignites). Read `docs/DECISIONS.md`'s D-103/D-106/D-107 rows for exactly where
   damage is currently computed before touching anything, so the gate goes in the right place without
   duplicating logic.
4. **Respawn at 1s, pickups respawn on** — per the preset table, these are just config field values on the
   Creative preset in `shared/room.ts` (and the equivalent in any test fixtures), not new sim logic:
   `respawn_secs: 1, pickup_respawn: 1`. Confirm the existing respawn-timer and pickup-respawn code (already
   built for Deathmatch-shaped presets, even though Deathmatch itself isn't built until R5) already reads these
   fields correctly for an arbitrary value, rather than assuming a hardcoded Deathmatch-only constant.
5. **A `CREATIVE` preset** in `shared/room.ts`, alongside the existing `CLASSIC_SANDBOX`/`CAVES_PVP`: terrain
   Solid box (the plan's "Solid box or Caves" — pick Solid box as the default since it has no traversal
   guarantee to maintain and digging/building both work on it immediately; note Caves as an equally valid
   advanced-sheet choice in your report, not a hard requirement to also default to), size M, avatars 1, damage
   0, spells 1, brushes 1, death 0, respawn_secs 1, pickup_respawn 1, round 0, max_players 8. Byte-vector test
   added alongside the existing shared ones in `sim/tests/config.rs`/`tests/net/room.test.ts` (R0a's pattern —
   same literal hex string in both languages).
6. **Client UI**: an Eraser entry in `client/materials.ts`'s `MATERIALS` (paints `EMPTY`), a fill-empty-only
   toggle next to the brush size slider, and a way to switch between the brush panel and the spell bar in a
   room that has both (`cfg.brushes === 1 && cfg.avatars === 1`) — a simple tab/toggle button is enough, the
   plan's own wording is "a toggle between the brush and the spell bar." Confirm the brush size slider's max
   matches `MAX_PAINT_RADIUS` (32).
7. **8-painter measurement.** The plan: "measure 8 painters." Adapt the existing bench pattern
   (`tests/soak/capacity-rooms.ts` from R2c, or a lighter standalone script — your call) to put 8 real bot
   clients painting in one Creative room at radius 32 (the worst case named in the plan: "A room of 8 painters
   at radius 32 must stay inside the per-tick step budget") and report the step-time percentile against the
   existing P1 budget (8ms, from `docs/research/g2-results.md`/D-087 — read that budget's history before citing
   it). This doesn't need the full capacity-rooms.ts machinery (memory isn't the question here, step time is);
   a focused script that creates one Creative room, connects 8 bots all painting radius-32 strokes, and samples
   `World.stats`/the sim's own step timer is enough. Don't touch `tests/soak/capacity-rooms.ts` itself.

## What NOT to build (later milestones' job)

- Deathmatch/Survival-specific rules (kill feed, scoreboard, round machine) — R5/R6.
- Sandspiel's cloner/wind tools, new materials (ice/oil/gas), spray density — plan says keep these in
  `FUTURE.md`, don't build them.
- Share-a-build export — already a `FUTURE.md` entry from the game-modes research, not this slice.
- Live preview on the menu — still R3's deferred item, not this slice's job either.

## Verify

- **Red first:** the fill-empty flag, spells-unlimited, and damage-off behaviours each need a test showing the
  old behaviour (overwrites solids / charges deplete / damage applies) before your change, then the new
  behaviour after.
- **Bounded work preserved:** a fill-empty Paint at radius 32 costs no more sim work than a normal one — the
  flag only skips writes, it doesn't add a second pass over the grid or any unbounded loop.
- **Determinism unaffected for existing presets:** `classic_sandbox`/`caves_pvp` hashes at the usual
  checkpoints (ticks 0/40/80/120) must be unchanged — this slice adds a new preset and new rule branches, it
  must not alter what the two existing presets compute. Diff baseline hashes before/after the same way R0a/R1
  did (a throwaway scratch binary, removed before committing, or an ignored test).
- **Two real browser-equivalent contexts**: one painting (fill-empty on, building a sand pile over rock without
  erasing it), one casting unlimited spells, both in the same Creative room, confirm no damage is ever applied
  to either even when a Blast or Fire bolt would normally hurt a player — mirrors the pattern in
  `tests/net/menu-room.test.ts`/`room-join.test.ts`.
- **Gate every commit on exit codes:**
  `(cd sim && cargo test --release && cargo clippy --release --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown --release -- -D warnings) && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...`
- `sim.wasm` imports nothing (CI and the D-suite check it).
- **Boot the real Docker image** and run `APP_URL=http://localhost:8093 pnpm check`. Create a Creative room via
  the API, join with a raw socket client, confirm Paint with the fill-empty flag, an unlimited-charge cast, and
  no damage all behave correctly against the live container.

## Files you may touch

`sim/src/{sim.rs, input.rs, config.rs, spells.rs, materials.rs (only if Eraser needs a sim-side id — it
shouldn't, EMPTY already exists), tuning.rs}`, `sim/tests/*.rs` (new tests), `shared/{inputs.ts, room.ts,
protocol.ts (only if a cap genuinely needs recomputing for the new preset's size)}`, `client/{materials.ts,
room.ts}` (the brush/spell toggle and Eraser/fill-empty UI only — don't touch the menu/create-sheet work from
R3), `tests/net/*` (new tests), `tests/soak/*` (a new focused script for the 8-painter measurement — don't
touch `capacity-rooms.ts`).

Don't touch `server/*` (no server logic changes expected — Creative is a config preset plus sim rules, not a
lifecycle change), `client/menu.ts` (R3's work, the create sheet's preset dropdown should pick this preset up
automatically once it exists in `shared/room.ts`'s preset list — confirm this works, don't hand-wire it).

## Commits (checklist; each gated)

1. [ ] Fill-empty Paint flag, sim + shared encode/decode, red then green
2. [ ] Spells wired to `cfg.all_spells()` (unlimited charges), red then green
3. [ ] Damage wired to `cfg.damage_from_players()`/`damage_from_env()` (off for Creative), red then green
4. [ ] `CREATIVE` preset in `shared/room.ts` with shared byte-vector tests; respawn/pickup-respawn fields confirmed working for non-Deathmatch values
5. [ ] Client UI: Eraser, fill-empty toggle, brush/spell-bar switch
6. [ ] 8-painter step-time measurement against the P1 budget
7. [ ] Docker boot plus `pnpm check` (no commit unless a fix is needed)

End each message with the attribution line from the session's instructions. **Don't push**: the session model
reviews and pushes.

## Report

Write to `docs/research/r4-worker-report.md` as you go (append per commit). Include: what changed per commit,
red-then-green evidence, determinism results (baseline hashes unchanged for the two existing presets), the
8-painter measurement numbers against the P1 budget, the Docker check, a section **"Architectural decisions for
review"** (the exact fill-empty bit chosen and why, how unlimited charges are represented, where each damage
gate landed and why, anything hard-to-reverse you were unsure about where you took the more reversible option),
and any FUTURE.md ideas written directly into `FUTURE.md`.

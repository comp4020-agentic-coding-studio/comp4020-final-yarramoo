# Brief F4: enemies slice 1: the Slime end to end, plus one-life co-op Survival

**Why:** the user wants tiered enemies and a spell-casting boss (31 Oct). The design is
`docs/research/enemies-design.md`; **read it in full**, especially sections 1-4 and the decisions banner at
the top. The user's decisions:

- **D-157:** enemies appear only in Survival, and **spawn once**. The generator places them, they never
  respawn, and players kill them on the way down.
- **D-158:** Survival is a **co-op descent**. Players can't hurt each other, and the boss's death wins.
- **D-160:** **no respawn**. A dead player stays dead and spectates. When everyone is dead the room has lost,
  and players must make a new room. **Survival may be played solo.**

This slice builds the foundation every later enemy and boss slice stands on, so it is structural: an
independent review follows. The game is not live, so a snapshot format bump is fine. Don't build
compatibility shims.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 120 tool calls. Read `CLAUDE.md`
first: the sim invariants and harness rules are binding (no floats, counter-based rng with a new salt per
use, bounded work, chunk sleeping invisible, `rm` only on literal absolute paths, every commit gated on exit
codes chained with `&&`, every new test red first, no pushing, finish each edit before starting its gate).
Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`.

## Scope

### A. Enemy state and stepping (sim)

Build what design sections 1-4 describe, minus nests and respawn (D-157):

- **State.** A new `sim/src/enemy.rs` (an `impl Sim` block, the way `spells.rs` is). `Enemy { id: u16, kind:
  u8, x, y (1/16 cell, i32), vx, vy, hp: u16, state: u8, cooldown_until: u32, last_hit_by: u32,
  last_hit_tick: u32 }`, or as the design gives it; keep the design's field list unless you have a reason,
  and flag any change. It lives in `Vec<Enemy>` sorted by id. Enemy ids are assigned by the generator in
  placement order. With no spawning after world creation, no id counter is needed in state; flag that. Stats
  go in an `ENEMY_STATS[kind]` table in `tuning.rs`. Only kind 0 (Slime) exists in this slice.
- **Placement.** In `sim/src/gen.rs`, after the pickups, the generator places slimes on floors in the shallow
  band (`scale_count`; at L about 25, scaled down for S and M). Keep them off the guaranteed path's spawn area
  near the surface (no slime within about 60 cells of `spawn_point`'s column at the surface), off pickups,
  and out of liquids. Enemies come from `Sim::new` like pickups and go into `Base` (the cached generation),
  the same way pickups do.
- **Only when `cfg.enemies()` is on.** Use config byte 12, currently reserved and required to be 0, as
  `enemies: 0|1`. Update the validation in `sim/src/config.rs` and `shared/room.ts` (`CONFIG_FIELDS`, the
  three presets with `enemies: 0`), and add a **`SURVIVAL` preset**: Caves, size M, avatars 1, **damage 1**,
  spells 0, brushes 0, **death 1**, respawn 0, pickup_respawn 0, round 1, max_players 8, **enemies 1**. The
  menu (`client/menu.ts`) Survival card uses the preset instead of its hand-written config (the same fix as
  D-147's Creative card). Change the card's text from "Last one standing. PvP, one life." to co-op wording,
  and set `pvp: false`.
- **Stepping rule (design section 3, D7-critical).** An enemy steps on a tick only if it lies inside a
  rectangle `ENEMY_ACTIVE_W x ENEMY_ACTIVE_H` (448x256) around an active, alive player, computed from
  `players` directly, **never from `grid.awake`**. Otherwise it is frozen by rule. Step enemies in id order,
  after `update_projectiles`. Cap the number stepped per tick (`MAX_ENEMIES_STEPPED` 24, lowest ids first) and
  the total (`MAX_ENEMIES` 48).
- **Slime AI (integer only).** Target the nearest alive player by squared distance; ties go to the lowest id.
  Within about 120 cells it hops toward the target: a jump impulse on a cooldown, with gravity, landing on
  solids. Otherwise it idles with small rng hops. Movement is integer, cell-grid collision against
  solid/liquid/gas using the same material classes as `shared/names.ts` `MATERIAL_CLASS`; mirror them in Rust
  as a function in `materials.rs`, pinned by a test. A slime overlapping a player's hitbox does **contact
  damage** 8 with a 40-tick cooldown and a small knock, through `apply_damage` with a new
  `CAUSE_ENEMY_BASE + kind` cause (40 onwards, per the design). The game must not crash or diverge if a slime
  is embedded in rock after a dig; add the design's "embedded rescue": move it up to the first free cell.
- **Enemies take damage.**
  - Player projectiles: `step_projectile` gets enemy boxes alongside the player boxes.
  - Explosions: `explode_at`.
  - Blast's cone: `blast`.
  - The world: an `enemy_hazard_scan` for lava, acid and fire, with a per-kind immunity bitmask; the slime
    has none.
  - Knockback moves enemies.
  - At 0 hp an enemy is removed and emits `EV_ENEMY_DEATH { player: killer, a: x, b: y, c: kind }`. Credit
    uses `last_hit_by` within `KILL_CREDIT_TICKS`.
  - Also emit `EV_ENEMY_HURT`. The design names these events; use the next free `EV_*` ids.
- **The co-op gate (D-158).** When `!cfg.damage_from_players()`:
  - Push and Blast knockback no longer move **other players**; they still move enemies.
  - The Black Hole's pull no longer pulls other players (D-159 found it ungated).
  - A caster's own knockback on themself, if any exists, is unchanged.

  Damage is already gated. Add tests: in a `damage: 1` room, Push on a player gives no `EV_KNOCK` and no
  hp loss, while Push on a slime moves it and hurts it.

### B. One life (sim), D-160

- When `cfg.death == 1`, a dead player **does not respawn**. `dead_until` is never reached, and the respawn
  path is skipped. A clean way: set `dead_until = u32::MAX` on death when `death == 1`. Check every reader of
  `dead_until` and `alive()`.
- **Round end:** when `cfg.round == 1`, emit `EV_ROUND_END { a: 1 win | 0 loss }` once.
  - **Loss:** at least one player has joined, and no active player is alive.
  - **Win:** comes in the boss slice. Leave a clearly named hook, with no boss yet.
  - Keep a `round_over: u8` in hashed state, so the event fires exactly once and nothing steps enemies
    afterwards.
  - Solo is fine: no minimum player count.
- **The server:** on a majority-confirmed `EV_ROUND_END`, reusing the existing claim path (read how
  `EV_DEATH` claims work, D-120/D-121; the plan's "Survival rounds" section describes it), log a
  `round.end` event through `log.event`, with a name added to `shared/events.ts`. Mark the room as ended so
  the room list stops offering Join for it. Deleting the room can be left to the existing empty-room unload.
  Flag what you chose. **If the claim plumbing is too big for this slice, stop at the sim event plus a
  client banner, and say so.** Don't half-build server deletion.
- **The client:**
  - When I'm dead in a `death: 1` room, show "You died. Spectating", and the camera follows a living
    teammate (`follow` already exists).
  - On `EV_ROUND_END`, show a banner ("The party fell" / "Victory") with a **"New room"** button that creates
    a fresh Survival room (`POST /api/rooms` with the preset; read how the menu's create sheet does it) and
    navigates there.

### C. The snapshot and the entities view

- Enemies are appended after the bags in `entities::encode`. Players stay first, because of the server's
  fixed-offset reader in `server/world.ts` `activePlayersIn`. `round_over` goes in too. `FORMAT_VERSION` goes
  6 to 7. `snapshot::size` must still equal `write().len()`.
- Add a new `ENT_ENEMY` kind in the entities view (`ENTITY_BYTES` stays 18 if it fits: `sub` = kind, `a` = hp,
  and so on). Mirror it in `shared/sim.ts`.

### D. Client rendering (`client/worker.ts`, `client/fx.ts`, `client/sfx.ts`)

- A slime sprite in the style of the existing pixel grids in `fx.ts`: a green blob, squashing when it lands
  and stretching when it hops (from its vertical velocity or state), and white for the hit flash.
- A small hp bar over a hurt enemy.
- Fx and sound for hurt (a squelch) and death (a splat with green particles).
- **Render only** (invariants 1 and 9): nothing read from the view feeds back.

## Tests (each red first)

- **D7:** sleeping is invisible with slimes near a player, a slime just outside the stepping rectangle, and
  one straddling its edge. Run with sleeping on and off and assert equal hashes.
- **D5:** a snapshot round trip mid-fight: a slime hurt, one dead, one frozen far away.
- **D2:** cross-engine hashes agree. Extend the determinism scripts, or `tools/inputgen*.ts`, so a Survival
  config world is exercised. Check how `tests/determinism` chooses configs.
- **Unit tests:**
  - targeting ties go to the lowest id;
  - the proximity rule;
  - contact damage and its cooldown;
  - slimes take damage from Push, Fire and Bomb, and from lava and acid;
  - kill credit;
  - the embedded rescue;
  - no respawn with `death 1`;
  - `EV_ROUND_END` loss fires exactly once (solo and with two players);
  - the co-op knock gate.
- **Gen:**
  - slimes appear only when `enemies` is 1;
  - none near the spawn column, none in liquid;
  - counts per size;
  - `traversable_to_every_band` is still green.
- **Config:** byte 12 round-trips in Rust and TS; the existing config vector tests are updated; `SURVIVAL`
  is in the shared vectors.
- **A net test:** create a Survival room through `POST /api/rooms`, have two clients join, and check they
  agree on the state hash with slimes present (the pattern in `tests/net/menu-room.test.ts`).

## Files you may touch

- `sim/src/{enemy (new),entities,sim,spells,snapshot,config,tuning,rng,gen,materials,lib}.rs` and `sim/tests/*.rs`.
- `shared/{sim,room,events,names,achievements}.ts`.
- `server/{world,main}.ts`, only for `round.end`, the room-ended flag, and the derived record offsets if
  they move.
- `client/{worker,fx,sfx,room,menu,toasts}.ts` and `client/index.html` (the banner).
- `tools/inputgen*.ts`, `tests/net/*.test.ts`, `tests/determinism/*` (update expectations only, never weaken
  a check; tie any re-pointed expectation to the exact tick it is about), `docs/art/shots/`, and your report.
- Don't edit `FUTURE.md`, `docs/DECISIONS.md` or `docs/engineering-decisions.md`.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && git commit ...
```

Run `pnpm test:net` before the server and client commits and the last commit. **A test that fails once and
passes on retry is a defect:** find which assertion is timing-dependent, as `claims-live` and M4b were this
week (D-155, D-159).

## Look at it

`pnpm dev:client` serves on 5173. The dev route `/game?world=game&avatar=1` uses the old fixed game-world
config, so add a **dev-only** query option, for example `&cfg=survival`, guarded by `import.meta.env.DEV` the
way `__devPaint` is, so the local route can init with the `SURVIVAL` preset. Use `agent-browser` via
`zsh -ic`, with the viewport at 1280x800 first. Walk to a slime (add a dev `__devGotoEnemy()` if useful), let
it hit you, kill it with Push, and screenshot each. **Look at each screenshot yourself before citing it.**
Kill vite by PID.

## Commit checklist (commit each separately)

- [ ] 1. Config byte 12 `enemies` plus the `SURVIVAL` preset (Rust and TS, the vectors, the menu card).
- [ ] 2. Enemy state, the snapshot section, format 7, the entities view; no AI yet (enemies frozen).
- [ ] 3. Gen places slimes (`enemies` on only), with the gen tests.
- [ ] 4. The stepping rule, slime AI, contact damage, the embedded rescue; D7 and unit tests.
- [ ] 5. Enemies take damage (projectiles, explosions, Blast, hazards), death, credit, events.
- [ ] 6. The co-op knock gate, including the Black Hole pull, with tests.
- [ ] 7. One life, plus `EV_ROUND_END` loss, `round_over`; the server `round.end` (or stop at sim plus client, said plainly).
- [ ] 8. Client: the sprite, hp bar, fx, sfx, the spectate notice, the round banner with New room, the dev `cfg=survival`.
- [ ] 9. Screenshots and the report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/f4-worker-report.md` as you go. It should cover:

- per commit: the hash, what changed, how you verified it, and the red-first evidence;
- slime counts per size;
- the per-tick enemy cost measured as a work count;
- what you couldn't verify;
- **"Architectural decisions for review"**: the Enemy fields; no id counter; config byte 12; the stepping
  rectangle; how enemy boxes enter `step_projectile`; the cause-code range; `dead_until = u32::MAX` for one
  life; `round_over` and the round-end rule; and the server's room-ended handling. For each: what you chose,
  the alternatives, why, and what it costs the boss slice later. When unsure about something hard to
  reverse, take the more reversible option and flag it;
- FUTURE.md ideas, suggested only.

## Independent review (separate Sonnet reviewer, after the worker)

Read the diff cold. Check:

- that D7 holds: nothing in enemy logic reads `awake`, and the stepping set is a pure function of hashed state;
- that work is bounded;
- that the snapshot section and format 7 cover every new field, and `size == write().len()`;
- that the server's fixed-offset player reader still works;
- that the co-op gate covers every player-on-player effect (Push, Blast, Black Hole, Bomb knock);
- that one life can't be bypassed (a reconnect or a rejoin with a new life number: read D-078);
- that `EV_ROUND_END` fires exactly once and can't be forged past the majority claim.

Write the findings to `docs/research/review-f4.md`.

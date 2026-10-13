# Handover brief: multiplayer falling-sand game (COMP4020 final project)

> **Conformed 2026-10-13** to the real course setup (see `docs/assignment-spec.md`, `fly.toml`, and `docs/DECISIONS.md` D-001 to D-016). Where the original brief assumed Postgres, 512 MB, a team, or no phone support, the text below has been changed and the decision is logged.

You are picking up a project that was designed in a separate planning conversation. This file is the complete brief: product, architecture, implementation details, the determinism test suite, and the timeline. Read all of it before writing any code.

---

## 0. How to work on this project

**First actions, in order:**

1. The official brief is summarised in `docs/assignment-spec.md` (fetched 2026-10-13). Section 1 has been re-checked against it.
2. `CLAUDE.md` already exists and holds the harness rules. Section 4 (hard rules) is copied into it as its own section of code invariants. Add build and test commands to it as they come into existence.
3. Create a task list from the milestones in section 13 and work through them in order. Every milestone ends deployed and demoable.
4. Start with Milestone 0, the determinism spike. Do not build game features until gate G1 passes.

**Working rules:**

- Record decisions in `docs/DECISIONS.md` (date, decision, reason). Section 14 lists open decisions with defaults. When one blocks you, use the default, record it, and keep going.
- Never break a hard rule in section 4 without asking the user first.
- The Claude Code credit budget is limited. Prefer targeted file reads, small diffs and fast tests. Delegation follows the rules already in `CLAUDE.md`.
- Keep commits small, one concern each. Run the determinism suite before every commit that touches `sim/`, `shared/protocol`, or the input path.

---

## 1. Context and known requirements

- **Course:** COMP4020 Agentic Coding Studio (ANU), Final Project (Assignment 3). **Individual** project, worth 40%, **due noon Monday 9 November 2026**. Marked 50% legibility of process, 25% deployed app, 25% response to the brief.
- **Requirements** (from `docs/assignment-spec.md`):
  - **Multi-user:** two people in separate browsers act on shared state and the app tells them apart. Markers use two Chrome profiles with no shared storage.
  - **Real-time:** a change shows in every other open session within about a second, with no reload. Markers watch both sessions at once, **one at each marking viewport (desktop and phone)**.
  - **Persists:** survives sessions, restarts and redeploys. The marker returns the next day, after the machine has stopped and restarted.
  - **Good by a defended definition:** `README.md` (400–600 words, with sources, published at `/readme/`) argues it, `CLAUDE.md` holds the rules, `spec/` holds the checks, and the three must agree.
  - `pnpm check` and `pnpm check:evidence` pass. `PROCESS.md` is 900–1100 words and justifies the stack and workflow.
  - Crit 9 "All at once" (Wed 14 Oct): real-time. Crit 10 "Fly by instruments" (Wed 21 Oct): two classmates use it from the URL alone while you read the logs, which is where the telemetry and dashboard come in.
- **Infrastructure** (fixed by `fly.toml`): **one `shared-cpu-1x` machine with 256 MB of memory**, **one 1 GB volume at `/data`** as the only storage that survives a restart, region `syd`, and **auto-stop when idle**. There is no database server; a separate Fly Postgres app is outside the course setup. The stack is otherwise open.

---

## 2. The game

A Noita-style 2D falling-sand world shared by everyone, in the browser.

- **The world** is wide and persistent. Players spawn on the surface.
- **Surface:** players start with knockback spells (Push, Blast). These knock each other around but do **no damage**. The surface is a social playground.
- **Shallow caves:** pickups for creative spells: **Water** and **Rose seed** (seeds grow a woody stem topped with a rose).
- **Deep caves:** pickups for **Fire bolt** and **Bomb**, plus gunpowder pockets and lava. These are the only sources of damage.
- **Griefing is intentionally allowed.** Players can build gardens together or burn them down. Achievements reward both play styles.
- **Achievements** are based on player actions (spell casts, depth reached) and on kills/deaths. A kill is credited with a **last-hit rule**: if you die from *any* cause within 5 seconds of being hit by someone's spell, they get the kill. Knocking someone into lava counts.
- **Sandbox / creative mode:** a separate world where players paint materials directly. This is also Milestone 2 and fallback #1.

---

## 3. Architecture: server-paced deterministic lockstep

```
 Browser (Web Worker)                    Fly server (Node, never simulates)           SQLite on /data
 ┌───────────────────────┐   inputs     ┌──────────────────────────────────┐        ┌─────────────┐
 │ sim.wasm (deterministic)│ ──────────► │ tick clock + input sequencer      │        │ worlds      │
 │ avatar controller      │             │ closed-tick broadcast             │ ─────► │ snapshots   │
 │ WebGL2 renderer        │ ◄────────── │ hash majority check + resync      │ ◄───── │ tick_log    │
 │ net + playout buffer   │ closed ticks│ snapshot verify (restore + hash)  │        │ players ... │
 └───────────────────────┘             │ achievements, telemetry, dashboard│        └─────────────┘
                                       └──────────────────────────────────┘
```

**How it works:**

- Every client runs the **same deterministic simulation** (Rust compiled to WASM) on the same ordered input stream, so all clients hold a bit-identical world at every tick.
- The **server is a clock and a sequencer.** It stamps each incoming input with a tick, closes ticks on its own clock, and broadcasts each closed tick's input list. It never steps the simulation.

**Why the server never simulates:** Fly shared vCPUs have a baseline of 1/16 of a core with burst credits. A 60 Hz cellular automaton would exhaust the credits and get throttled. Players' browsers are free compute.

**Why lockstep and not ownership-plus-corrections:** lockstep is exactly consistent by construction and has very few moving parts. A desync is then always a bug, which can be detected (hash checks) and reproduced (input log replay). The trade-off is that determinism is all-or-nothing, which is why Milestone 0 exists.

**Persistence:** periodic snapshots (produced by clients, verified by the server) plus the input log, both in SQLite on the `/data` volume. Recovery is the latest snapshot plus exact replay of the logged inputs, and the replay is done by the first client to join, never the server.

**Idle stop is the normal case.** Fly stops the machine when nobody is using it and starts it on the next request, so "restore from the latest snapshot and replay the log" runs on every cold start, not only after a crash. The marker's next-day visit always takes this path.

**Players' own movement is not lockstepped.** Each client predicts its avatar locally and sends its position as an input. The simulation only ever sees these "official" positions, which arrive through the input stream and are therefore about a round trip old.

---

## 4. Hard rules (copy into CLAUDE.md)

1. **All logic that affects shared state lives in `sim/` (the WASM module).** TypeScript only captures input, renders, handles networking and predicts the local avatar. TypeScript never writes to simulation state except through `push_input`.
2. **The simulation ABI accepts and returns integers only.** Quantize floats (aim angle, avatar position) in TypeScript *before* they become inputs.
3. **No floating point in `sim/`.** Enforce with `#![deny(clippy::float_arithmetic)]`. Use fixed-point (section 6).
4. **No host imports.** `sim.wasm` must import nothing. CI asserts that `WebAssembly.Module.imports(module)` is empty. This makes it impossible for the simulation to read clocks, randomness, or the JS engine.
5. **No `HashMap`/`HashSet` in `sim/`** (ban via clippy `disallowed-types`). Use `Vec`, sorted `Vec`, or `BTreeMap`. No `std::time`, no threads, no entropy-seeded RNG.
6. **Randomness is counter-based:** `rng(seed, tick, x, y, salt)`. There is no stateful RNG.
7. **Hash only fixed-width integers** (`u8`/`u16`/`u32`/`u64`), never `usize`. `usize` is 32-bit on wasm32 and 64-bit natively.
8. **Chunk sleeping must be semantically invisible.** Results are identical with sleeping disabled (test D7).
9. **Outputs never feed back.** `dirty_rects`, `events` and `entities` are read-only views for rendering and UI. Nothing read from them may become an input, except where explicitly specified (Pos inputs come from the local controller, which is allowed).
10. **All clients in a world run the identical `sim.wasm`.** The server rejects a client whose sim build hash differs from the world's.
11. **No server-side stepping, no P2P/WebRTC, no rollback, no WASM threads, no per-cell ownership tags.** See section 16.

---

## 5. Stack and repo layout

- **Simulation:** Rust → `wasm32-unknown-unknown`, raw `extern "C"` exports (no wasm-bindgen, so the module has zero imports). Use the `xxhash-rust` crate (xxh3) for hashing. Release profile: `panic = "abort"`, `opt-level = 3`.
  - Rust is decided (D-006); Zig is no longer an option.
- **Client:** TypeScript + Vite. The simulation, networking, avatar controller and renderer all run in a **Web Worker**, rendering to an OffscreenCanvas with WebGL2. The main thread handles DOM UI (HUD, inventory, toasts) and forwards input events.
  - Verify OffscreenCanvas + WebGL2 support in Chrome (desktop and phone), Firefox and Safari. Fallback: render on the main thread from a transferred buffer.
- **Server:** TypeScript on Node 24 (as the existing `Dockerfile` runs it, with built-in type stripping). Keep Hono for HTTP, add `ws` for WebSockets, and use Node's built-in `node:sqlite` for the database. It loads `sim.wasm` **only** to restore and hash snapshots for verification, and for the replay tool. Use `fflate` for snapshot compression on both ends.
- **Database:** SQLite on the `/data` volume (`DATA_DIR`), in WAL mode. Section 9.1 gives the schema.
- **Tests:** `cargo test` (native simulation), Vitest (TypeScript units plus the Node determinism runner), Playwright (Chromium, Firefox and WebKit determinism runners and multi-client tests).
- **CI:** the course workflow (`.github/workflows/checks.yml`) builds the Docker image, starts it with a throwaway `/data` and runs `pnpm check` against it. It only runs once the repo is public; until then `pnpm check` runs locally. Add the Rust and Playwright determinism jobs to it without removing the course steps.
- **Build:** the `Dockerfile` becomes multi-stage: a Rust stage builds `sim.wasm`, a Node stage builds the Vite client, and the final `node:24-slim` stage runs the server with both copied in. Fly builds it remotely.

```
/sim                 Rust crate → sim.wasm (deterministic core)
  src/lib.rs         C ABI exports
  src/grid.rs        cells, update loop
  src/materials.rs   material rules
  src/rng.rs         counter-based RNG
  src/entities.rs    players, projectiles, pickups
  src/spells.rs      cast handling, effects, explosions
  src/gen.rs         world generation (integer noise)
  src/hash.rs        chunk + state hashing
  src/snapshot.rs    canonical snapshot encode/decode
  src/tuning.rs      all gameplay constants (integers)
/shared              TS: protocol codec, constants, sim loader/wrapper, achievements table
/client              Vite app: main thread UI + worker (sim, net, render, avatar)
/server              ws server, tick clock, sequencer, persistence, achievements, telemetry, dashboard
/tools               inputgen (seeded bot inputs), replay CLI, bench
/tests/determinism   runners (node, browser page) + comparator
/docs                assignment-spec.md, DECISIONS.md
fly.toml, Dockerfile (multi-stage: Rust → wasm, Vite build, Node runtime)
```

---

## 6. Simulation specification

### 6.1 World and cells

- **Tick rate:** 60 Hz. One tick is one simulation step.
- **Game world:** `W = 2048`, `H = 1536` cells. `CHUNK = 64`, so the world is 32 × 24 = 768 chunks. The sandbox world is 512 × 512.
- **Coordinates:** `y = 0` is the top of the sky. `y` increases downward.
- **Storage:** two parallel row-major arrays, `mat: [u8; W*H]` (material ID) and `aux: [u8; W*H]` (material-specific state such as lifetime or growth stage). Both are simulation state, hashed and snapshotted.
- **Scratch state:** a `moved` bitmap prevents a cell from being updated twice in one tick. It is cleared at the start of each tick, is **not** state, and is not hashed.
- **Per-chunk metadata:**
  - `awake` (sleep optimisation; invisible)
  - `pristine` (unchanged since generation; used to shrink snapshots)
  - `hash_cache` plus a `dirty_since_hash` flag

### 6.2 Update order (single-threaded, fixed)

Each tick runs in this order:

1. Apply this tick's inputs, in the order given.
2. Update entities: players (official positions from inputs, health, timers), then projectiles (in spawn order), then pickups.
3. Update cells:
   - Iterate active and awake chunks sorted by `cy` descending (bottom first).
   - Within a chunk, scan rows from bottom to top.
   - The x direction alternates with tick parity: even ticks go left→right, odd ticks right→left. The order of chunks within a row follows the same parity.
   - Skip any cell already set in `moved`.
4. Resolve deferred effects (explosions queued during the tick) in queue order.
5. Emit events. Increment the tick.

### 6.3 RNG

```rust
fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}
fn rng(seed: u64, tick: u32, x: u32, y: u32, salt: u32) -> u32 {
    (mix(seed ^ mix(tick as u64 | ((salt as u64) << 32)) ^ mix(((x as u64) << 32) | y as u64)) >> 32) as u32
}
```

Each distinct use of randomness gets its own `salt` constant.

### 6.4 Materials (keep the set small; invest in interactions)

| ID | Material | Class | Behaviour |
|---|---|---|---|
| 0 | Empty | – | – |
| 1 | Bedrock | static | Indestructible. Forms the world floor (bottom 64 rows) and side walls (16 columns). |
| 2 | Rock | static | Destroyed only by explosions. |
| 3 | Dirt | static | Destroyed by explosions. Seeds germinate on it. |
| 4 | Sand | powder | Falls; slides diagonally; sinks through liquids by swapping. |
| 5 | Water | liquid | Falls, spreads sideways. Water + Fire → Steam (the fire is removed). Water + Lava → Rock + Steam. |
| 6 | Wood | static, flammable | Burns slowly. |
| 7 | Seed | powder | On Dirt, `aux` counts up and the seed germinates into Stem; faster when Water is within 2 cells. |
| 8 | Stem | static, flammable | Grows upward with RNG to a height of 8–14 (stored in `aux`), then places a Flower on top and becomes mature (no longer volatile). |
| 9 | Flower (rose) | static, flammable | Cosmetic. |
| 10 | Fire | gas | Rises and flickers. Lifetime of 30–90 ticks in `aux`. Ignites adjacent flammables by chance. Damages players. May become Smoke when it dies. |
| 11 | Smoke | gas | Rises; decays via `aux`. |
| 12 | Steam | gas | Rises; decays via `aux`. |
| 13 | Gunpowder | powder | Fire or Lava contact → explosion of radius 4 (chains). |
| 14 | Lava | liquid (slow; moves every other tick) | Ignites flammables. Damages players at 3× the fire rate. |

**Swap density, low to high:** gases < Water < Lava < powders.

**Volatile materials** keep their chunk awake: Fire, Smoke, Steam, germinating Seed, growing Stem, and any cell that moved last tick.

### 6.5 Chunk activity and sleeping

- **Active set (semantic):** a chunk is active if it intersects a 576 × 320 cell rectangle centred on any *active* player's official position. The view is 480 × 270 cells, plus margin.
  - In the sandbox world, all chunks are always active.
  - Inactive chunks are frozen and don't update (Noita does the same). Because the active set is computed from official positions in the input stream, every client agrees on it.
- **Sleeping (optimisation, invisible):**
  - An active chunk sleeps if no cell in it changed last tick and it contains no volatile material.
  - It wakes when a neighbouring chunk changes a cell within 1 cell of the shared edge, an input touches it, or an explosion or projectile reaches it.
  - After `restore`, all chunks start awake. Test D7 proves this optimisation is invisible.

### 6.6 Entities

- **Player** (stored in a `Vec` sorted by `player_id: u32`). Fields:
  - `active`
  - `life: u16` (incremented on each respawn)
  - `pos` (official, in 1/16-cell fixed point, i32)
  - `health: u8` (max 100)
  - `dead_until: u32`
  - `charges: [u16; NUM_SPELLS]` (`u16::MAX` means infinite)
  - `cooldown_until: [u32; NUM_SPELLS]`
  - `last_hit_by: u32` (0 = none)
  - `last_hit_tick: u32`
  - Hitbox: 5 × 10 cells, anchored at the feet centre.
- **Projectile** (stored in a `Vec` in spawn order; remove with order-preserving `retain`). Fields: `owner`, `spell`, `cast_seq`, `pos` and `vel` (1/256-cell fixed point, i32), `age`.
  - Per tick: apply gravity, then move with integer DDA sub-steps of at most 1 cell.
  - It collides with any non-gas, non-empty cell, or with a player hitbox (official positions, excluding the owner for its first 10 ticks).
- **Pickup** (fixed array created by generation). Fields: `id`, `spell`, `pos`, `charges`, `respawn_at`.
  - When an active player overlaps it, the player gains the charges and the pickup goes inactive until `tick + PICKUP_RESPAWN`.
- **Aim** uses an angle `u16` (65536 units per turn) and a **baked integer sin/cos table** (generated once by a script and checked into the source). Never compute trig at runtime.

### 6.7 Spells (all values are tunables in `tuning.rs`)

| Spell | Found | Cooldown (ticks) | Charges per pickup | Effect |
|---|---|---|---|---|
| Push | starter | 20 | infinite | Fast bolt. On a player hit: knockback impulse, no damage. Sets last-hit. |
| Blast | starter | 90 | infinite | Short cone (radius 24). Knockback to every player in the cone, no damage. Sets last-hit. |
| Water | shallow | 10 | 15 | Bolt that bursts into about 60 Water cells on impact. |
| Rose seed | shallow | 10 | 15 | Bolt that scatters about 8 Seed cells on impact. |
| Fire bolt | deep | 15 | 10 | Bolt that ignites a radius of 3 on impact. Sets last-hit on a direct player hit. |
| Bomb | deep | 60 | 5 | Lobbed with gravity. Explodes on contact or after a 120-tick fuse, radius 18. |

**Casting:** a Cast input spawns a projectile at the caster's official position, provided the caster is alive, has charges, and the cooldown has elapsed. Otherwise the cast is ignored and a `CastRejected` event is emitted.

**Knockback:** the simulation does **not** move players. It emits `Knock { player, vx, vy }` (1/16-cell per tick units, e.g. Push 64, Blast 96). The victim's own client applies the impulse to its local avatar when its simulation reaches that tick, and the result flows back through its Pos inputs.

**Explosion:**
- Carves a circle: destructible cells inside radius `r` become Empty, with rng-chosen Fire on the rim.
- Damages players at `60 * (r - d) / r` (integer arithmetic).
- Knocks back every player within `1.5 r`.
- Wakes affected chunks.
- Explosions caused by a player's projectile set that player as last-hit for everyone damaged.

### 6.8 Damage, death, kills

- **Fire contact:** 1 HP every 6 ticks while the hitbox overlaps Fire. **Lava:** 1 HP every 2 ticks. **Explosions:** as above.
- **Death:** when health reaches 0, the player is dead for 180 ticks, then respawns at the surface spawn point with a rng-chosen horizontal offset. `life` is incremented and a `Respawn { player, x, y, life }` event is emitted.
  - Pos inputs carry `life`. The simulation **ignores Pos inputs with a stale `life`**, so a dead avatar's old position can't override the respawn.
- **Kill credit (last-hit rule):** on death, if `last_hit_by != 0`, `last_hit_by != victim` and `tick - last_hit_tick <= 300`, emit `Death { victim, killer: last_hit_by, cause_spell }`. Otherwise emit `Death { victim, killer: 0, cause }`.
- **Inventory is kept on death** (default; see section 14).

### 6.9 World generation (deterministic, integer-only)

- **Integer value noise:** lattice values come from `rng(seed, 0, ix, iy, SALT_GEN_*)`, with bilinear interpolation using a fixed-point smoothstep table.
- **Surface:** a heightmap around y ≈ 200–260 of Dirt over Rock, with some Wood trees.
- **Shallow band** (y ≈ 260–800): caves where a noise threshold is met. Water pools and sand pockets. Pickups: about 40 total, Water and Rose seed.
- **Deep band** (y ≈ 800–1472): larger, more open caves. Lava pools, gunpowder pockets. Pickups: about 25 total, Fire bolt and Bomb.
- **Cave entrances:** 3–5 guaranteed shafts from the surface into the shallow band.
- **Spawn point:** the centre of the surface.
- **Generation runs eagerly in `init`** (about 3M cells). All chunks start `pristine`.

### 6.10 State hash and snapshots

- **Chunk hash:** xxh3 over the chunk's `mat` and `aux` bytes. Cached, and recomputed only if the chunk changed since the last hash.
- **State hash:** xxh3 over:
  - `tick`
  - the canonical entity bytes (players sorted by ID, projectiles in order, then pickups)
  - the array of 768 chunk hashes, in index order
- **Hash checkpoints:** every 60 ticks. Keep a ring buffer of the last 5 chunk-hash arrays for desync diagnosis.
- **Canonical snapshot format** (little-endian):
  - header: `magic`, `format_version`, `sim_build_hash`, `seed`, `world_kind`, `tick`, `W`, `H`
  - entities section
  - chunk section: the count of **non-pristine** chunks, then `(chunk_index u16, mat[4096], aux[4096])` for each, in ascending index order
- **Restore:** regenerate the world from the seed, then overwrite the listed chunks. Compression (fflate) happens outside the simulation; the hash is over the uncompressed canonical state.

### 6.11 WASM ABI (C ABI, integer arguments only)

```
init(seed_lo: u32, seed_hi: u32, world_kind: u32) -> i32   // generates world, tick = 0
alloc(len: u32) -> u32;  dealloc(ptr: u32, len: u32)
push_input(ptr: u32, len: u32) -> i32      // canonical encoded input for the NEXT step, in order
step() -> u32                              // consumes queued inputs, advances one tick, returns tick
tick() -> u32
state_hash(out_ptr: u32)                   // writes u64 LE
chunk_hashes(out_ptr: u32) -> u32          // writes u64 LE per chunk, returns count
snapshot_size() -> u32;  snapshot_write(out_ptr: u32) -> u32
restore(ptr: u32, len: u32) -> i32
mat_ptr() -> u32;  aux_ptr() -> u32;  width() -> u32;  height() -> u32
dirty_rects(out_ptr: u32, max: u32) -> u32 // render-only
events(out_ptr: u32, max: u32) -> u32      // events from last step
entities(out_ptr: u32, max: u32) -> u32    // render-only view of players/projectiles/pickups
set_sleep_enabled(on: u32)                 // test hook for D7
```

**Input encodings (simulation level, after server stamping):**

| Input | Fields | Notes |
|---|---|---|
| `Join` | `player_id` | Creates the player, or reactivates a persisted one. Emits `Spawn`. |
| `Leave` | `player_id` | Deactivates; the entity stays in state, so inventory persists. |
| `Pos` | `player_id, life, x, y, facing` | Position in 1/16-cell fixed point. |
| `Cast` | `player_id, spell, angle u16, cast_seq u16` | |
| `Paint` | `player_id, mat, x0, y0, x1, y1, radius` | Sandbox worlds only; ignored in game worlds. |

---

## 7. Networking protocol

### 7.1 Tick model

- **Server clock:** `c(t) = floor((t - t0) * 60 / 1000) + base_tick`, using a monotonic clock.
- **Stamping:** an input received while the clock reads `c` is appended to **open tick `c + 1`**. Within a tick, inputs keep server arrival order.
- **Closing:** when the clock advances to `c`, tick `c` is **closed**, since no new input can land in it. The server broadcasts every closed tick immediately: one message per tick, about 5 bytes when empty.
- **Pausing:** when a world has no connected players, its clock pauses. On the next join, `t0` is re-based so ticks continue from where they stopped.
- **Client playout buffer:** the client steps at a steady 60 Hz and keeps `latest_closed - sim_tick` near a target J = 2 (adapted to measured jitter).
  - If the buffer grows beyond J + 4, step extra ticks, at most 4 extra per frame.
  - If it is empty, hold.
  - If the client falls more than 600 ticks behind, request a resync.
- **Resulting latency:** a world action appears after about RTT + (1 + J) ticks, roughly 50 ms plus the round trip.

### 7.2 Messages (binary WebSocket frames, little-endian, `u8` type tag)

**Client → Server:**

| Message | Fields |
|---|---|
| `HELLO` | `protocol_version, sim_build_hash[32], player_token[32], world_id` |
| `INPUT` | `client_seq u32, kind u8, payload` (`Pos` every 2 ticks; `Cast` and `Paint` on action) |
| `HASH` | `tick u32, state_hash u64, step_ms_p50 u16, step_ms_p95 u16` (every 60 ticks; µs/10 units) |
| `SNAPSHOT_UPLOAD` | `tick u32, state_hash u64, compressed bytes` |
| `CHUNK_HASHES` | `tick u32, hashes[768] u64` (only on request) |
| `CLAIM` | `tick u32, claim_kind u8, payload` (achievement-relevant simulation events: `Death`) |
| `PING` | `t u32` |

**Server → Client:**

| Message | Fields |
|---|---|
| `WELCOME` | `player_id, world_seed, world_kind, tick_hz` |
| `REJECT` | `reason` (e.g. build mismatch → client must reload) |
| `SNAPSHOT` | `tick, compressed bytes` |
| `TICK` | `tick u32, n u16, [player_id u32, kind u8, len u16, payload]*` |
| `REQUEST_SNAPSHOT` | `tick` |
| `REQUEST_CHUNK_HASHES` | `tick` |
| `RESYNC` | (followed by `SNAPSHOT` + `TICK`s) |
| `ACHIEVEMENT` | `player_id, achievement_id` (for UI toasts) |
| `PONG` | `t` |

### 7.3 Join, leave, late join

1. On `HELLO`, the server checks the build hash. It sends the latest **verified** snapshot (tick S) and every closed tick from S+1 up to now, and stamps a `Join` input for the player.
2. The client restores, fast-forwards with a progress bar, and then plays live.
3. On disconnect, the server stamps `Leave`.
4. The player entity (position, health, inventory) persists in simulation state, so it survives logout through snapshots.

### 7.4 Hash checks and resync

- At each checkpoint tick, collect `HASH` from every client, waiting up to 2 seconds. The majority value is the truth.
  - Tie-break between two clients: trust the client connected longest.
- A client that disagrees gets `RESYNC`.
- The server also records a **desync incident**:
  1. Request `CHUNK_HASHES` for that tick from both sides.
  2. Diff them to find the diverging chunks.
  3. Store the tick, chunks, user agents and build in `desync_incidents`.
  4. Ask the divergent client to upload its snapshot, so `tools/replay` can diff the cells offline.

### 7.5 Snapshots

- Roughly every 1800 ticks (30 seconds), the server picks a **reference client** (agreed with the majority recently, connected longest). It requests a snapshot at a future tick S that is a multiple of 60 and at least `now + 120`.
- **Verification:** the server restores the uploaded snapshot into its own `sim.wasm` instance (restore only, never step), computes the state hash, and accepts it only if it matches the majority hash for tick S.
- **Retention:** keep the last 5 verified snapshots per world, plus one per hour flagged `keep_for_timelapse`. Delete `tick_log` rows older than the oldest retained snapshot.

### 7.6 Validation and rate limits (light; this is co-op)

- Validate message shapes.
- Cap inputs at about 40 per second per client.
- Reject Pos jumps larger than the maximum avatar speed plus the maximum knockback speed (no simulation needed for this check).
- Paint is only accepted in sandbox worlds.

---

## 8. Client

- **Worker** owns the simulation instance, the WebSocket, the playout buffer, the avatar controller and the renderer. **Main thread** owns the DOM HUD (health, spell bar with charges and cooldowns, achievement toasts, join screen) and forwards keyboard and mouse events.
- **Rendering (WebGL2):**
  - R8UI textures for `mat` and `aux`; upload only `dirty_rects` with `texSubImage2D`.
  - The fragment shader looks up a palette by material, adds cosmetic variation from `hash(x, y)` (floats are fine here), and animates fire flicker from `aux`.
  - Overlay sprites for players, projectiles and pickups (from `entities`), plus cast previews.
  - The view is 480 × 270 cells, scaled to the canvas with nearest-neighbour filtering.
- **Avatar controller** (TypeScript, local only, floats allowed):
  - Walk, jump, and **levitation with limited energy**, so players can climb out of caves.
  - Collides read-only against the latest simulated grid.
  - Applies `Knock` impulses when the simulation reaches their tick.
  - Teleports on `Respawn`.
  - Sends `Pos` (quantized, with the current `life`) every 2 ticks.
- **Other players** are drawn from their official positions, interpolated.
- **Cast preview:** on click, draw a ghost projectile immediately from the predicted avatar position. Remove it when the real projectile with the matching `cast_seq` appears.
- **Identity:** on first visit, `POST /api/players { display_name }` returns a random token, stored in `localStorage`. The server stores only `sha256(token)`.

---

## 9. Server and persistence

### 9.1 Schema (SQLite on `/data`)

Types follow SQLite: `u64` hashes are stored as the signed 64-bit reinterpretation, blobs hold the fflate-compressed bytes, and times are Unix milliseconds.

```sql
create table worlds (
  id integer primary key,
  kind text not null check (kind in ('sandbox','game')),
  seed integer not null,
  sim_build text not null,
  last_tick integer not null default 0,
  created_at integer not null
);
create table snapshots (
  world_id integer not null references worlds(id),
  tick integer not null,
  state_hash integer not null,         -- u64 reinterpreted as signed
  sim_build text not null,
  format_version integer not null,
  data blob not null,                  -- fflate-compressed canonical snapshot
  keep_for_timelapse integer not null default 0,
  created_at integer not null,
  primary key (world_id, tick)
);
create table tick_log (
  world_id integer not null references worlds(id),
  first_tick integer not null,
  last_tick integer not null,
  sim_build text not null,
  data blob not null,                  -- encoded TICK entries for [first_tick, last_tick]
  primary key (world_id, first_tick)
);
create table players (
  id integer primary key,
  display_name text not null,
  token_hash text unique not null,
  created_at integer not null,
  last_seen integer
);
create table player_stats (
  player_id integer references players(id),
  stat text not null,                  -- casts_push, casts_water, max_depth, kills, deaths, ...
  value integer not null default 0,
  primary key (player_id, stat)
);
create table achievements (
  player_id integer references players(id),
  achievement text not null,
  world_id integer references worlds(id),
  tick integer,
  earned_at integer not null,
  primary key (player_id, achievement)
);
create table desync_incidents (
  id integer primary key,
  world_id integer, tick integer, details text, created_at integer   -- details is JSON text
);
create table metrics_minutely (
  world_id integer, minute integer, name text, value real,
  primary key (world_id, minute, name)
);
```

### 9.2 Write policy

- The database is never in the real-time path. Keep worlds, recent ticks and players in memory.
- Flush `tick_log` batches at least every second.
- Write verified snapshots as soon as they're accepted.
- Update stats and achievements on change, batched.
- **Recovery after a crash or an idle stop** is the latest verified snapshot plus the replayed `tick_log`, so at most about 1 second of world is lost.
- **When the last player leaves,** request a snapshot from them before stamping `Leave`, so the next cold start replays a short log rather than the whole session.
- **Memory budget (256 MB):** Node itself takes roughly 60–80 MB. One game world is about 6.3 MB of cells, and the server's verify-only `sim.wasm` instance needs about the same again. Keep only the tick log since the latest verified snapshot in memory, and watch RSS on the dashboard; warn at 200 MB.

### 9.3 Shutdown and deploys

- Handle `SIGINT`/`SIGTERM`: stop accepting inputs, close the current tick, flush `tick_log`, then exit. Auto-stop sends this signal every time the machine idles, so it is a hot path. Set `kill_signal` and `kill_timeout` in `fly.toml` if the defaults are too short (adding them leaves the course-fixed settings alone).
- **New sim build deployed:** the logged inputs after the latest snapshot can't be replayed under new rules. Load the latest verified snapshot under the new build (if the snapshot `format_version` is unchanged), start a fresh log, and accept losing at most 30 seconds of history. If `format_version` changes, reset the world only before crit 10 (Wed 21 Oct). After that, classmates and markers rely on the world persisting across redeploys, so a format change needs a migration.

### 9.4 Fly configuration

`fly.toml` is fixed by the course; don't change these settings:

- `primary_region = "syd"`.
- **One `shared-cpu-1x` machine with 256 MB**, deployed with `--ha=false`. One machine is also what the design needs, because world state lives in this process's memory.
- **One 1 GB volume at `/data`.** The SQLite file, snapshots and tick log all live here; warn at 700 MB.
- **Auto-stop and auto-start**, with `min_machines_running = 0`. See section 9.2 for what this means for recovery.
- Serve the client's static build from the same Node process, so WebSockets share the origin.

---

## 10. Achievements

All achievements are defined in `shared/achievements.ts`. Tune the names freely.

**Counted on the server from inputs** (no client trust needed; counts cast *attempts*):

| Achievement | Condition |
|---|---|
| First spell | Any Cast |
| Gardener | 100 Rose seed casts |
| Waterworks | 100 Water casts |
| Pyromaniac | 50 Fire bolt casts |
| Demolitionist | 25 Bomb casts |
| Spelunker | A Pos input with y ≥ 800 (deep band) |

**Claimed from simulation outcomes** (majority rule):

| Achievement | Condition |
|---|---|
| First blood | First credited kill |
| Shoved to their doom | A kill whose last hit was Push or Blast |
| Five kills | 5 credited kills |
| Back from the dead | 10 deaths |

**Majority claim rule:**
- Each client sends `CLAIM` for every `Death` event its simulation emits.
- The server awards the achievement when at least `ceil(active_clients / 2)` distinct clients send an identical claim (same tick and payload) within 10 seconds. With one client connected, it accepts the single claim.
- Kills and deaths also go into `player_stats`.

---

## 11. Telemetry and live dashboard

The server collects metrics in memory, streams them to `/dashboard` via SSE (protected by `DASHBOARD_TOKEN`), and writes per-minute aggregates to `metrics_minutely` for history charts. Basic metrics come in at M2 and the full dashboard at M6.

**Metrics:**

- **Presence:** players online per world, joins and leaves
- **Tick health:** server tick rate; per client, tick lag (server tick − last hashed tick), RTT, playout buffer size, and client-reported step time p50/p95
- **Traffic:** bytes in and out per client; inputs per second by kind; casts by spell
- **Consistency:** hash checks passed and failed, resyncs, desync incidents (with the first diverging chunk)
- **Snapshots:** count, compressed size, verify time, upload latency
- **Database:** `tick_log` write latency, rows per second, SQLite file size on `/data` (warn at 700 MB of the 1 GB volume)
- **Game:** kills, deaths, achievements awarded
- **Process:** event-loop lag, RSS (warn at 200 MB of 256 MB), CPU (headline point for the demo: the server stays near idle because it never simulates)

Crit 10 (Wed 21 Oct) has classmates use the app from the URL alone while you read the logs, so structured server logs and the basic dashboard must be live by then, not at M6.

---

## 12. Determinism and assumption tests (upfront)

### 12.1 Harness

- **`tools/inputgen`** produces a seeded, deterministic input script: N bot players doing random-walk Pos, casts and paints over M ticks, including joins and leaves.
- **Runner contract:** `run(script) -> { hashes: [(tick, u64)] every 60 ticks, finalChunkHashes }`.
- **Runners:**
  - Node (Vitest)
  - a browser page `tests/determinism/runner.html` driven by Playwright in **Chromium, Firefox and WebKit**
  - native Rust (`cargo test`)
- **Comparator:** prints the first diverging tick and the diverging chunk indices, using the chunk-hash ring buffer.

### 12.2 Tests

| ID | Test | Catches | Needed by |
|---|---|---|---|
| D1 | Repeatability: two fresh instances, same runtime, same script | uninitialised memory, ordering bugs | M0 / G1 |
| D2 | Cross-engine: Node vs Chromium vs Firefox vs WebKit | engine-dependent behaviour | M0 / G1 |
| D3 | Native Rust vs WASM hash logs | `usize`/target-dependent code | M0 / G1 |
| D4 | Cross-machine: D2 on x86-64 (this Mac and CI) **and** an ARM device once; a phone opening the browser runner counts | architecture differences | G1 |
| D5 | Snapshot round-trip: snapshot at random ticks, restore into a fresh instance, continue, compare | state missing from snapshots | M0 (grid); re-run at M4 and M5 as entities are added |
| D6 | Step-batching invariance: 1 step per call vs k per call vs catch-up mode | frame-timing dependence | M0 / G1 |
| D7 | Sleep invisibility: `set_sleep_enabled(0)` vs `1` | sleep optimisation leaking into results | M3 |
| D8 | Generation determinism across D2 runtimes; regenerated pristine chunks equal stored ones | float or noise drift in generation | M3 |
| D9 | Late join: client B joins at tick N via snapshot + replay and matches A thereafter | join and replay path | M2 |
| D10 | **Canary:** a `--features canary` build imports one host function returning an engine-dependent value and mixes it into one cell. **D2 must fail.** | proves the harness can detect nondeterminism | M0 / G1 |
| D11 | Static guards in CI: `clippy::float_arithmetic` deny, `disallowed-types` (HashMap/HashSet), `disallowed-methods` (time APIs), and **assert the normal `sim.wasm` build has zero imports** (the D10 canary build is exempt) | rule violations | M0 / G1 |
| D12 | Soak: 4 bots × 100k ticks across all runtimes | rare-path divergence | before G2; then nightly |
| N1 | Live multi-client: local server plus 3 Playwright clients running bots for 10 minutes, with WebSocket delay/jitter injection (20–150 ms) and one client CPU-throttled 4× via CDP. Zero mismatches; the throttled client catches up or resyncs cleanly. | protocol, playout and resync bugs | G2 |
| P1 | Worst-case performance: 4 players spread across the world, each starting a large fire and a flood at once. Measure step time p50/p95 in Chromium on this laptop with 4× CDP CPU throttling as a stand-in for a weak machine, and once on a real phone at the marking viewport. Budget: **p95 ≤ 8 ms**. | the CPU assumption | G2 |

### 12.3 If P1 fails (in order)

1. Tune sleeping and dirty-rect skipping.
2. Update liquids every other tick.
3. Shrink the active rectangle.
4. *(Stretch)* "Islands": each client simulates only the connected group of active chunks around its own player. When groups merge, the joining client gets a snapshot and replays the logged inputs to catch up.

---

## 13. Milestones and timeline

Today is Tuesday 13 October 2026. The project is due **noon Monday 9 November**. It is individual, so these dates are for one person.

The course checkpoints set two hard dates inside this plan:

- **Crit 9 "All at once", Wed 14 Oct:** too soon for this branch. Whatever is shown there comes from the existing work, and that choice is the user's.
- **Crit 10 "Fly by instruments", Wed 21 Oct:** classmates use the deployed URL while you read the logs. M2 (deployed multiplayer sandbox) plus basic telemetry must be live by **Tue 20 Oct**.

| Milestone | Dates | Scope | Done when |
|---|---|---|---|
| **M0: Determinism spike + skeleton** | Tue 13 – Thu 15 Oct | Monorepo and CI. Simulation core: grid, update order, RNG, hashing, snapshot/restore, Paint input, materials 0–5 and 10. ABI and TS wrapper. Harness: inputgen, the 3 runner types, comparator, canary. | **Gate G1:** D1, D2 (all 4 runtimes), D3, D5, D6, D10, D11 green in CI; D4 run once. |
| **M1: Single-player sandbox** | Thu 15 – Sat 17 Oct | Worker, WebGL2 renderer, paint UI, the full material set and interactions (section 6.4). | All materials paintable and interacting; D1–D6 still green. |
| **M2: Multiplayer sandbox, deployed** (fallback #1) | Sat 17 – Tue 20 Oct | Tick clock, sequencer, protocol, join/leave, late join, playout buffer, hash checks and resync, verified snapshots, SQLite persistence on `/data`, identity tokens, Fly deploy (`syd`), structured logs and a basic dashboard for crit 10, touch painting at the phone viewport, a first README definition of good. | 3 browsers paint together on the Fly URL, one at phone width. Killing the server, and separately letting it idle-stop, restores the world to within about 1 second. D9 passes. Live for crit 10. |
| **M3: Big world** | Tue 20 – Thu 22 Oct | 2048 × 1536 game world, generation (bands, caves, entrances, pickups placed), active-set rule, sleeping, pristine snapshots, camera and scrolling. | D7 and D8 green; world explorable in free-camera mode. |
| **M4: Avatars + surface/shallow spells** (fallback #2) | Thu 22 – Mon 26 Oct | Player entities, Pos inputs with `life`, avatar controller (walk, jump, levitate), collision, Push, Blast, knockback, pickups, Water and Rose seed with growth, cast previews, HUD. | **Gate G2 (Mon 26 Oct):** N1 passes (3 players, 10 minutes, zero mismatches) and P1 within budget. |
| **M5: Deep caves and damage** | Tue 27 – Sat 31 Oct | Fire bolt, Bomb, gunpowder, lava, explosions, health, fire and lava damage, death and respawn, last-hit kills, events. | D5 re-run with entities green; deep caves playable. |
| **M6: Achievements + full dashboard** | Fri 30 Oct – Mon 2 Nov | Server-counted and majority-claimed achievements, toasts, per-minute dashboard history (basic telemetry already shipped at M2). | **Feature freeze, end of Mon 2 Nov.** |
| **M7: Polish + submission** | Tue 3 – Sun 8 Nov | Balance, onboarding, D12 and a 30-minute N1 soak, bug fixes, final README (400–600 words) and PROCESS.md (900–1100 words) rewrite, check both marking viewports, final deploy. | Final deploy by Sun 8 Nov; submit by noon Mon 9 Nov. |

**Gate playbook:**

- **G1 red:** do not build further. If the failure is specific to one engine and can't be fixed in a day, document it and require the passing browsers for the demo.
- **G2 red on performance:** follow section 12.3 and keep going.
- **G2 red on desync:** freeze feature work and fix it. If it isn't fixed by Wed 28 Oct, polish and ship the M4 feature set, or the M2 sandbox.

---

## 14. Open decisions (use the default unless the user says otherwise)

| Decision | Default |
|---|---|
| How players get underground | Pre-generated cave entrances; explosions can carve. A Dig spell is optional later. |
| Spell charges, cooldowns, pickup respawn | Values in section 6.7; `PICKUP_RESPAWN = 3600` ticks (60 s) |
| Death penalty | Keep inventory; respawn on the surface after 3 seconds |
| Simulation language | Rust (installed locally with the `wasm32-unknown-unknown` target) |
| Database flavour | SQLite (`node:sqlite`) on the `/data` volume; no database server is available |
| Maximum players per world | 8 |
| Phone viewport | The marker watches one session on a phone. The sandbox supports touch painting; the game world on a phone is spectate-only (camera follow, no avatar). |
| Sandbox in the final build | Kept as a separate "creative mode" world |
| Climbing out of caves | Levitation with limited energy |

---

## 15. Fallback ladder

Every milestone leaves a playable product, so there's always a shippable fallback:

- If M5 slips, ship M4: a co-op mini-Noita with knockback and creative spells.
- If M4 slips, ship M2 plus M3: a persistent multiplayer sandbox on a big world.
- The sandbox world stays in the final build as creative mode, so no milestone's work is thrown away.

**Do not build the Noita version and the sandbox in parallel.** They share one core.

---

## 16. Out of scope (don't build)

- Server-side simulation stepping (the server only restores snapshots to hash them)
- P2P or WebRTC
- Rollback netcode
- WASM threads or SharedArrayBuffer
- Rigid-body physics
- Per-cell ownership or provenance tags
- Anti-cheat beyond the light validation in section 7.6
- Full avatar controls on phones (touch painting in the sandbox and spectating the game world are in scope; see section 14)

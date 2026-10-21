# Plan: configurable rooms and game modes

Rewritten 2026-10-21 (evening) by the session model, after the user's direction:

- **Modes:** Survival (last player standing), Deathmatch (endless fighting, resources respawn), and peaceful
  Creative rooms that players make and share.
- **Tools:** Creative has every spell, plus Sandspiel-style brushes.
- **Config:** everything is configurable per room: terrain, size and rules.
- **Not live:** the game is **not live until the user says so**, so resets and format breaks are fine.

The first version of this plan (four fixed worlds, protecting the live cave world) is replaced. Its git history is
`cd194e7`.

Inputs: `docs/research/game-modes-design.md` (prior art), `docs/research/game-modes-capacity.md` (server budget),
`docs/research/cave-gen-v2.md` (why the caves can't be walked; gen v2). Feature freeze is Mon 2 Nov; the final
submission is due Mon 9 Nov.

## The idea: a room is a seed plus a config

Every world becomes a **room**: a seed plus a small fixed-width integer **config**. A mode is just a preset of
config values. The sim reads the config at `init`, stores it in the snapshot header, and includes it in the world
hash, so two clients with different configs fail the hash check straight away. All rule logic stays in `sim/`
(invariant 1). The config is integers only (invariant 2).

### Config fields (version 1, 16 bytes, all `u8` or `u16`)

| Field | Values | Notes |
|---|---|---|
| `terrain` | 0 Caves (gen v2), 1 Solid box, 2 Empty box | Solid box: Dirt over Rock, for digging and carving. Empty box: a Sandspiel canvas with walls |
| `size` | 0 S 512x384, 1 M 1024x768, 2 L 2048x1536 | L only for Caves; the snapshot cap scales by size |
| `avatars` | 0 off, 1 on | Off reproduces today's paint-only sandbox |
| `damage` | 0 none, 1 environment only, 2 full PvP | 1 is "peaceful but lava still burns" |
| `spells` | 0 from pickups, 1 all, unlimited charges | Cooldowns stay in both cases: they bound per-tick work |
| `brushes` | 0 off, 1 on | Sandspiel tool panel; Paint inputs refused when off |
| `death` | 0 respawn, 1 out until the round ends | 1 is what makes Survival |
| `respawn_secs` | 0..30 | Used when `death` is 0 |
| `pickup_respawn` | 0 off, 1 on | Deathmatch on, Survival off |
| `round` | 0 none, 1 last player standing | Needs `death` 1 |
| `max_players` | 2..8 | The server enforces it; the sim's `MAX_PLAYERS` stays 8 |
| `visibility` | 0 public, 1 unlisted | Server-only (not hashed); unlisted rooms are reachable by link only |

The sim rejects an out-of-range config (`init` returns -1) and clamps nothing silently. The server validates the
same table in `shared/room.ts` before it creates a room, so a bad config never reaches a client.

### Presets

| Preset | terrain | size | damage | spells | brushes | death | pickups respawn | round |
|---|---|---|---|---|---|---|---|---|
| **Survival** | Caves | M | PvP | pickups | off | out | off | last standing |
| **Deathmatch** | Caves | M | PvP | pickups | off | respawn 3 s | on | none |
| **Creative** | Solid box or Caves | M | none | all | on | respawn 1 s | on | none |
| **Classic sandbox** | Empty box | S | n/a | n/a | on | n/a | n/a | none (avatars off) |

The create-room form opens on a preset, with an "Advanced" section that exposes every field.

## Sandspiel-style brushes (Creative)

Sandspiel's appeal is a big element palette, a size slider, and instant feedback. In this game:

- **Panel:** a material picker (every material in `sim/src/materials.rs` that makes sense to place: Rock, Dirt,
  Sand, Water, Wood, Seed, Fire, Gunpowder, Lava, plus an Eraser), a size slider up to `MAX_PAINT_RADIUS` (32), and
  a toggle between the brush and the spell bar. The panel sits beside the spell bar, so both are one click away.
- **Paint modes:** *replace* (today's Paint) and *fill empty only* (paint sand without erasing rock). The second
  needs one flag bit in the Paint input. The input stays bounded: the same radius clamp and endpoint clamp.
- **Rate:** brush strokes are already batched per tick by the client. The existing per-connection input caps
  apply. A room of 8 painters at radius 32 must stay inside the per-tick step budget, and R4 measures it.
- **Out of scope, kept in FUTURE.md:** Sandspiel's cloner and wind tools, new materials (ice, oil, gas), and spray
  density.

## Survival rounds (sim-side)

A round state machine lives in sim state, so every client agrees on it:

- **Phases:** `waiting` (fewer than 2 players), `countdown` (5 s), `playing`, `ended` (5 s banner).
- **Death:** a death in `playing` sets the player *out* until the round ends. They watch, and the camera can
  follow survivors. A player who joins mid-round is out until the next round.
- **End:** one player left (or none) ends the round with an `EV_ROUND_END {winner}` event.
- **After the win:** the room ends; there is no next round in the same world (user, 21 Oct). The server sees
  `EV_ROUND_END` confirmed by a majority claim (the D-120/D-121 path deaths use), shows the banner, then deletes
  the room. "Play again" makes a fresh room with the same config. So **no in-sim reset is needed**, which removes
  the riskiest piece of the earlier design (reset vs chunk sleeping).
- **Joiners:** a player who arrives after `countdown` spectates. The room is listed as "in progress" in the browser.
- **Tests:** D1/D2 need a scripted round to a winner, and a net test checks the room is deleted after the win and
  after the last leave.

## Server: rooms instead of two fixed worlds

The capacity research measured 82 MB RSS idle with two worlds loaded, and found no per-world sim on the server. A
world is a tick log, a member map and a snapshot blob. That makes many rooms cheap **if empty ones unload**.

- **Storage:** a `rooms` table (id, code, name, config blob, seed, creator visitor id, created_at, last_active).
  The existing world tables are already keyed by world id, so a room's id is its world id.
- **Codes:** each room gets a 6-character code from `crypto.randomBytes` (not its sequential id, so unlisted rooms
  can't be enumerated). Links are `/r/<code>`.
- **Lifecycle (user's answers, 21 Oct):**
  - **Creative:** a room loads on its first join and unloads after 2 minutes empty (snapshot flushed, then dropped
    from memory). After **1 hour inactive** it is **archived**: the server takes one final snapshot and deletes the
    tick log and older snapshots, leaving one row. Snapshots are already zlib level 6 (`shared/protocol.ts:301`),
    so the archive step may recompress at level 9, or with a material-run pre-pass if R2's measurement shows it
    pays. A join to an archived room restores from that snapshot. Deleted after **7 days** inactive.
  - **Deathmatch:** deleted as soon as the last player leaves. Nothing persists; the room is never snapshotted to
    disk for archive.
  - **Survival:** deleted when a player wins the round (after the 5 s winner banner) or when the last player
    leaves, whichever comes first. One match per room; "play again" creates a fresh room with the same config and
    sends everyone the new code.
  - **`/sandbox`:** a permanent public Classic sandbox room, never archived or deleted.
  - Because match rooms vanish when empty, they cost disk only while running, and stored-room limits apply to
    Creative only.
- **Caps** (from the capacity note, measured in R2 before shipping): 6 loaded rooms, 40 members in total, 8 per
  room, 3 rooms created per visitor per day, 100 stored rooms. Room creation goes through `log.limited`.
- **Names:** room names are user text. Cap them at 32 characters, store them plain, and render them only with
  `textContent`. Like player names, they never go into HTML.
- **API:** `POST /api/rooms` (create, validated), `GET /api/rooms` (public rooms with live counts, no player
  names), `GET /api/rooms/<code>` (config and world id for joining). The admin dashboard gets a rooms panel.
- **Joining:** the client fetches the room, then sends HELLO with the world id. WELCOME carries the config, so a
  fresh room with no snapshot inits identically everywhere. Protocol v9.
- **Process:** one process. Worker threads buy nothing on one shared vCPU (capacity note).

## Caves: gen v2 everywhere

Since nothing is live, the cave world simply moves to gen v2. No frozen v1 and no versioned generator; that drops
architectural decision 2 from the cave note. Gen v2, from `docs/research/cave-gen-v2.md`:

- A worm backbone at minimum radius 7.
- An opening pass that widens necks.
- A box-fit repair, flood-filling with a 6x11 box and carving to any band it can't reach.
- No pools on the backbone.

The test `traversable_to_every_band` must be shown red on today's generator first. It has to work at all three
sizes.

**Starting dig:** a short-range dig from spawn that cuts Dirt, Sand, Wood **and Rock** at a small radius (about 4)
and leaves Bedrock alone. Soft-only carving (the cave note's cheaper option) won't open the rock necks that are
the actual problem. Bomb stays the big digger, so deep pickups still matter. Whether the dig is part of Blast or
its own spell is R1's call. With no live world, a new spell id and a snapshot format change cost nothing extra.

## Settled by this plan (DECISIONS.md rows on landing)

- **D-132** Rooms with a hashed, integer config replace fixed world kinds. Modes are presets.
- **D-133** Snapshot format 4 carries the config and the round state. Older formats are refused: nothing is live.
- **D-134** One process; rooms load lazily and unload when empty; caps as above.
- **D-135** Room lifetimes by mode: Creative archives at 1 h and is deleted at 7 days; match rooms are deleted on
  a win or the last leave. Survival is one match per room, so there is no in-sim round reset.
- **D-136** `/` is the menu: the room browser, the presets, and "create a room". The course spec only needs `/` to
  serve the client page, with a module script and a `/readme/` link (`spec/game.test.ts:15-22`).
- **D-137** Gen v2 for every Caves room; a starting dig that cuts Rock at a small radius.

## Answered by the user (21 Oct)

- **U1:** Keep `/sandbox` as a permanent room. Yes.
- **U2:** Creative rooms archive after 1 h inactive and are deleted after 7 days. Deathmatch is deleted when the
  last player leaves. Survival is deleted on a win or when the last player leaves.
- **U3:** No cut line. Time and budget are ample; build all of it, with the full review discipline.
- **Open:** how many rooms of each type fit at once. A measurement is under way (`docs/research/capacity-rooms.md`).
  The caps in "Server" above are placeholders until it lands.

## Milestones

Workers run one at a time: they share `shared/protocol.ts`, `server/world.ts`, `client/main.ts` and `sim/`. Each
brief names the files the worker may touch, gives a commit checklist, and asks for "Architectural decisions for
review". Each commit is gated on exit codes:
`pnpm typecheck && pnpm test:net && pnpm test:determinism && git commit`.

| # | Milestone | Worker | Size | Review |
|---|---|---|---|---|
| R0 | **Config in the sim.** `init(seed_lo, seed_hi, cfg_ptr, cfg_len)`, the config struct and validation, rule helpers replacing every `world_kind` check, snapshot format 4, `shared/room.ts` table and presets. Worlds 0 and 1 re-expressed as presets | Sonnet | M | **yes** (ABI, snapshot) |
| R1 | **Terrain.** Gen v2 for Caves, Solid box and Empty box, all three sizes; the traversal test red then green; the starting dig | Sonnet | M | gen output by eye in `client/gen-preview.html` |
| R2 | **Rooms on the server.** Table, codes, create/list/get API, lazy load and unload, caps, logging, admin panel, protocol v9; then the capacity measurement (Docker image, 24 sockets over 4 rooms, a forced verify; pass is under 200 MB) | Sonnet, then Haiku runs the measurement | M | **yes** (protocol, lifecycle) |
| R3 | **Menu.** Room browser, presets, create form with Advanced, `/r/<code>` links, share button | Sonnet | M | look at phone width |
| R4 | **Creative.** All spells, the brush panel, fill-empty mode, damage off; measure 8 painters | Sonnet | M | two browser contexts |
| R5 | **Deathmatch.** Respawn delay, pickup respawn, kill and death tallies in sim state, kill feed, scoreboard | Sonnet | M | two contexts fighting |
| R6 | **Survival.** The round machine, out-until-the-end, late joiners spectate, the winner banner, delete on win or last leave, "play again" | Sonnet | M | **yes** (sim state, lifecycle) |
| R7 | **Ship prep.** DECISIONS rows, an engineering-decisions entry ("consent by room"), README, FUTURE.md, merge rehearsal, Docker boot, `pnpm check` against it; ask before pushing to `main` | session model plus Sonnet | S | |

## Schedule

| Day | Work |
|---|---|
| Thu 22 Oct (budget resets) | R0 and its review |
| Fri 23 | R1 |
| Sat 24 to Sun 25 | R2, its review, the measurement |
| Mon 26 | R3 |
| Tue 27 | R4 |
| Wed 28 to Thu 29 | R5 |
| Fri 30 to Sun 1 Nov | R6 and its review (cut line), R7 |
| Mon 2 Nov | Feature freeze |

Eight milestones in eleven days, serial. The user has said time and budget are ample, so there's no cut line, and
any slack goes to the FUTURE.md extras (rounds polish, more brush tools).

## Risks

- **Room churn under memory pressure.** Loading a Caves L room verifies a 7 MiB snapshot. The loaded-room cap and
  the R2 measurement are the levers. A Caves L room may need to count as two slots.
- **A win claimed by a lying client.** The room is deleted on a win, so the end of a round must be majority-agreed
  like deaths (D-121), not taken from one client. R6's review checks it.
- **Brush load.** 8 painters at radius 32 in one tick; R4 measures it, and the radius cap is the lever.
- **User text** (room names): `textContent` only, with a length cap. The net tests include a name with markup.
- **Scope.** Cloner and wind tools, new materials, private passwords, room ownership transfer, and a per-player
  PvP toggle all go to FUTURE.md.

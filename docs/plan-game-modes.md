# Plan: game modes and a menu

Written 2026-10-21 by the session model. Builds on `docs/research/game-modes-design.md` (what the modes are) and
`docs/research/game-modes-capacity.md` (whether the server can carry them). Feature freeze is Mon 2 Nov; the final
submission is due Mon 9 Nov.

## The problem

PvP is "up to the players", but damage is unconditional in the cave world (`apply_damage` in `sim/src/spells.rs`).
One player who wants to fight forces everyone else to. Every game the research looked at that handles this well
(Minecraft servers, Noita's Entangled Worlds lobbies, .io games) settles consent **at the world level**: you choose a
fight by choosing where you go. A per-player toggle (Terraria) is weaker here, because Blast and Bomb are area
damage, and a griefer can still blow up the ground under a peaceful player.

## The shape

A menu at `/` with one card per world. Each card has the rules in one line, a PvP badge, the number of players
online (aggregate only), and a Join button. Name entry moves onto the menu.

| id | kind | URL | World | Damage | Spells | Paint | Size |
|---|---|---|---|---|---|---|---|
| 0 | 0 sandbox | `/sandbox` | Materials toy, as now | n/a | none | yes | 512x512 |
| 1 | 1 caves | `/caves` | The live cave world, as now | **decision U1** | pickups | no | 2048x1536 |
| 2 | 2 creative | `/creative` | Build freely with avatars | off (lava and fire too) | all, unlimited | yes | 1024x768 |
| 3 | 3 arena | `/arena` | Free-for-all PvP | on | pickups, strong ones deep | no | 1024x768 |

**New kinds, not flags.** `world_kind` is already an integer in the ABI and in the snapshot, and it already gates
behaviour in the sim. Adding kinds 2 and 3 leaves worlds 0 and 1 byte-identical, so the live cave world keeps its
state (D-014). Flags on world 1 would be cheaper to write but would change a live world's rules underfoot.

**One process.** The capacity research measured 82 MB RSS idle with both worlds loaded. The server runs no sim per
world: a world is a tick log, a member map and a snapshot blob, and one shared verify worker does the checking.
Worker threads or child processes would cost RAM and give no CPU gain on one shared vCPU. What binds first is the
total number of sockets (each can buffer up to 8 MiB) and the single 4 ms tick timer, not the number of worlds. So:
four worlds, one process, plus a **server-wide cap of 40 members** on top of the per-world caps. The capacity note
lists six estimated (not measured) figures. Milestone G1 measures them before anything ships.

**Arena and creative are 1024x768**, a quarter of the cave world's cells. That keeps their snapshots and verify jobs
small (the verify of a 7 MiB cave snapshot is the memory peak the capacity note warns about), keeps late-join replay
short, and matches an 8-player room.

## Settled by this plan (each gets a DECISIONS.md row)

- **D-132** New world kinds 2 (creative) and 3 (arena); worlds 0 and 1 unchanged.
- **D-133** One kind table replaces every `kind === WORLD_GAME ? a : b` ternary. Today a new kind silently gets
  sandbox values from `maxSnapshotRawFor`, `maxUploadFrameFor` and `chunkGridFor` in `shared/protocol.ts:64-70`.
  The table is an exhaustive `Record<WorldKind, KindInfo>`, so a missing kind fails `pnpm typecheck`. The Rust side
  gets matching `has_players()`, `damage_on()`, `paint_on()` and `grants_all_spells()` on the sim.
- **D-134** One process; a total member cap; per-kind caps from the kind table.
- **D-135** Arena kill and death tallies live in sim state (snapshot format 4), so scores are shared state that
  every client agrees on. The scoreboard reads them as an output and never writes back (invariant 9). Format 3
  snapshots must still restore, because world 1's stored snapshot is format 3 and a new build keeps the snapshot
  (`server/world.ts:372-391`).
- **D-136** `/` becomes the menu. The course spec only requires that `/` serves the client page, with a module
  script and a `/readme/` link (`spec/game.test.ts:15-22`). The menu is part of the same bundle, so this holds.

## Decisions for the user

- **U1: is the cave world peaceful?** Option (a): player damage off in world 1 (players still die to lava, fire and
  falls). Size S. It's safe for history: on a new sim build the server keeps the verified snapshot and clears the
  input log, so no old input replays under the new rule (checked in `server/world.ts:372-391`; this corrects the
  design note's worry). Option (b): leave world 1 hostile and label it "Caves (PvP)". **Recommendation: (a)**,
  because then the arena is the only place to fight, which is the point of the whole change.
- **U2: the arena's world generation.** The arena needs the cave fixes (passages wide enough to walk, and a way to
  dig from spawn). Those come from the overnight cave research (`docs/research/cave-gen-v2.md`). New kinds can use
  gen v2 at no cost to world 1. Whether world 1 gets a deliberate reset to gen v2 is a separate question.
  The research found that for 8 seeds, no player-sized body can walk from the surface to the deepest band
  (1100+), and one seed never leaves the shallow band. Bomb is the only spell that carves, and it's a deep pickup.
  Its recommendation: Blast also carves Dirt, Sand and Wood (no new spell id, no snapshot format change, safe on
  the live world), plus gen v2 (a minimum-width backbone, box-fit repair, no pools on the path) for kinds 2 and 3,
  with v1 frozen for world 1. **Session-model caveat:** caves are mostly Rock, so a soft-only Blast won't widen a
  rock neck. Either let a starting dig cut Rock at a small radius, or accept that world 1 stays hard until a reset.
  **U2b:** is a deliberate reset of world 1 to gen v2 acceptable?
- **U3: rounds.** Ship the arena as continuous free-for-all with tallies (size M). Timed rounds with a round-end
  screen are size L, and need a deterministic sim-side reset that has to pass D7 with a reset inside the run. Only
  worth it if G4 lands with time to spare.

## Milestones

Workers run one at a time: they share `shared/protocol.ts`, `server/world.ts` and `client/main.ts`. Each brief
names the files the worker may touch, the commit checklist, the gate, and asks for "Architectural decisions for
review". Each commit is gated on exit codes:
`pnpm typecheck && pnpm test:net && pnpm test:determinism && git commit`.

### G0. The kind table refactor (Sonnet, size S, no behaviour change)

- `shared/protocol.ts`: `WorldKind` type and a `KIND_INFO` table (snapshot cap, upload cap, chunk grid, has players,
  max members). The three helpers read the table.
- `server/world.ts`: the roughly 10 `this.kind === WORLD_GAME` sites become `KIND_INFO[this.kind].hasPlayers`.
- `server/main.ts`: build `worlds` from a list of `{id, kind}` instead of two literals.
- `sim/src/sim.rs`: rule helpers replace the bare `world_kind == 0` checks (lines 150, 166, 171, 310).
- Commits: (1) the TS table and helpers; (2) the server sites; (3) the Rust helpers.
- Verify: no test changes, all green, and the determinism suite's hashes unchanged.
- **Independent review.** It touches the input path and the snapshot caps.

### G1. Capacity check (Haiku runs it, session model reads it)

- Boot the real Docker image locally. Connect 24 bot sockets across worlds 0 and 1, and force a cave verify
  mid-run. Record peak RSS, event-loop p99, and per-socket memory into `docs/research/game-modes-capacity.md`.
- Pass: peak RSS under 200 MB. If it fails, lower the total cap before going on.

### G2. Menu and routing (Sonnet, size M, client plus a small server change)

- `client/main.ts:48`: derive the world id from a route table (`/sandbox` 0, `/caves` 1, `/creative` 2,
  `/arena` 3, `/` the menu). Old links to `/` reach the menu, one click from the caves.
- New `client/menu.ts`: cards from the kind table, plus counts from `/api/summary` polled every 10 s. The summary
  carries counts per world and no names (project rule).
- `server/main.ts`: serve the client at the new paths.
- Spec and net tests: `/caves`, `/creative` and `/arena` serve the page, and `/` still passes the course spec.
- Commits: (1) the route table; (2) the menu; (3) the server routes and tests.
- Open it and look: the menu in a phone-width context, and both kinds of join.

### G3. Creative world, kind 2 (Sonnet, size M, sim-heavy)

- Sim: kind 2 accepts Join, Pos, Cast and Paint. `apply_damage` returns early. Join grants every spell with
  unlimited charges. Cooldowns stay, since they are the bound on per-tick work (the unbounded-input rule in
  CLAUDE.md). Generation: an open plain with a hill and a pool, so there is something to dig and build with.
- Server: world 2 in the worlds list. Identity and presence come free from `hasPlayers`.
- Client: the paint palette and the spell bar together, and no health bar.
- Determinism: a kind-2 script in D1/D2 (paint plus every spell, two clients), and D7 with sleeping off.
- Commits: (1) the sim rules plus Rust tests; (2) generation; (3) the server and client; (4) the determinism script.
- Look: two browser contexts on `/creative`; each sees the other's builds and casts.

### G4. Arena, kind 3, continuous FFA (Sonnet, size M; after the cave research is reviewed)

- Sim: gen v2 at 1024x768. Weak spells near spawn, Fire bolt and Bomb deep. The starting dig ability from
  the cave research. Kill and death tallies per player in sim state; snapshot format 4; format 3 still loads.
  Respawn already exists (`dead_until`).
- Client: a kill feed from the existing `EV_DEATH` events, a scoreboard from the tallies, and a PvP warning on the
  card and on entry.
- Determinism: the arena script fights to a kill (adapt the D-114 scripted combat test) on all four runtimes.
- Commits: (1) gen v2 for kind 3; (2) the tallies and format 4; (3) the client; (4) the tests.
- **Independent review.** It changes the snapshot format.

### G5. The U1 outcome, and docs (session model plus Sonnet, size S)

- If U1 is (a): one guard in `apply_damage` for world 1, for player-sourced damage only. Merge rehearsal, then boot
  the Docker image (the build-change path must keep world 1's snapshot) before asking to push to `main`.
- Update `docs/DECISIONS.md` (D-132 to D-136), `docs/engineering-decisions.md` (one entry: "consent at the world
  level"), the README, and FUTURE.md.

## Schedule

| Day | Work |
|---|---|
| Thu 22 Oct (budget resets) | G0 with its review; G1 |
| Fri 23 to Mon 26 | G2; G3 |
| Tue 27 to Thu 29 | G4 with its review |
| Fri 30 to Sun 1 Nov | G5; merge rehearsal; ask before deploying |
| Mon 2 Nov | Feature freeze. U3 rounds only if everything above is in |

## Protocol and deploy

Protocol goes to v9 in G2: HELLO accepts world ids 2 and 3, and the summary shape changes. Open tabs reload once.
Each deploy changes the sim build, so world 1 keeps its snapshot and starts a fresh log (the path above). The
merge rehearsal boots the real image with a copy of a format 3 snapshot to prove it.

## Risks

- **Memory under a cave verify with many sockets.** G1 measures it; the total cap is the lever.
- **The snapshot format bump.** Format 3 must still restore. G4's review checks it, and a test loads a stored
  format 3 snapshot.
- **Narrow caves make the arena unplayable.** That's why G4 waits on the cave research.
- **Scope.** Rounds (U3), private arena rooms and a per-player PvP toggle stay out of scope; they go to FUTURE.md.

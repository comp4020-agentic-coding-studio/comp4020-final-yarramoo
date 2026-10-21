# Game modes and PvP consent: research and proposals

Status: research only, 2026-10-21. Prior-art claims from memory except where linked; one web search was run.

## What exists today

- `server/world.ts`: `worldKindOf(id)` maps world id 0 to `WORLD_SANDBOX` (paint only) and id 1 to `WORLD_GAME`. `HELLO.world_id` picks one. Only the game world has names, persistent player ids, spectate and activity tracking.
- `sim/src/sim.rs`: `world_kind` is part of the snapshot and gates behaviour. Kind 0 ignores Join/Leave/Pos/Cast. Kind 1 generates caves (`gen.rs`), pickups, players, damage (`apply_damage` in `spells.rs`), death, bags. Paint is allowed in kind 0, or kind 1 only with the `dev_paint` feature.
- Damage is unconditional: explosions, Fire bolt hits (`FIRE_BOLT_DAMAGE`), lava, fire. A single aggressor therefore forces PvP on everyone in world 1.
- Spells are collected from pickups (`pickups`, respawn after `PICKUP_RESPAWN`); there is no grant input.

## 1. Prior art

- **Noita (vanilla)**: single-player; hazards are the opponent. Mods: [Entangled Worlds](https://github.com/IntQuant/noita_entangled_worlds) is co-op first, with PvP as an option and host settings like friendly fire, shared health, banned perks. Noita Together and a separate Noita Arena mod (2-player PvP) show the community split: co-op and PvP are different products with different rules, chosen at lobby creation, not toggled mid-run.
- **Sandspiel / powder games**: pure creative. No fail state; the hook is making and sharing a thing. Fun comes from material interaction, not scoring.
- **Terraria**: per-player PvP toggle (team colours, button in the UI). Consent is individual and visible; a player who never toggles cannot be hit. Boss/event servers separate modes by realm.
- **Minecraft**: creative vs survival is a server/world property; PvP is a server flag; minigame servers (Bed Wars, Hunger Games) isolate fighting into dedicated lobbies with round timers.
- **Worms**: turn-based, everyone opted in by joining a match. Fun is destructible terrain plus tools; match ends on last team standing.
- **.io games (agar, slither)**: you join a lobby that is a fight; no consent question. Hooks: instant respawn, a leaderboard, kill feed, size/score as visible progress, 5-minute sessions.

Takeaways: (a) consent is cleanest at world level (Minecraft servers, Entangled lobbies) or as an explicit per-player toggle that is visible to others (Terraria); (b) fighting modes need a loop: timer, scoring, kill feed, fast respawn, a reason to move (king of the hill); (c) creative modes need no loop but need all tools at hand.

## 2. Mode proposals for this codebase

Common mechanism: a per-world **mode/config byte** derived from the world id on both server and client, passed to `init`. Prefer a new `world_kind` value (2, 3...) over a separate flags argument, because `world_kind` is already hashed in the snapshot, gated in `Base`, and in the ABI as an integer. Existing worlds 0 and 1 keep their kinds, so nothing resets.

### A. Creative Sandbox with players (kind 2): effort M

All spells, no damage, paint materials, avatars visible. A merge of world 0 paint and world 1 players. This is the "build freely" mode.
- Sim: kind 2 allows Join/Pos/Cast and Paint; `apply_damage` returns early for kind 2 (one guard, but it must also skip knockback decisions only if spec'd; knockback is fine and fun). On Join, grant max charges of every spell (inline in join handling, no new input kind, so no new bound to worry about). Terrain: flat-ish arena or a small hand-authored generated layout; spells that dig need something to dig.
- Server: treat kind 2 like `WORLD_GAME` for names/presence (`this.kind === WORLD_GAME` checks, about 10 sites, become a helper `hasPlayers(kind)`); snapshot size/chunk grid helpers (`maxSnapshotRawFor`, `chunkGridFor`) need a case.
- Client: show paint palette plus spell bar together; no health bar.
- Risks: invariants 1-9 untouched if the grant is sim-side. Determinism suite needs a kind-2 script. Paint cost bound already exists.

### B. Arena (kind 3): effort L

Round-based PvP. Small generated arena (reuse `gen.rs` with a different size/params, own seed), pickups scattered including deeper in caves, everyone opted in by entering.
- Sim: damage on; respawn already exists (`dead_until`). Scoring: count kills in sim state from `EV_DEATH` killer (it is already recorded), plus a round timer in ticks and a "round over" event. Round reset must be deterministic: either a sim-side reset at `tick % ROUND_TICKS` (regenerate from base, re-grant, respawn players) or server-driven reset via the existing world reset path (`resetting` in `world.ts`). The sim-side reset is more invariant-safe (no TS writes to state) but needs scores in the snapshot format.
- Server: leaderboard from events; no persistence needed beyond the snapshot.
- Client: kill feed (events already exist), scoreboard, timer, round-end overlay.
- Risks: snapshot format change (version bump); round reset interacts with chunk sleeping (invariant 8), so test D7 with a reset inside the run. Avoid "outputs feed back": scoreboard is read-only, scores live in sim state.
- Cheaper variant (M): no rounds; a continuous free-for-all with kills/deaths tally and instant respawn, round timer added later.

### C. Keep Caves as peaceful co-op (kind 1): effort S

Make it truly peaceful by default: a damage flag so player-vs-player damage is off in world 1, while environmental damage (lava, fire) stays. Rule in sim: in `apply_damage`, when the cause is a player-owned projectile or explosion and the victim is a different player, skip it. This changes behaviour of an existing persistent world, but it does not alter generation or the snapshot layout. Caveat: it changes sim semantics for a running world, so every client must run the new wasm (invariant 10 already enforces via build hash; the world may need a replay-compatibility decision, since old inputs replay under new rules). Flag this: if the world replays history from the input log, changing damage rules alters history. Safer: a build-hash-gated rule, or accept that deaths in past history are rewritten only if replay is used (check `server/world.ts` replay path before choosing). Ask the user.
- **Correction (session model, checked after this was written):** the replay worry does not apply. On a new sim build, `server/world.ts:372-391` keeps the verified snapshot and clears the tick log, so old inputs are never replayed under new rules. A peaceful-damage rule in world 1 costs the same as any other sim deploy.
- Alternative (S, zero risk): leave world 1 as is, and rename it "Caves (hostile)" in the menu, putting peaceful play in mode A.

### D. Opt-in duels in the Caves (per-player toggle): effort M-L

Terraria-style. Needs a new input kind (SetPvp) plus a flag in player state (snapshot change) and a visible marker. Higher cost and risk than separate worlds, and still lets a griefer stand next to peaceful players with explosions (area damage consent is awkward). Not recommended now.

## 3. The menu screen

Shown at `/` (replacing the direct join). Cards, one per world: title, one-line rules ("Peaceful. Explore, collect spells", "Build freely. All spells, no damage", "Fight. 5-minute rounds"), a PvP badge, players online (the server already tracks `online` per world and `/api/summary` aggregates exist), and a Join button. Name entry stays on the menu.

URL mapping, keeping existing links alive:
- `/` menu (new). Anything currently at `/` that deep-links to the cave world moves to `/play` or `/caves` (id 1).
- `/sandbox` stays id 0 (paint only, keep it as the zero-risk toy).
- `/creative` id 2, `/arena` id 3.
- Server: `worldKindOf` table lookup; unknown ids still rejected.
- Counts: poll `/api/summary` every 5-10 s. Do not expose names (only aggregates, per project rules).

## 4. Recommendation (freeze Mon 2 Nov, due 9 Nov)

1. **Menu plus Creative Sandbox (A)**: M. Biggest user-visible win; solves "wanting to build" with zero consent problem; reuses almost everything. Do the menu in the same pass since it is client-only and cheap.
2. **Arena, continuous free-for-all variant first (B-lite)**: M. Gives fighters their own room so the Caves can be peaceful. Add round timer and scoreboard only if time remains.
3. **Peaceful Caves (C)**: do last, and only via the low-risk route (relabel in the menu, or damage flag after the replay question is answered).

Main tradeoff: new world kinds are the safest for determinism and persistence but cost more server/client plumbing (every `=== WORLD_GAME` site), whereas toggling rules in the existing world is cheap but alters a live persistent game's semantics. Recommendation takes plumbing cost to protect the live world. Do the `hasPlayers(kind)` refactor first.

Decisions that need a DECISIONS.md row: new kinds vs flags argument; snapshot version bump (arena scores); whether round reset is sim-side.

## 5. Ideas for FUTURE.md

- Terraria-style per-player PvP toggle with a visible team colour, once kinds exist.
- King-of-the-hill zone in Arena: points per second standing in a marked area (sim-side counter).
- Kill feed and killer cam using existing `EV_DEATH` events.
- Rotating arena maps from seeds; daily seed arena.
- Capture-the-bag variant using the existing dropped-bag mechanic.
- Share/snapshot a creative build as a link or PNG (Sandspiel-style gallery).
- Spectator mode for Arena (spectate already exists for the game world).
- Lobby rooms with private codes (several arena instances, world id per room).
- Handicap/mutators: low gravity, explosive-only, gunpowder rain.

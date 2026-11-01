# Brief F6b: the Survival ready-up lobby (D-166)

**Why:** D-166, the user's call on 1 Nov. A Survival room opens as a **lobby**. Players gather, each one
readies up, and **once every player in the room has been ready for 3 seconds** the descent starts. A
player who arrives after the start may **choose to spectate**, or go back and join or start a different
lobby. They never join the round alive. This replaces D-161's guess ("the round started at the first kill or
death").

Out of scope:
- achievements and the server round-end claim (F7);
- S5, ended rooms still listed. You may expose the lobby phase in the room list if it's cheap (see
  Server), but don't build the claim;
- Deathmatch.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 110 tool calls. Read `CLAUDE.md`
first. The sim invariants and harness rules are binding:
- no floats;
- bounded work;
- every input bounded;
- `rm` only on literal absolute paths;
- every commit gated on exit codes chained with `&&`;
- every new test shown red first;
- no pushing;
- never weaken a test expectation;
- tie any re-pointed expectation to the exact tick it is about.

Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`. Read D-160, D-161, D-162, D-166 and D-167 in
`docs/DECISIONS.md`, `docs/research/f6-worker-report.md` (its reused-field decisions), and `sim/src/sim.rs`
(`join`, `check_round_end`, `round_won`).

## The design: the lobby lives in the sim

Every client must agree on the tick the round starts, so the ready state and the countdown are **hashed sim
state driven by inputs**, not server state (invariant 1).

### A new input, `Ready { player, ready: u8 }`

- Kind 6, in `sim/src/input.rs` and mirrored in `shared/inputs.ts`.
- The player sends it to toggle ready.
- It is bounded: one flag write.
- The server accepts it only in a game world whose config has `round == 1`, from a joined, non-spectator
  connection. Rate limiting is already shared. It is counted in `input.summary`, never logged per input.

### Round phase in state

There are three phases: **Lobby**, then **Running**, then **Over**.
- Today `round_over` and `round_started` cover part of this.
- **Choose a representation and flag it.** For example, a hashed `lobby_ready_since: u32` tick plus a
  per-player ready bit, or a phase byte.
- `round_started` bit 0 (D-161's first-kill flag) is no longer how a round starts. Decide whether bit 0 now
  means "the countdown completed", or whether a new field replaces it. **Bit 1 is the boss win** (D-167).
  Keep it working, and pin it with a test.
- A snapshot format bump is fine: the game is not live. Follow it through: `FORMAT_VERSION`,
  `server/db.ts`'s label, and the `entity-layout` and `room-abi` net tests.
- The view needs to tell the client the phase, each player's ready flag, and the countdown remaining.
  Extend the round tail of the entities view.

### In the lobby

- **Enemies don't step**, and players take no damage from anything.
- **Movement:** either players can't move, or they move freely in the safe surface area. Choose one, take
  the more reversible option, and flag it.
- **Spells** can't be cast. The sim ignores `Cast` during the lobby.
- **Pickups and the world** don't change, except for ambient falling sand. Hashing the grid covers that
  anyway.

### The countdown

- When every **active** player is ready, record the tick.
- If anyone un-readies, a new player joins (who starts not ready), or the count of active players changes,
  the countdown resets.
- Once 180 ticks have passed (3 s at `TICK_HZ` 60) with everyone still ready, the round starts: the phase
  becomes Running and an event `EV_ROUND_START` fires.
- **Zero players never start a round.** A solo player can start alone (D-160: solo is allowed).
- Put the tick count in `tuning.rs`.

### After the start

- A first Join by a new id joins **dead, as a spectator** (D-161's mechanics, now keyed on the phase).
- A rejoin by an existing id keeps its state.
- A player who leaves during the lobby simply leaves. A player who disconnects mid-round is still D-160's
  "alive until dead" rule.

### The client choice for a late arrival

- When a player arrives at a room whose round is Running or Over, show a **panel** instead of silently
  dropping them in dead. The panel offers:
  - "Spectate" (stay, as now);
  - "Find another room" (the menu's room list);
  - "Start a new room" (the existing New-room flow that the round banner uses).
- **Choose whether "Spectate" joins as a dead player or as a pure spectator connection**
  (`server/world.ts` already has `opts.spectate`). Prefer the pure spectator: it doesn't add a dead player
  to the room, so it doesn't change the loss rule. Flag the choice.

## Client

- **Lobby overlay** over the canvas in a Survival room:
  - a "Ready" toggle button, and the key **R**;
  - the list of players by **plain name** (never `name#id`), each with a ready tick;
  - "Waiting for N", or the 3-2-1 countdown;
  - a short line saying what Survival is: co-op, one life, kill the Deep Mage.
- When the round starts, the overlay goes away, with a "Descend!" toast and a sound.
- The round banner (Victory / The party fell) is unchanged.
- **Dev route** (`/game?world=game&avatar=1&cfg=survival`): the local dev world must still be usable. Either
  the dev avatar auto-readies, or R works there too. A dev world stuck in the lobby would break every dev
  shortcut in the earlier briefs. Check that `__devGotoEnemy`, `__devBossHp` and `__devGoto` still work after
  the start.

## Server

- Accept `KIND_READY` in game worlds as described above, in `server/main.ts` next to `KIND_CAST`.
- Add a `log.event` name in `shared/events.ts` for the round starting, if the server can see it cheaply (for
  example from the stamped inputs). Optional. **Don't** add server-side stepping.
- The room list may show "lobby" or "in progress" if the server can derive it from what it already knows,
  for example the last snapshot's round bytes. Optional; skip it if it isn't cheap.

## Tests (each red first)

**Sim:**
- In the lobby, enemies don't step, no damage is taken, and casts are ignored.
- The countdown:
  - all ready for 179 ticks: not started; 180: started;
  - an un-ready at tick 100 resets it;
  - a new joiner resets it;
  - a leaver who was the only not-ready player lets the countdown begin;
  - solo works;
  - zero players never start.
- `EV_ROUND_START` fires once.
- **After the start**, a new id joins dead and a rejoin by an existing id keeps its state.
- The boss win (bit 1) still wins after a lobby start. Run F6's end-to-end kill through the lobby.
- **D5:** snapshot round trips mid-countdown and mid-lobby.
- **D7:** sleeping is invisible through a lobby, then the start.
- **D2:** cross-engine. The Survival and boss determinism scripts now need a Ready from each player first.
  Update them so the hash still compares the same fight, and tie any re-pointed expectation to the exact
  tick.
- **Hostile snapshot:** decode rejects bad phase or ready values.
- **Input:** decoding Ready, and rejecting bad lengths and values.

**Net:**
- **Two clients in one Survival room:** both ready, and the round starts on the same tick for both.
- A third client arriving after the start is offered the choice, and spectating doesn't add a dead player.
- The server rejects Ready in a non-Survival room and from a spectator.

**Real terrain:** run the lobby tests on seed 1's real Survival world, not only a synthetic box.

## Files you may touch

- Sim:
  - `sim/src/{sim,input,entities,snapshot,tuning,enemy,spells,lib}.rs`;
  - `sim/tests/*.rs`.
- Shared:
  - `shared/{inputs,sim,events,protocol}.ts`.
- Server:
  - `server/{main,world,db}.ts`;
  - `server/rooms.ts`, only for the optional list badge.
- Client:
  - `client/{room,worker,toasts,sfx,menu,protocol}.ts`;
  - `client/index.html`.
- Tools and tests:
  - `tools/inputgen*.ts`;
  - `tests/net/*.test.ts`;
  - `tests/determinism/*`: update expectations only, never weaken a check.
- Output: `docs/art/shots/` and your report.

Don't edit `FUTURE.md`, `docs/DECISIONS.md` or `docs/engineering-decisions.md`.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

**This slice touches the server and the protocol, so `pnpm test:net` is in every commit's gate.** A test that
fails once and passes on retry is a defect: find the timing-dependent assertion.

## Look at it (two browser contexts; this is the slice where it matters)

- Run the dev server (`pnpm dev` or the scripts the net tests use), open one Survival room in **two
  `agent-browser` sessions** with different names, ready both, and screenshot the countdown in both.
- Check the start happens together.
- Then open a third session after the start, and screenshot the late-arrival panel.
- Also screenshot the dev route.
- **Look at each screenshot yourself before citing it.**
- At the end: kill every server and vite you started (by PID; check `pgrep -fl vite.js` and the server
  process), and close every `agent-browser` session.

## Commit checklist (commit each separately)

- [ ] 1. Sim: the round phase, the `Ready` input, the countdown, lobby rules (no enemies, damage or casts), `EV_ROUND_START`, late join keyed on the phase, the snapshot bump and its follow-through, sim tests.
- [ ] 2. Determinism: D2 and D5/D7 scripts ready up first; the boss win through a lobby.
- [ ] 3. Server and shared: `KIND_READY` acceptance and rejection, the event name, net tests (two clients start on the same tick).
- [ ] 4. Client: the lobby overlay, R, the countdown, the start toast and sound, the late-arrival panel, the dev route.
- [ ] 5. Two-browser screenshots and the report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/f6b-lobby-worker-report.md` as you go. It should cover:

- per commit: the hash, what changed, how you verified it, and the red-first evidence;
- what you couldn't verify;
- **"Architectural decisions for review":**
  - the phase representation;
  - what `round_started` bit 0 now means;
  - movement in the lobby;
  - late arrivals as pure spectators or as dead players;
  - which events reset the countdown;
  - the snapshot bump.

  For each: what you chose, the alternatives, why, and what it costs F7 (achievements, the round-end claim,
  S5) and Deathmatch.
- FUTURE.md ideas, suggested only.

## Independent review (separate Sonnet reviewer, after the worker)

Read the diff cold. Check:

- that the countdown is pure sim state, so two clients can't disagree on the start tick;
- that every countdown-reset path is covered (join, leave, un-ready, a disconnect mid-countdown);
- that a client can't force a start for others, for example by sending Ready for another player id (the
  server stamps the player);
- that the lobby can't be used to cheat (moving or casting before the start);
- that the boss win bit survives;
- that the snapshot decode is hostile-safe;
- that the late-arrival path can't add a living player mid-round.

Write the findings to `docs/research/review-f6b.md`.

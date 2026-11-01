# Brief F7: Survival polish (achievements, round claims, connection fixes, balance, two-browser descent)

**Why:** Survival is playable end to end:
- the lobby (D-168);
- enemies (D-162, D-163);
- the boss and the win (D-167).

The server still knows nothing about what happens in a Survival round. Kills and the boss earn nothing, an
ended room stays listed, and the lobby farms stats. The 1 Nov code review
(`docs/research/code-review-2026-11-01.md`) also found connection bugs on these same paths. This slice closes
those gaps before ship prep.

Read these first:
- `CLAUDE.md`;
- D-160 to D-169 in `docs/DECISIONS.md`;
- the code review summary, rows 4, 5, 7 and 9;
- `docs/research/code-review-server.md` findings 3, 5 and 6;
- `docs/research/code-review-client.md` finding 1;
- `docs/research/enemies-design.md` section 7, "Achievements".

**Worker:** one Sonnet worker. Use no subagents, and stay within about 120 tool calls. Rules:
- the binding rules in `CLAUDE.md`;
- every commit gated on exit codes chained with `&&`, including `pnpm test:net`;
- red-first tests;
- `rm` only on literal absolute paths;
- no pushing;
- never weaken a test;
- no `console.*` in `server/`, and every new log name goes in `shared/events.ts`;
- anything a client can repeat goes through `log.limited`;
- players see plain names only.

Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`.

**The server never steps the sim** (invariant 11). Everything the server learns about a round comes from
**majority claims**, the way deaths do today (`World.onClaim`, `tryResolveClaim`, D-120): each client reports
an outcome it saw in its own sim, and the server acts once a majority of eligible witnesses agree.

## 1. Deaths in every room (review row 9)

`onDeathResolved` is wired only on the fixed game world (`server/main.ts:465`), and `onClaim` returns early
unless `kind === WORLD_GAME`. Wire it for every world that has players, including lazily loaded rooms (set it
where `mk` creates a World), so deaths in created rooms reach stats and achievements. Write the net test red
first, with a death in a created room.

## 2. Generalise claims, and add three new ones

Today the claim message carries one `EV_DEATH`. Generalise it so it can carry other outcomes: add a `kind`
byte, or define new message codes. Keep death claims working byte for byte, or bump the protocol and follow
it through. Then add:

- **Enemy kill:**
  - the claim carries the tick, the killer (a player id), the enemy kind and the enemy id, all from
    `EV_ENEMY_DEATH`;
  - each resolved claim bumps `stat_enemy_kills` and `stat_kills_<kind>`;
  - a boss kill is `stat_boss_kills`.
- **Round end:**
  - the claim carries the tick and the result (win or loss, from `EV_ROUND_END`);
  - once resolved, the server marks the room **ended**: store it on the room row (a column, with a
    migration), or in memory if that's simpler, and flag the choice;
  - an ended room **leaves the public room list** (this is S5);
  - on a win, every player who joined **and is still alive** gets the boss achievement;
  - use the sim's own rule for the alive set; don't recompute it;
  - the claim may carry a bitmask or list of ids, which the majority must agree on.
- **Round start:**
  - the claim carries the tick, from `EV_ROUND_START`;
  - once resolved, the server knows the room is **running**.

The quorum, dedup, rate limits and tick-window checks of `onClaim` apply to all of these. Reuse that code
rather than copying it.

### New achievements (`shared/achievements.ts`, all `source: "claim"`)

- "Slime slayer": the first enemy kill.
- "Exterminator": 50 enemy kills.
- "Deep Mage slain": in a party that wins.
- "Last one standing": alive at a win when everyone else in the party died.
- "Solo descent": won alone.

Plain names in every toast.

## 3. Lobby stats and the Spectate record (D-168's known gaps)

- **Lobby stats:**
  - While a Survival room hasn't had its start claim resolved, `server/main.ts` must not credit max depth or
    cast stats from Pos or Cast inputs.
  - Use the claim from section 2; the worker on F6b rejected reading snapshots for this.
  - A room with no round (`round == 0`) is unaffected.
  - The claim lags the real start by up to a second. Accept that, and say so.
- **The Spectate record:**
  - A late arrival who picks Spectate currently leaves a dead player record behind, so Who counts them.
  - Make the panel's choice come **before** the join: the client knows the room is running from
    `GET /api/rooms/:code`, if the server now exposes `running` or `ended` there. The client then opens a
    pure spectator connection directly, or shows the panel without joining.
  - If that isn't cheap, flag it and leave it.

## 4. Connection fixes from the review

- **Names after a resync** (review row 5): the server resends the `PLAYER_NAME` frames after a RESYNC, as it
  does after WELCOME. Write the net test red first.
- **Resync budget** (row 4):
  - at most 3 resyncs per member per minute; past that, close the socket with a clear code, and have the
    client show "Out of sync, reload";
  - `desync` and `resync` log through `log.limited`;
  - incident rows are pruned to the last 1000.
- **Liveness timeout** (row 7): a member that hasn't answered pings for 10 s is closed and goes through the
  normal leave path. Write the test with an injected clock, not a real sleep (the review flagged real-clock
  tests as flaky).

## 5. Log names

Add `log.event` names in `shared/events.ts`:
- `round.start`, `round.end` (with result), `enemy.kill` (aggregated, not one line per kill: fold it into
  `input.summary` or a per-room summary), and `boss.killed`;
- `claim.*` for the new claim kinds, limited.

The admin dashboard may show per-room round state. The public dashboard shows aggregates only.

## 6. Balance (measure, then change)

- **The solo boss fight.** Using the Node sim, script one player who picks up everything on seed 1's real
  M-size path, walks to the arena and fights, aiming at the boss's real position each cast. Report whether
  they win, at what hp, and the tick.
- **Two players.** Do the same.
- **Tuning target:** a scripted perfect-aim solo player should win with **some margin, not barely**. Real
  players miss. Tune `BOSS_HP`, the supply pile and the phase cadences in `tuning.rs` toward that.
- **Enemy density.** Report the deaths per band from scripted descents, and flag anything absurd.
- Put the numbers in the report. Don't tune anything you didn't measure.

## 7. The two-browser Survival descent (the slice's acceptance check)

- Run the real server built from this tree, at size M.
- Two `agent-browser` sessions, using names registered through `/api/players`, open one room through its
  `/r/<code>` link.
- They ready up, descend (dev helpers are fine to speed the walk), and fight the boss. Use `__devBossHp` only
  if you can't kill it in the budget, and say so.
- See Victory in **both** sessions.
- Then check:
  - the room has left the public list;
  - the boss achievement toast showed in both;
  - the server logged `round.end`;
  - a third session gets the late panel without leaving a dead record.
- Screenshot each step, and look at each screenshot before citing it.
- At the end: kill every server you started, and close every session.

## Files you may touch

- Server: `server/{main,world,db,rooms,achievements,stats,log}.ts`.
- Shared: `shared/{protocol,achievements,events,stats,sim}.ts`.
- Client: `client/{worker,room,menu,toasts,protocol,lockstep}.ts`.
- Sim:
  - `sim/src/tuning.rs`, for balance only;
  - `sim/tests/*.rs`, for the balance script.
- Tests: `tests/net/*.test.ts`, `tests/determinism/*` (expectations only).
- Output: `docs/art/shots/` and your report.

**No sim logic changes:** if balance needs one, flag it rather than build it.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

## Commit checklist (commit each separately)

- [ ] 1. Deaths resolved in every room, test.
- [ ] 2. Generalised claims: enemy kill, round start and round end; the ended room leaves the list; tests.
- [ ] 3. New achievements and toasts; lobby stat gating; the Spectate choice before the join (or flagged).
- [ ] 4. Names resent after a resync, the resync budget, the liveness timeout, incident pruning, tests.
- [ ] 5. Log names and the dashboard round state.
- [ ] 6. Balance: scripted solo and duo fights, tuning, the numbers in the report.
- [ ] 7. The two-browser descent: screenshots, then the report.

If you run short, stop at a clean commit. Items 1, 2 and 4 matter most. 6 and 7 can be a second pass.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/f7-worker-report.md` as you go. It should cover:

- per commit: the hash, what changed, and the red-first evidence;
- the balance numbers;
- what you couldn't verify;
- **"Architectural decisions for review":**
  - the claim message format and whether the protocol was bumped;
  - where "ended" and "running" live, in the DB or in memory;
  - how the alive-at-win set is agreed;
  - the resync budget and the close code;
  - the liveness timeout;
  - the Spectate flow.

  For each: what you chose, the alternatives, why, and what it costs Deathmatch.
- FUTURE.md ideas, suggested only.

## Independent review (separate Sonnet reviewer, after the worker)

Check:

- that a single client can't forge a kill, a round end or a boss win (the quorum holds for every new claim
  kind, including in a 1-player and a 2-player room);
- that an ended room really can't be rejoined alive;
- that the liveness timeout can't drop a slow but honest client mid catch-up;
- that the resync budget can't lock out an honest player after a server hiccup;
- that no client-repeatable path logs unlimited lines.

Write the findings to `docs/research/review-f7.md`.

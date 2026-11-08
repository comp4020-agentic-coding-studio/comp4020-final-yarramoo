# Review of F7 (`dcc640b..0579af0`)

Reviewer: independent, read-only (git, grep and reading only; nothing was run). "Confirmed" means read in the code. "Suspected" means it follows from the code plus an assumption about runtime ordering, and was not exercised. Line numbers are at `0579af0`.

## Blockers

None found. The design is weak against a lone client in a 1- or 2-player room (S1), but that is the trust model of every claim since D-120 and the brief accepts a 2-client majority. It is listed as should-fix because F7 raises the stakes: a round end is now permanent.

## Should-fix

### S1. One client in a 1- or 2-player room can end the round, fake a win, and mint kills (confirmed)
`server/world.ts:1313-1315` (`need = ceil(eligible/2)`), `:1235-1246` (`onRoundEndClaim`).
- With 1 or 2 eligible visitors, `need` is 1. A single honest-looking `CLAIM_ROUND_END` frame sets `roundEnded = true`, calls `rooms.markEnded` (`server/main.ts:527`, permanent in the DB, removes the room from the list) and, with `win=1` and its own id in `alive`, grants `deep_mage_slain` and `solo_descent`/`last_one_standing`. The honest second client's differing claim is only a logged dissent (`vote`, "won !== key").
- Nothing requires `roundRunning` first. There is no check that the round started, or that it has not already ended. A lone client in a 2-player lobby can end the room within seconds of creating it. A griefing client can do this to a friend's room.
- Kills: `onKillClaim` keys on `tick:x:y`, so a lone client invents distinct positions. With the rate limit (30 claims per 10 s) it reaches `exterminator` (50 kills) in about 20 s, and sends `boss` kills (kind 4) the same way. The claim tick only has to lie within the last 10 s.
- In a 3-player room one liar is not enough (need 2), as the tests show. Two sock-puppet visitors are enough. Registered spectators count in `eligibleAt` (they have a `visitorId`) and can vote, so sock puppets also dilute honest quorum. Registration is rate limited, which is the only brake.
- Fix, cheapest first:
  - (a) For `round_end`, require `roundRunning`, require `!roundEnded`, and require a strict majority of all members who were eligible at the round's start (not `ceil(n/2)`). For `n = 2` require both.
  - (b) For a permanent effect, either accept the claim only when every eligible client that is not a dissenter agrees, or hold it for a grace period (for example 5 s) during which a dissenting key vetoes it.
  - (c) Accept that a 1-player room is self-trusting, and say so in `docs/engineering-decisions.md`. State that room-only achievements are therefore not leaderboard material.

### S2. `rs`/`re` "resolved" markers live in the shared FIFO `resolvedDeaths` and can be evicted (confirmed)
`server/world.ts:1329-1331` (`resolvedDeaths.set(tally.group)`, delete past `MAX_RESOLVED_DEATHS = 1024`); `:1186-1190` in `vote`.
- Kills, deaths and the round markers share one 1024-entry FIFO. A client that floods resolved kills (easy in a 2-player room, see S1) pushes the `"re"` and `"rs"` entries out, because `Map` iteration order is insertion order.
- After eviction a new round-end claim resolves again. A loss followed by a forged win would fire `onRoundEndResolved` a second time and grant the win achievements. `markEnded` is idempotent but `grant` is not gated on that.
- `onRoundEndClaim` and `onRoundStartClaim` never test `roundEnded`/`roundRunning`.
- Fix: in both handlers, `if (this.roundEnded) return;` (and for start `if (this.roundRunning || this.roundEnded) return;`). Keep the round markers out of the FIFO.

### S3. Unbounded `player_stats` keys from a client-chosen enemy kind (confirmed)
`server/achievements.ts` (`onEnemyKill`, `this.stats.bump(killer, killStat(kind))`), `shared/stats.ts:17`, `server/main.ts:1260` (`kind: msg.d`, any u32).
- The stat name is `kills_k${kind}`. A lone client in a 1- or 2-player room resolves kills with a different `d` each time, about 3 per second. Each is a new row in the killer's `player_stats` and in the in-memory `PlayerStats` map. This is unbounded DB and memory growth from one connection.
- `killsByKind` in `main.ts` is cleared every summary interval, so it is fine. The player stats are not.
- Fix: in `onKillClaim` refuse `kind` outside the sim's enemy-kind range (a small table in `shared/stats.ts`). Also reject unknown positions (outside the world).

### S4. The liveness reaper can mass-drop every client after a server stall (suspected)
`server/world.ts:812-817` (`reapSilent` runs in `tick()` before any queued frames are read), `:773-786`.
- If the event loop is blocked for 10 s or more (snapshot verification of an MB-scale snapshot, a long GC, the laptop or Fly VM being paused), then when the interval timer next fires, Node's timers phase runs before the poll phase that delivers the clients' pings. Every live member then has `t - lastHeard >= 10 s` and is closed with 4002 in one sweep. The honest clients reconnect and replay, which is exactly the load spike that follows a stall.
- Fix: measure silence in ticks the server actually ran: skip the sweep, and reset every `lastHeard`, when the gap since the previous `tick()` exceeds about 1 s. Or require two consecutive sweeps.
- A background tab is probably fine: the ping runs in a dedicated Worker (`client/worker.ts:375`), which browsers do not throttle like page timers. The worker's single thread is blocked while it replays or steps, though. A step stall of more than 10 s on a very slow device is dropped, and the member only reaches `live` after its replay, so only a post-live freeze counts. Confirmed that catch-up members are exempt (`!m.live`); `m.live` is set at `world.ts:920,931`.

### S5. `running` in `GET /api/rooms/:code` is false for an unloaded or restarted running round (confirmed)
`server/main.ts:755-756`: `roomWorld = worlds.get(r.id); running: !!roomWorld?.roundRunning`.
- A room unloads 2 minutes after its last member leaves (`ROOM_UNLOAD_MS`), and `roundRunning` is memory-only. Whenever a running round's room has been empty for 2 minutes, or after any restart, the API says `running: false`. A returning player then gets the normal join path, not the late panel, so a dead record is created, the exact thing the "Spectate before join" change was meant to prevent.
- The same applies in memory: a restart or reload of an ended room has `roundEnded = false` in `World`. `ended` is read from the DB row, so the API is right, but the admin summary `round` (`main.ts:1368`) says "lobby", and nothing stops a second round end firing (S2).
- Fix: on load, `World.roundEnded = row.endedAt !== null`. For running, derive from `restoredWithTicks && !roundEnded && cfg.round === 1`, or persist a `started_at`.

## Nits and questions

### N1. An ended room is only hidden, not closed (confirmed)
- `markEnded` writes the DB row and the public list excludes it. `server/main.ts` HELLO has no `endedAt` check, so any client (a direct WS, or a link with `?spectate=1` dropped) can join an ended room. In the sim a late joiner is dead/spectator, so nobody comes back alive from the sim's side. Confirmed: the join path never reads `endedAt`.
- Clients already inside see nothing: there is no broadcast on end, so the room keeps stepping. The ended room unloads only through the normal "empty for 2 minutes" timer, and a room with someone spectating never unloads. Fix, if wanted: refuse non-spectate HELLO for an ended room (`rej("round is over")`), and close the loop with a server-to-client notice. This is a polish item.

### N2. Resync budget (confirmed fine, one wrinkle)
- `resync()` (`world.ts:1159-1170`): the budget is per member (per connection), 3 per 60 s. A hiccup that desyncs everyone once costs each member one slot. Three desync waves within 60 s lock a member out with 4001, and a reload (new connection) starts fresh, so no permanent lockout. The `resyncAt` array is bounded (filtered, at most 3 entries) and dies with the member.
- Wrinkle: the client's 4001 handler sets `net = "rejected"` and stops reconnecting. That is the intent. 4002 deliberately falls through to the normal reconnect path (the empty `if` is dead code and could carry a comment).
- Both codes sit in the application range 4000-4999, so `ws.close(code)` is valid.

### N3. `chunk-diag.test.ts` change (confirmed not weakened)
- The two additions only (a) call `heard()` for every fake member each `advance`, so the liveness reaper does not fire on fake peers, and (b) clear `resyncAt` before each hash round so the new budget does not truncate tests that make many desyncs in one fake minute. Neither touches the assertions on what a diagnosis records. The budget and the reaper have their own tests in `tests/net/connection-fixes.test.ts`.
- One small loss: the diagnosis tests no longer prove the diagnosis path works when the budget is active. Acceptable.

### N4. Logging and memory (confirmed)
- New client-repeatable lines: all go through `limited` (`silent:`, `resync_refused:`, `claim_bad:`, `claim_unknown:`, `claim_dissent`, `claim_conflict`, `claim_unresolved`, `desync:`, `resync:`). The keys `silent:${m.id}`, `resync_refused:${m.id}`, `claim_bad:${memberId}` and `claim_unknown:${memberId}` are per connection and are never `forget`-ed on leave (`main.ts:1125-1128` forgets only `rate`, `pos`, `bad` and `held`). The `windows` map sweeps itself at 5000 entries, so this is bounded but untidy. Add `log.forget` calls on leave, or key them by world.
- `claim_dissent` and `claim_conflict` use one global key each, so a lone client in a 2-player room can suppress the real lines for 10 s. This is diagnostics only.
- `kills` and `killsByKind` in `main.ts` are cleared every interval, so they are bounded by the number of loaded rooms and by the resolved kinds in one interval.
- `claims` is capped at 256, and a single member can have at most 30 open claims in a 10 s window, so it cannot be flooded out by one client (at 3 or more players).
- `desync_incidents` is pruned to 1000 rows, but the prune runs `delete ... where id <= ?` on every insert, which is cheap.

### N5. `restoredWithTicks` logic (confirmed, with a flaw)
- Meaning: `base + frames.length > 0` after `load()`. Survival rooms that were running are credited, and lobbies are credited early after a restart. The choice is documented and harmless for stats (the depth and cast credit only).
- Flaw: a lobby room that sat open for some seconds before the restart has closed ticks, so it counts as credited. That is the documented cost.
- Related: `creditsStats()` also does not look at `roundEnded` being restored (see S5), but `restoredWithTicks` covers it.
- The summary's `round: "lobby"` is wrong after a restart for both running and ended rooms (S5).

### N6. Round-start claim has no `active` sanity check (confirmed)
`onRoundStartClaim` keys on `r.active` (any u32) and the tick. It only marks `roundRunning`, which gates stat credit and the `running` flag, so a lone liar in a 2-player lobby can open the stat gate early. This is minor but is part of S1.

## Unverified
- I did not run the tests, so I cannot say whether `claims-survival.test.ts` is genuinely red without the fix. The report says the claim tests were written after the implementation (commit 2).
- I did not trace how the sim treats a late joiner in an ended room beyond the comment at `sim/src/sim.rs:300` ("a spectator, exactly like a late joiner").
- I did not open the client in a browser.

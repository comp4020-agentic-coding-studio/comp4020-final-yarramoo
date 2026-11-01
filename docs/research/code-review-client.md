# Code review: browser client (`client/*.ts`)

Scope: client/*.ts, index.html, vite.config.ts; shared/ and server/world.ts read only where the client depends on them. Read-only review, about 25 tool calls, no tests run. "Confirmed" means traced in the code; "suspected" means plausible from the code but not demonstrated.

## Findings

### 1. A resync wipes every other player's name and nothing resends them (medium, consistency, confirmed)
- `client/worker.ts:313` (`names.clear()` inside `beginReplay`), `:373-377` (`case "resync"`). Server side: `server/world.ts:598` is the only place names go out, right after WELCOME; the resync path (`world.ts:1080`) sends `encodeResync` alone.
- `beginReplay` runs for both WELCOME and RESYNC, but only WELCOME is followed by `S_PLAYER_NAME` frames.
- Scenario: a hash disagreement makes the server send RESYNC. The client replays, and from then on every other player is labelled "someone" (`UNKNOWN_NAME`), the death toasts read "someone was killed by someone", and lobby rows read "Player". That lasts until each of those players reconnects. Only the local player's name survives, via `myName`.
- Fix: do not clear `names` in a resync (names are not sim state), or clear them only in the WELCOME branch. Better, have the server resend names after a RESYNC.

### 2. Snapshot size ceiling is inferred from world dimensions, not the room config (medium, consistency, confirmed)
- `client/lockstep.ts:69`: `width*height > 512*512 ? CAVES_PVP : CLASSIC_SANDBOX`.
- The worker already holds the real config (`seedInfo.cfg`, `worker.ts:78`), and `maxSnapshotRawFor(cfg)` wants a `RoomConfig`.
- It works today by luck: a 1024x768 room gets the 7 MiB ceiling meant for 2048x1536, and size S gets 1 MiB. Any new size entry in `SIZE_DIMS` that needs a different ceiling will either fail decompression (the client drops the connection and reconnects in a loop) or run with a loose zip-bomb guard.
- This is the same class of assumption as the size-S bug already fixed in `worker.ts:920`.
- Fix: pass the decoded `RoomConfig` into `Lockstep` (constructor or `loadSnapshot`) and delete the size heuristic.

### 3. A dropped paint permanently skews `sentAt`, so the latency figure drifts and the array can grow (low, stability, confirmed)
- `worker.ts:98`, `:213` (push per paint sent), `:285-288` (shift per own Paint seen in a tick).
- The queue assumes a 1:1 match between paints sent and paints applied. The server rate-limits inputs (the comment at `:57` says "under the server's 40/s cap"), and a rejected or dropped paint is never applied.
- After the first drop, every later `shift()` pairs with the wrong send time, and the array only grows by the drops. Pos and Cast inputs do not enter the queue, but the server's shared per-connection cap means a burst can still drop paints.
- Fix: carry `inputSeq` through (if the server echoes it) or timestamp by seq and drop entries older than N seconds. At minimum, cap the length.

### 4. `pendingEvents` is capped by silently dropping the newest events (medium, consistency, suspected)
- `worker.ts:267` and `:884`: `if (pendingEvents.length < 300) pendingEvents.push(e)`.
- `gameFrame` drains it once per rendered frame. Anything that pauses the worker's `requestAnimationFrame` (a hidden tab) while the lockstep keeps stepping, or a frame that steps several ticks with many events, loses the later events with no log.
- The round banner has a state-based fallback (`worker.ts:581-585`), but death toasts, `EV_KNOCK` effects and `EV_ROUND_START`'s "Descend!" do not.
- A hidden tab can also hit the server's "too slow" close, which means a full reconnect and replay. Not verified here.
- Fix: drain events per tick for the things that matter (toast and sound decisions) and cap only the particle-producing ones. Or keep the cap but drop the oldest and count the drops.

### 5. A fatal worker or wasm failure leaves the page on a stale status with no visible error (medium, stability, confirmed)
- `worker.ts:964` (`fetch(m.wasmUrl)` with no `res.ok` check) and `:1011-1013`: init errors post `{type:"error"}`.
- `room.ts:564-567` only sets `info.textContent = "worker error"` and never reveals `#note`.
- `room.ts:1041`, `worker.onerror`, only logs.
- `onmessage` handlers for the socket (`worker.ts:350-402`) also run `beginReplay`, `sim.init` and the wasm calls without a try/catch. A throw there, such as a config the sim rejects or a wasm trap, is an uncaught worker error. The socket stays open, the status stays "catching up" or "connecting", and `loop()` keeps drawing a frozen world.
- Scenario: a stale deploy serves an HTML 404 for `sim.wasm`. The user sees an empty canvas and a tiny "worker error" in the info line.
- Fix: check `res.ok`, show `#note` with a reload hint on `error` and `worker.onerror`, and wrap the socket handler body so an exception closes the socket, which reuses the reconnect path.

### 6. No WebGL context-loss handling (medium, stability, confirmed)
- `grep contextlost client/*.ts` finds nothing, and `render.ts` has no handler.
- A GPU reset or driver crash, or a mobile tab being backgrounded, leaves a permanently blank canvas while the lockstep and the networking keep working.
- Fix: handle `webglcontextlost` and `webglcontextrestored` in the worker renderer (re-create textures and re-upload the full grid). Failing that, post `render-failed` so the main thread's fallback path engages, which already exists.

### 7. Events from the last replayed tick play as live, and stale per-connection state leaks across a reconnect (low, consistency, confirmed)
- `worker.ts:272` gates event capture on `!ls.fastForwarding`. After the step that reaches `catchUpTarget`, `fastForwarding` is already false, so that tick's events (one tick, tick == target) are queued.
- `gameFrame` then runs with `net === "live"` (`:919`) and treats them as fresh, so `spellFx` sends the death toast (`:722`, which is not gated on `quiet` at all) and plays sounds.
- Similar leftovers survive `beginReplay`: `lastSentPos`, `avTicks`, `sinceSentPos` (`worker.ts:118-119`), `enemySeen`, `enemyBoltSeen`, `bossPhase`, `bossHud`, `roundShown` is reset but `shown` is cleared while `camF` is not.
- Effect: a duplicate death toast or "Descend!" right after joining, and the first Pos after a reconnect can be suppressed for up to half a second (the signature matches the old one).
- Fix: gate capture on `tick > ls.catchUpTarget` (the same rule already used for the claims on the next line), put the toast behind `quiet`, and gather the per-connection variables into one `resetConnectionState()` or a single object.

### 8. `world`-size and terrain assumptions in the client (low, consistency, confirmed)
- Dev local path: `worker.ts:876`, `:887`, `:992` use `width() > 512` to mean "has avatars", the exact assumption already fixed for networked rooms at `:920`. The local path also has its own copy of event handling (`:874-882`) that skips the `fastForwarding` and `quiet` logic.
- `room.ts:531-532`: the initial camera is hard-coded to `y = 230 - ...` ("the centre of the surface"), which is a Caves-terrain fact. Survival and Creative have other terrain and sizes. The worker steers the camera soon after, so this only affects the first frames and spectators with no one to follow.
- `lockstep.ts:69` (finding 2) belongs here too.
- `worker.ts:172`: `ENEMY_MAX_HP = [20, 30, 60, 90, 800]` mirrors `tuning.rs` by hand. A rebalanced enemy gives wrong HP bars and no test notices.
- Fix: derive "has avatars" from the decoded config in both paths, and expose the enemy max HP (and spell table) from the sim or a generated shared constant.

### 9. `FromWorker`/`ToWorker` are typed at the send site but not checked for exhaustiveness at the receive site (low, maintainability, confirmed)
- `room.ts:512-570` and `worker.ts:1009-1086` are plain `switch (m.type)` with no `default: assertNever(m)`.
- Adding a message type compiles even if the other end never handles it. For example, `"stats"` and `"net"` are handled, but nothing would flag a new `"ready"` variant that nobody consumes.
- `FromWorker.world.kind` is "has avatars" (0/1) but `room.ts:274` tests `worldKind === 1` for "casts" and other places test `=== 0` for "sandbox". Two meanings of one field.
- `protocol.ts:22-23` has two doc comments stacked on `camera` ("Client-only camera" is on the line above `sleep`), so the comments no longer match the members.
- Fix: add an `assertNever` default on both switches. Rename `kind` to `avatars: boolean`, or drop it since `cfg` carries the same fact.

### 10. Structure: two very large closures with module-level mutable state (medium, maintainability, confirmed)
- `worker.ts` has about 70 module-level `let`s (`:72-200`) that mix per-connection, per-room, per-frame and cosmetic state. Which ones are reset in `beginReplay` is by convention only (finding 7 shows it already drifted).
- `gameFrame` (`:430-640`) does sim reads, prediction, Pos sending, camera control, HUD message assembly and sprite drawing in one function. `spellFx` (`:656-800`) is an if-chain on event kind with inline magic numbers (particle counts, colours per enemy kind, `e.c === 4` meaning "Fire").
- `room.ts` `startRoom` is a single 1,250-line closure creating DOM, listeners and timers. Everything is imperative `document.createElement`, with `#hud`, `#spells`, `#death`, `#toasts` and the lobby overlay each hand-built.
- Adding a HUD element means editing `startRoom`, the `players` message, `onPlayers`, and `gameFrame`'s send. Adding an entity kind means touching `gameFrame`, `spellFx`, `render.ts` sprites and (when it has a bar) `ENEMY_MAX_HP`.
- Entity-view fields are decoded by bitmask inline (`e.health & 2`, `(e.health >> 2) & 3`, `e.sub === 4`). The mapping lives only in a Rust file and a doc comment.
- Fix, in order of payoff: (a) a `ConnectionState` object created fresh per `beginReplay`; (b) a table-driven event handler (`Record<EventKind, (e, ctx) => void>`) for `spellFx`; (c) named constants and small decode helpers for the entity view bits (`isBoss(e)`, `enemyPhase(e)`) in `shared/`; (d) split `startRoom` into modules (palette, spell bar, lobby, social strip, toasts) each with a `mount(stage)` and a `dispose()`.

### 11. Reconnect loops forever on a persistent malformed frame, and magic numbers for backoff (low, stability, confirmed)
- `worker.ts:354` (`if (!m) return sock.close()`), `:420-424` (`RECONNECT_MS` capped at 4 s, no attempt limit, `attempt` resets on any WELCOME).
- A server that speaks a newer protocol, so `decodeServer` returns null, makes every client retry every 4 s indefinitely, replaying from a fresh snapshot each time.
- Fix: count consecutive decode failures and move to `rejected` ("new version, reload") after a few.

## Checked and found sound
- Event reads happen inside `onStepped`, so multi-step frames do not lose per-tick events (`worker.ts:263-275`).
- Death claims and hashes are only sent past the replay target (`:271`, `lockstep.ts reactToTick`).
- Pos is sent with the sim's current `life`, and a stale life is ignored by the sim, so respawn reconciliation is safe (`worker.ts:431-446`, `sim.rs:361-372`).
- Knock is applied to the predicted avatar only when fresh (`knockIsFresh`).
- Presence counting is UI-only.
- Replay is quiet for sounds. `sfxAt` and `sfxSelf` honour `quiet`.
- A second tab is told to stop (close 4000) instead of fighting.

## Strengths
- The lockstep core (`lockstep.ts`, `catchup.ts`) is DOM-free and pure, and is shared with the Node tests. It enforces contiguous ticks and detects snapshot-tick mismatch.
- The rule "TypeScript only writes sim state through `push_input`" is respected everywhere I looked. The comments at each sensitive site name the invariant.
- Replay is deliberately quiet: sounds are gated on `quiet`, claims and hashes on the replay target, and the round banner has a state-based path so a late joiner still sees it.
- Stale-socket guards (`if (sock !== ws) return`), a stale-life guard on Pos, and the one-tab-per-player close code show attention to races.
- The vite plugin that serves and copies a freshly built `sim.wasm` keeps the client and sim in step.

## Top 5
1. Resync wipes all other players' names and the server never resends them (finding 1).
2. Fatal worker or wasm errors leave a frozen page with only "worker error" in the info line, and socket-handler exceptions are uncaught (finding 5).
3. `Lockstep.loadSnapshot` picks the snapshot ceiling from world dimensions instead of the room config (finding 2).
4. `pendingEvents` silently drops the newest events past 300, and the last replayed tick's events and per-connection state leak as live (findings 4 and 7).
5. `worker.ts` and `room.ts` concentrate state in about 70 module-level variables and one 1,250-line closure, which makes new HUD elements and entity kinds hard to add safely (finding 10).

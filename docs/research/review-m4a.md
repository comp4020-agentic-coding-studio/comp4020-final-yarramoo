# M4a review (origin/multa..HEAD), read-only

## Verdict: the sim, snapshot and Pos paths trace as sound. No lockstep blocker. The server-side identity and connection handling has two should-fixes that let an unauthenticated client lock everyone out of the game world.

All findings are CONFIRMED (code path traced) unless marked SUSPECTED.

## Should-fix

### S1: a zero token mints a permanent player on every HELLO, with no rate limit (server/identity.ts:67-72, server/main.ts:230-237)
`resolve()` with an all-zero token inserts a new `players` row each time. It is not covered by `MAX_CREATES_PER_MINUTE` (that guard is only in `register`).
Scenario: a script opens 900 sockets to world 1 with `token = 0`. `count >= MAX_REGISTERED`, so `/api/players` returns 429 and `resolve` returns null ("too many players registered") for everyone, permanently. There is no eviction; `last_seen` is stored and never used. Each such player also gets a Join, so the sim holds a persistent active entity at the spawn point (up to MAX_PLAYERS = 1024 entities).
Fix: refuse a zero token for non-spectators in world 1. The tests need a seam, so give them a `registerForTest` helper or an `allowAnonymous` option. Also evict or ignore rows never seen again, e.g. `last_seen` older than N days and never connected.

### S2: `/api/players` is a global registration pool with no origin check, and spectators are uncapped (server/main.ts:112-146, 187, 230-237)
- Any web page can POST cross-origin and burn the 60/min / 900 cap, so a drive-by script has the same lockout effect as S1.
- A HELLO with the spectate flag needs no token, and nothing caps connections per world or per IP. Every join sends the 3 MB game snapshot plus the log (a fresh `encodeSnapshot` copy per peer).
- `MAX_BUFFERED_BYTES` (8 MB) is only checked at tick close. A snapshot sits under 8 MB, so about 80 slow-reading sockets queue 240 MB, which is OOM on the 256 MB machine.
- `maxPayload` is now 4 MiB for every socket, including pre-HELLO ones.
Fix: cap members per world (for example 64), cap pre-HELLO frames (ws `maxPayload` is global, so close on the first frame if it is over 256 B, as the code already does after buffering), and require a same-origin `Origin` header, or at least a custom header, on `/api/players`.

### S3: no timeout on a verification job (server/verify.ts:53-60, server/world.ts:584-601)
A worker that hangs (not crashes) leaves the promise pending. `exit`/`error` handle a crash correctly. A hang means `verifying` stays true, every later job queues behind the stuck one, and no snapshot is ever accepted again.
Consequence: the log grows to MAX_LOG_TICKS (200,000 ticks, about 55 minutes), then `w.full` rejects all joins.
Also `.then(...)` has no `.catch`. If `db.saveSnapshot` throws (disk full), that is an unhandled rejection, which kills the process under Node's default.
Fix: `Promise.race` with a 10 s timer that calls `worker.terminate()` and resolves null, and add `.catch(() => reject("save failed"))`.

### S4: a player can stay active forever after a hard crash (server/world.ts:227-228 and :250-254, sim/src/sim.rs `Leave`)
- A SIGKILL, OOM or machine loss with players online leaves their Join in the log with no Leave. On cold start `online = 0` and nobody stamps a Leave, so the entities are active forever. Every chunk in their 576x320 box simulates whenever anyone is connected. Only `shutdown()` stamps Leaves.
- Smaller instance of the same bug: `onClosed` catches a `peer.send` throw and does `members.delete(id)` without stamping a Leave. The later `close` event then finds no member, so no Leave is ever stamped.
Fix, either of:
  - A deterministic sim-side idle timeout: a player with no accepted Pos for N ticks (say 1800) goes inactive in `update_entities`. `last_pos_tick` must go in `entity_bytes`.
  - On cold start, or on the first Join after one, stamp a Leave for every player id that has no connection. The log scan in `loadFromDb` already tracks presence.

### S5: pre-existing, but it crashes the server: `decodeURIComponent` is unguarded (server/main.ts:111)
`GET /%` throws URIError inside the request listener, which is an uncaught exception, so the process exits. It is a public URL and takes down both worlds. Wrap it in try/catch and return 400.

## Notes

### N1: Pos is stamped only if the server accepts it, so a rejection leaves the client predicting on its own (world.ts:403-413, client/worker.ts gameFrame)
The client is never told, so its local avatar runs ahead of the official position (others see it frozen). It self-heals because the allowance (about 9 cells per tick times (dt + 10)) grows. No divergence is possible: rejected Pos is never stamped.
- The first Pos in a process has no baseline (restart or first connect). The player gets one free teleport anywhere in the world, and the speed limit is about 144 cells/s through walls. This is by design (D-067), but it is not "anti-cheat".
- Server `x >= GAME_W*16` versus sim clamp `(w-1)*16`: harmless one-cell slack.

### N2: D-067 consequence confirmed for M5
`life` is ignored, so a respawn teleport of D cells is rejected until `(dt + 10) * 144 >= D * 16`. For D = 1000 cells that is about 110 ticks (about 2 s), and 2-3 s for a world-crossing respawn.
Meanwhile the sim keeps the old position (it has the new `life` but the old x, y). The player sits at the death point, wakes chunks there, and can trigger pickups. Everything stays consistent and deterministic, but it is visible. Reset `lastPosOf` when the server stamps or observes the respawn; it does not currently see it.

### N3: the client only re-places its avatar on its own Join (client/worker.ts, onTickApplied)
A respawn (`life` change, M5) needs `avatarReady = false` when `mine.a` changes. Otherwise the controller keeps the pre-death position, and the Pos it sends (new `life`, old position) overrides the respawn.
Also: if sand buries the avatar while inactive or between Pos, `collides()` is true for every move, so the avatar is stuck until M5 respawn. Consider a "dig out" nudge.

### N4: client restore double-generates (carryover M3-S2): client/worker.ts `beginReplay` calls `init` and then `loadSnapshot`
That is about 800 ms on join or resync. The verifier worker handles the server cost (about 400 ms off the tick thread). `snapshot::size` calls `write` (6 MB), then `snapshot_write` calls `write` again: three transient copies in client wasm memory. Cheap to fix by caching the last write, or computing the exact size arithmetically with a test.

### N5: small things
- `MAX_ENTITIES` (1200) in shared/sim.ts versus up to 1024 players plus pickups: render truncation only, but the cap should be 1024 + pickups.
- `lastPos: null` on `Member` is dead (world.ts:58, 329).
- `decode` in entities.rs accepts player id 0 and arbitrary x/y/facing from a snapshot. This is harmless because the hash must match the majority. `hitbox_cells` could overflow i32 on a crafted x, which wraps deterministically in release.
- Zalgo and combining marks are not stripped by `cleanName`.
- Snapshot upload compresses 6 MB with fflate on the client worker: expect a 100-300 ms stall of that client every 30 s. This was not measured. SUSPECTED.

## SOUND (traced)
- **Entity bytes cover all state that feeds future steps:** player fields (id, active, life, x, y, facing, health, dead_until, charges, cooldowns, last_hit) and pickup (respawn_at, charges). Pickup identity (id, spell, x, y) is regenerated from the seed and checked on decode. No usize reaches the bytes: widths are fixed LE, counts are u32.
- **Ordering:** players are kept sorted by id (binary-search insert, strictly increasing on decode). Pickups are in generation order, and two players on one pickup resolve to the lower id.
- **Restore is exact:** `awake`, `active`, `events` and the hash cache are scratch or derived, and `active` is recomputed from entity state every step. `respawn_at` and inactive players round-trip (test `d5` plus the code).
- **Spawn placement:** `rng(seed, tick, id, ...)` plus a grid read, a pure function of shared state at apply time. Bounded work: 16 columns of one column scan each.
- **Pos path:** the server stamps `player = joined.playerId`, never the client's id (main.ts:267). The sim ignores Pos for an inactive or stale-`life` player, and clamps. Reordering is impossible: one server order.
- **Snapshot v2:** entity length is `checked_add`-ed and the player count is bounded by MAX_PLAYERS. The total length is compared in u64 (no wasm32 wrap). The chunk count uses `checked_mul`. `size()` is defined as `write().len()`.
- **v1 compat:** v1 accepted only with elen 0. The sandbox hash is unchanged because entity bytes are empty for kind 0. The deployed-fixture compat test exists.
- **Verifier worker:** restore and hash only, never step or push. One worker is reused for both worlds. A crash or exit fails the outstanding jobs and the next call respawns. A stale or duplicate result is dropped (`tick <= snapshot.tick`). `log.splice(tick - logBase)` is correct. Memory is about 2 grids (about 20 MB) plus a 7 MB decompress buffer.
- **Two worlds:** separate clock, log, snapshot, hash checks, `lastPosOf` and member maps. Only the db, verifier and identity are shared, and all are keyed by world id. D-065 replacement: the old connection is removed from `members`, so its in-flight Pos, hash and upload are ignored. The `close` event then no-ops, and no Leave is stamped while the new Join keeps the entity active.
- **Identity:** 32 random bytes, only sha256 stored, token never in a URL or log, `no-store` on the registration response, and the body is capped at 1 KB. Names are cleaned (control, bidi and zero-width characters stripped, 24 code points). The client label uses `textContent`. /readme renders only README.md.
- **Invariant 9:** the client never calls `events()`. `entities()` feeds rendering, the avatar spawn and teleport (documented) and the `life` field of Pos only.
- **Bounded work:** 40 inputs/s per connection. Game world accepts only Pos (11 B) and Cast (5 B). Sim events are bounded by inputs per tick. Active set cost is 768 chunks times players per tick.

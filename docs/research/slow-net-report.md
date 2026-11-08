# Slow connections: what happens, and a notice for the slow player (brief SLOWNET)

Opus lead, 8 Nov, branch `slow-net` from `multa` 4e5fee2. Written as the work went.

## 1. What the code says (read before measuring)

**The server never waits for a connected player.** `TickClock` (`server/clock.ts`) closes ticks from the server's own
time source (`advance()` closes every tick the clock has passed). The only thing that pauses it is the catch-up hold
(`World.evaluateHold`, `server/world.ts` ~435): it holds **only while no member is live** (`want = members > 0 &&
!anyLive && t < limit`). A slow player who is live, or one clean live player anywhere in the room, keeps the clock
running. A slow player can delay only a room where nobody else is live, which is a room with nobody playing.

What can touch the others, read from the code:
- **Hash votes wait up to `HASH_WAIT_MS` (2 s) for a voter that has not reported** (`tryResolve`). That delays only
  when a checkpoint is *judged*, and not the clock or anyone's play. A slow client's late HASH for a resolved tick is
  compared against the stored truth; past `HASH_WINDOW_TICKS` (30 s) it is ignored.
- **The snapshot uploader** is the longest-connected live voter whose last HASH is within 3 checkpoints
  (`requestSnapshot`). A slow member that lags more than 3 s is skipped; one that lags less may be asked, and a late
  upload lapses after `SNAPSHOT_GIVE_UP_TICKS` (10 s), retried after 300 ticks. That costs persistence slack and not play.
- **Its inputs** are stamped on arrival into the server's open tick (`stamp`): late inputs are not dropped and not
  back-dated, they simply land late, and everyone applies them at the same tick (lockstep). Pos is checked against
  `maxPosJump(dt)` with dt measured on the **server** clock between accepted Pos, plus 10 ticks of slack: a burst of
  delayed Pos arrives in a few ms of server time and covers the distance of the whole delay, so the jump check can
  reject one (`pos.rejected`).
- **Server-side closes** of a slow member: send queue over `MAX_BUFFERED_BYTES` (8 MiB) closes it with 1013 "too slow"
  (`trySend`); silent for `LIVENESS_MS` 10 s while live closes it with 4002; resync budget (3 a minute) closes with
  4001. The client handles 4001 (stops, "Out of sync, reload") and 4000; **1013 and 4002 fall through to reconnect**,
  which is a full replay from the latest snapshot.

What the slow player gets on the client (`client/lockstep.ts`, `client/worker.ts`):
- Ticks are applied as they arrive with a playout buffer of `J` = 2 ticks. A buffer that runs dry holds the world still
  until 2 ticks are queued again; a buffer above J + 4 steps up to `MAX_EXTRA` extra per frame to drain.
- A live client more than `CATCHUP_THRESHOLD` (120 ticks, 2 s) behind switches to **catching up**: the world is
  fast-forwarded, the catch-up card covers the middle of the screen, and the avatar is **paused** (`gameFrame` only
  runs when `net === "live"`), so no Pos and no casts go out until it is live again.
- The local avatar is predicted, so the slow player's own movement stays smooth; the world, the enemies and the other
  players are shown at the client's sim tick, which is behind.
- Signals the client already has: `NetState`, the PING round trip `pingMs` (every 2 s, through the worker's socket),
  `stats.stepsPerSec` and `stats.buffered` (every 500 ms), the `resyncs` count. Nothing reaches the player today except
  the header dot (amber while catching up or reconnecting) and the catch-up card.

## 2. How it was measured

**CDP network throttling does not work on this game's socket.** The brief asked for
`Network.emulateNetworkConditions`. `tests/soak/slow-net-probe.ts` set 800 ms of latency on the page target, then on the
worker target that owns the WebSocket (`Target.setAutoAttach`), then with `Network.emulateNetworkConditionsByRule` on
both. The client's own PING round trip stayed at 61-72 ms each time (clean: 55-66 ms). The worker target answered "Not
supported" to `emulateNetworkConditions`; the by-rule variant was accepted and did nothing to WebSocket frames.
Chromium's DevTools throttling shapes HTTP requests, not frames on an open WebSocket.

So the measurement shapes the wire instead: `tests/soak/slow-net.ts` puts a proxy between one client (Bo) and the
server. The other client (Ana) connects directly. Per direction the proxy models latency (RTT / 2, +-10% jitter, in
order), a byte rate (with real TCP backpressure: past 256 KB queued it stops reading from the server, so the
**server's** own send queue grows as it would behind a slow link), loss as TCP sees it (a lost frame is a head-of-line
stall of one RTO for it and everything behind it), and blackouts (nothing passes for N s, then a burst). Both bots walk
left and right and hop, so "how late does each see the other" can be read by lining up one's own predicted x against
the other's view of it (`perceivedDelay`). The server is sampled every 500 ms (closed ticks, held, per-connection
lag) and its event log is captured.

Known gap: the server's ws `ping()` is answered by the proxy, so the server's `rtt_p95_ms` does not see the shaping.

## 3. What happens (measured)

Run 1: `node tests/soak/slow-net.ts`, 14:30-14:36 on 8 Nov, Survival size S, two bots walking and hopping. **Load:**
`uptime` 2.85 before and 58 after. The other lead's full cargo gate started at about 14:34. Going by the phase
lengths, the phases up to and including **loss10 ran quiet**. **bw4k and everything after it ran under heavy load**
and mix CPU starvation with network slowness. The bw4k dips hit the clean client at the same moment, so they are load.
(An earlier smoke run at load 59-75 is discarded: even the clean client fell into catch-up.) Raw data:
`/tmp/slownet-run/run1.json`, `run1-recs.json`, `run1.log` (not committed).

| Phase (Bo shaped) | Server ticks/s | Held | Ana (clean) steps/s, lag p50 | Bo PING p50 / max | Bo lag p50 / max (ticks) | Ana sees Bo late by | Bo sees Ana late by | Server events |
|---|---|---|---|---|---|---|---|---|
| clean | 60 | no | 60, 19 | 4 / 169 ms | 20 / 55 | 100 ms | 125 ms | none |
| RTT 300 ms | 60 | no | 60, 20 | 378 / 708 | 30 / 59 | 400 ms | 375 ms | none |
| RTT 800 ms | 60 | no | 60, 20 | 930 / 967 | 44 / 70 | 550 ms | 525 ms | none |
| RTT 2000 ms | 60 | no | 60, 20 | 2179 / 2286 | 81 / 117 | 1200 ms | 1225 ms | none |
| RTT 150 + 3% loss | 60 | no | 60, 19 | 384 / 703 | 37 / 68 | 275 ms | 475 ms | none |
| RTT 150 + 10% loss | 60 | no | 60, 22 | 514 / 1041 | 45 / 87 | 150 ms | 575 ms | none |
| 4 KB/s *(load)* | 60 | no | 60, 28 | 302 / 703 | 34 / 188 | 150 ms | 125 ms | none |
| 1.5 KB/s *(load)* | 60 | no | 60, 23 | 244 / 617 | 27 / 89 | 150 ms | 175 ms | none |
| 5 s blackout *(load)* | 60 | no | 60, 21 | n/a | 32 / 322 | | | none; Bo froze 5 s, then 0.5 s catching up |
| 12 s blackout *(load)* | 60 | no | 60, 25 | n/a | 184 / 1654 | | | `leave` silent (4002) at 10 s, then `join`: Bo reconnected and replayed in ~6 s |

Every phase: **0** desyncs, resyncs, `pos.rejected` and holds; no 1013 "too slow". Snapshots kept being taken
from Ana. The proxy never had to apply backpressure, so the server's send queue never grew.

**What this says.**
- **The user is right: a slow player does not slow the server or spoil the game for others.** The room's clock ran at
  60 ticks/s through 2 s round trips, 10% loss, 1.5 KB/s and a 12 s blackout. The clean player stepped at 60/s with
  the same lag as in the clean phase. No vote, snapshot or hold waited on the slow player.
- **What the others see** is the slow player's avatar **late by about half their round trip** (550 ms at 800 ms RTT,
  1.2 s at 2 s). Only the uplink matters for that. It moves smoothly, without rubber-banding. Their own spells and
  pickups land on everyone's screen at the same (late) tick, so nobody is treated unfairly in the sim. The slow player
  simply acts later.
- **What the slow player sees**: their own avatar stays smooth (predicted), but the world, enemies and other players
  run **behind by their downlink delay** (44-81 ticks at 800-2000 ms), and hits and casts land late. Under loss the
  world stutters (buffer refills, steps/s swinging 21-80). **In a blackout the world freezes with the header dot still
  green and no message** for up to 10 s, until the server closes the socket (4002). Then the player sees "Connection
  lost, reconnecting..." and a replay. That silent freeze is the gap the notice fills.
- **No server fix is needed.** The fair-treatment question has a measured answer: lockstep already isolates the slow
  player, so the server is untouched.

## 4. What was built

`client/slownet.ts` (pure) and a badge in `client/room.ts` and `client/index.html`. The badge is fixed at top centre
over the stage, has `pointer-events: none` and `role=status`, and on phones its two lines stack. It is fed from the
worker's existing 500 ms `stats` and `net` messages: nothing new is sent, and neither the input path nor the server
changes. Only the player whose connection is slow ever sees it.

- **"Slow connection: 930 ms round trip: others see your moves late"** when the PING round trip is >= **600 ms** for
  **4 s** (two readings: one stale spike never shows). It is hidden after **6 s under 250 ms**. Why 600: clean links
  read at most 169 ms, and up to 350 ms under machine load (smoke run), while 800 ms RTT read 790-970. 300 ms RTT plus
  loss swings 190-700 ms, so the wide 250/600 band and the 6 s exit keep that from flickering.
- **"Connection stalled: no updates from the server..."** when live, with 0 steps/s and nothing buffered, for
  **1.5 s**. It is hidden after 1 s of ticks flowing. A CPU-starved client still has ticks queued, so it never trips
  this. The lowest clean-link rate measured was 17 steps/s. The stall outranks latency.
- Catching up, reconnecting and rejected states reset it: those already have the card and the note.

## 5. Tests (red first)

`tests/net/slownet.test.ts`, 8 tests. **Red**: against a stub `nextSlow` that always returns idle and an empty
`slowText`, 6 of 8 failed (`/tmp/slownet-red.log`). The 2 that passed assert "never shown" and "resets", which a stub
satisfies vacuously. Their red partners are the "shows" tests. One test expectation was wrong against the rule it
tests: a stall clearing still owes the latency notice its exit hold. It was corrected before the green run, which
passed 8/8 (`/tmp/slownet-green.log`). `pnpm typecheck` was green (`/tmp/slownet-tsc.log`). There is no server net
test, because the server was not touched.

## 6. Not done (budget stop at B0 + $21.7 of $25; the shared week counter read $336.87)

- **The gate is owed.** `node scripts/gate-plan.ts` should give the client tier (typecheck + net). The net suite and
  `APP_URL=http://localhost:8075 pnpm check` were **not run**: the other lead's gate held the load at 58-286.
- **Screenshots are owed** (desktop and phone). Nobody has seen the notice in a browser. The harness records
  `#slowNotice` text per sample, and with `SHOTS=` it screenshots Bo at each phase end, so a rebuilt client
  (`pnpm build:client`) plus one quiet run of `tests/soak/slow-net.ts` gives both. Pass a phone viewport for the phone
  shot.
- **A quiet rerun of the bandwidth and blackout phases is owed** (load under 4). The latency and loss phases that set
  the thresholds ran quiet.

## 7. Architectural decisions for review

1. **The notice is client-only, driven by signals the client already has** (PING RTT, steps/s, buffered). The
   alternatives were a server-pushed per-member lag signal, or telling other players about a slow peer. Neither is
   needed: the room is unaffected, and naming a slow peer to others adds nothing they can act on. Cost: the
   server-side `rtt_p95_ms` and this notice can disagree, since they are measured differently. Reversible.
2. **No server change.** Measured: there is no hold, vote, snapshot or queue effect from a slow member. Cost: none.
3. **The measurement uses a frame-shaping proxy, not CDP.** CDP `Network.emulateNetworkConditions` (page, worker and
   by-rule) does not delay WebSocket frames (`tests/soak/slow-net-probe.ts`). Anyone re-measuring with DevTools
   throttling will see nothing and wrongly conclude the game shrugs off latency.

## 8. D-row draft

| D-2xx | 2026-11-08 | **Slow connections: a notice for the slow player, no server change.** Measured with a frame-shaping proxy in a two-client Survival room (CDP throttling does not reach WebSocket frames): through 2 s RTT, 10% loss, 1.5 KB/s and a 12 s blackout the server held 60 ticks/s, never held the clock, and logged no desync, resync, pos rejection or "too slow"; the clean player stepped at 60/s. Others see the slow player about half an RTT late; the slow player sees the world a downlink delay behind, and in a blackout it froze silently until the 10 s 4002 close. Added a client-only badge: "Slow connection" at PING >= 600 ms for 4 s (off under 250 ms for 6 s), "Connection stalled" at 0 steps and nothing buffered for 1.5 s. | `docs/research/slow-net-report.md`. Gate and screenshots owed at handback. |

## 9. FUTURE.md ideas

- Show a slow player's avatar label slightly dimmed to others (plain name, no numbers). Only if playtests show
  confusion; the measurements say it is not needed.
- Close code 1013 ("too slow") currently falls through to a silent reconnect. A specific note would help if it is
  ever seen in production logs (it never fired here).

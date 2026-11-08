# Brief SLOWNET: tell a player when their connection is too slow, and handle them fairly (Opus lead)

Written 8 Nov by the session model from the user's request: "a notice that the player's network connection is too
slow. They may experience update lags (or something - you may have to investigate what happens under these
conditions). I'm not too sure how the player should be treated in this case - I don't believe they will be slowing the
server down or ruining the game for other players in the same room." Final submission is **Mon 9 Nov 12:00**.

## Budget and stopping (hard)
- **$25 total** for you and every worker. Read spend at the start (B0), after every worker and every ~20 of your own
  tool calls:
  `curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
  Stop dispatching at B0 + $20; finish by B0 + $25. **If the week reads $395 or more, stop at once**, commit to your
  branch and report.
- **At most 2 workers, one at a time.** Workers never dispatch. Write `docs/research/slow-net-report.md` **as you go**.

## Where
`git worktree add /tmp/wt-slownet -b slow-net multa`. Never touch the main checkout or the user's :8080 server (PID in
`HANDOVER.md`); never push or merge. Ports **8075** / **5175**, data `/tmp/slownet-*`.
**Another Opus lead is building owned sandbox worlds in parallel** (`/tmp/wt-owned`, branch `owned-sandbox`). It owns
room creation, ownership, the sweep and the menu. You own the connection-status UI and per-member lag signals. **Both
of you may need `server/main.ts`**: keep your edits there small and in the connection/HELLO sections; never reformat
code you don't change. **Before any gate, soak or heavy build** check `pgrep -fl "cargo test|vitest|test:determinism|tests/soak"`
and `docker ps`, and wait for quiet: one heavy job at a time.

## Investigate first (~$6), and write it into the report before building
The question: **what actually happens to a player on a slow or lossy connection, to them and to the room?** Read the
code, then measure. Known pieces (verify):
- Lockstep: the server closes a tick every 1/60 s and relays inputs; a client steps the sim as ticks arrive
  (`client/lockstep.ts`, `client/worker.ts`; since D-215 it steps by real time owed). A client whose ticks arrive late
  falls behind `lastClosed`; its own inputs are stamped late (does the server drop or delay them? `server/world.ts`
  input path), so its avatar's moves land late for everyone.
- The server holds or not: is there anything that waits for a slow member (a "hold" exists for catch-up: `catchupHold`,
  `evaluateHold`, `CATCHUP_HOLD_MAX_MS`)? Can one slow member stall the room's clock? (The user believes not: confirm or
  refute with evidence.)
- Server-side limits: the send queue cap `MAX_BUFFERED_BYTES` 8 MiB closes a socket as "too slow"; resyncs are budgeted
  (`RESYNC_BUDGET_MS`, close with `CLOSE_OUT_OF_SYNC`); the HASH and PING rate (D-222); the join deadline (D-187).
- Client signals that exist: `NetState` (connecting, catching-up, live, reconnecting, rejected), RTT (`rtt_p95_ms` is
  logged per member), `buffered`, `__net` and the connection dot in the header (`?debug=1` shows stats).
**Measure** with real throttling: a node server on 8075, two agent-browser or Playwright sessions in one Survival room,
one throttled with CDP `Network.emulateNetworkConditions` (latency 300/800/2000 ms, low throughput, some packet loss if
you can) and one clean. Record: does the clean player's game stay smooth; how far behind the slow one runs; what the
slow one sees (avatar lag, rubber-banding, catch-ups, resyncs, a close); whether the server log shows holds, resyncs,
"too slow". The existing N1 soak harness (`tests/soak/n1.ts`) has a delay proxy you can borrow.

## Build (from what you found)
1. **A notice for the slow player**: a small, non-blocking banner or header badge, e.g. "Your connection is slow:
   other players may see you lag" with a plain reason ("high latency" / "catching up"), shown when a measured signal
   crosses a threshold for a few seconds (hysteresis: no flicker), hidden when it recovers. Thresholds come from the
   measurements, not guesses. Desktop and phone. Never shown to other players about someone else unless you find a
   good reason (and then plain names only).
2. **Fair treatment**: if the investigation shows a slow player can't hurt the room, say so with evidence and leave the
   server alone. If it can (e.g. it delays a hold, floods resyncs, or its late inputs do something odd), fix the
   smallest thing, e.g. a clearer close reason the client shows ("your connection was too slow to keep up; rejoin"),
   and the room carrying on. **Never make the server wait for a slow client** (lockstep relays; the clock doesn't block).
3. **Tests, red first**: a pure function for the "is it slow" decision (thresholds, hysteresis) with unit tests;
   a net test that a slow member doesn't change the clean members' tick rate (if you touch the server).

## Gate and verify
`node scripts/gate-plan.ts` picks the tier (client- or server-only: typecheck + net; anything in `shared/`, `sim/` or
the input path (`client/lockstep.ts`, `client/worker.ts`): the full gate). `APP_URL=http://localhost:8075 pnpm check`
against your own server. Screenshots of the notice (desktop and phone) that you Read. A cold read-only Sonnet review
if you change the server, written to `docs/research/review-slow-net.md`.

## Hand back
`docs/research/slow-net-report.md`: the investigation (what happens, measured, with the conditions), what was built,
thresholds and why, tests with red-first evidence, gate results with log paths, screenshots, **Architectural decisions
for review**, a D-row draft, FUTURE.md ideas. Branch `slow-net` committed, not pushed; commits end with the writing
model's `Co-Authored-By` line (Opus `Claude Opus 5.5 <noreply@anthropic.com>`, Sonnet
`Claude Sonnet 5.5 <noreply@anthropic.com>`, Haiku `Claude Haiku 5.5 <noreply@anthropic.com>`). Kill everything you start.

# S1 Robustness report

`pnpm typecheck`, engine project (85 tests) and full `pnpm check` on a fresh app at :8101 green, twice (second run after the 60 s rate window).

1. **Simultaneous actions.** Spec: seat race (303 + 409); 4 concurrent `start`s (one ok); 5 concurrent `arm_retract` from two tabs (one ok); replay has one `step_done` row each. Polls need minutes of real clock, so `restart.test.ts` shifts `clock_offset_ms` while the server is down, then fires 4 concurrent `poll_open`s and `poll_report`s: one ok each. No bug (`act` is synchronous), so **`rooms.ts` is unchanged**.
2. **Two tabs.** Spec: both get views; closing one leaves the other. Process test (`ABANDON_AFTER_MS=3000`): still live 5.7 s after one tab closes, scrubbed after the last closes.
3. **Stream drop.** Spec: abort, wait 1.5 s, reconnect gives `lobby` then `views`, tMs advanced 1.4-4 s. **Bug found, fixed in `console.js`:** a dead link with no RST raised no `error`, so the UI froze silently. Added a watchdog (live phase, 5 s quiet: show "reconnecting…" and reconnect). Browser-verified by SIGSTOP/SIGCONT of the server: shown after ~5 s, cleared on resume.
4. **Restart.** `restart.test.ts` plus `testserver.ts` (paths from `import.meta.url`, children killed in `afterAll`). SIGTERM with 1.5 s down: live, step done, clock advanced only the up time. SIGKILL: both steps kept, clock at the last write (under 5 s lost). About 10 s.
5. **Slow network.** Actions abort after 10 s with "No reply from mission control — try again" and the button re-enables (browser-tested with a delayed `fetch`).
6. **Limits.** `src/ratelimit.ts` plus unit test: `/crew` 10/min per IP (only successful sign-ups count), `/missions` 10/min per crew, `/act` 20/s per crew; `RATE_LIMIT_SCALE` can only raise them. Spec bursts both for 429s. Caveats: a classroom behind one NAT shares the `/crew` allowance; `fly-client-ip` is trusted blindly; two `pnpm check` runs within a minute on one server exceed `/crew` (restart the app). The spec creates 2 crews.
7. **Inputs.** `bodyLimit` 16 KB on POSTs before `csrfGuard`. 64 KB gives 413; 1 MB (declared or chunked) gives 413 or a client reset. Sixteen garbage action bodies, bad content types and bad paths never reach 500.

**Flakiness:** none in two runs. A pooled-socket reset after a 413 broke client `fetch`, so the 1 MB test uses raw `http.request`.
**Not tested:** offline/online (`agent-browser set offline` leaves an open EventSource alone; SIGSTOP stood in), real Fly proxy headers.

## Session review

- Raised the sign-up limit from 10 to 30 a minute per address: at a crit or the
  showcase a whole class signs up from one NAT.
- Fixed in the new watchdog: it did not reset its timer when it reconnected, so
  on a link slower than a second it would reconnect every second, each attempt
  killing the last before it opened. Each attempt now gets its own 5 s.
- Re-ran: engine project 85 green, full check 112 green on a fresh app.

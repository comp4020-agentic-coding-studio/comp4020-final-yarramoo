# 03 Server report

`pnpm check` green against a fresh app on :8093 (typecheck, 54 engine incl. 4 new replay tests, 8 spec). `check:evidence` passes. Nothing committed.

## Routes
`GET /`, `POST /crew`, `GET /join?code=`, `POST /missions` (303 to `/m/CODE`), `GET /m/:code` (lobby and console shell), `POST /m/:code/seat|unseat` (`role`; 303, or the page again with `#error` and 409/403/422), `POST /m/:code/act` (JSON `{ok,error?}`; 403 if the crew does not hold `role`; engine rejections are 200 ok:false; `start` goes here too, flight seat, needs every role seated), `GET /m/:code/stream` (SSE). `/events` is gone; `bus.ts` is internal pub/sub only.

## Schema (001_init.sql, replaced)
`crew`, `missions`, `seats`, `mission_actions` (accepted only, with now_ms and crew_id, NULL for server), `mission_events`. `meta` dropped.

## Stream messages (one JSON per SSE message)
- `{type:"lobby", serverNow, phase, tMs, seats:{flight,propulsion,ground: callsign|null}, outcome}` to everyone, observers included.
- `{type:"views", serverNow, views:{[role]: ConsoleView}}`, held roles only; coalesced across roles.
- `{type:"reseat"}`: reconnect.
On connect: lobby, then views. Pushed on every accepted action or event, and at 1 Hz while live. Role topics are subscribed per held role, so other views never reach a stream.

## Restart pause
On boot `clock_offset_ms += now - last_seen_ms` per live mission; engine `nowMs = Date.now() - offset`. SIGTERM/SIGINT flush state first. Observed (SIGTERM): tMs -233982 just before kill, server down 5269 ms, 1.5 s up again, tMs -232500 (+1.5 s, not +6.8 s). A SIGKILL loses at most 5 s of clock, never an action. Boot also replays the action log and warns if it differs from `state_json`.

## Tests (all pass)
Spec: seats reach the other's lobby stream; start needs all seats and B sees phase "count"; B's step shows done in A's checklist; B's stream has no other role data, labels, `real`/`debrief`/events; 403 unheld role, 403 no CSRF, unknown type ok:false, client time fields ignored; callsign clash (409) and bad callsign (422). Engine: rebuild equals live (rejected actions unlogged), sensitive to log, finished mission, JSON round trip. Abandonment checked by hand with `ABANDON_AFTER_MS=3000` (test-only env override): scrub logged with crew_id NULL.

## Engine notes (not changed)
- A server-side scrub records "Scrubbed by the Flight Director" as its reason; the engine has no way to say "crew lost contact".

## Weak spots
- Client clock extrapolates from message arrival, not `serverNow`, because wall-clock skew between machines is unbounded; `serverNow` is sent but unused.
- No rate limit on `POST /crew` or `/missions`; a cookie is the only identity (clearing it loses the callsign).

## FUTURE.md suggestions
- Engine scrub reason parameter, so an abandonment reads "crew lost contact" in the debrief.
- Mission history JSON built from `mission_events` for the replay page.

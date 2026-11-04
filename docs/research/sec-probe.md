# Security probe (prober, brief SEC)

Local server on 127.0.0.1:8104 only, `DATA_DIR=/tmp/sec-probe-data`, `ADMIN_TOKEN=probe-admin`. Scripts were in /tmp/sec-probe/.

## S1 CRITICAL: `POST /api/rooms` with body `null` kills the whole server process
- where: `server/main.ts:~708-725` (`createRoomRoute`). `JSON.parse("null")` succeeds and returns `null`; `body.config` / `body.name` is then read outside the try, in the `req.on("end")` handler. A literal `null` is the trigger (an array or a number would not throw on property access).
- attack: `curl -X POST localhost:8104/api/rooms -d null`. No Origin header and no token are needed (a script passes `originOk`), and it is anonymous.
- impact: the Node process exits (uncaught TypeError in an event handler; only `unhandledRejection` is handled, no `uncaughtException` handler). Every room and every connected player is dropped. One request, repeatable at will, so Fly restart loops are a trivial DoS.
- evidence: the next `curl` got connection refused (HTTP code 000); the server log ended with `TypeError: Cannot read properties of null (reading 'name') at IncomingMessage.<anonymous> (server/main.ts:725:27)` and the process was gone.
- fix: after parsing, `if (typeof body !== "object" || body === null || Array.isArray(body)) return 400`; do the same in every JSON POST route (players and admin reset are inside their try, so they are safe). Also wrap handler bodies in try/catch, or add a process-level `uncaughtException` log-and-continue guard only as a backstop. Test: net test that POSTs `null`, `[]`, `1`, `"x"` to /api/rooms and expects 400 and a live server.
- confidence: high, reproduced. Did not test other routes with exotic JSON beyond reading them.

## S2 MEDIUM: anonymous room creation has no IP or global cap
- where: `POST /api/rooms` (`server/main.ts` createRoomRoute, `server/rooms.ts` createRoom; the per-creator daily limit only applies when `creatorPlayerId !== null`, and the route always passes null).
- attack: 150 sequential `POST /api/rooms` with a valid config and `visibility:"unlisted"` (or public).
- evidence: all 150 returned 201; the rooms table held 153 rows afterwards. Public ones flood `GET /api/rooms` (which returns only the newest N, so a spammer can push real rooms out of the list). No Origin or token needed.
- impact: unbounded SQLite growth on the Fly volume, room-list spam/defacement (names are plain text, client uses `textContent`, so no XSS), 6-char codes slowly filling.
- fix: require a registered token on creation and apply `MAX_ROOMS_PER_CREATOR_PER_DAY`, plus a per-IP and global per-hour cap via `log.ipTag`-style limiter. Test: 5 creates from one token returns 429 on the 4th.
- confidence: high. Did not measure the DB growth ceiling or code-collision behaviour.

## S3 LOW: no Origin check on the WebSocket upgrade
- where: `server/main.ts:~905` upgrade handler checks only the path and per-IP count.
- attack: a page on evil.example opens `ws://host/ws`; the server accepted it. HELLO still needs a valid 32-byte token, which another origin cannot read from the victim's localStorage, so no session is hijacked. It does let any web page make visitors' browsers open up to 12 connections per IP and burn the per-IP cap (and a shared NAT's budget).
- fix: reject `Origin` that is neither same-host nor in `allowedOrigins` (reuse `originOk`). Test: upgrade with a foreign Origin gets 403.
- confidence: high on the accept; impact is low.

## S4 LOW: no security headers on any response
- evidence: `curl -I /` shows only content-type, cache-control, keep-alive. No CSP, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, or Referrer-Policy.
- impact: the dashboard accepts `?token=` in the URL (isAdmin, SSE and links), so a Referer or clickjacking frame of /dashboard is possible; no framing protection for the game. Admin token in query strings also lands in proxy logs (the reset route correctly requires the header).
- fix: add a small header set in the single `createServer` handler (`frame-ancestors 'none'`, nosniff, `Referrer-Policy: no-referrer`), and prefer header-only admin auth. Test: assert headers on `/` and `/dashboard`.
- confidence: high.

## S5 INFO: bad-input flood is rate limited but each rejected input is still parsed
- 546,000 malformed inputs (bad kind/length) were sent over one socket in 3 s. The server stayed up, stayed responsive (summary 1 ms afterwards, RSS 96 MB to 94 MB), and logged one `input.rate_limited` line (via `log.limited`) plus per-input counts in `input.summary` (rejected 39 in the earlier fuzz). The connection was not closed; consider closing on sustained rate-limit breach (e.g. over 10x the limit) to cut CPU spent on frames. Not tested: valid Paint floods against the sim, snapshot uploads, claim spam, CPU of the verify worker (left alone; a test gate was running and the brief asked to keep floods short).

## Checked and found sound
- Static serving: `/../`, `%2e%2e`, `..%2f`, encoded double traversal, `//etc/passwd`, NUL bytes all give 403/404; `/%` gives 400 (no crash).
- Admin: `/dashboard/players`, `/dashboard/player/:id`, `/api/admin/player/:id` and `/api/admin/reset` give 403 without a token or with a wrong one; reset needs the `Authorization: Bearer` header (query token refused) and a same-origin or absent Origin; comparison is `timingSafeEqual` over SHA digests.
- Public `/api/summary` and the public `/dashboard/stream` carry no names, `#id`, IPs or tokens; the admin stream carries only `ip_tag`.
- Registration: name cleaned (control, bidi and zero-width characters removed, 24 chars max; `<img onerror...>` stored as plain text and truncated), non-string name falls back to "Wanderer", invalid JSON 400, 5 KB body 413, foreign Origin 403, 30 per minute rate cap (31st gets 429; global, not per IP).
- WebSocket: empty, unknown-tag, truncated, pre-HELLO input and 900 KB pre-join frames all close the socket with 1002 and leave the server up; unknown world, nonexistent room and wrong build hash get a REJECT; a second HELLO on one socket closes it; the per-IP cap refused connection 13 of 20; input kind/length fuzz was rejected per input without a crash.
- Room list and room GET: code validated `^[A-Za-z0-9]{1,6}$`; config validated by `decodeConfig` (bad config 400); `unlisted` rooms not listed; CORS headers absent.
- No raw IP or token seen in the server log during the run.
- Not probed: snapshot upload/verify worker, claims, dev-teleport (not enabled; reader's area), dependencies.

## Architectural decisions for review
- Handlers that parse JSON outside a try/catch (S1) are one mistake away from killing the process because there is no `uncaughtException` backstop and no shared "parse a JSON body" helper. A single `readJsonObject(req, max)` used by all POST routes that returns `Record<string, unknown> | null` would remove the class of bug at the cost of a small refactor.
- Anonymous creation (S2) is a deliberate choice for a no-login game; tying creation to the existing token is the cheap fix, at the cost of one more registration round trip for first-time creators.

## Session model's resolution (4 Nov)

- **S1 (CRITICAL, `null` body kills the process): fixed.** `createRoomRoute` refuses any body that isn't a plain
  object with 400. `tests/net/sec-bodies.test.ts` reproduced the TypeError before the fix. `/api/players` and the
  admin reset read their one field inside the `try`, so they were already safe; the test covers `/api/players` too.
- **S2 (MEDIUM, uncapped anonymous creation): fixed.** At most `ROOM_CREATES_PER_IP_HOUR` (10) rooms per IP tag in a
  sliding hour, 429 after; the map is bounded at 4096 tags. Test red without the cap.
- **S3-S5: not changed tonight**; listed for the user with the code review's S5-S8.

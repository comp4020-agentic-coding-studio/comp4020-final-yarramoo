# Security review, code reader (brief SEC)

Read-only pass over `server/main.ts`, `server/dashboard.ts`, `server/identity.ts`, `server/rooms.ts`, `server/world.ts` (message, claim, upload and hash paths), `server/verify*.ts`, `server/log.ts`, `server/devteleport.ts`, `shared/protocol.ts`, `Dockerfile`, `fly.toml`, `package.json`. Nothing was run. Line numbers are for the tree at the time of reading.

## S1 HIGH: Unlisted rooms are not private, and anyone can join or spectate any room by integer id
- where: `server/main.ts:1083-1123` (HELLO resolves `msg.worldId` through `getOrLoadRoom`, `main.ts:445`), `server/rooms.ts` (room id is the autoincrement row id, the world id).
- attack: send HELLO with `worldId = 2, 3, 4, ...` and the `HELLO_SPECTATE` flag and a zero token. A spectator or painter is accepted as anonymous (`main.ts:1119-1123`: only a game *player* needs a known token). The room code is never checked on the socket path, only on `GET /api/rooms/:code`. A registered token can also join as a player in any room by id.
- impact: the "Unlisted (link only)" option gives no privacy. A stranger can watch or join a private session, and enumeration also loads rooms (each costs a loaded-room slot, see S2). Room ids are sequential, so the whole set is enumerable in a few hundred HELLOs.
- fix: put an unguessable value on the socket path (HELLO carries the 6-char room code or a per-room join secret, checked in `getOrLoadRoom`), or at minimum make unlisted rooms refuse HELLO unless the connection first fetched `GET /api/rooms/:code` (short-lived join ticket). Test: HELLO for an unlisted room by id with no code is rejected "unknown room".
- confidence: high on the code path; not run. Not checked: whether the client protocol could carry a code without a version bump.

## S2 HIGH: A handful of anonymous spectator sockets can lock every other player out (global member cap)
- where: `server/main.ts:80-82` (`MAX_MEMBERS_SOFT = 32`, hard 48), `memberCapReason` (`main.ts:422`), `MAX_CONNS_PER_IP = 12` (`main.ts:68`), `MAX_LOADED_ROOMS = 16` (`main.ts:84`).
- attack: from 3 source addresses (or 3 cheap proxies) open 12 sockets each, HELLO with the spectate flag and a zero token. No registration, no rate limit on HELLO other than the per-IP socket count. Once 32 members exist across all worlds every later HELLO gets "server busy" (`main.ts:1103-1108`). Spectators send no frames, but `reapSilent` skips members that are not `live` (`world.ts` ~790, `if (!m.live || ...) continue`), and a member only becomes live by sending LIVE or a valid HASH. A socket that completes HELLO and then sends nothing therefore appears never to be reaped by the liveness timer; `CATCHUP_HOLD_MAX_MS` (120 s) bounds only the clock hold, not membership. Verify this reading with the prober.
- also: one connection per distinct room id can fill the 16 loaded-room slots (4 for L rooms) with spectators of different rooms, which refuses every new room load ("server busy") for everyone.
- impact: cheap denial of service for the whole deployment, trivially repeatable. On Fly a single attacker with a few IPs suffices.
- fix: reap sockets that never become live (a join deadline after WELCOME), count anonymous spectators separately with a small cap, and raise per-IP limits only for registered tokens; make spectator HELLO to a not-yet-loaded room refuse to load it (only already-loaded or player HELLOs may load). Test: 40 spectator sockets over a few seconds do not stop a registered player from joining.
- confidence: medium-high on the cap arithmetic; medium on the never-reaped claim (read `reapSilent` condition only, not run). Not checked: whether the WELCOME send path times out a client that never reads.

## S3 MEDIUM: Admin token is public in the repo and is also accepted in query strings
- where: `fly.toml` `ADMIN_TOKEN = "w-9dwbvsOY0f"` (accepted by D-098), `server/dashboard.ts:75-83` (`isAdmin` accepts `?token=`), `dashboard.ts:154-155` and `playersPage` (token re-emitted into links in the HTML).
- attack: read the repo once the repo is public, open `/dashboard?token=...`. You get `name#id`, the connection list (who, role, per-conn stats), the log feed, desync incident details including user agents, and `POST /api/admin/reset {world:N}` (header-only, good) resets any loaded world, including other people's rooms by id.
- impact: once the repo is public this is full admin to anyone, contrary to the "players never see name#id" rule in CLAUDE.md. A reset destroys a room's state mid-game (a way to hurt others' rooms at will, which the brief rates CRITICAL; downgraded here to MEDIUM only because D-098 accepted it explicitly for the course, and this review treats the reset as known).
- fix: set a Fly secret `ADMIN_TOKEN` (it overrides `[env]`) and delete the value from `fly.toml`; rotate the committed value now since it is in git history. Drop `?token=` for everything except the SSE stream (EventSource cannot set headers) or move to a cookie after a POST login. Test: `curl /api/admin/player/1?token=old` returns 403 after rotation.
- confidence: high. Not checked: whether Fly access logs record query strings (they do record URLs by default).

## S4 MEDIUM: Room creation is anonymous, uncapped by IP or total, and each room is permanent
- where: `server/main.ts:724-730` passes `creatorPlayerId: null`; `server/rooms.ts:123` only rate-limits when a creator id exists; no total cap, no pruning (`rooms.ts` has no delete; `totalRooms` is only a dashboard figure).
- attack: loop `POST /api/rooms` with distinct names and `visibility: public`. Each call inserts a row. Body up to 4 KiB, 16-byte config. The public list (`listPublicRooms`, 100 newest by `last_active`) is then entirely attacker names: spam or abusive text pushed to every visitor's menu. DB growth is small per row (about 100 bytes) but unbounded; 1 GB volume.
- impact: menu spam and defacement within seconds, slow DB growth, `GET /api/rooms` always returns 100 rows of attacker choice. Names pass `cleanName` (control chars stripped) so there is no injection, only content.
- fix: per-IP creation limit (e.g. 3 per hour via `log.ipTag` style keyed map, `Fly-Client-IP`), a global stored-room cap with pruning of never-joined rooms after a day, optionally require a registered token for creation. Test: the fourth create from one IP in an hour returns 429.
- confidence: high (also listed in FUTURE.md as known). Not checked: the client UI's own limits.

## S5 MEDIUM: No security headers anywhere (CSP, nosniff, frame-ancestors, referrer policy)
- where: all `res.writeHead` calls in `server/main.ts` and `server/dashboard.ts`; none set `content-security-policy`, `x-content-type-options`, `x-frame-options`/`frame-ancestors` or `referrer-policy`.
- attack: any page can iframe the game or the dashboard (clickjacking a logged-in admin who has the token in the URL). Static files are served with `cache-control: no-cache` and a MIME map with an `application/octet-stream` fallback, no nosniff. The README page renders `marked` output with raw HTML allowed (trusted file today, but any README line with HTML runs script on the game's origin).
- impact: no XSS source was found (see sound list), so this is defence in depth, but the dashboard URL carries the admin token and the `?token=` URL can leak via Referer to any external link on the page (the README links out).
- fix: a small `securityHeaders` helper applied in the one request handler: `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY` (or `frame-ancestors 'none'`), and a CSP (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:`; the dashboard inlines its script so it needs a nonce or hash). Test: response header assertions in `tests/net`.
- confidence: high on absence; not checked: whether the Fly proxy adds any.

## S6 LOW: `/api/summary` and the public SSE stream are unauthenticated and uncapped per-request cost
- where: `server/dashboard.ts:206-210`, `stream()` (`MAX_STREAMS = 8`).
- attack: `/api/summary` calls `deps.summary()` (per-world loops, a file stat for db size) on every request with no rate limit; 8 public SSE streams each run a 1 s timer. Eight idle SSE connections from one client also count toward nothing per IP.
- impact: minor CPU cost under a request flood; the aggregate content itself is clean (no names, IPs or tokens: `ServerSummary` fields are numeric).
- fix: cache `summary()` for 1 s, per-IP limit on streams. Confidence: medium; not measured.

## S7 LOW: Registration has only a global rate limit, so one client can burn the registration budget for everyone
- where: `server/identity.ts:42-47` (`MAX_CREATES_PER_MINUTE = 60`, one global window) and the cap `MAX_REGISTERED = 900`.
- attack: 60 `POST /api/players` per minute from one script keeps the window full; every genuine new player gets 429 ("register.refused" logged each time, not `log.limited`: `main.ts:822` uses `log.event`, so the attacker also floods the 500-entry log ring the admin reads). Also fills the 900 cap at 15 minutes of effort (unjoined rows are evicted after 10 min only when the cap is hit).
- impact: new players cannot register for as long as the attack lasts; the log ring is dominated by `register.refused` lines.
- fix: per-IP registration limit alongside the global one, and use `log.limited` keyed by IP tag for the refusal and for `player.registered`. Confidence: high on code path. This violates the CLAUDE.md rule "anything a client can trigger repeatedly goes through log.limited".

## S8 LOW: Other client-triggerable lines that bypass `log.limited`
- where: `server/main.ts:795` (`register.refused` for a bad Origin, per request), `main.ts:826` (`player.registered`), `main.ts:737` (`room.created`), `main.ts:933` (`hello.rejected`, per rejected HELLO), `main.ts:460/465` (`register.refused` per HELLO when room-load caps are hit).
- attack: a script sending cross-origin POSTs or HELLOs with a bad build hash writes one ring entry each; 500 entries evict everything real the admin dashboard shows (desync incidents live in the DB, but the feed is lost).
- fix: wrap in `log.limited` keyed by `ipTag`. Confidence: high. Impact is log hygiene, not takeover.

## S9 LOW: `Fly-Client-IP` is trusted without checking it came from the proxy
- where: `server/main.ts:637, 686, 910` (`req.headers["fly-client-ip"] ?? remoteAddress`).
- impact: on Fly the proxy overwrites the header, so it is fine there. If the machine is ever reachable another way (a Fly private network address, 6PN, or a different front) a client sets its own header, defeating the per-IP socket cap and every IP tag. Document the assumption; no code change needed unless the port is exposed directly.
- confidence: medium; depends on the Fly topology, not checked.

## S10 INFO: Dev-teleport flag cannot enable under the Dockerfile or on Fly
- where: `server/devteleport.ts:16`; `Dockerfile` sets `ENV NODE_ENV=production`; `main.ts:272` passes `opts.env ?? process.env`; the flag appears in a response only when `tele.on` (`main.ts:773`).
- result: `NODE_ENV=production` or any `FLY_APP_NAME` forces `on: false` whatever `SIMULTA_DEV_TELEPORT` says. Fly always sets `FLY_APP_NAME`. Only a caller passing a custom `env` object to `startServer` (tests) can bypass it. One caveat: `requested` from `opts.devTeleport` is also gated by the same production check, good.

## S11 INFO: Dependencies
- `package.json`: runtime deps `fflate ^0.8.3`, `marked ^18.0.14`, `ws ^8.22.0`; lockfile pins `marked@18.0.14`, `ws@8.22.0` (`pnpm-lock.yaml:570, 801`). Carets are fine with `--frozen-lockfile` in the Dockerfile. `ws` 8.22 is past the old DoS advisories (8.17.1 and earlier). I could not look up advisories offline, so run `pnpm audit --prod` before the deploy. `rust:1-slim`, `node:24-slim` and `pnpm@11` are floating tags (unpinned): a rebuild can change the base image.

## Checked and found sound
- Static file serving: `decodeURIComponent` failures return 400 (no crash); the joined path is `normalize`d and must start with `clientDir + sep` (`main.ts:882-886`), so `..`, `%2e%2e` and absolute paths are refused; `existsSync` plus a try on read. Symlinks in `dist/client` were not checked (built by Vite, none expected).
- Admin routes: reset requires POST, same-origin, and `Authorization: Bearer` specifically (no query token); comparison is timing-safe over sha256 digests (`dashboard.ts:75`); every `/dashboard/player*`, `/dashboard/players` and `/api/admin/player/*` route returns 403 first without the token; the public stream and `/api/summary` contain no `name#id`, IPs or tokens. Admin and public SSE stream caps are separate.
- Dashboard XSS: server-rendered pages escape with `esc` (`& < > "`; attribute values are double-quoted); the client script builds the feed and tables with `textContent`; names are also stripped of control and bidi characters by `cleanName`, 24 chars; room names 32. Menu room names use `textContent` (`client/menu.ts:207`). `innerHTML` uses in `client/` take only constants and config numbers.
- Tokens: 32 random bytes from `randomBytes`, only `sha256(token)` stored, lookup by hash (equality in SQLite, no early-exit comparison on the secret), all-zero token refused, a stolen token only grants that player's identity (no admin).
- Origin checks on `POST /api/players`, `POST /api/rooms` and the reset; body caps 1 KiB / 4 KiB / 1 KiB with `req.destroy()`; JSON parse errors return 400. CORS headers are never sent, so cross-origin reads are blocked by default.
- WebSocket: `maxPayload` set, binary only, `decodeClient` length-checks every message, chunk-hash and upload frames have per-world caps checked before decoding, unsolicited chunk-hash frames close the socket, a second HELLO while one is in flight closes, HELLO timeout 10 s, input rate limit 40/s per connection, claim rate and open-claim caps (`MAX_OPEN_CLAIMS`), claim tick windows, forged player ids refused via `seenPlayers`, unknown message kinds close with 1002. The message handler's async join path has a `.catch`; the `unhandledRejection` handler rethrows by design, so any other rejected promise would exit the process and rely on Fly's restart (noted, none found).
- Snapshot uploads: only the member the server asked, at the asked tick, once (`expectsUpload`); frame cap 1 to 4 MiB; the claimed hash must equal the majority hash before the verifier even runs (so a lone hostile upload costs nothing); decompression is bounded by `maxBytes` (fflate output buffer preallocated at the cap); verification runs in a worker with a timeout and is terminated on overrun. Residual cost: a majority-hash match requires being the chosen uploader.
- Room codes: 6 chars from a 32-letter alphabet via `randomBytes` (about 1e9), route regexes limit to `[A-Za-z0-9]{1,6}`; `listPublicRooms` filters `visibility = 'public'` and ended rooms, returns no player names or counts; SQL uses prepared statements throughout.
- Identity logging: `ipTag` is a salted sha256 slice, the salt is per process; no raw IP or token found in `log.event` calls read.

## Architectural decisions for review
- **Room id is the world id and the socket authorises by id alone.** This is what makes S1 possible. Alternative: a separate random join key per room checked at HELLO (cost: protocol version bump, a client change, a migration for existing rooms); or accept that "unlisted" means "unlisted", rename the option and say so in the UI (cost: none, but private rooms are then not private).
- **One global member cap (32 soft) with anonymous spectators counted equally.** Simple and protects the 256 MB machine, but it makes capacity a shared resource any anonymous socket can drain (S2). Alternative: reserve capacity for registered players and cap anonymous sockets separately (cost: a second counter and a policy for the reserve).
- **Admin token in a public `fly.toml`.** Accepted in D-098 when the repo was private. Moving to a Fly secret costs one command and removes S3; once the repo is public this stops being a course-demo convenience and becomes the front door.

## Session model's resolution (4 Nov)

- **S4 (anonymous creation): fixed** with the prober's S2 (a per-IP hourly cap).
- **S2 (silent spectators hold member slots): confirmed by reading.** `reapSilent` skips members that are not `live`,
  and a spectator HELLO needs no token. Not fixed tonight: a join deadline for sockets that never go live touches the
  connection path and wants its own test and review. For the user.
- **S3 (public admin token): confirmed** (`fly.toml` `ADMIN_TOKEN`, D-098). The fix is a Fly secret, which is the
  user's account step. For the user, before the deploy.
- **S1 (rooms joinable by id): confirmed.** Matters only if "unlisted" is meant to be private. For the user.
- **S5-S9, S11: not changed tonight.** S10 (dev teleport) agrees with the session model's own read.

# Brief SEC: a security review before the deploy (a code reader and a prober)

**Why:** Simulta is about to go public on Fly (`fly.toml`, `Dockerfile`). Earlier reviews looked for correctness and
desync, not attack. The server is a Node HTTP + WebSocket lockstep relay (`server/`), with SQLite storage, anonymous
token identity (`server/identity.ts`), an admin dashboard behind `ADMIN_TOKEN`, snapshot uploads checked by a
verify worker, majority claims for deaths, kills and round results, and a new dev-teleport flag
(`server/devteleport.ts`, refused under `NODE_ENV=production` or `FLY_APP_NAME`).

**Accepted gaps, so don't report them as new** (`docs/DECISIONS.md` D-120, D-171; HANDOVER "Known gaps"): with one or
two eligible voters, one client is a majority of its own co-op room's claims. A modified client can always cheat its
own view (it's lockstep; the sim runs on every client).

**Two Sonnet agents, in parallel.** Use no subagents, stay within about 60 tool calls, and write each finding to your
output file **as soon as it's confirmed**, so a stopped run still leaves something. **Do not edit any tracked file,
do not commit, do not push.** Rules from `CLAUDE.md` that apply: `rm` only on literal absolute paths; kill
everything you start by PID before you finish; prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"` if you build wasm.

| Agent | Mode | Output |
|---|---|---|
| reader | read code only: no servers, no builds | `docs/research/sec-review-code.md` |
| prober | run a local server and attack it with your own scripts | `docs/research/sec-probe.md` |

## What to look at

1. **Identity and tokens:** registration (`POST /api/players`), token format, storage and comparison (timing-safe?),
   what a stolen or guessed token gives, rate limits per IP (`log.ipTag`), the name rules (length, control
   characters, HTML in names shown to other players or on the dashboards).
2. **The admin dashboard and its APIs:** every `/dashboard`, `/api/admin/*`, `/api/summary` route. Can anything
   admin-only be reached without the token? Is the token compared safely, sent in a URL (logs, Referer), or cached?
   Does the public dashboard leak `name#id`, IPs or tokens (CLAUDE.md says it must not)?
3. **HTTP surface:** static file serving (path traversal: `..`, encoded `%2e%2e`, absolute paths, symlinks), room
   codes, `/readme`, the new preview or dev routes, headers (CSP, `X-Content-Type-Options`, frame options), CORS and
   `ALLOWED_ORIGINS`, body size limits on every POST, JSON parsing errors.
4. **WebSocket protocol** (`shared/protocol.ts`, `server/main.ts`, `server/world.ts`): the Origin check, malformed or
   truncated frames, oversized frames, unknown message kinds, input floods (per-member input rate), HELLO with a
   wrong build hash or a world id that doesn't exist, joining two rooms at once, connections per IP, the liveness
   timeout, anything that throws inside a message handler (does one bad frame crash the process or the room?).
5. **Room creation and the room list:** creation rate limits (FUTURE.md notes anonymous creation has no IP cap), config
   validation (the server's `decodeConfig` against the sim's), private rooms leaking into lists, room-code
   guessability.
6. **Snapshot uploads and claims:** the upload size cap, the verify worker's timeouts and memory, a hostile snapshot
   (`sim/src/snapshot.rs` restore validates it; can it cost the server unbounded CPU or memory first?), claim spam.
7. **Logging:** a raw IP, token or `name#id` in any log or response a player can see; client-triggerable lines that
   bypass `log.limited` (flooding the ring).
8. **The dev-teleport flag:** confirm it can't switch on under the Dockerfile's env or on Fly, and that
   `devTeleport: true` never appears in a production response.
9. **Dependencies:** `package.json` and `pnpm-lock.yaml`. Note anything known-vulnerable or unpinned; don't install
   or update anything.

## The prober

- Build and start a real server on **port 8104 only**: `pnpm build:client` (only if `dist/client` is missing or stale),
  then `PORT=8104 DATA_DIR=/tmp/sec-probe-data ADMIN_TOKEN=probe-admin node server/main.ts`, in the background. Use
  `/tmp/sec-probe-data` as written (create it first).
- Write your attack scripts under `/tmp/sec-probe/` (not in the repo). Use `ws` and `fetch` from Node; the repo's
  `tests/net/helpers.ts` shows how to register, HELLO and send inputs (`connect`, `register`, `buildHashHex`), and you
  may import from it.
- Each attack: what you sent, what came back, whether the server stayed up (`curl -sf localhost:8104/api/summary`
  after each), memory and CPU if relevant (`ps -o rss,pcpu -p <pid>`), and what's in the server's output.
- **Only ever target `localhost:8104`.** Never the deployed Fly app or any other host. Keep floods short (a few
  seconds) and bounded; the aim is to show a weakness, not to cook the laptop. Other workers run on this machine.
- Other agents may use ports 5173-5177 and 8099-8103. Don't touch them.
- At the end: kill your server by PID and remove `/tmp/sec-probe-data` and `/tmp/sec-probe` by those literal paths.

## Each finding

```
## S<n> CRITICAL | HIGH | MEDIUM | LOW | INFO: <one line>
- where (file:line, or the route or message), and the concrete attack: what an attacker sends and what happens
- impact on the deployed app (other players, the server, the data, the admin)
- evidence: the code path (reader) or the request and the server's response (prober)
- the fix you'd suggest, and how to test it
- confidence, and what you didn't check
```

CRITICAL means remote crash, data loss, admin access, or a way to hurt other players' rooms at will. Prefer a few
verified findings to many guesses. End with a "Checked and found sound" list.

## Architectural decisions for review

If a design choice (not a bug) makes the app hard to secure, say so under this heading at the end, with the
alternatives and their cost.

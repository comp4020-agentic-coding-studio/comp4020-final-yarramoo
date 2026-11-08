# Worker brief W1 (Sonnet): `GET /api/live` — players live + public death log

You are a Sonnet worker for the menu redesign (lead brief: `docs/briefs/menu-redesign.md`). Work only in
`/tmp/wt-menu` (branch `menu-redesign`). Read `CLAUDE.md` in that worktree first and follow it. **Do not dispatch
subagents.** Do not push, do not merge, do not touch `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`.

## Budget
Your cap is **$6**. Check spend at the start and after every ~20 tool calls:
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
If you reach start + $6, stop, commit what is green, and write the report.

## Report as you go
Write `/tmp/wt-menu/docs/research/menu-w1-report.md` after each commit (what landed, test output summary, spend so
far). Include a section **"Architectural decisions for review"**: each choice later work builds on, what you chose,
the alternatives, why, what it costs later. When unsure about a hard-to-reverse choice, take the more reversible one
and flag it. Suggest `FUTURE.md` ideas in the report (do not edit `FUTURE.md`).

## Files you may touch
- `server/main.ts` (the route and the death ring wiring only), a new `server/live.ts` if you want the ring/cache as a
  small pure module (recommended: easy to unit test), `shared/events.ts` (only if you add a log line).
- New test `tests/net/menu-live-api.test.ts`.
- Nothing in `client/`, `sim/`, `shared/room.ts`, `shared/protocol*`. Not `server/world.ts`.

## The contract (the menu worker builds on exactly this; do not change field names)
`GET /api/live` returns `200 application/json`, `cache-control: no-store`:
```json
{ "players": 3, "rooms": 2, "deaths": [ { "victim": "Ana", "killer": "Bo" | null, "cause": 44, "bag": false, "mode": "survival", "at": 1762400000000 } ] }
```
- `players`: connected **non-spectator** members (`m.playerId !== 0`, same rule as `playersIn`) summed over **public**
  rooms that are loaded in `worlds`. Do not count unlisted rooms or the fixed worlds (sandbox, game).
  `rooms`: number of public rooms with at least one such player.
- `deaths`: newest first, at most **20** entries, from a ring buffer filled in `w.onDeathResolved`
  (`server/main.ts` `wireWorld`, ~line 572) **only when the world is a public room** (look the room up by world id:
  `rooms.getRoomById(w.id)`; `visibility === "public"`). `victim`/`killer` are the **plain display names** (the
  existing `nameOfVisitor`), never `name#id`, never an id, never a room code or room name. Two fields carry the killer, so
  the client's `formatDeath` can phrase it exactly like the in-game toast: `killer` is `null` when `d.killer === 0`
  or `d.killer === d.victim`, otherwise the killer's plain name; `self` is `true` only when `d.killer === d.victim`
  and nonzero (add `"self": false` to every other entry). The example above omits `self` for brevity; always send it. `cause` is `d.cause` (a number),
  `bag` is `d.bag !== 0`, `mode` is the room's `mode` string, `at` is `Date.now()` ms.
  Empty names: skip the entry (an unregistered or nameless visitor never appears).
- **Cache**: compute the response at most once per **2 s** (store the JSON string and its time; a death resolving
  invalidates it). A poll storm must cost one computation per 2 s. Not logged per request (CLAUDE.md: anything a
  client polls is never logged per call). If you log anything (you probably do not need to), use `log.event` with a
  name added to `shared/events.ts`, and `log.limited` for anything client-triggerable.
- Method other than GET: `405` with `allow: GET`. `rooms` unavailable (no db): `200 {players:0, rooms:0, deaths:[]}`.

## Commit checklist (one commit each, gate before each; message ends with
`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`)
1. [ ] **Test first, shown red**: `tests/net/menu-live-api.test.ts` with these cases (model it on
   `tests/net/menu-live-counts.test.ts` for the server boot and `tests/net/claims-rooms.test.ts` for making a death
   resolve by majority claim in a created room; reuse `tests/net/helpers.ts`):
   a. `players`/`rooms` count a connected player in a public room, and **not** one in an unlisted room.
   b. A resolved death in a **public** room appears with plain names (assert the strings contain no `#` and equal
      the registered display names), the right `cause` and `mode`.
   c. A resolved death in an **unlisted** room never appears.
   d. The ring is capped at 20, newest first (drive it through the pure module directly if you made `server/live.ts`;
      otherwise many claims).
   e. The 2 s cache: two GETs within 2 s with a player joining in between return the same `players` (or test the
      pure cache with an injected clock: preferred; never sleep 2 s in a test if a clock can be injected).
   Run it before implementing and **paste the red output summary into your report**. Commit the test only if the
   repo's convention allows a red test commit — it does not: so commit the test together with commit 2.
2. [ ] The endpoint + ring + cache, test green. Commit test + implementation together.
3. [ ] Report finalised (commit `docs/research/menu-w1-report.md`).

## How to verify (all must pass before each commit; gate on exit codes, never `;`, never `| grep`)
```bash
cd /tmp/wt-menu && pnpm typecheck > /tmp/menu-w1-tsc.log 2>&1 \
 && pnpm vitest run --config vitest.net.config.ts tests/net/menu-live-api.test.ts tests/net/menu-live-counts.test.ts tests/net/imports.test.ts tests/net/claims-rooms.test.ts > /tmp/menu-w1-net.log 2>&1 \
 && git add <files by name> && git commit -q -F /tmp/menu-w1-msg.txt; echo "exit $?"
```
Then once, before your final commit, the whole net suite in the background: `pnpm test:net > /tmp/menu-w1-netall.log 2>&1`
(it takes several minutes; check `uptime` first; if the load is above ~16, wait). Report its `Tests` line. A test
that fails one run in three is a real defect: find the timing-dependent assertion, do not retry until green.
`sim.wasm` is already built in this worktree (`sim/target/...`); do not rebuild it.

## Rules
- Never log a raw IP or token. No `console.*` in `server/`. `server/` and `shared/` never import from `client/`.
- Every `rm` names a literal absolute path; no globs on variables. Tests clean up their temp dirs.
- Do not start any long-running server on port 8080. Tests use `port: 0`.
